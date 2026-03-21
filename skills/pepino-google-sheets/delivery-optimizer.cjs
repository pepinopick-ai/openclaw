#!/usr/bin/env node
/**
 * Pepino Pick -- Оптимизатор маршрутов доставки
 *
 * Анализирует заказы на сегодня/завтра и строит оптимальный маршрут:
 *   1. Читает продажи из "Продажи" (Google Sheets)
 *   2. Загружает профили клиентов (зона/адрес)
 *   3. Группирует доставки по зонам (barrios)
 *   4. Рассчитывает оптимальную последовательность остановок
 *   5. Оценивает временные окна доставки
 *   6. Генерирует план и отправляет в Telegram (топик 20)
 *
 * Cron: 30 6 * * * (ежедневно в 06:30, до утреннего брифа)
 * Usage:
 *   node delivery-optimizer.cjs                  -- план на сегодня+завтра
 *   node delivery-optimizer.cjs --dry-run        -- без отправки в Telegram
 *   node delivery-optimizer.cjs --date 2026-03-22  -- план на конкретную дату
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { trace } = require("./langfuse-trace.cjs");
const { send } = require("./telegram-helper.cjs");

// -- Конфигурация -------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

/** Целевая дата (--date YYYY-MM-DD) или сегодня */
function getTargetDate() {
  const idx = process.argv.indexOf("--date");
  if (idx !== -1 && process.argv[idx + 1]) {
    const raw = process.argv[idx + 1];
    const parsed = new Date(raw + "T00:00:00");
    if (!isNaN(parsed.getTime())) return parsed;
    console.error(`[delivery-optimizer] Невалидная дата: ${raw}, используем сегодня`);
  }
  return new Date();
}

const TARGET_DATE = getTargetDate();
const TG_THREAD_DELIVERY = 20;

/** Время начала развозки (часы, местное время Cordoba/Buenos Aires) */
const DEPARTURE_HOUR = 9;
const DEPARTURE_MINUTE = 0;

/** Тайминги (минуты) */
const MINUTES_PER_STOP = 15;
const MINUTES_BETWEEN_STOPS_SAME_ZONE = 10;
const MINUTES_BETWEEN_ZONES = 25;

/** Продукты, требующие холодовой цепи */
const COLD_CHAIN_PRODUCTS = [
  "грибы",
  "шиитаке",
  "вешенка",
  "эноки",
  "эринги",
  "шампиньоны",
  "майтаке",
  "намеко",
  "львиная грива",
  "mushroom",
  "setas",
  "hongos",
];

/** Директория с профилями клиентов */
const CLIENTS_DIR = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  "workspace",
  "memory",
  "people",
  "clients",
);

// -- Матрица смежности зон (barrios Buenos Aires) -----------------------------
// Зоны, расположенные рядом, имеют меньший вес перехода.
// Используется для сортировки порядка объезда зон.

/** @type {Record<string, string[]>} Зона -> список соседних зон */
const ZONE_ADJACENCY = {
  palermo: ["recoleta", "belgrano", "colegiales", "villa crespo", "almagro"],
  recoleta: ["palermo", "retiro", "barrio norte", "balvanera"],
  belgrano: ["palermo", "nunez", "colegiales", "saavedra"],
  "san telmo": ["la boca", "monserrat", "barracas", "constitución"],
  "la boca": ["san telmo", "barracas"],
  monserrat: ["san telmo", "microcentro", "constitución"],
  microcentro: ["monserrat", "retiro", "san nicolas"],
  retiro: ["recoleta", "microcentro", "puerto madero"],
  "puerto madero": ["retiro", "san telmo", "microcentro"],
  "villa crespo": ["palermo", "almagro", "chacarita"],
  almagro: ["villa crespo", "balvanera", "caballito", "palermo"],
  caballito: ["almagro", "flores", "parque chacabuco"],
  colegiales: ["palermo", "belgrano", "chacarita"],
  chacarita: ["colegiales", "villa crespo", "paternal"],
  nunez: ["belgrano", "saavedra"],
  flores: ["caballito", "floresta"],
};

