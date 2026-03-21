#!/usr/bin/env node
/**
 * Pepino Pick — Cash Flow Forecast
 *
 * Прогноз денежного потока на 7 и 30 дней на основе исторических данных:
 *   1. Средний дневной доход (за последние 7 и 30 дней)
 *   2. Средний дневной расход (за последние 7 и 30 дней)
 *   3. Паттерны по дням недели (какие дни самые продуктивные)
 *   4. Прогноз выручки и расходов на 7 и 30 дней
 *   5. Чистый cash flow прогноз
 *   6. Runway — через сколько дней кончатся деньги (при негативном тренде)
 *
 * Алерт если прогнозируемый cash flow уходит в минус в пределах 14 дней.
 *
 * Cron: 0 18 * * 3 (среда 18:00)
 * Usage: node cashflow-forecast.cjs [--dry-run] [--telegram]
 */

"use strict";

const http = require("http");
const https = require("https");
const { apiHeaders } = require("./api-auth.cjs");
const { trace } = require("./langfuse-trace.cjs");

const API_BASE = "http://localhost:4000";
const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

// Порог алерта: прогноз уходит в минус в пределах N дней
const NEGATIVE_CF_ALERT_DAYS = 14;

// Названия дней недели для отчёта
const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(/** @type {string} */ path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${API_BASE}${path}`, { headers: apiHeaders() }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Parse error from ${path}`));
          }
        });
      })
      .on("error", reject);
  });
}

function telegramSend(/** @type {string} */ text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: TG_CHAT_ID,
      message_thread_id: TG_THREAD_ID,
      text,
      parse_mode: "HTML",
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            reject(new Error("Telegram parse error"));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

/**
 * Парсит числовое значение из ячейки Sheets (аргентинский формат: точка = разделитель тысяч, запятая = десятичная).
 * @param {string | number | undefined} v
 * @returns {number}
 */
function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v || "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "");
  return parseFloat(s) || 0;
}

/** @param {Date} d @returns {string} YYYY-MM-DD */
function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

/** @param {number} n @returns {string} YYYY-MM-DD (n дней назад) */
function nDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

/**
 * Извлекает сумму из строки продажи/расхода (поддержка разных имён колонок).
 * @param {Record<string, string>} row
 * @param {"revenue" | "expense"} type
 * @returns {number}
 */
function extractAmount(row, type) {
  if (type === "revenue") {
    return parseNum(
      row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["total_ars"] || row["Total"],
    );
  }
  return parseNum(
    row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["amount_ars"] || row["Amount"],
  );
}

/**
 * Извлекает дату из строки (поддержка разных имён колонок).
 * @param {Record<string, string>} row
 * @returns {string} YYYY-MM-DD или пустая строка
 */
function extractDate(row) {
  return (row["Дата"] || row["дата"] || row["date"] || "").slice(0, 10);
}

// ── Анализ ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ForecastResult
 * @property {{revenue: number, expenses: number, net: number}} avg7  -- среднедневные за 7 дней
 * @property {{revenue: number, expenses: number, net: number}} avg30 -- среднедневные за 30 дней
 * @property {Record<number, {revenue: number, expenses: number, count: number}>} dayOfWeek -- паттерн по дням недели
 * @property {{revenue: number, expenses: number, net: number}} forecast7  -- прогноз на 7 дней
 * @property {{revenue: number, expenses: number, net: number}} forecast30 -- прогноз на 30 дней
 * @property {number | null} runwayDays -- дней до отрицательного баланса (null = не уходит в минус)
 * @property {boolean} negativeCfAlert -- true если cash flow уйдёт в минус в пределах NEGATIVE_CF_ALERT_DAYS
 * @property {{day: string, revenue: number}[]} bestDays -- топ-3 дня по выручке
 * @property {{day: string, revenue: number}[]} worstDays -- 3 дня с минимальной выручкой
 * @property {number} dataQuality -- % дней с данными из последних 30
 */

