/**
 * Утренний бриф Pepino Pick
 * Собирает данные из sheets-api (localhost:4000), погоду Кордовы,
 * форматирует и отправляет в Telegram топик #111 (Бриф).
 *
 * Cron: 0 7 * * * cd /home/roman/openclaw/skills/pepino-google-sheets && /usr/bin/node morning-brief.js >> /tmp/morning-brief.log 2>&1
 */

import http from "http";
import https from "https";
import { apiHeaders } from "./api-auth.js";
import { trace } from "./langfuse-trace.js";
import { readSheet, PEPINO_SHEETS_ID } from "./sheets.js";

// ── Конфигурация ─────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:4000";
const WEATHER_URL = "https://wttr.in/Cordoba,Argentina?format=j1";

const TG_TOKEN = "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = "-1003757515497";
const TG_THREAD_ID = 111;

const TZ = "America/Argentina/Cordoba";

// ── HTTP-хелперы (без внешних зависимостей) ──────────────────────────────────

/** GET-запрос, возвращает распарсенный JSON */
function fetchJson(url, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const isLocal = url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
    const req = client.get(
      url,
      { timeout: timeoutMs, ...(isLocal ? { headers: apiHeaders() } : {}) },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} от ${url}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (err) {
            reject(new Error(`JSON parse error для ${url}: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout для ${url}`));
    });
  });
}

/** POST в Telegram Bot API */
function telegramSend(text) {
  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: TG_THREAD_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            return reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
          }
          resolve(JSON.parse(body));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Telegram API timeout"));
    });
    req.write(payload);
    req.end();
  });
}

// ── Сбор данных ──────────────────────────────────────────────────────────────

/** Безопасный fetch: при ошибке возвращает fallback */
async function safeFetch(url, fallback = null) {
  try {
    return await fetchJson(url);
  } catch (err) {
    console.error(`[WARN] ${url}: ${err.message}`);
    return fallback;
  }
}

async function gatherData() {
  // Пытаемся загрузить кеш farm-state (TTL=15 мин, обновляется по cron)
  /** @type {object|null} */
  let farmState = null;
  try {
    const { getState } = await import("./farm-state.cjs");
    farmState = await getState();
    console.log("[farm-state] Кеш загружен, refreshed_at:", farmState.refreshed_at);
  } catch (err) {
    console.error(`[WARN] farm-state недоступен, fallback на API: ${err.message}`);
  }

  // Если кеш есть — берём данные из него, иначе fallback на API
  const [production, sales, gaps, alerts, inventory, weather, alertsSummary] = await Promise.all([
    farmState?.production ?? safeFetch(`${API_BASE}/production`, []),
    farmState?.sales ?? safeFetch(`${API_BASE}/sales`, []),
    safeFetch(`${API_BASE}/gaps`, []), // gaps нет в farm-state, всегда через API
    farmState?.alerts ?? safeFetch(`${API_BASE}/alerts`, []),
    farmState?.inventory ?? safeFetch(`${API_BASE}/inventory`, []),
    safeFetch(WEATHER_URL, null),
    fetchAlertsSummary(farmState),
  ]);

  return {
    production,
    sales,
    gaps,
    alerts,
    inventory,
    weather,
    alertsSummary,
    _dataSource: farmState ? "farm-state-cache" : "sheets-api",
  };
}

// ── Парсинг данных ───────────────────────────────────────────────────────────