// -- Хелперы ------------------------------------------------------------------

/** Форматирует дату как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Следующий день */
function nextDay(d) {
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  return n;
}

/**
 * Парсит дату из строки (DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD).
 * @param {string} raw
 * @returns {string|null} YYYY-MM-DD или null
 */
function parseDateStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // YYYY-MM-DD
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;

  // DD/MM/YYYY или DD.MM.YYYY или DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${mm}-${dd}`;
  }

  return null;
}

/** Безопасный parseFloat */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  return parseFloat(cleaned) || 0;
}

/**
 * Преобразует массив строк из Sheets в массив объектов.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((row) => {
    /** @type {Record<string, string>} */
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j] ?? "";
    }
    return obj;
  });
}

/**
 * Проверяет, нужна ли холодовая цепь для продукта.
 * @param {string} product
 * @returns {boolean}
 */
function needsColdChain(product) {
  const lower = product.toLowerCase();
  return COLD_CHAIN_PRODUCTS.some((kw) => lower.includes(kw));
}

/**
 * Нормализует название зоны (lowercase, trim, базовая очистка).
 * @param {string} raw
 * @returns {string}
 */
function normalizeZone(raw) {
  if (!raw) return "sin zona";
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^barrio\s+/, "");
}

// -- Загрузка профилей клиентов -----------------------------------------------

/**
 * Загружает все профили клиентов из JSON-файлов.
 * Возвращает карту: имя клиента (lowercase) -> { zone, address, name }.
 * @returns {Map<string, {zone: string, address: string, name: string}>}
 */
function loadClientProfiles() {
  /** @type {Map<string, {zone: string, address: string, name: string}>} */
  const profiles = new Map();

  if (!fs.existsSync(CLIENTS_DIR)) {
    console.error(`[delivery-optimizer] Директория клиентов не найдена: ${CLIENTS_DIR}`);
    return profiles;
  }

  const files = fs.readdirSync(CLIENTS_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CLIENTS_DIR, file), "utf-8");
      const data = JSON.parse(raw);

      const name = data.core_identity?.full_name || "";
      const address = data.business_identity?.address || data.core_identity?.current_location || "";

      // Извлекаем зону из адреса (ищем название barrio)
      const zone = extractZoneFromAddress(address);

      if (name) {
        const key = name.toLowerCase().trim();
        profiles.set(key, { zone, address, name });

        // Также добавляем алиасы
        const aliases = data.core_identity?.aliases || [];
        for (const alias of aliases) {
          if (alias) {
            profiles.set(alias.toLowerCase().trim(), { zone, address, name });
          }
        }
      }
    } catch {
      // Пропускаем битые файлы
    }
  }

  return profiles;
}

/**
 * Извлекает зону (barrio) из адреса.
 * Ищет известные barrios Buenos Aires в строке адреса.
 * @param {string} address
 * @returns {string}
 */
function extractZoneFromAddress(address) {
  if (!address) return "sin zona";
  const lower = address.toLowerCase();

  // Список barrios для поиска в адресе (от длинных к коротким, чтобы "palermo hollywood" матчился раньше "palermo")
  const knownZones = [
    "palermo hollywood",
    "palermo soho",
    "palermo viejo",
    "palermo chico",
    "palermo",
    "recoleta",
    "belgrano",
    "san telmo",
    "la boca",
    "monserrat",
    "microcentro",
    "retiro",
    "puerto madero",
    "villa crespo",
    "almagro",
    "caballito",
    "colegiales",
    "chacarita",
    "nunez",
    "flores",
    "barracas",
    "constitución",
    "san nicolas",
    "balvanera",
    "barrio norte",
    "saavedra",
    "floresta",
    "paternal",
    "parque chacabuco",
    "villa urquiza",
    "villa devoto",
    "liniers",
    "mataderos",
    "boedo",
    "parque patricios",
  ];

  for (const zone of knownZones) {
    if (lower.includes(zone)) {
      // Нормализуем вариации Palermo в одну зону
      if (zone.startsWith("palermo")) return "palermo";
      return zone;
    }
  }

  return "sin zona";
}

