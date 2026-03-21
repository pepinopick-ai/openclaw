#!/usr/bin/env node
/**
 * Pepino Pick — Knowledge Distiller (Weekly Business Intelligence)
 *
 * Еженедельный анализ данных продаж и производства:
 *   1. Топ продуктов (по кг и выручке)
 *   2. Топ клиентов (по обороту и частоте)
 *   3. Сезонные паттерны (какие продукты когда продаются)
 *   4. Соотношение производство/продажи
 *   5. Средний размер заказа по клиенту
 *
 * Результат: сводка в лист "📊 Аналитика" + отчёт в Telegram thread 20
 *
 * Cron: 0 10 * * 0 (воскресенье в 10:00)
 * Usage: node knowledge-distiller.cjs [--dry-run]
 */

"use strict";

const https = require("https");
const { sendReport } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { normalize } = require("./product-aliases.cjs");

const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");

// ── Загрузка данных из Sheets (ESM dynamic import) ──────────────────────────

/**
 * Загружает данные из Google Sheets через dynamic import sheets.js.
 * @param {string} sheetName — название листа
 * @returns {Promise<Record<string, string>[]>} — массив объектов (заголовки -> значения)
 */
async function loadSheetData(sheetName) {
  const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
  const rows = await readSheet(PEPINO_SHEETS_ID, sheetName);
  return rowsToObjects(rows);
}

/**
 * Преобразует двумерный массив (с заголовками в первой строке) в массив объектов.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
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
}

// ── Парсинг чисел ───────────────────────────────────────────────────────────

/**
 * Парсит число из строки с поддержкой аргентинского формата (точка = тысячи, запятая = десятичные).
 * @param {string | number | undefined} val
 * @returns {number}
 */
function parseNum(val) {
  if (typeof val === "number") return val;
  const s = String(val || "")
    .replace(/\./g, "") // убираем точки-разделители тысяч
    .replace(",", ".") // запятая -> десятичный разделитель
    .replace("%", "");
  return parseFloat(s) || 0;
}

/**
 * Форматирует число с разделителем тысяч.
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

// ── Извлечение даты из строки ───────────────────────────────────────────────

/**
 * Извлекает YYYY-MM из строки даты (поддерживает DD/MM/YYYY и YYYY-MM-DD).
 * @param {string} dateStr
 * @returns {string | null} — "YYYY-MM" или null
 */
function extractYearMonth(dateStr) {
  if (!dateStr) return null;
  // YYYY-MM-DD
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  // DD/MM/YYYY
  const argMatch = dateStr.match(/^\d{2}\/(\d{2})\/(\d{4})/);
  if (argMatch) return `${argMatch[2]}-${argMatch[1]}`;
  return null;
}

// ── Получение значения по вариантам заголовков ──────────────────────────────

/**
 * Получает значение поля, проверяя несколько вариантов названия столбца.
 * @param {Record<string, string>} row
 * @param {string[]} keys — варианты названия столбца
 * @returns {string}
 */
function getField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== "") return row[k];
  }
  return "";
}

// ── Аналитические функции ───────────────────────────────────────────────────

/**
 * Топ продуктов по кг и выручке.
 * @param {Record<string, string>[]} sales
 * @returns {{ byKg: [string, number][], byRevenue: [string, number][] }}
 */
function topProducts(sales) {
  /** @type {Record<string, number>} */
  const kgMap = {};
  /** @type {Record<string, number>} */
  const revMap = {};

  for (const row of sales) {
    const rawProduct = getField(row, ["Продукт", "продукт", "product"]);
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const kg = parseNum(getField(row, ["Кол-во кг", "кг", "kg", "Количество"]));
    const rev = parseNum(getField(row, ["Итого ARS", "Сумма ARS", "Сумма", "total_ars", "Total"]));
    kgMap[product] = (kgMap[product] || 0) + kg;
    revMap[product] = (revMap[product] || 0) + rev;
  }

  const byKg = Object.entries(kgMap).sort((a, b) => b[1] - a[1]);
  const byRevenue = Object.entries(revMap).sort((a, b) => b[1] - a[1]);
  return { byKg, byRevenue };
}