/** Вчерашняя дата в формате YYYY-MM-DD (аргентинский TZ) */
function yesterdayStr() {
  const now = new Date();
  const yesterday = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  yesterday.setDate(yesterday.getDate() - 1);
  const y = yesterday.getFullYear();
  const m = String(yesterday.getMonth() + 1).padStart(2, "0");
  const d = String(yesterday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Сегодняшняя дата DD.MM.YYYY для заголовка */
function todayFormatted() {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const d = String(local.getDate()).padStart(2, "0");
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const y = local.getFullYear();
  return `${d}.${m}.${y}`;
}

/** Суммирует числовое поле из массива объектов, фильтруя по дате */
function sumByDate(rows, dateField, valueField, targetDate) {
  if (!Array.isArray(rows)) return 0;
  return rows
    .filter((r) => {
      const d = String(r[dateField] || r.date || r.fecha || "").slice(0, 10);
      return d === targetDate;
    })
    .reduce((sum, r) => {
      const val = parseFloat(r[valueField] || r.total || r.kg || 0);
      return sum + (isNaN(val) ? 0 : val);
    }, 0);
}

/** Извлекает общий вес урожая за вчера */
function parseProduction(data, yesterday) {
  if (!Array.isArray(data) || data.length === 0) return "нет данных";
  const total = sumByDate(data, "date", "kg", yesterday);
  if (total > 0) return `${total.toFixed(1)} кг огурцов`;
  // Пробуем суммировать все записи с вчерашней датой по любому полю веса
  const altTotal = data
    .filter((r) => String(r.date || r.fecha || "").slice(0, 10) === yesterday)
    .reduce((s, r) => s + (parseFloat(r.kg || r.weight || r.cantidad || 0) || 0), 0);
  return altTotal > 0 ? `${altTotal.toFixed(1)} кг огурцов` : "нет данных";
}

/** Парсит вчерашние продажи */
function parseSales(data, yesterday) {
  if (!Array.isArray(data) || data.length === 0) return "нет данных";
  const total = data
    .filter((r) => String(r.date || r.fecha || "").slice(0, 10) === yesterday)
    .reduce((s, r) => s + (parseFloat(r.total || r.amount || r.monto || 0) || 0), 0);
  if (total <= 0) return "нет данных";
  return `${total.toLocaleString("es-AR")} ARS`;
}

/** Парсит остатки склада */
function parseInventory(data) {
  if (!Array.isArray(data) || data.length === 0) return "нет данных";
  // Если массив объектов — суммируем kg/cantidad
  const totalKg = data.reduce(
    (s, r) => s + (parseFloat(r.kg || r.stock || r.cantidad || 0) || 0),
    0,
  );
  return totalKg > 0 ? `${totalKg.toFixed(1)} кг` : "нет данных";
}

/** Парсит открытые алерты */
function parseAlerts(data) {
  if (!Array.isArray(data) || data.length === 0) return { count: 0, lines: [] };
  const open = data.filter(
    (a) =>
      (a.status || a.estado || "").toLowerCase() === "открыт" ||
      (a.status || a.estado || "").toLowerCase() === "open",
  );
  const lines = open
    .slice(0, 3)
    .map((a) => `  \u2022 ${a.description || a.descripcion || a.message || a.tipo || "—"}`);
  return { count: open.length, lines };
}

/** Парсит пропуски данных */
function parseGaps(data) {
  if (!Array.isArray(data) || data.length === 0) return [];
  return data
    .slice(0, 3)
    .map((g) => `  \u2022 ${g.field || g.sheet || g.description || g.mensaje || "—"}`);
}

/** Парсит текущую погоду из wttr.in JSON */
function parseWeather(data) {
  if (!data || !data.current_condition || !data.current_condition[0]) {
    return { current: "нет данных", forecast: "" };
  }
  const cc = data.current_condition[0];
  const tempC = cc.temp_C || "?";
  const humidity = cc.humidity || "?";
  const windKmh = parseFloat(cc.windspeedKmph || 0);
  const windMs = (windKmh / 3.6).toFixed(1);
  const desc =
    (cc.lang_ru && cc.lang_ru[0] && cc.lang_ru[0].value) || cc.weatherDesc?.[0]?.value || "";

  let forecast = "";
  if (data.weather && data.weather[0]) {
    const today = data.weather[0];
    const maxT = today.maxtempC || "?";
    const minT = today.mintempC || "?";
    forecast = `${desc}, макс ${maxT}\u00B0C, мин ${minT}\u00B0C`;
  }

  return {
    current: `${tempC}\u00B0C, влажность ${humidity}%, ветер ${windMs} м/с`,
    forecast,
  };
}

// ── Система алертов (прямое чтение из Sheets) ────────────────────────────────

/** Заголовки листа "⚠️ Алерты": дата, тип, источник, зона, описание, severity, статус, ответственный, решение */
const ALERT_HEADERS = [
  "date",
  "type",
  "source",
  "zone",
  "description",
  "severity",
  "status",
  "assignee",
  "resolution",
];

/**
 * Читает алерты из farm-state кеша или напрямую из Google Sheets,
 * фильтрует за последние 24ч, группирует нерешённые по категории.
 * @param {object|null} [farmState] — кеш farm-state.cjs (если доступен)
 * @returns {{ recent: object[], unresolvedByCategory: Record<string, number>, totalUnresolved: number }}
 */
async function fetchAlertsSummary(farmState = null) {
  try {
    /** @type {Record<string, string>[]} */
    let alerts;

    if (farmState?.alerts && Array.isArray(farmState.alerts) && farmState.alerts.length > 0) {
      // Кеш farm-state уже содержит алерты как массив объектов
      console.log(`[farm-state] Алерты из кеша: ${farmState.alerts.length} записей`);
      alerts = farmState.alerts;
    } else {
      // Fallback: прямое чтение из Google Sheets
      console.log("[farm-state] Алерты: fallback на readSheet");
      const rows = await readSheet(
        PEPINO_SHEETS_ID,
        "\u26A0\uFE0F \u0410\u043B\u0435\u0440\u0442\u044B",
      );
      if (!rows || rows.length < 2) {
        return { recent: [], unresolvedByCategory: {}, totalUnresolved: 0 };
      }

      // Первая строка — заголовки, остальные — данные
      const headers = rows[0];
      alerts = rows.slice(1).map((row) => {
        /** @type {Record<string, string>} */
        const obj = {};
        headers.forEach((h, i) => {
          obj[h.toLowerCase().trim()] = (row[i] || "").trim();
        });
        return obj;
      });
    }

    // Дата 24 часа назад (аргентинский TZ)
    const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
    const cutoff = new Date(nowLocal);
    cutoff.setHours(cutoff.getHours() - 24);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    // Алерты за последние 24ч
    const recent = alerts.filter((a) => {
      const d = (a["\u0434\u0430\u0442\u0430"] || a["date"] || "").slice(0, 10);
      return d >= cutoffStr;
    });

    // Все нерешённые алерты, сгруппированные по типу/зоне
    const unresolvedByCategory = {};
    let totalUnresolved = 0;
    for (const a of alerts) {
      const status = (a["\u0441\u0442\u0430\u0442\u0443\u0441"] || a["status"] || "").toLowerCase();
      if (status === "\u043E\u0442\u043A\u0440\u044B\u0442" || status === "open") {
        totalUnresolved++;
        // Категория = зона или тип, что не пусто
        const category = (
          a["\u0437\u043E\u043D\u0430"] ||
          a["zone"] ||
          a["\u0442\u0438\u043F"] ||
          a["type"] ||
          "\u041F\u0440\u043E\u0447\u0435\u0435"
        ).trim();
        unresolvedByCategory[category] = (unresolvedByCategory[category] || 0) + 1;
      }
    }

    return { recent, unresolvedByCategory, totalUnresolved };
  } catch (err) {
    console.error(
      `[WARN] \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0430\u043B\u0435\u0440\u0442\u044B \u0438\u0437 Sheets: ${err.message}`,
    );
    return { recent: [], unresolvedByCategory: {}, totalUnresolved: 0 };
  }
}

/**
 * Форматирует секцию алертов для брифа.
 * @param {{ recent: object[], unresolvedByCategory: Record<string, number>, totalUnresolved: number }} summary
 * @returns {string[]} строки для вывода
 */
function formatAlertsSection(summary) {
  const lines = [];
  lines.push(
    "\uD83D\uDD14 \u0421\u0438\u0441\u0442\u0435\u043C\u0430 \u0430\u043B\u0435\u0440\u0442\u043E\u0432:",
  );
  lines.push("");

  // Новые алерты за 24ч
  if (summary.recent.length === 0) {
    lines.push(
      "  \u2705 \u041D\u043E\u0432\u044B\u0445 \u0430\u043B\u0435\u0440\u0442\u043E\u0432 \u0437\u0430 24\u0447 \u043D\u0435\u0442",
    );
  } else {
    lines.push(
      `  \u26A1 \u041D\u043E\u0432\u044B\u0445 \u0437\u0430 24\u0447: ${summary.recent.length}`,
    );
    // Показываем до 5 последних
    for (const a of summary.recent.slice(-5)) {
      const sev =
        a["\u0441\u0435\u0432\u0435\u0440\u043D\u043E\u0441\u0442\u044C"] || a["severity"] || "?";
      const desc =
        a["\u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"] || a["description"] || "\u2014";
      const zone = a["\u0437\u043E\u043D\u0430"] || a["zone"] || "";
      const prefix = zone ? `[${zone}] ` : "";
      lines.push(`    \u2022 ${prefix}${desc} (sev:${sev})`);
    }
  }

  lines.push("");

  // Нерешённые по категориям
  if (summary.totalUnresolved === 0) {
    lines.push(
      "  \u2705 \u041D\u0435\u0440\u0435\u0448\u0451\u043D\u043D\u044B\u0445 \u0430\u043B\u0435\u0440\u0442\u043E\u0432 \u043D\u0435\u0442",
    );
  } else {
    lines.push(
      `  \uD83D\uDCCB \u041D\u0435\u0440\u0435\u0448\u0451\u043D\u043D\u044B\u0445: ${summary.totalUnresolved}`,
    );
    // Сортируем категории по количеству (больше — первые)
    const sorted = Object.entries(summary.unresolvedByCategory).sort(([, a], [, b]) => b - a);
    for (const [cat, count] of sorted) {
      lines.push(`    \u2022 ${cat}: ${count}`);
    }
  }

  return lines;
}

// ── Генерация приоритетов ────────────────────────────────────────────────────

function generatePriorities(alertsInfo, gapLines) {
  const priorities = [];
  if (alertsInfo.count > 0) {
    priorities.push("Разобрать открытые алерты");
  }
  if (gapLines.length > 0) {
    priorities.push("Заполнить пропуски данных");
  }
  priorities.push("Проверить состояние теплицы и полив");
  // Всегда возвращаем минимум 3 приоритета
  if (priorities.length < 3) {
    const defaults = [
      "Обновить план продаж на неделю",
      "Проверить заказы клиентов",
      "Ревизия расходных материалов",
    ];
    for (const d of defaults) {
      if (priorities.length >= 3) break;
      if (!priorities.includes(d)) priorities.push(d);
    }
  }
  return priorities.slice(0, 3);
}

// ── Форматирование брифа ─────────────────────────────────────────────────────

function formatBrief(data) {
  const yesterday = yesterdayStr();
  const dateHeader = todayFormatted();
  const weather = parseWeather(data.weather);
  const productionText = parseProduction(data.production, yesterday);
  const salesText = parseSales(data.sales, yesterday);
  const inventoryText = parseInventory(data.inventory);
  const alertsInfo = parseAlerts(data.alerts);
  const gapLines = parseGaps(data.gaps);
  const priorities = generatePriorities(alertsInfo, gapLines);

  const lines = [];
  lines.push(
    `\u2600\uFE0F \u0423\u0422\u0420\u0415\u041D\u041D\u0418\u0419 \u0411\u0420\u0418\u0424 | ${dateHeader}`,
  );
  lines.push("");
  lines.push(`\uD83C\uDF24 Погода: ${weather.current}`);
  if (weather.forecast) {
    lines.push(`   Прогноз: ${weather.forecast}`);
  }
  lines.push("");
  lines.push(`\uD83C\uDF31 Вчера собрано: ${productionText}`);
  lines.push(`\uD83D\uDCB0 Вчера продано: ${salesText}`);
  lines.push(`\uD83D\uDCE6 На складе: ${inventoryText}`);
  lines.push("");
  lines.push(`\u26A0\uFE0F Алерты: ${alertsInfo.count} открытых`);
  if (alertsInfo.lines.length > 0) {
    lines.push(...alertsInfo.lines);
  }
  lines.push("");
  if (gapLines.length > 0) {
    lines.push(`\uD83D\uDCCB Пропуски данных:`);
    lines.push(...gapLines);
    lines.push("");
  }
  lines.push(`\u2705 Приоритеты на сегодня:`);
  priorities.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));

  // Секция системных алертов (из прямого чтения Sheets)
  if (data.alertsSummary) {
    lines.push("");
    lines.push(...formatAlertsSection(data.alertsSummary));
  }

  return lines.join("\n");
}

// ── Главная функция ──────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const now = new Date().toLocaleString("en-US", { timeZone: TZ });
  console.log(`[${now}] Запуск утреннего брифа...`);

  const data = await gatherData();
  const brief = formatBrief(data);

  console.log("--- БРИФ ---");
  console.log(brief);
  console.log("--- /БРИФ ---");

  try {
    const result = await telegramSend(brief);
    console.log(`[OK] Бриф отправлен в Telegram, message_id: ${result.result?.message_id}`);

    // Langfuse trace
    await trace({
      name: "morning-brief",
      input: { date: new Date().toISOString().slice(0, 10) },
      output: { brief_length: brief.length, message_id: result.result?.message_id },
      duration_ms: Date.now() - startMs,
      metadata: {
        skill: "pepino-google-sheets",
        cron: "morning-briefing",
        data_source: data._dataSource || "unknown",
      },
    }).catch(() => {}); // never fail on trace error
  } catch (err) {
    console.error(`[ERROR] Не удалось отправить бриф: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
