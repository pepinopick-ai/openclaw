#!/usr/bin/env node
/**
 * Pepino Pick -- Мониторинг поставщиков и сырьевых запасов
 *
 * Анализирует:
 *   1. Запас сырья (substrato, bolsas и т.д.) из "Склад" — расчёт days-of-raw-materials
 *   2. Расход сырья из "Производство" — среднедневное потребление за 14 дней
 *   3. Динамику цен из "Расходы" — детектирует рост >10% для одного и того же товара
 *   4. Генерирует рекомендации по перезаказу с оптимальными количествами
 *
 * Алерты:
 *   - <3 дня запаса сырья → CRITICAL (громкое уведомление)
 *   - <7 дней запаса      → WARNING  (тихое)
 *   - Рост цены >10%      → PRICE ALERT
 *   - Еженедельная сводка → thread 20
 *
 * Usage:
 *   node supplier-monitor.cjs              -- полный запуск с TG-алертами
 *   node supplier-monitor.cjs --dry-run    -- без отправки в Telegram
 *
 * Cron: 0 9 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/supplier-monitor.cjs >> /home/roman/logs/supplier-monitor.log 2>&1
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendAlert, sendStatus, send } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_SUPPLIER = 20;

/** Пороги дней запаса сырья */
const CRITICAL_DAYS = 3;
const WARNING_DAYS = 7;

/** Период для расчёта среднего потребления сырья (дней) */
const CONSUMPTION_WINDOW_DAYS = 14;

/** Порог роста цены, при котором генерируется алерт (доля, 0.10 = 10%) */
const PRICE_INCREASE_THRESHOLD = 0.1;

/**
 * Категории сырья (raw materials) — ключевые слова для фильтрации позиций склада.
 * Позиции, содержащие эти подстроки (в нижнем регистре), считаются сырьём.
 */
const RAW_MATERIAL_KEYWORDS = [
  "substrat",
  "субстрат",
  "bolsa",
  "болс",
  "пакет",
  "мешок",
  "semilla",
  "семен",
  "семя",
  "micelio",
  "мицелий",
  "fertiliz",
  "удобрен",
  "envase",
  "контейнер",
  "упаковк",
  "etiqueta",
  "этикетк",
  "cloro",
  "хлор",
  "дезинфект",
  "agua",
  "вода",
  "grano",
  "зерно",
];

/** Оптимальный запас для перезаказа (дней потребления) */
const REORDER_TARGET_DAYS = 14;

// -- Хелперы ------------------------------------------------------------------

/** Безопасное извлечение числа из строки (поддержка запятых, пробелов, валюты) */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Парсит дату из строки. Поддерживает форматы:
 *   - DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
 *   - YYYY-MM-DD
 * @param {string} raw
 * @returns {Date|null}
 */
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Дата N дней назад (начало дня, UTC) */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Преобразует массив строк из Sheets в массив объектов.
 * Первая строка -- заголовки.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i]?.[j] ?? "";
    }
    result.push(obj);
  }
  return result;
}

