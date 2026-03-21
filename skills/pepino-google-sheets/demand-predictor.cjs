#!/usr/bin/env node
/**
 * Pepino Pick — Demand Predictor (4-week forecast)
 *
 * Прогнозирует спрос на каждый продукт на ближайшие 4 недели:
 *   1. Читает ВСЮ историю продаж из "🛒 Продажи"
 *   2. Для каждого продукта:
 *      - Понедельные объёмы продаж
 *      - Тренд (растёт / стабильный / падает) — линейная регрессия
 *      - Паттерн по дням недели (пиковые дни)
 *      - 4-недельный прогноз (взвешенное скользящее среднее)
 *   3. Клиентские прогнозы:
 *      - Ожидаемая дата следующего заказа по частоте
 *      - Клиенты, которые вероятно закажут на этой неделе
 *   4. Telegram-отчёт в топик 20
 *
 * Cron: 0 7 * * 1 (понедельник 07:00)
 * Usage: node demand-predictor.cjs [--dry-run] [--telegram]
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { normalize } = require("./product-aliases.cjs");

const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

// Минимум недель истории для прогноза
const MIN_WEEKS_FOR_FORECAST = 3;
// Минимум заказов клиента для прогноза следующего заказа
const MIN_ORDERS_FOR_CLIENT_PREDICTION = 3;
// Сколько недель в прогнозе
const FORECAST_WEEKS = 4;
// Дни недели на русском
const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// ── Telegram ──────────────────────────────────────────────────────────────────

function telegramSend(text) {
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
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
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

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Парсинг числа из строки (разделитель тысяч — точка, десятичный — запятая) */
function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v || "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "");
  return parseFloat(s) || 0;
}