/**
 * Основной расчёт прогноза cash flow.
 * @param {Record<string, string>[]} sales
 * @param {Record<string, string>[]} expenses
 * @returns {ForecastResult}
 */
function buildForecast(sales, expenses) {
  const today = dateStr(new Date());
  const cutoff7 = nDaysAgo(7);
  const cutoff30 = nDaysAgo(30);

  // Агрегация по дням: выручка
  /** @type {Record<string, number>} */
  const revByDate = {};
  for (const row of sales) {
    const d = extractDate(row);
    if (!d || d > today) continue;
    revByDate[d] = (revByDate[d] || 0) + extractAmount(row, "revenue");
  }

  // Агрегация по дням: расходы
  /** @type {Record<string, number>} */
  const expByDate = {};
  for (const row of expenses) {
    const d = extractDate(row);
    if (!d || d > today) continue;
    expByDate[d] = (expByDate[d] || 0) + extractAmount(row, "expense");
  }

  // Фильтруем по периодам
  const allDates = new Set([...Object.keys(revByDate), ...Object.keys(expByDate)]);

  let rev7 = 0;
  let exp7 = 0;
  let days7 = 0;
  let rev30 = 0;
  let exp30 = 0;
  let days30 = 0;

  for (const d of allDates) {
    if (d >= cutoff30 && d <= today) {
      rev30 += revByDate[d] || 0;
      exp30 += expByDate[d] || 0;
      days30++;
    }
    if (d >= cutoff7 && d <= today) {
      rev7 += revByDate[d] || 0;
      exp7 += expByDate[d] || 0;
      days7++;
    }
  }

  // Используем календарные дни, а не количество дней с данными, для средних
  const calDays7 = 7;
  const calDays30 = 30;

  const avgDailyRev7 = rev7 / calDays7;
  const avgDailyExp7 = exp7 / calDays7;
  const avgDailyRev30 = rev30 / calDays30;
  const avgDailyExp30 = exp30 / calDays30;

  // Паттерн по дням недели (из последних 30 дней)
  /** @type {Record<number, {revenue: number, expenses: number, count: number}>} */
  const dayOfWeek = {};
  for (let dow = 0; dow < 7; dow++) {
    dayOfWeek[dow] = { revenue: 0, expenses: 0, count: 0 };
  }

  for (const d of allDates) {
    if (d < cutoff30 || d > today) continue;
    const dow = new Date(d + "T12:00:00").getDay();
    dayOfWeek[dow].revenue += revByDate[d] || 0;
    dayOfWeek[dow].expenses += expByDate[d] || 0;
    dayOfWeek[dow].count++;
  }

  // Прогноз на 7 и 30 дней с учётом дневных паттернов
  let forecast7Rev = 0;
  let forecast7Exp = 0;
  let forecast30Rev = 0;
  let forecast30Exp = 0;

  // Считаем средние по дням недели (для взвешенного прогноза)
  const totalWeekRevenue = Object.values(dayOfWeek).reduce((s, d) => s + d.revenue, 0);
  const hasWeeklyPattern = totalWeekRevenue > 0;

  for (let i = 1; i <= 30; i++) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + i);
    const dow = futureDate.getDay();

    let dayRev;
    let dayExp;

    if (hasWeeklyPattern && dayOfWeek[dow].count > 0) {
      // Взвешенный прогноз: средний для этого дня недели
      dayRev = dayOfWeek[dow].revenue / dayOfWeek[dow].count;
      dayExp = dayOfWeek[dow].expenses / dayOfWeek[dow].count;
    } else {
      // Fallback: общая средняя
      dayRev = avgDailyRev30;
      dayExp = avgDailyExp30;
    }

    if (i <= 7) {
      forecast7Rev += dayRev;
      forecast7Exp += dayExp;
    }
    forecast30Rev += dayRev;
    forecast30Exp += dayExp;
  }

  // Runway: через сколько дней баланс уйдёт в минус
  // Считаем от текущего накопленного cash flow за 30 дней
  const netDailyAvg = avgDailyRev30 - avgDailyExp30;
  let runwayDays = null;
  let negativeCfAlert = false;

  if (netDailyAvg < 0) {
    // При отрицательном тренде считаем runway от текущего запаса
    // (используем net за 30 дней как "запас")
    const currentReserve = rev30 - exp30;
    if (currentReserve > 0) {
      runwayDays = Math.ceil(currentReserve / Math.abs(netDailyAvg));
    } else {
      runwayDays = 0; // Уже в минусе
    }
    negativeCfAlert = runwayDays !== null && runwayDays <= NEGATIVE_CF_ALERT_DAYS;
  }

  // Топ дни / худшие дни
  const dowEntries = Object.entries(dayOfWeek).map(([dow, data]) => ({
    day: DAY_NAMES[Number(dow)],
    revenue: data.count > 0 ? data.revenue / data.count : 0,
  }));
  dowEntries.sort((a, b) => b.revenue - a.revenue);
  const bestDays = dowEntries.slice(0, 3);
  const worstDays = dowEntries.slice(-3).reverse();

  // Качество данных: сколько % дней из 30 имеют записи
  const dataQuality = Math.round((days30 / calDays30) * 100);

  return {
    avg7: { revenue: avgDailyRev7, expenses: avgDailyExp7, net: avgDailyRev7 - avgDailyExp7 },
    avg30: { revenue: avgDailyRev30, expenses: avgDailyExp30, net: avgDailyRev30 - avgDailyExp30 },
    dayOfWeek,
    forecast7: { revenue: forecast7Rev, expenses: forecast7Exp, net: forecast7Rev - forecast7Exp },
    forecast30: {
      revenue: forecast30Rev,
      expenses: forecast30Exp,
      net: forecast30Rev - forecast30Exp,
    },
    runwayDays,
    negativeCfAlert,
    bestDays,
    worstDays,
    dataQuality,
  };
}