/** Проверяет, является ли позиция сырьём по ключевым словам */
function isRawMaterial(productName) {
  const lower = productName.toLowerCase();
  return RAW_MATERIAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -- Анализ запасов сырья -----------------------------------------------------

/**
 * Извлекает текущие остатки сырья со склада.
 * @param {Record<string, string>[]} inventoryRows
 * @returns {Map<string, {stock: number, unit: string}>}
 */
function parseRawMaterialStock(inventoryRows) {
  /** @type {Map<string, {stock: number, unit: string}>} */
  const stock = new Map();

  for (const row of inventoryRows) {
    const product = (
      row["Продукт"] ||
      row["Товар"] ||
      row["Название"] ||
      row["Insumo"] ||
      ""
    ).trim();
    if (!product) continue;

    // Фильтруем: только сырьё
    if (!isRawMaterial(product)) continue;

    const qty = parseNum(
      row["Остаток кг"] ||
        row["Кол-во кг"] ||
        row["Количество"] ||
        row["Остаток"] ||
        row["Stock"] ||
        0,
    );
    const unit = (row["Ед. изм."] || row["Unidad"] || "кг").trim();
    const key = product.toLowerCase();

    const existing = stock.get(key);
    if (existing) {
      existing.stock += qty;
    } else {
      stock.set(key, { stock: qty, unit });
    }
  }

  return stock;
}

/**
 * Рассчитывает среднедневной расход сырья из производственных данных за период.
 * Ищет колонки расхода материалов в листе "Производство".
 * @param {Record<string, string>[]} productionRows
 * @param {number} windowDays
 * @returns {Map<string, number>} сырьё -> кг/день (или ед./день)
 */
function calcRawMaterialConsumption(productionRows, windowDays) {
  const cutoff = daysAgo(windowDays);
  /** @type {Map<string, number>} */
  const totalUsed = new Map();

  for (const row of productionRows) {
    const prodDate = parseDate(row["Дата"] || row["Дата сбора"] || row["Fecha"]);
    if (!prodDate || prodDate < cutoff) continue;

    // Перебираем все колонки строки — если колонка содержит ключевое слово сырья,
    // значение в ней — расход этого материала за этот производственный цикл.
    for (const [header, value] of Object.entries(row)) {
      if (!header || header === "Дата" || header === "Дата сбора" || header === "Fecha") continue;

      const headerLower = header.toLowerCase();
      const matchedKeyword = RAW_MATERIAL_KEYWORDS.find((kw) => headerLower.includes(kw));
      if (!matchedKeyword) continue;

      const qty = parseNum(value);
      if (qty <= 0) continue;

      // Используем заголовок колонки как название сырья
      const key = header.toLowerCase().trim();
      totalUsed.set(key, (totalUsed.get(key) || 0) + qty);
    }
  }

  // Также считаем общий расход сырья через связь: произведённый продукт нуждается в сырье.
  // Оценка: если нет прямых колонок расхода, используем объём производства как прокси.
  // Каждый кг продукции потребляет примерно 2-3 кг субстрата (для грибов).
  if (totalUsed.size === 0) {
    for (const row of productionRows) {
      const prodDate = parseDate(row["Дата"] || row["Дата сбора"] || row["Fecha"]);
      if (!prodDate || prodDate < cutoff) continue;

      const product = (row["Продукт"] || row["Культура"] || row["Товар"] || "")
        .trim()
        .toLowerCase();
      const qty = parseNum(row["Кол-во кг"] || row["Урожай кг"] || row["Количество"] || 0);
      if (!product || qty <= 0) continue;

      // Прокси: субстрат ~2.5x от урожая для грибов
      if (
        product.includes("вешенк") ||
        product.includes("гриб") ||
        product.includes("girgola") ||
        product.includes("hongo")
      ) {
        const key = "субстрат (оценка)";
        totalUsed.set(key, (totalUsed.get(key) || 0) + qty * 2.5);
      }
    }
  }

  /** @type {Map<string, number>} */
  const avgPerDay = new Map();
  for (const [material, total] of totalUsed) {
    avgPerDay.set(material, total / windowDays);
  }

  return avgPerDay;
}

// -- Анализ цен поставщиков ---------------------------------------------------

/**
 * @typedef {Object} PriceChange
 * @property {string} item       -- название позиции
 * @property {string} supplier   -- поставщик
 * @property {number} oldPrice   -- предыдущая цена
 * @property {number} newPrice   -- текущая цена
 * @property {number} changePct  -- изменение в %
 * @property {string} oldDate    -- дата старой покупки
 * @property {string} newDate    -- дата новой покупки
 */

/**
 * Анализирует расходы и находит случаи роста цен >10% для одного и того же товара.
 * @param {Record<string, string>[]} expenseRows
 * @returns {{ priceChanges: PriceChange[], supplierCosts: Map<string, {total: number, count: number}> }}
 */
function analyzeSupplierPrices(expenseRows) {
  // Группируем покупки одного товара по дате для выявления изменений цен
  /** @type {Map<string, Array<{date: Date, dateStr: string, price: number, qty: number, supplier: string}>>} */
  const purchaseHistory = new Map();

  /** @type {Map<string, {total: number, count: number}>} */
  const supplierCosts = new Map();

  for (const row of expenseRows) {
    const item = (row["Описание"] || row["Concepto"] || row["Товар"] || row["Item"] || "").trim();
    const supplier = (row["Поставщик"] || row["Proveedor"] || row["Контрагент"] || "").trim();
    const dateRaw = row["Дата"] || row["Fecha"] || "";
    const amount = parseNum(row["Сумма ARS"] || row["Сумма"] || row["Monto"] || row["Total"] || 0);
    const qty = parseNum(row["Кол-во"] || row["Количество"] || row["Qty"] || 0);

    if (!item || amount <= 0) continue;

    const date = parseDate(dateRaw);
    if (!date) continue;

    // Цена за единицу (если есть количество)
    const unitPrice = qty > 0 ? amount / qty : amount;

    const key = item.toLowerCase();
    if (!purchaseHistory.has(key)) {
      purchaseHistory.set(key, []);
    }
    purchaseHistory.get(key).push({
      date,
      dateStr: dateRaw,
      price: unitPrice,
      qty,
      supplier,
    });

    // Статистика по поставщикам
    const suppKey = supplier || "(без поставщика)";
    const existing = supplierCosts.get(suppKey);
    if (existing) {
      existing.total += amount;
      existing.count++;
    } else {
      supplierCosts.set(suppKey, { total: amount, count: 1 });
    }
  }

  // Ищем рост цен: сравниваем последнюю покупку с предпоследней
  /** @type {PriceChange[]} */
  const priceChanges = [];

  for (const [item, purchases] of purchaseHistory) {
    if (purchases.length < 2) continue;

    // Сортируем по дате
    purchases.sort((a, b) => a.date.getTime() - b.date.getTime());

    const prev = purchases[purchases.length - 2];
    const last = purchases[purchases.length - 1];

    if (prev.price <= 0) continue;

    const changePct = (last.price - prev.price) / prev.price;

    if (changePct > PRICE_INCREASE_THRESHOLD) {
      priceChanges.push({
        item: capitalize(item),
        supplier: last.supplier || prev.supplier || "(n/a)",
        oldPrice: Math.round(prev.price),
        newPrice: Math.round(last.price),
        changePct: Math.round(changePct * 100),
        oldDate: prev.dateStr,
        newDate: last.dateStr,
      });
    }
  }

  // Сортируем по % роста (самые сильные первыми)
  priceChanges.sort((a, b) => b.changePct - a.changePct);

  return { priceChanges, supplierCosts };
}

// -- Рекомендации по перезаказу -----------------------------------------------

/**
 * @typedef {Object} ReorderRecommendation
 * @property {string} material       -- название материала
 * @property {number} currentStock   -- текущий остаток
 * @property {string} unit           -- единица измерения
 * @property {number} dailyUsage     -- среднедневной расход
 * @property {number} daysOfStock    -- дней запаса осталось
 * @property {number} reorderQty     -- рекомендуемое количество к заказу
 * @property {string} severity       -- critical / warning / ok
 * @property {string} urgency        -- описание срочности
 */

/**
 * Генерирует рекомендации по перезаказу.
 * @param {Map<string, {stock: number, unit: string}>} rawStock
 * @param {Map<string, number>} dailyUsage
 * @returns {ReorderRecommendation[]}
 */
function generateReorderRecommendations(rawStock, dailyUsage) {
  /** @type {ReorderRecommendation[]} */
  const recommendations = [];

  // Обрабатываем все известные материалы (объединение склада и потребления)
  const allMaterials = new Set([...rawStock.keys(), ...dailyUsage.keys()]);

  for (const material of allMaterials) {
    const stockInfo = rawStock.get(material) || { stock: 0, unit: "кг" };
    const usage = dailyUsage.get(material) || 0;

    let daysOfStock = null;
    if (usage > 0) {
      daysOfStock = stockInfo.stock / usage;
    }

    // Определяем severity
    let severity = "ok";
    let urgency = "";
    if (daysOfStock !== null) {
      if (daysOfStock < CRITICAL_DAYS) {
        severity = "critical";
        urgency = `СРОЧНО: осталось на ${daysOfStock.toFixed(1)} дн.`;
      } else if (daysOfStock < WARNING_DAYS) {
        severity = "warning";
        urgency = `Внимание: осталось на ${daysOfStock.toFixed(1)} дн.`;
      }
    } else if (stockInfo.stock <= 0 && usage <= 0) {
      // Нет данных ни по остатку, ни по потреблению — пропускаем
      continue;
    } else if (stockInfo.stock <= 0) {
      severity = "critical";
      urgency = "НУЛЕВОЙ остаток при активном потреблении";
    }

    // Рекомендуемое количество: запас на REORDER_TARGET_DAYS минус текущий остаток
    let reorderQty = 0;
    if (usage > 0) {
      const targetStock = usage * REORDER_TARGET_DAYS;
      reorderQty = Math.max(0, targetStock - stockInfo.stock);
      // Округляем до разумных величин (кратно 5 для кг, кратно 10 для штук)
      reorderQty = Math.ceil(reorderQty / 5) * 5;
    }

    recommendations.push({
      material: capitalize(material),
      currentStock: Math.round(stockInfo.stock * 10) / 10,
      unit: stockInfo.unit,
      dailyUsage: Math.round(usage * 10) / 10,
      daysOfStock: daysOfStock !== null ? Math.round(daysOfStock * 10) / 10 : null,
      reorderQty,
      severity,
      urgency,
    });
  }

  // Сортируем: критичные первыми, затем по дням запаса
  recommendations.sort((a, b) => {
    const order = { critical: 0, warning: 1, ok: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    const da = a.daysOfStock ?? 9999;
    const db = b.daysOfStock ?? 9999;
    return da - db;
  });

  return recommendations;
}

// -- Форматирование отчёта для Telegram ---------------------------------------

/**
 * Формирует HTML-сообщение с критическими алертами (для громкого уведомления).
 * @param {ReorderRecommendation[]} criticals
 * @returns {string}
 */
function formatCriticalAlert(criticals) {
  const lines = [];
  const now = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });

  lines.push(`<b>!!! СЫРЬЕ: КРИТИЧЕСКИЙ ДЕФИЦИТ</b>`);
  lines.push(`${now}\n`);

  for (const item of criticals) {
    const daysStr = item.daysOfStock !== null ? `${item.daysOfStock} дн.` : "0 дн.";
    lines.push(
      `!!! <b>${item.material}</b>: ${item.currentStock} ${item.unit} | ` +
        `${daysStr} запаса | расход ${item.dailyUsage} ${item.unit}/дн.`,
    );
    if (item.reorderQty > 0) {
      lines.push(`    -> Заказать: ${item.reorderQty} ${item.unit}`);
    }
  }

  lines.push(`\n<b>Действие:</b> Немедленно связаться с поставщиком и оформить заказ.`);

  return lines.join("\n");
}