// -- Логика оптимизации -------------------------------------------------------

/**
 * @typedef {Object} DeliveryStop
 * @property {string} client -- Имя клиента
 * @property {string} zone -- Зона доставки
 * @property {string} address -- Адрес
 * @property {string} date -- Дата заказа (YYYY-MM-DD)
 * @property {Array<{product: string, qty: number, coldChain: boolean}>} items
 * @property {number} totalKg -- Суммарный вес (кг)
 * @property {boolean} hasColdChain -- Есть продукты, требующие холод
 */

/**
 * Фильтрует заказы на указанные даты и агрегирует по клиенту.
 * @param {Record<string, string>[]} salesRows
 * @param {string[]} targetDates -- Массив дат YYYY-MM-DD
 * @param {Map<string, {zone: string, address: string, name: string}>} clientProfiles
 * @returns {DeliveryStop[]}
 */
function buildDeliveryStops(salesRows, targetDates, clientProfiles) {
  /** @type {Map<string, DeliveryStop>} ключ = client+date */
  const stopMap = new Map();

  for (const row of salesRows) {
    const dateRaw = row["\u0414\u0430\u0442\u0430"] || row["date"] || row["Fecha"] || "";
    const orderDate = parseDateStr(dateRaw);
    if (!orderDate || !targetDates.includes(orderDate)) continue;

    const client = (
      row["\u041a\u043b\u0438\u0435\u043d\u0442"] ||
      row["client"] ||
      row["Cliente"] ||
      ""
    ).trim();
    if (!client) continue;

    const product = (
      row["\u041f\u0440\u043e\u0434\u0443\u043a\u0442"] ||
      row["product"] ||
      row["Producto"] ||
      ""
    ).trim();
    const qty = parseNum(
      row["\u041a\u043e\u043b-\u0432\u043e \u043a\u0433"] ||
        row["\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e"] ||
        row["Cantidad"] ||
        0,
    );

    const key = `${client.toLowerCase()}|${orderDate}`;
    if (!stopMap.has(key)) {
      // Ищем профиль клиента
      const profile = clientProfiles.get(client.toLowerCase().trim());
      stopMap.set(key, {
        client: profile?.name || client,
        zone: profile?.zone || "sin zona",
        address: profile?.address || "",
        date: orderDate,
        items: [],
        totalKg: 0,
        hasColdChain: false,
      });
    }

    const stop = stopMap.get(key);
    const cold = needsColdChain(product);
    stop.items.push({ product, qty, coldChain: cold });
    stop.totalKg += qty;
    if (cold) stop.hasColdChain = true;
  }

  return Array.from(stopMap.values());
}

/**
 * Определяет оптимальный порядок объезда зон.
 * Использует жадный алгоритм: начинаем с зоны с максимальным кол-вом остановок,
 * затем переходим к ближайшей соседней зоне.
 * @param {string[]} zones -- Уникальные зоны
 * @returns {string[]} -- Упорядоченный список зон
 */
function optimizeZoneOrder(zones) {
  if (zones.length <= 1) return zones;

  // Считаем частоту (для приоритизации)
  const remaining = new Set(zones);
  const ordered = [];

  // Начинаем с первой зоны (или зоны с max остановками -- обработано вызывающим кодом)
  let current = zones[0];
  ordered.push(current);
  remaining.delete(current);

  while (remaining.size > 0) {
    // Ищем соседнюю зону из оставшихся
    const neighbors = ZONE_ADJACENCY[current] || [];
    let next = null;

    for (const neighbor of neighbors) {
      if (remaining.has(neighbor)) {
        next = neighbor;
        break;
      }
    }

    // Если соседей нет, берём любую оставшуюся
    if (!next) {
      next = remaining.values().next().value;
    }

    ordered.push(next);
    remaining.delete(next);
    current = next;
  }

  return ordered;
}