// ── Форматирование ───────────────────────────────────────────────────────────

/** @param {number} n @returns {string} */
function fmtARS(n) {
  return Math.round(n).toLocaleString("es-AR");
}

/**
 * Формирует HTML-отчёт для Telegram.
 * @param {ForecastResult} fc
 * @returns {string}
 */
function formatReport(fc) {
  const lines = [];
  const d = dateStr(new Date());
  lines.push(`<b>📈 Cash Flow Forecast — ${d}</b>\n`);

  // Качество данных
  if (fc.dataQuality < 50) {
    lines.push(`⚠️ Данные за ${fc.dataQuality}% дней из 30 — прогноз неточный\n`);
  }

  // Средние дневные
  lines.push("<b>Среднедневные показатели:</b>");
  lines.push(
    `  7д: +${fmtARS(fc.avg7.revenue)} / -${fmtARS(fc.avg7.expenses)} = ${fc.avg7.net >= 0 ? "+" : ""}${fmtARS(fc.avg7.net)} ARS`,
  );
  lines.push(
    `  30д: +${fmtARS(fc.avg30.revenue)} / -${fmtARS(fc.avg30.expenses)} = ${fc.avg30.net >= 0 ? "+" : ""}${fmtARS(fc.avg30.net)} ARS`,
  );
  lines.push("");

  // Прогноз 7 дней
  const net7Emoji = fc.forecast7.net >= 0 ? "🟢" : "🔴";
  lines.push("<b>Прогноз на 7 дней:</b>");
  lines.push(`  Выручка: +${fmtARS(fc.forecast7.revenue)} ARS`);
  lines.push(`  Расходы: -${fmtARS(fc.forecast7.expenses)} ARS`);
  lines.push(
    `  ${net7Emoji} Нетто: ${fc.forecast7.net >= 0 ? "+" : ""}${fmtARS(fc.forecast7.net)} ARS`,
  );
  lines.push("");

  // Прогноз 30 дней
  const net30Emoji = fc.forecast30.net >= 0 ? "🟢" : "🔴";
  lines.push("<b>Прогноз на 30 дней:</b>");
  lines.push(`  Выручка: +${fmtARS(fc.forecast30.revenue)} ARS`);
  lines.push(`  Расходы: -${fmtARS(fc.forecast30.expenses)} ARS`);
  lines.push(
    `  ${net30Emoji} Нетто: ${fc.forecast30.net >= 0 ? "+" : ""}${fmtARS(fc.forecast30.net)} ARS`,
  );
  lines.push("");

  // Паттерн по дням недели
  lines.push("<b>Лучшие дни по выручке:</b>");
  for (const day of fc.bestDays) {
    if (day.revenue <= 0) continue;
    lines.push(`  • ${day.day}: ~${fmtARS(day.revenue)} ARS/день`);
  }
  lines.push("");

  // Runway
  if (fc.runwayDays !== null) {
    if (fc.runwayDays === 0) {
      lines.push("🔴 <b>Cash flow уже отрицательный!</b>");
    } else {
      lines.push(`⏳ <b>Runway: ~${fc.runwayDays} дней</b> при текущем тренде`);
    }
  } else {
    lines.push("✅ Cash flow положительный — runway не ограничен");
  }

  // Критический алерт
  if (fc.negativeCfAlert) {
    lines.push("");
    lines.push(
      `🚨 <b>ВНИМАНИЕ: Cash flow уйдёт в минус в пределах ${NEGATIVE_CF_ALERT_DAYS} дней!</b>`,
    );
    lines.push("<b>Рекомендация:</b> Сократить расходы или увеличить продажи.");
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Cash flow forecast starting...`);

  /** @type {Record<string, string>[]} */
  let sales;
  /** @type {Record<string, string>[]} */
  let expenses;

  // Загрузка данных: прямой доступ к Sheets с fallback на API
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");

    const toJson = (/** @type {string[][]} */ rows) => {
      if (!rows || rows.length < 2) return [];
      const headers = rows[0];
      return rows.slice(1).map((row) => {
        /** @type {Record<string, string>} */
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] || "";
        });
        return obj;
      });
    };

    const [salesRows, expRows] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "🛒 Продажи"),
      readSheet(PEPINO_SHEETS_ID, "💰 Расходы"),
    ]);

    sales = toJson(salesRows);
    expenses = toJson(expRows);
  } catch (err) {
    console.log(`Direct sheet read failed (${err.message}), using API...`);
    [sales, expenses] = await Promise.all([fetchJson("/sales"), fetchJson("/expenses")]);
  }

  console.log(`Sales: ${sales.length}, Expenses: ${expenses.length}`);

  if (sales.length === 0) {
    console.log("No sales data — cannot forecast. Exiting.");
    return;
  }

  const forecast = buildForecast(sales, expenses);
  const report = formatReport(forecast);

  // Вывод в консоль (без HTML тегов)
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Отправка в Telegram
  if (SEND_TG) {
    try {
      await telegramSend(report);
      console.log("[OK] Forecast sent to Telegram thread 20");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse trace
  await trace({
    name: "cashflow-forecast",
    input: { sales_count: sales.length, expenses_count: expenses.length },
    output: {
      avg_daily_rev_7: Math.round(forecast.avg7.revenue),
      avg_daily_rev_30: Math.round(forecast.avg30.revenue),
      forecast_7d_net: Math.round(forecast.forecast7.net),
      forecast_30d_net: Math.round(forecast.forecast30.net),
      runway_days: forecast.runwayDays,
      negative_alert: forecast.negativeCfAlert,
      data_quality_pct: forecast.dataQuality,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "cashflow-forecast" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