/**
 * Формирует HTML-сообщение с полной еженедельной сводкой.
 * @param {ReorderRecommendation[]} recommendations
 * @param {PriceChange[]} priceChanges
 * @param {Map<string, {total: number, count: number}>} supplierCosts
 * @returns {string}
 */
function formatWeeklySummary(recommendations, priceChanges, supplierCosts) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);

  lines.push(`<b>Мониторинг поставщиков -- ${d}</b>\n`);

  // Секция 1: Запасы сырья
  const criticals = recommendations.filter((r) => r.severity === "critical");
  const warnings = recommendations.filter((r) => r.severity === "warning");
  const ok = recommendations.filter((r) => r.severity === "ok");

  lines.push(`<b>Запасы сырья:</b>`);
  if (criticals.length > 0) {
    lines.push(`  !!! Критично: ${criticals.length}`);
    for (const item of criticals) {
      const daysStr = item.daysOfStock !== null ? `${item.daysOfStock} дн.` : "0 дн.";
      lines.push(`    !!! ${item.material}: ${item.currentStock} ${item.unit} (${daysStr})`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`  ! Внимание: ${warnings.length}`);
    for (const item of warnings) {
      lines.push(
        `    ! ${item.material}: ${item.currentStock} ${item.unit} (${item.daysOfStock} дн.)`,
      );
    }
  }
  lines.push(`  OK: ${ok.length}`);
  lines.push("");

  // Секция 2: Рост цен
  if (priceChanges.length > 0) {
    lines.push(`<b>Рост цен поставщиков:</b>`);
    for (const pc of priceChanges.slice(0, 5)) {
      lines.push(
        `  ! <b>${pc.item}</b> (${pc.supplier}): ` +
          `${pc.oldPrice} -> ${pc.newPrice} ARS (+${pc.changePct}%)`,
      );
    }
    lines.push("");
  }

  // Секция 3: Рекомендации по перезаказу
  const toReorder = recommendations.filter((r) => r.reorderQty > 0);
  if (toReorder.length > 0) {
    lines.push(`<b>Рекомендации к заказу:</b>`);
    for (const item of toReorder) {
      const urgencyTag = item.severity === "critical" ? " [СРОЧНО]" : "";
      lines.push(`  ${item.material}: ${item.reorderQty} ${item.unit}${urgencyTag}`);
    }
    lines.push("");
  }

  // Секция 4: Топ поставщиков по затратам
  if (supplierCosts.size > 0) {
    const sorted = [...supplierCosts.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);

    lines.push(`<b>Топ-5 поставщиков (затраты):</b>`);
    for (const [name, data] of sorted) {
      lines.push(
        `  ${name}: ${Math.round(data.total).toLocaleString("ru-RU")} ARS (${data.count} покупок)`,
      );
    }
    lines.push("");
  }

  // Итого
  const totalRecommendations = criticals.length + warnings.length;
  if (totalRecommendations === 0 && priceChanges.length === 0) {
    lines.push("Все позиции в норме. Ценовых аномалий не обнаружено.");
  }

  return lines.join("\n");
}