/**
 * Рассчитывает временные окна для каждой остановки.
 * @param {DeliveryStop[]} stops -- Упорядоченные остановки
 * @returns {Array<DeliveryStop & {estimatedArrival: string, estimatedDeparture: string, stopNumber: number}>}
 */
function calculateTimeWindows(stops) {
  if (stops.length === 0) return [];

  let currentMinutes = DEPARTURE_HOUR * 60 + DEPARTURE_MINUTE;
  let prevZone = null;

  return stops.map((stop, idx) => {
    // Время в пути до этой остановки
    if (idx > 0) {
      if (stop.zone === prevZone) {
        currentMinutes += MINUTES_BETWEEN_STOPS_SAME_ZONE;
      } else {
        currentMinutes += MINUTES_BETWEEN_ZONES;
      }
    }

    const arrivalH = Math.floor(currentMinutes / 60);
    const arrivalM = currentMinutes % 60;
    const arrival = `${String(arrivalH).padStart(2, "0")}:${String(arrivalM).padStart(2, "0")}`;

    // Время на разгрузку
    currentMinutes += MINUTES_PER_STOP;
    const departH = Math.floor(currentMinutes / 60);
    const departM = currentMinutes % 60;
    const departure = `${String(departH).padStart(2, "0")}:${String(departM).padStart(2, "0")}`;

    prevZone = stop.zone;

    return {
      ...stop,
      estimatedArrival: arrival,
      estimatedDeparture: departure,
      stopNumber: idx + 1,
    };
  });
}

// -- Форматирование -----------------------------------------------------------

/**
 * Формирует HTML-отчёт для Telegram.
 * @param {Array<DeliveryStop & {estimatedArrival: string, estimatedDeparture: string, stopNumber: number}>} plan
 * @param {string} targetDateStr
 * @param {string} tomorrowDateStr
 * @returns {string}
 */
function formatDeliveryPlan(plan, targetDateStr, tomorrowDateStr) {
  if (plan.length === 0) {
    return `<b>Маршрут доставки -- ${targetDateStr}</b>\n\nЗаказов на доставку не найдено.`;
  }

  const lines = [];
  lines.push(`<b>Маршрут доставки</b>`);
  lines.push(`${targetDateStr} + ${tomorrowDateStr}\n`);

  // Общая статистика
  const totalKg = plan.reduce((s, p) => s + p.totalKg, 0);
  const totalStops = plan.length;
  const zones = [...new Set(plan.map((p) => p.zone))];
  const coldStops = plan.filter((p) => p.hasColdChain).length;
  const firstArrival = plan[0]?.estimatedArrival || "--:--";
  const lastDeparture = plan[plan.length - 1]?.estimatedDeparture || "--:--";

  lines.push(`<b>Сводка:</b>`);
  lines.push(`  Остановок: ${totalStops}`);
  lines.push(`  Зон: ${zones.length} (${zones.join(", ")})`);
  lines.push(`  Общий вес: ${totalKg.toFixed(1)} кг`);
  if (coldStops > 0) {
    lines.push(`  Холодовая цепь: ${coldStops} остановок`);
  }
  lines.push(`  Время: ${firstArrival} -- ${lastDeparture}`);

  // Детали по остановкам, сгруппированные по зонам
  let currentZone = null;
  for (const stop of plan) {
    if (stop.zone !== currentZone) {
      currentZone = stop.zone;
      const zoneName = currentZone.charAt(0).toUpperCase() + currentZone.slice(1);
      lines.push(`\n<b>[${zoneName}]</b>`);
    }

    const coldFlag = stop.hasColdChain ? " [FRIO]" : "";
    lines.push(`  ${stop.stopNumber}. <b>${escapeHtml(stop.client)}</b>${coldFlag}`);
    lines.push(
      `     ${stop.estimatedArrival}-${stop.estimatedDeparture} | ${stop.totalKg.toFixed(1)} кг`,
    );

    if (stop.address) {
      lines.push(`     ${escapeHtml(stop.address)}`);
    }

    // Список товаров (компактно)
    const itemStrs = stop.items.map((it) => {
      const cold = it.coldChain ? "*" : "";
      return `${it.product}${cold} ${it.qty}кг`;
    });
    lines.push(`     ${itemStrs.join(", ")}`);
  }

  // Предупреждения
  const noAddress = plan.filter((p) => !p.address);
  const noZone = plan.filter((p) => p.zone === "sin zona");
  if (noAddress.length > 0 || noZone.length > 0) {
    lines.push("\n<b>Внимание:</b>");
    if (noZone.length > 0) {
      lines.push(`  Без зоны: ${noZone.map((p) => p.client).join(", ")}`);
    }
    if (noAddress.length > 0) {
      lines.push(`  Без адреса: ${noAddress.map((p) => p.client).join(", ")}`);
    }
  }

  return lines.join("\n");
}