/** ISO-номер недели (ISO 8601) */
function getISOWeek(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Ключ недели: "2026-W12" */
function weekKey(date) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-W${String(getISOWeek(date)).padStart(2, "0")}`;
}

/** Понедельник текущей недели */
function mondayOfWeek(date) {
  const d = new Date(date.getTime());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Линейная регрессия: возвращает slope (наклон) и r2 (качество) */
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
    sumY2 += values[i] * values[i];
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R-squared
  const ssTot = sumY2 - (sumY * sumY) / n;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

/**
 * Взвешенное скользящее среднее (WMA).
 * Последние недели имеют больший вес: w(i) = i+1.
 */
function weightedMovingAverage(values, windowSize) {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < window.length; i++) {
    const weight = i + 1;
    weightedSum += window[i] * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

// ── Основной анализ ───────────────────────────────────────────────────────────

/**
 * Парсинг строки продажи, возвращает объект или null.
 * @param {object} sale — строка из Sheets
 * @returns {{ date: Date, product: string, client: string, qty: number } | null}
 */
function parseSale(sale) {
  const dateStr = sale["Дата"] || sale["дата"] || sale["date"] || "";
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  const rawProduct = sale["Продукт"] || sale["продукт"] || sale["product"] || "";
  const product = normalize(rawProduct);
  if (!product) return null;

  const client = sale["Клиент"] || sale["клиент"] || sale["client"] || "";
  if (!client || client === "Тест" || client === "test") return null;

  const qty = parseNum(
    sale["Кол-во кг"] || sale["Кол-во"] || sale["qty_kg"] || sale["Количество"] || 0,
  );

  return { date, product, client, qty };
}

/**
 * Анализ спроса по продуктам.
 * @param {Array<{date: Date, product: string, client: string, qty: number}>} records
 * @returns {object}
 */
function analyzeProducts(records) {
  const now = new Date();
  const currentWeekKey = weekKey(now);

  // Группировка продаж по продукту и неделе
  const productWeeks = {}; // product -> { weekKey: totalQty }
  const productDays = {}; // product -> [0..6] суммарные объёмы по дням недели

  for (const r of records) {
    const wk = weekKey(r.date);
    const dayOfWeek = r.date.getDay();

    if (!productWeeks[r.product]) {
      productWeeks[r.product] = {};
      productDays[r.product] = [0, 0, 0, 0, 0, 0, 0];
    }

    productWeeks[r.product][wk] = (productWeeks[r.product][wk] || 0) + r.qty;
    productDays[r.product][dayOfWeek] += r.qty;
  }

  // Собираем все ключи недель для определения диапазона
  const allWeekKeys = new Set();
  for (const weeks of Object.values(productWeeks)) {
    for (const wk of Object.keys(weeks)) {
      allWeekKeys.add(wk);
    }
  }
  const sortedWeeks = [...allWeekKeys].sort();

  const results = [];

  for (const [product, weeks] of Object.entries(productWeeks)) {
    // Массив понедельных объёмов в хронологическом порядке
    const weeklyVolumes = sortedWeeks.map((wk) => weeks[wk] || 0);

    if (weeklyVolumes.length < MIN_WEEKS_FOR_FORECAST) continue;

    // Линейная регрессия для тренда
    const { slope, r2 } = linearRegression(weeklyVolumes);
    const avgWeekly = weeklyVolumes.reduce((a, b) => a + b, 0) / weeklyVolumes.length;
    let trend = "стабильный";
    // Значимый тренд: slope > 5% от среднего И r2 > 0.15
    if (avgWeekly > 0 && Math.abs(slope) > avgWeekly * 0.05 && r2 > 0.15) {
      trend = slope > 0 ? "растёт" : "падает";
    }

    // Пиковые дни недели
    const days = productDays[product];
    const totalDaySales = days.reduce((a, b) => a + b, 0);
    const peakDays = [];
    if (totalDaySales > 0) {
      const avgDay = totalDaySales / 7;
      for (let d = 0; d < 7; d++) {
        if (days[d] > avgDay * 1.3) {
          peakDays.push(DAY_NAMES[d]);
        }
      }
    }

    // 4-недельный прогноз (WMA по последним 6 неделям)
    const wmaBase = weightedMovingAverage(weeklyVolumes, 6);
    const forecast = [];
    for (let w = 1; w <= FORECAST_WEEKS; w++) {
      // Корректируем тренд: slope * w
      let predicted = wmaBase + slope * w;
      if (predicted < 0) predicted = 0;
      forecast.push(Math.round(predicted * 10) / 10);
    }

    const totalSold = weeklyVolumes.reduce((a, b) => a + b, 0);

    results.push({
      product,
      weekCount: weeklyVolumes.length,
      avgWeekly: Math.round(avgWeekly * 10) / 10,
      trend,
      slopePerWeek: Math.round(slope * 10) / 10,
      peakDays,
      forecast,
      totalSold: Math.round(totalSold * 10) / 10,
    });
  }

  // Сортировка по общему объёму продаж (самые ходовые сверху)
  results.sort((a, b) => b.totalSold - a.totalSold);

  return results;
}

/**
 * Прогноз следующего заказа для каждого активного клиента.
 * @param {Array<{date: Date, product: string, client: string, qty: number}>} records
 * @returns {Array<{client: string, avgGapDays: number, predictedNext: Date, daysTillNext: number, lastOrder: string, orderCount: number}>}
 */
function predictClientOrders(records) {
  const now = new Date();
  const clientOrders = {}; // client -> [Date]

  for (const r of records) {
    if (!clientOrders[r.client]) clientOrders[r.client] = [];
    clientOrders[r.client].push(r.date);
  }

  const predictions = [];

  for (const [client, dates] of Object.entries(clientOrders)) {
    if (dates.length < MIN_ORDERS_FOR_CLIENT_PREDICTION) continue;

    dates.sort((a, b) => a - b);

    // Вычисляем среднее расстояние между заказами
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      const gapDays = Math.floor((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
      if (gapDays > 0) gaps.push(gapDays);
    }

    if (gaps.length === 0) continue;

    // Взвешенное среднее (последние интервалы важнее)
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < gaps.length; i++) {
      const weight = i + 1;
      weightedSum += gaps[i] * weight;
      weightTotal += weight;
    }
    const avgGap = weightTotal > 0 ? weightedSum / weightTotal : 0;
    if (avgGap <= 0) continue;

    const lastOrder = dates[dates.length - 1];
    const predictedNext = new Date(lastOrder.getTime() + avgGap * 24 * 60 * 60 * 1000);
    const daysTillNext = Math.floor((predictedNext - now) / (1000 * 60 * 60 * 24));

    predictions.push({
      client,
      avgGapDays: Math.round(avgGap),
      predictedNext,
      daysTillNext,
      lastOrder: lastOrder.toISOString().slice(0, 10),
      orderCount: dates.length,
    });
  }

  // Сортировка: ближайшие заказы первыми
  predictions.sort((a, b) => a.daysTillNext - b.daysTillNext);

  return predictions;
}

// ── Форматирование отчёта ─────────────────────────────────────────────────────

function formatReport(productForecasts, clientPredictions) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>📈 Прогноз спроса — ${d}</b>\n`);

  // Прогноз по продуктам на следующую неделю
  if (productForecasts.length > 0) {
    lines.push(`<b>🥒 Прогноз на ближайшие 4 недели:</b>`);
    for (const p of productForecasts.slice(0, 10)) {
      const peakStr = p.peakDays.length > 0 ? `, пик: ${p.peakDays.join(", ")}` : "";
      const fc = p.forecast.map((v) => `${v} кг`).join(" → ");
      lines.push(`  <b>${p.product}</b>: ${fc}${peakStr}`);
    }
    lines.push("");
  }

  // Тренды
  const growing = productForecasts.filter((p) => p.trend === "растёт");
  const declining = productForecasts.filter((p) => p.trend === "падает");

  if (growing.length > 0 || declining.length > 0) {
    lines.push(`<b>📊 Тренды:</b>`);
    if (growing.length > 0) {
      lines.push(
        `  📈 Растёт: ${growing.map((p) => `${p.product} (+${p.slopePerWeek} кг/нед)`).join(", ")}`,
      );
    }
    if (declining.length > 0) {
      lines.push(
        `  📉 Падает: ${declining.map((p) => `${p.product} (${p.slopePerWeek} кг/нед)`).join(", ")}`,
      );
    }
    lines.push("");
  }

  // Клиенты, которые вероятно закажут на этой неделе
  const thisWeekClients = clientPredictions.filter((c) => c.daysTillNext <= 7);
  const overdueClients = clientPredictions.filter((c) => c.daysTillNext < 0);

  if (thisWeekClients.length > 0) {
    lines.push(`<b>👥 Клиенты, ожидающие заказ на этой неделе:</b>`);
    for (const c of thisWeekClients.slice(0, 10)) {
      const status =
        c.daysTillNext < 0
          ? `просрочен на ${Math.abs(c.daysTillNext)}д`
          : c.daysTillNext === 0
            ? "ожидается сегодня"
            : `через ${c.daysTillNext}д`;
      lines.push(
        `  • <b>${c.client}</b> — ${status} (цикл: ~${c.avgGapDays}д, посл. заказ: ${c.lastOrder})`,
      );
    }
    lines.push("");
  }

  if (overdueClients.length > 0 && thisWeekClients.length === 0) {
    lines.push(`<b>⚠️ Просроченные заказы (клиент не заказал в ожидаемый срок):</b>`);
    for (const c of overdueClients.slice(0, 5)) {
      lines.push(
        `  • <b>${c.client}</b> — просрочен на ${Math.abs(c.daysTillNext)}д (цикл: ~${c.avgGapDays}д)`,
      );
    }
    lines.push("");
  }

  // Сводка
  const nextWeekTotal = productForecasts.reduce((s, p) => s + (p.forecast[0] || 0), 0);
  lines.push(`<b>📦 Итого на след. неделю: ~${Math.round(nextWeekTotal)} кг</b>`);
  if (thisWeekClients.length > 0) {
    lines.push(`<b>👥 Ожидаем заказы от ${thisWeekClients.length} клиентов</b>`);
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Demand predictor starting...`);

  // Загрузка данных из Sheets
  let sales;
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    if (!rows || rows.length < 2) {
      console.log("Нет данных о продажах.");
      return;
    }
    const headers = rows[0];
    sales = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || "";
      });
      return obj;
    });
  } catch (err) {
    console.error(`[ERROR] Не удалось прочитать данные: ${err.message}`);
    process.exit(1);
  }

  console.log(`Загружено ${sales.length} записей продаж`);

  // Парсинг
  const records = [];
  for (const sale of sales) {
    const parsed = parseSale(sale);
    if (parsed) records.push(parsed);
  }
  console.log(`Валидных записей: ${records.length}`);

  if (records.length === 0) {
    console.log("Нет валидных данных для анализа.");
    return;
  }

  // Анализ
  const productForecasts = analyzeProducts(records);
  const clientPredictions = predictClientOrders(records);

  console.log(`Продуктов с прогнозом: ${productForecasts.length}`);
  console.log(`Клиентов с прогнозом: ${clientPredictions.length}`);

  // Отчёт
  const report = formatReport(productForecasts, clientPredictions);
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Telegram
  if (SEND_TG) {
    try {
      await telegramSend(report);
      console.log("[OK] Прогноз отправлен в Telegram");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse
  const thisWeekClients = clientPredictions.filter((c) => c.daysTillNext <= 7);
  await trace({
    name: "demand-predictor",
    input: { sales_count: sales.length, valid_records: records.length },
    output: {
      products_forecasted: productForecasts.length,
      clients_predicted: clientPredictions.length,
      clients_this_week: thisWeekClients.length,
      trending_up: productForecasts.filter((p) => p.trend === "растёт").length,
      trending_down: productForecasts.filter((p) => p.trend === "падает").length,
      next_week_total_kg: Math.round(
        productForecasts.reduce((s, p) => s + (p.forecast[0] || 0), 0),
      ),
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "demand-predictor" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