/**
 * Топ клиентов по выручке, частоте и среднему чеку.
 * @param {Record<string, string>[]} sales
 * @returns {{ clients: { name: string, totalRevenue: number, orderCount: number, avgOrder: number }[] }}
 */
function topClients(sales) {
  /** @type {Record<string, { totalRevenue: number, orderCount: number }>} */
  const clientMap = {};

  for (const row of sales) {
    const client = getField(row, ["Клиент", "клиент", "client"]);
    if (!client) continue;
    const rev = parseNum(getField(row, ["Итого ARS", "Сумма ARS", "Сумма", "total_ars", "Total"]));
    if (!clientMap[client]) {
      clientMap[client] = { totalRevenue: 0, orderCount: 0 };
    }
    clientMap[client].totalRevenue += rev;
    clientMap[client].orderCount += 1;
  }

  const clients = Object.entries(clientMap)
    .map(([name, data]) => ({
      name,
      totalRevenue: data.totalRevenue,
      orderCount: data.orderCount,
      avgOrder: data.orderCount > 0 ? data.totalRevenue / data.orderCount : 0,
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  return { clients };
}

/**
 * Сезонные паттерны: объёмы продаж по месяцам для каждого продукта.
 * @param {Record<string, string>[]} sales
 * @returns {Record<string, Record<string, number>>} — продукт -> { "YYYY-MM": кг }
 */
function seasonalPatterns(sales) {
  /** @type {Record<string, Record<string, number>>} */
  const patterns = {};

  for (const row of sales) {
    const rawProduct = getField(row, ["Продукт", "продукт", "product"]);
    const dateStr = getField(row, ["Дата", "дата", "date"]);
    if (!rawProduct || !dateStr) continue;
    const product = normalize(rawProduct);

    const ym = extractYearMonth(dateStr);
    if (!ym) continue;

    const kg = parseNum(getField(row, ["Кол-во кг", "кг", "kg", "Количество"]));
    if (!patterns[product]) patterns[product] = {};
    patterns[product][ym] = (patterns[product][ym] || 0) + kg;
  }

  return patterns;
}

/**
 * Соотношение производство/продажи.
 * @param {Record<string, string>[]} production
 * @param {Record<string, string>[]} sales
 * @returns {{ product: string, produced: number, sold: number, ratio: number }[]}
 */
function productionSalesRatio(production, sales) {
  /** @type {Record<string, number>} */
  const producedMap = {};
  /** @type {Record<string, number>} */
  const soldMap = {};

  for (const row of production) {
    const rawProduct = getField(row, ["Продукт", "Культура", "продукт", "product"]);
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const qty = parseNum(getField(row, ["Кол-во кг", "Урожай кг", "кг", "kg", "Количество"]));
    producedMap[product] = (producedMap[product] || 0) + qty;
  }

  for (const row of sales) {
    const rawProduct = getField(row, ["Продукт", "продукт", "product"]);
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const kg = parseNum(getField(row, ["Кол-во кг", "кг", "kg", "Количество"]));
    soldMap[product] = (soldMap[product] || 0) + kg;
  }

  // Объединяем все продукты
  const allProducts = new Set([...Object.keys(producedMap), ...Object.keys(soldMap)]);
  const result = [];

  for (const product of allProducts) {
    const produced = producedMap[product] || 0;
    const sold = soldMap[product] || 0;
    const ratio = produced > 0 ? Math.round((sold / produced) * 100) : 0;
    result.push({ product, produced, sold, ratio });
  }

  return result.sort((a, b) => b.sold - a.sold);
}

// ── Запись результатов в лист "📊 Аналитика" ────────────────────────────────

/**
 * Записывает сводку аналитики в Google Sheets.
 * @param {object} analysis — результат анализа
 * @param {ReturnType<typeof topProducts>} analysis.products
 * @param {ReturnType<typeof topClients>} analysis.clientsData
 * @param {{ product: string, produced: number, sold: number, ratio: number }[]} analysis.ratios
 */
async function writeAnalyticsSheet(analysis) {
  const { writeToSheet, createSheetIfNotExists, PEPINO_SHEETS_ID } = await import("./sheets.js");

  const SHEET_NAME = "\u{1F4CA} \u0410\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u0430"; // 📊 Аналитика
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  // Создаём лист если не существует
  await createSheetIfNotExists(PEPINO_SHEETS_ID, SHEET_NAME);

  // Формируем данные: один блок с разделителями
  const rows = [];

  // Заголовок
  rows.push([`Отчёт Knowledge Distiller — ${now}`]);
  rows.push([]);

  // Топ продуктов по выручке
  rows.push(["=== ТОП ПРОДУКТОВ ПО ВЫРУЧКЕ ==="]);
  rows.push(["Продукт", "Выручка ARS", "Объём кг"]);
  for (const [product, rev] of analysis.products.byRevenue.slice(0, 10)) {
    const kgEntry = analysis.products.byKg.find(([p]) => p === product);
    const kg = kgEntry ? kgEntry[1] : 0;
    rows.push([product, Math.round(rev), Math.round(kg * 10) / 10]);
  }
  rows.push([]);

  // Топ клиентов
  rows.push(["=== ТОП КЛИЕНТОВ ==="]);
  rows.push(["Клиент", "Оборот ARS", "Заказов", "Ср. чек ARS"]);
  for (const c of analysis.clientsData.clients.slice(0, 10)) {
    rows.push([c.name, Math.round(c.totalRevenue), c.orderCount, Math.round(c.avgOrder)]);
  }
  rows.push([]);

  // Соотношение производство/продажи
  rows.push(["=== ПРОИЗВОДСТВО vs ПРОДАЖИ ==="]);
  rows.push(["Продукт", "Произведено кг", "Продано кг", "Реализация %"]);
  for (const r of analysis.ratios.slice(0, 10)) {
    rows.push([r.product, Math.round(r.produced * 10) / 10, Math.round(r.sold * 10) / 10, r.ratio]);
  }

  await writeToSheet(PEPINO_SHEETS_ID, rows, SHEET_NAME);
  console.log(`[OK] Аналитика записана в лист "${SHEET_NAME}"`);
}

// ── Формирование Telegram-отчёта ────────────────────────────────────────────

/**
 * Формирует компактный HTML-отчёт для Telegram.
 * @param {object} analysis
 * @param {ReturnType<typeof topProducts>} analysis.products
 * @param {ReturnType<typeof topClients>} analysis.clientsData
 * @param {{ product: string, produced: number, sold: number, ratio: number }[]} analysis.ratios
 * @param {Record<string, Record<string, number>>} analysis.seasonal
 * @param {number} analysis.totalSales
 * @param {number} analysis.totalProduction
 * @returns {string}
 */
function formatTelegramReport(analysis) {
  const lines = [];
  const dateStr = new Date().toISOString().slice(0, 10);

  lines.push(`<b>📊 Knowledge Distiller — ${dateStr}</b>`);
  lines.push(
    `Продаж: ${analysis.totalSales} | Записей производства: ${analysis.totalProduction}\n`,
  );

  // Топ продуктов по выручке
  lines.push(`<b>Топ продуктов (выручка):</b>`);
  for (const [product, rev] of analysis.products.byRevenue.slice(0, 5)) {
    const kgEntry = analysis.products.byKg.find(([p]) => p === product);
    const kg = kgEntry ? Math.round(kgEntry[1] * 10) / 10 : 0;
    lines.push(`  ${product}: ${fmtNum(rev)} ARS (${kg} кг)`);
  }

  // Топ продуктов по кг
  lines.push(`\n<b>Топ продуктов (объём):</b>`);
  for (const [product, kg] of analysis.products.byKg.slice(0, 5)) {
    lines.push(`  ${product}: ${Math.round(kg * 10) / 10} кг`);
  }

  // Топ клиентов
  lines.push(`\n<b>Топ клиентов:</b>`);
  for (const c of analysis.clientsData.clients.slice(0, 5)) {
    lines.push(
      `  ${c.name}: ${fmtNum(c.totalRevenue)} ARS (${c.orderCount} зак., ср. ${fmtNum(c.avgOrder)})`,
    );
  }

  // Средний чек (общий)
  const allOrders = analysis.clientsData.clients.reduce((s, c) => s + c.orderCount, 0);
  const allRevenue = analysis.clientsData.clients.reduce((s, c) => s + c.totalRevenue, 0);
  if (allOrders > 0) {
    lines.push(`\n<b>Средний чек:</b> ${fmtNum(allRevenue / allOrders)} ARS`);
  }

  // Соотношение производство/продажи
  const withProduction = analysis.ratios.filter((r) => r.produced > 0);
  if (withProduction.length > 0) {
    lines.push(`\n<b>Реализация (произв./продажи):</b>`);
    for (const r of withProduction.slice(0, 5)) {
      const emoji = r.ratio >= 80 ? "🟢" : r.ratio >= 50 ? "🟡" : "🔴";
      lines.push(
        `  ${emoji} ${r.product}: ${r.ratio}% (${Math.round(r.sold * 10) / 10}/${Math.round(r.produced * 10) / 10} кг)`,
      );
    }
  }

  // Сезонные паттерны: для топ-3 продуктов показываем последние 3 месяца
  const topSeasonalProducts = analysis.products.byRevenue.slice(0, 3).map(([p]) => p);
  const seasonalEntries = topSeasonalProducts.filter((p) => analysis.seasonal[p]);
  if (seasonalEntries.length > 0) {
    lines.push(`\n<b>Сезонность (кг/мес):</b>`);
    for (const product of seasonalEntries) {
      const months = Object.entries(analysis.seasonal[product]).sort((a, b) =>
        b[0].localeCompare(a[0]),
      );
      const last3 = months.slice(0, 3).reverse();
      if (last3.length > 0) {
        const monthStr = last3.map(([m, kg]) => `${m.slice(5)}: ${Math.round(kg)}кг`).join(", ");
        lines.push(`  ${product}: ${monthStr}`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Knowledge Distiller starting...`);

  // Загрузка данных
  let sales, production;
  try {
    sales = await loadSheetData("🛒 Продажи");
    console.log(`[OK] Продажи: ${sales.length} строк`);
  } catch (err) {
    console.error(`[ERROR] Не удалось загрузить продажи: ${err.message}`);
    process.exit(1);
  }

  try {
    production = await loadSheetData("🌿 Производство");
    console.log(`[OK] Производство: ${production.length} строк`);
  } catch (err) {
    console.warn(`[WARN] Не удалось загрузить производство: ${err.message}`);
    production = [];
  }

  if (sales.length === 0) {
    console.error("[ERROR] Нет данных продаж для анализа");
    process.exit(1);
  }

  // Анализ
  const products = topProducts(sales);
  const clientsData = topClients(sales);
  const seasonal = seasonalPatterns(sales);
  const ratios = productionSalesRatio(production, sales);

  const analysis = {
    products,
    clientsData,
    ratios,
    seasonal,
    totalSales: sales.length,
    totalProduction: production.length,
  };

  // Формирование отчёта
  const report = formatTelegramReport(analysis);
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Запись в Sheets
  if (!DRY_RUN) {
    try {
      await writeAnalyticsSheet(analysis);
    } catch (err) {
      console.error(`[ERROR] Запись в Sheets: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Запись в Sheets пропущена");
  }

  // Telegram
  if (!DRY_RUN) {
    try {
      const tgResult = await sendReport(report, TG_THREAD_ID, "HTML");
      if (tgResult.ok) {
        console.log("[OK] Отчёт отправлен в Telegram");
      } else {
        console.error(`[ERROR] Telegram: ${tgResult.error}`);
      }
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Telegram пропущен");
  }

  // Langfuse
  const durationMs = Date.now() - startMs;
  await trace({
    name: "knowledge-distiller",
    input: {
      sales_rows: sales.length,
      production_rows: production.length,
    },
    output: {
      top_product: products.byRevenue[0]?.[0] || "N/A",
      top_client: clientsData.clients[0]?.name || "N/A",
      unique_products: products.byRevenue.length,
      unique_clients: clientsData.clients.length,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", cron: "knowledge-distiller" },
  }).catch(() => {});

  console.log(`Done in ${durationMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