/** Экранирует HTML-спецсимволы */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  const todayStr = fmtDate(TARGET_DATE);
  const tomorrowStr = fmtDate(nextDay(TARGET_DATE));

  console.error(
    `[${new Date().toISOString()}] delivery-optimizer запуск ` +
      `(${todayStr} + ${tomorrowStr})${DRY_RUN ? " [DRY RUN]" : ""}`,
  );

  // 1. Загрузка данных из Google Sheets
  /** @type {{ readSheet: Function, PEPINO_SHEETS_ID: string }} */
  let readSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[delivery-optimizer] Не удалось импортировать sheets.js: ${err.message}`);
    process.exit(1);
  }

  let salesRaw;
  try {
    salesRaw = await readSheet(
      PEPINO_SHEETS_ID,
      "\u{1F6D2} \u041F\u0440\u043E\u0434\u0430\u0436\u0438",
    );
  } catch (err) {
    const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
    console.error(`[delivery-optimizer] ${msg}`);
    if (!DRY_RUN) {
      await send(`!!! Delivery Optimizer FAIL\n${msg}`, {
        silent: false,
        threadId: TG_THREAD_DELIVERY,
        parseMode: "HTML",
      });
    }
    process.exit(1);
  }

  const salesRows = rowsToObjects(salesRaw);
  console.error(`[delivery-optimizer] Загружено продаж: ${salesRows.length}`);

  // 2. Загрузка профилей клиентов
  const clientProfiles = loadClientProfiles();
  console.error(`[delivery-optimizer] Загружено профилей клиентов: ${clientProfiles.size}`);

  // 3. Построение остановок доставки (сегодня + завтра)
  const targetDates = [todayStr, tomorrowStr];
  const stops = buildDeliveryStops(salesRows, targetDates, clientProfiles);
  console.error(`[delivery-optimizer] Найдено остановок: ${stops.length}`);

  if (stops.length === 0) {
    const emptyMsg = formatDeliveryPlan([], todayStr, tomorrowStr);
    console.log(emptyMsg.replace(/<[^>]+>/g, ""));

    if (!DRY_RUN) {
      await send(emptyMsg, {
        silent: true,
        threadId: TG_THREAD_DELIVERY,
        parseMode: "HTML",
      });
    }

    await trace({
      name: "delivery-optimizer",
      input: { target_dates: targetDates, sales_count: salesRows.length },
      output: { stops: 0, message: "Нет заказов на доставку" },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets", script: "delivery-optimizer" },
    }).catch(() => {});

    console.error(`[delivery-optimizer] Завершено за ${Date.now() - startMs}мс. Нет заказов.`);
    return;
  }

  // 4. Группировка по зонам и оптимизация порядка
  /** @type {Map<string, DeliveryStop[]>} */
  const byZone = new Map();
  for (const stop of stops) {
    const zone = stop.zone;
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(stop);
  }

  // Сортируем зоны: сначала те, у которых больше остановок
  const zonesByCount = [...byZone.keys()].sort(
    (a, b) => (byZone.get(b)?.length || 0) - (byZone.get(a)?.length || 0),
  );

  // Оптимизируем порядок объезда зон по смежности
  const orderedZones = optimizeZoneOrder(zonesByCount);

  // Внутри каждой зоны сортируем: холодовая цепь первой (быстрее доставить)
  /** @type {DeliveryStop[]} */
  const orderedStops = [];
  for (const zone of orderedZones) {
    const zoneStops = byZone.get(zone) || [];
    zoneStops.sort((a, b) => {
      // Холодовая цепь — приоритет
      if (a.hasColdChain !== b.hasColdChain) return a.hasColdChain ? -1 : 1;
      // Больший вес — приоритет (эффективнее разгружать тяжёлое раньше)
      return b.totalKg - a.totalKg;
    });
    orderedStops.push(...zoneStops);
  }

  // 5. Расчёт временных окон
  const plan = calculateTimeWindows(orderedStops);

  // 6. Формирование отчёта
  const report = formatDeliveryPlan(plan, todayStr, tomorrowStr);

  // Вывод в консоль (без HTML тегов)
  console.log(report.replace(/<[^>]+>/g, ""));

  // JSON-результат в stdout
  const jsonResult = {
    target_dates: targetDates,
    total_stops: plan.length,
    total_kg: plan.reduce((s, p) => s + p.totalKg, 0),
    zones: [...new Set(plan.map((p) => p.zone))],
    cold_chain_stops: plan.filter((p) => p.hasColdChain).length,
    estimated_start: plan[0]?.estimatedArrival,
    estimated_end: plan[plan.length - 1]?.estimatedDeparture,
    stops: plan.map((p) => ({
      number: p.stopNumber,
      client: p.client,
      zone: p.zone,
      address: p.address,
      arrival: p.estimatedArrival,
      departure: p.estimatedDeparture,
      total_kg: p.totalKg,
      cold_chain: p.hasColdChain,
      items: p.items,
    })),
  };
  console.log("\n" + JSON.stringify(jsonResult, null, 2));

  // 7. Отправка в Telegram
  if (!DRY_RUN) {
    try {
      await send(report, {
        silent: false,
        threadId: TG_THREAD_DELIVERY,
        parseMode: "HTML",
      });
      console.error("[delivery-optimizer] Отправлено в Telegram");
    } catch (err) {
      console.error(`[delivery-optimizer] Ошибка отправки в Telegram: ${err.message}`);
    }
  } else {
    console.error("[delivery-optimizer] DRY RUN: пропуск отправки Telegram");
  }

  // 8. Langfuse trace
  await trace({
    name: "delivery-optimizer",
    input: {
      target_dates: targetDates,
      sales_count: salesRows.length,
      client_profiles: clientProfiles.size,
    },
    output: {
      total_stops: plan.length,
      total_kg: jsonResult.total_kg,
      zones: jsonResult.zones,
      cold_chain_stops: jsonResult.cold_chain_stops,
      estimated_window: `${jsonResult.estimated_start}-${jsonResult.estimated_end}`,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", script: "delivery-optimizer" },
  }).catch(() => {});

  console.error(
    `[delivery-optimizer] Завершено за ${Date.now() - startMs}мс. ` +
      `Остановок: ${plan.length}, зон: ${jsonResult.zones.length}, ` +
      `вес: ${jsonResult.total_kg.toFixed(1)} кг`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[delivery-optimizer] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