// -- Главная функция ----------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Запуск supplier-monitor...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Динамический импорт ESM-модуля sheets.js из CJS
  /** @type {{ readSheet: Function, PEPINO_SHEETS_ID: string }} */
  let readSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[supplier-monitor] Не удалось импортировать sheets.js: ${err.message}`);
    process.exit(1);
  }

  // Параллельное чтение трёх листов
  let inventoryRaw, productionRaw, expensesRaw;
  try {
    [inventoryRaw, productionRaw, expensesRaw] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} Склад"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F33F} Производство"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F4B0} Расходы"),
    ]);
  } catch (err) {
    const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
    console.error(`[supplier-monitor] ${msg}`);
    if (!DRY_RUN) {
      await sendAlert(`!!! Supplier Monitor FAIL\n${msg}`, TG_THREAD_SUPPLIER);
    }
    process.exit(1);
  }

  // Парсинг строк в объекты
  const inventoryRows = rowsToObjects(inventoryRaw);
  const productionRows = rowsToObjects(productionRaw);
  const expenseRows = rowsToObjects(expensesRaw);

  console.error(
    `[supplier-monitor] Загружено: склад=${inventoryRows.length}, ` +
      `производство=${productionRows.length}, расходы=${expenseRows.length}`,
  );

  // 1. Анализ запасов сырья
  const rawStock = parseRawMaterialStock(inventoryRows);
  const dailyUsage = calcRawMaterialConsumption(productionRows, CONSUMPTION_WINDOW_DAYS);

  console.error(
    `[supplier-monitor] Найдено сырья на складе: ${rawStock.size}, ` +
      `типов расхода: ${dailyUsage.size}`,
  );

  // 2. Рекомендации по перезаказу
  const recommendations = generateReorderRecommendations(rawStock, dailyUsage);

  // 3. Анализ цен поставщиков
  const { priceChanges, supplierCosts } = analyzeSupplierPrices(expenseRows);

  // Подсчёт severity
  const counts = { critical: 0, warning: 0, ok: 0 };
  for (const rec of recommendations) {
    counts[rec.severity]++;
  }

  // JSON-отчёт в stdout
  const result = {
    timestamp,
    dry_run: DRY_RUN,
    summary: {
      raw_materials_tracked: recommendations.length,
      critical: counts.critical,
      warning: counts.warning,
      ok: counts.ok,
      price_increases_detected: priceChanges.length,
      suppliers_tracked: supplierCosts.size,
    },
    recommendations: recommendations.map((r) => ({
      material: r.material,
      current_stock: r.currentStock,
      unit: r.unit,
      daily_usage: r.dailyUsage,
      days_of_stock: r.daysOfStock,
      reorder_qty: r.reorderQty,
      severity: r.severity,
    })),
    price_changes: priceChanges,
    top_suppliers: [...supplierCosts.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([name, data]) => ({
        supplier: name,
        total_ars: Math.round(data.total),
        purchases: data.count,
      })),
    data_sources: {
      inventory_rows: inventoryRows.length,
      production_rows: productionRows.length,
      expense_rows: expenseRows.length,
      consumption_window_days: CONSUMPTION_WINDOW_DAYS,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  // Telegram: критические алерты (громко, немедленно)
  const criticals = recommendations.filter((r) => r.severity === "critical");
  if (criticals.length > 0) {
    const alertMsg = formatCriticalAlert(criticals);
    if (!DRY_RUN) {
      try {
        if (sendThrottled) {
          await sendThrottled(alertMsg, {
            thread: TG_THREAD_SUPPLIER,
            silent: false,
            priority: "critical",
            parseMode: "HTML",
          });
        } else {
          await send(alertMsg, {
            silent: false,
            threadId: TG_THREAD_SUPPLIER,
            parseMode: "HTML",
          });
        }
        console.error("[supplier-monitor] Критический алерт отправлен в Telegram");
      } catch (err) {
        console.error(`[supplier-monitor] Ошибка отправки критического алерта: ${err.message}`);
      }
    } else {
      console.error("[supplier-monitor] DRY RUN: пропуск критического алерта");
      console.error(alertMsg);
    }
  }

  // Telegram: еженедельная сводка (всегда отправляем в thread 20)
  const summaryMsg = formatWeeklySummary(recommendations, priceChanges, supplierCosts);
  const hasSomethingToReport = recommendations.length > 0 || priceChanges.length > 0;
  if (!DRY_RUN && hasSomethingToReport) {
    try {
      const summSilent = criticals.length === 0;
      if (sendThrottled) {
        await sendThrottled(summaryMsg, {
          thread: TG_THREAD_SUPPLIER,
          silent: summSilent,
          priority: "normal",
          parseMode: "HTML",
        });
      } else {
        await send(summaryMsg, {
          silent: summSilent,
          threadId: TG_THREAD_SUPPLIER,
          parseMode: "HTML",
        });
      }
      console.error("[supplier-monitor] Сводка отправлена в Telegram");
    } catch (err) {
      console.error(`[supplier-monitor] Ошибка отправки сводки: ${err.message}`);
    }
  } else if (DRY_RUN) {
    console.error("[supplier-monitor] DRY RUN: пропуск отправки сводки");
    console.error(summaryMsg);
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "supplier-monitor",
    input: {
      sheets: ["Склад", "Производство", "Расходы"],
      consumption_window: CONSUMPTION_WINDOW_DAYS,
      dry_run: DRY_RUN,
    },
    output: {
      raw_materials: recommendations.length,
      critical: counts.critical,
      warning: counts.warning,
      ok: counts.ok,
      price_increases: priceChanges.length,
      suppliers: supplierCosts.size,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "supplier-monitor",
    },
  });

  console.error(
    `[supplier-monitor] Завершено за ${durationMs}мс. ` +
      `Сырьё: ${recommendations.length}, критично: ${counts.critical}, ` +
      `внимание: ${counts.warning}, рост цен: ${priceChanges.length}`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[supplier-monitor] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
