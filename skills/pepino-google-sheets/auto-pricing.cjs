/**
 * auto-pricing.cjs -- Расчёт рекомендованных цен на основе реальных данных Pepino Pick
 *
 * Логика:
 * 1. Читает продажи из "🛒 Продажи" за последние 30 дней
 * 2. Читает расходы из "💰 Расходы" за последние 30 дней
 * 3. Рассчитывает себестоимость за кг (total expenses / total kg sold)
 * 4. Применяет целевую маржу (по умолчанию 50%) для рекомендованной цены
 * 5. Сравнивает с текущими ценами продаж (последние 10 продаж по продукту)
 * 6. Опциональный учёт цен конкурентов (Mercado Libre)
 * 7. Отправляет отчёт в Telegram
 * 8. Помечает изменения >15% как "needs approval" (Policy L2)
 * 9. Пишет трейс в Langfuse
 *
 * Использование:
 *   node auto-pricing.cjs                           -- полный анализ + TG отчёт
 *   node auto-pricing.cjs --dry-run                 -- только вывод в консоль
 *   node auto-pricing.cjs --product "вешенка"       -- анализ одного продукта
 *   node auto-pricing.cjs --margin 0.4              -- целевая маржа 40%
 *   node auto-pricing.cjs --with-competitors        -- включить анализ Mercado Libre
 */

"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const { google } = require("googleapis");
const { apiHeaders } = require("./api-auth.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport, sendAlert } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");
const { parseNum, parseDate } = require("./helpers.cjs");

// ── Конфигурация ──────────────────────────────────────────────────────────────

const PEPINO_SHEETS_ID = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";

const SALES_SHEET = "🛒 Продажи";
const EXPENSES_SHEET = "💰 Расходы";
const PRICING_SHEET = "Ценовой мониторинг";

const TG_THREAD_PRICING = 20;

const ML_API_BASE = "https://api.mercadolibre.com";
const ML_SITE = "MLA";

/** Маппинг продуктов для Mercado Libre (опциональный конкурентный анализ) */
const PRODUCT_ML_QUERIES = {
  вешенка: ["hongos girgolas frescas", "girgolas frescas kg"],
  микрозелень: ["microgreens frescos", "microverdes bandeja"],
  огурец: ["pepino fresco kg", "pepino holandes invernadero"],
  "съедобные цветы": ["flores comestibles bandeja"],
};

/** Период анализа в днях */
const ANALYSIS_DAYS = 30;

/** Порог изменения цены для L2 approval (15%) */
const L2_APPROVAL_THRESHOLD = 0.15;

// ── Google Sheets клиент ────────────────────────────────────────────────────

/** @returns {Promise<import("googleapis").sheets_v4.Sheets>} */
async function getSheetsClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Читает лист целиком и возвращает массив объектов (заголовок -> значение)
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {string} sheetName
 * @returns {Promise<Array<Record<string, string>>>}
 */
async function readSheetAsObjects(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: PEPINO_SHEETS_ID,
    range: `'${sheetName}'`,
  });
  const rows = response.data.values || [];
  if (rows.length < 2) return [];

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

// ── Парсинг данных ──────────────────────────────────────────────────────────
// parseNum и parseDate импортированы из helpers.cjs

/**
 * Нормализует название продукта через canonical aliases.
 * Обёртка для обратной совместимости -- вызывает normalize() из product-aliases.cjs.
 * @param {string} name
 * @returns {string}
 */
function normalizeProduct(name) {
  return normalize(name);
}

// ── Чтение продаж за последние N дней ───────────────────────────────────────

/**
 * @typedef {Object} SaleRecord
 * @property {Date} date
 * @property {string} client
 * @property {string} product
 * @property {number} kg
 * @property {number} pricePerKg
 * @property {number} totalArs
 * @property {string} status
 */

/**
 * Читает продажи за последние N дней
 * Колонки: "Дата", "Клиент", "Продукт", "Кол-во кг", "Цена ARS/кг",
 *           "Сумма ARS", "Итого ARS", "Курс USD", "Сумма USD", "Статус",
 *           "Доставка ARS", "Примечание"
 *
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {number} days
 * @returns {Promise<SaleRecord[]>}
 */
async function readSales(sheets, days) {
  const allRows = await readSheetAsObjects(sheets, SALES_SHEET);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  /** @type {SaleRecord[]} */
  const sales = [];

  for (const row of allRows) {
    const date = parseDate(row["Дата"]);
    if (!date || date < cutoff) continue;

    const product = normalizeProduct(row["Продукт"]);
    if (!product) continue;

    sales.push({
      date,
      client: (row["Клиент"] || "").trim(),
      product,
      kg: parseNum(row["Кол-во кг"]),
      pricePerKg: parseNum(row["Цена ARS/кг"]),
      totalArs: parseNum(row["Сумма ARS"]) || parseNum(row["Итого ARS"]),
      status: (row["Статус"] || "").trim(),
    });
  }

  return sales;
}

// ── Чтение расходов за последние N дней ─────────────────────────────────────

/**
 * @typedef {Object} ExpenseRecord
 * @property {Date} date
 * @property {string} name
 * @property {number} qty
 * @property {string} unit
 * @property {number} amountArs
 */

/**
 * Читает расходы за последние N дней
 * Колонки: "Дата", "Наименование", "Кол-во", "Единицы", "Сумма ARS",
 *           "Курс USD", "Сумма USD"
 *
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {number} days
 * @returns {Promise<ExpenseRecord[]>}
 */
async function readExpenses(sheets, days) {
  const allRows = await readSheetAsObjects(sheets, EXPENSES_SHEET);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  /** @type {ExpenseRecord[]} */
  const expenses = [];

  for (const row of allRows) {
    const date = parseDate(row["Дата"]);
    if (!date || date < cutoff) continue;

    expenses.push({
      date,
      name: (row["Наименование"] || "").trim(),
      qty: parseNum(row["Кол-во"]),
      unit: (row["Единицы"] || "").trim(),
      amountArs: parseNum(row["Сумма ARS"]),
    });
  }

  return expenses;
}

// ── Расчёт себестоимости ────────────────────────────────────────────────────

/**
 * @typedef {Object} CostAnalysis
 * @property {number} totalExpensesArs   -- общие расходы за период
 * @property {number} totalKgSold        -- всего кг продано
 * @property {number} costPerKg          -- себестоимость ARS/кг
 * @property {number} expenseCount       -- кол-во записей расходов
 * @property {number} saleCount          -- кол-во записей продаж
 */

/**
 * Считает общую себестоимость за кг (total expenses / total kg sold)
 * @param {ExpenseRecord[]} expenses
 * @param {SaleRecord[]} sales
 * @returns {CostAnalysis}
 */
function calculateOverallCost(expenses, sales) {
  const totalExpensesArs = expenses.reduce((sum, e) => sum + e.amountArs, 0);
  const totalKgSold = sales.reduce((sum, s) => sum + s.kg, 0);

  return {
    totalExpensesArs: Math.round(totalExpensesArs),
    totalKgSold: Math.round(totalKgSold * 100) / 100,
    costPerKg: totalKgSold > 0 ? Math.round(totalExpensesArs / totalKgSold) : 0,
    expenseCount: expenses.length,
    saleCount: sales.length,
  };
}

// ── Анализ текущих цен по продукту ──────────────────────────────────────────

/**
 * @typedef {Object} ProductPricing
 * @property {string} product
 * @property {number} currentAvgPrice     -- средняя цена последних продаж
 * @property {number} currentMinPrice     -- мин цена
 * @property {number} currentMaxPrice     -- макс цена
 * @property {number} lastSalePrice       -- цена последней продажи
 * @property {number} totalKgSold         -- всего кг продано
 * @property {number} saleCount           -- кол-во продаж
 * @property {number} costPerKg           -- себестоимость ARS/кг
 * @property {number} recommendedPrice    -- рекомендованная цена
 * @property {number} targetMargin        -- целевая маржа
 * @property {number} currentMargin       -- текущая маржа
 * @property {number} priceChangePct      -- изменение цены в %
 * @property {boolean} needsApproval      -- требуется L2 подтверждение
 * @property {string} recommendation      -- текстовая рекомендация
 * @property {{avg: number|null, min: number|null, max: number|null, count: number}|null} competitor
 */

/**
 * Анализирует цены по каждому продукту
 * @param {SaleRecord[]} sales
 * @param {CostAnalysis} costAnalysis
 * @param {number} targetMargin -- целевая маржа (0.5 = 50%)
 * @param {Record<string, {avg: number|null, min: number|null, max: number|null, count: number}>} competitorPrices
 * @returns {ProductPricing[]}
 */
function analyzeProducts(sales, costAnalysis, targetMargin, competitorPrices) {
  // Группировка продаж по продукту
  /** @type {Record<string, SaleRecord[]>} */
  const byProduct = {};
  for (const sale of sales) {
    if (!byProduct[sale.product]) byProduct[sale.product] = [];
    byProduct[sale.product].push(sale);
  }

  /** @type {ProductPricing[]} */
  const results = [];
  const costPerKg = costAnalysis.costPerKg;

  for (const [product, productSales] of Object.entries(byProduct)) {
    // Сортировка по дате (новые первые)
    productSales.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Берём последние 10 продаж для анализа текущей цены
    const recentSales = productSales.slice(0, 10);
    const prices = recentSales.map((s) => s.pricePerKg).filter((p) => p > 0);

    if (prices.length === 0) continue;

    const avgPrice = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const lastSalePrice = prices[0];
    const totalKg = productSales.reduce((s, sale) => s + sale.kg, 0);

    // Рекомендованная цена = себестоимость / (1 - маржа)
    // Пример: cost=3000, margin=0.5 -> price = 3000 / 0.5 = 6000
    const recommendedPrice = costPerKg > 0 ? Math.round(costPerKg / (1 - targetMargin)) : 0;

    // Текущая маржа = (цена - себестоимость) / цена
    const currentMargin =
      avgPrice > 0 && costPerKg > 0
        ? Math.round(((avgPrice - costPerKg) / avgPrice) * 1000) / 10
        : 0;

    // Изменение цены в % от текущей средней
    const priceChangePct =
      avgPrice > 0 ? Math.round(((recommendedPrice - avgPrice) / avgPrice) * 1000) / 10 : 0;

    // Флаг L2 approval: изменение >15%
    const needsApproval = Math.abs(priceChangePct) > L2_APPROVAL_THRESHOLD * 100;

    // Текстовая рекомендация
    let recommendation;
    if (costPerKg === 0) {
      recommendation = "INSUFFICIENT_DATA: нет данных о себестоимости";
    } else if (needsApproval && priceChangePct > 0) {
      recommendation = `INCREASE (L2 APPROVAL): +${priceChangePct}% от текущей`;
    } else if (needsApproval && priceChangePct < 0) {
      recommendation = `DECREASE (L2 APPROVAL): ${priceChangePct}% от текущей`;
    } else if (priceChangePct > 5) {
      recommendation = `CONSIDER_INCREASE: +${priceChangePct}%`;
    } else if (priceChangePct < -5) {
      recommendation = `CONSIDER_DECREASE: ${priceChangePct}%`;
    } else {
      recommendation = `HOLD: цена в пределах нормы (${priceChangePct > 0 ? "+" : ""}${priceChangePct}%)`;
    }

    const competitor = competitorPrices[product] || null;

    results.push({
      product,
      currentAvgPrice: avgPrice,
      currentMinPrice: minPrice,
      currentMaxPrice: maxPrice,
      lastSalePrice,
      totalKgSold: Math.round(totalKg * 100) / 100,
      saleCount: productSales.length,
      costPerKg,
      recommendedPrice,
      targetMargin,
      currentMargin,
      priceChangePct,
      needsApproval,
      recommendation,
      competitor,
    });
  }

  // Сортировка: сначала те, что требуют внимания (needsApproval)
  results.sort((a, b) => {
    if (a.needsApproval !== b.needsApproval) return a.needsApproval ? -1 : 1;
    return Math.abs(b.priceChangePct) - Math.abs(a.priceChangePct);
  });

  return results;
}

// ── Конкурентный анализ (опционально) ───────────────────────────────────────

/**
 * GET-запрос к HTTP/HTTPS endpoint
 * @param {string} url
 * @returns {Promise<Object>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error от ${url}: ${err.message}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout запроса к ${url}`));
    });
  });
}

/**
 * Запрашивает цены конкурентов на Mercado Libre
 * @param {string[]} products -- список продуктов для анализа
 * @returns {Promise<Record<string, {avg: number|null, min: number|null, max: number|null, count: number}>>}
 */
async function fetchCompetitorPrices(products) {
  /** @type {Record<string, {avg: number|null, min: number|null, max: number|null, count: number}>} */
  const result = {};

  // Фильтры нерелевантных результатов
  const excludePatterns = [
    /semilla/i,
    /micelio/i,
    /deshidratado/i,
    /seco/i,
    /en polvo/i,
    /suplemento/i,
    /capsula/i,
    /extracto/i,
    /kit.*cultivo/i,
    /spawn/i,
    /sustrato/i,
  ];

  for (const product of products) {
    const queries = PRODUCT_ML_QUERIES[product];
    if (!queries) continue;

    /** @type {number[]} */
    let prices = [];

    for (const query of queries) {
      try {
        const encoded = encodeURIComponent(query);
        const url = `${ML_API_BASE}/sites/${ML_SITE}/search?q=${encoded}&limit=15`;
        const data = await fetchJson(url);
        const items = data.results || [];

        for (const item of items) {
          const title = (item.title || "").toLowerCase();
          const isRelevant = !excludePatterns.some((p) => p.test(title));
          if (isRelevant && item.price > 0) {
            prices.push(item.price);
          }
        }

        // Уважаем rate limit ML API
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`  [WARN] ML "${query}": ${err.message}`);
      }
    }

    // Дедупликация и агрегация
    prices = [...new Set(prices)].sort((a, b) => a - b);

    if (prices.length > 0) {
      const sum = prices.reduce((s, p) => s + p, 0);
      result[product] = {
        avg: Math.round(sum / prices.length),
        min: prices[0],
        max: prices[prices.length - 1],
        count: prices.length,
      };
    } else {
      result[product] = { avg: null, min: null, max: null, count: 0 };
    }
  }

  return result;
}

// ── Форматирование Telegram-отчёта ──────────────────────────────────────────

/**
 * Форматирует отчёт для Telegram (HTML)
 * @param {ProductPricing[]} products
 * @param {CostAnalysis} costAnalysis
 * @param {number} targetMargin
 * @param {boolean} withCompetitors
 * @returns {string}
 */
function formatTelegramReport(products, costAnalysis, targetMargin, withCompetitors) {
  const today = new Date().toISOString().slice(0, 10);

  let msg = `<b>ЦЕНОВОЙ АНАЛИЗ PEPINO PICK</b>\n`;
  msg += `${today} | Период: ${ANALYSIS_DAYS} дней\n\n`;

  // Сводка по себестоимости
  msg += `<b>Себестоимость:</b>\n`;
  msg += `  Расходы: ${costAnalysis.totalExpensesArs.toLocaleString("es-AR")} ARS`;
  msg += ` (${costAnalysis.expenseCount} записей)\n`;
  msg += `  Продано: ${costAnalysis.totalKgSold} кг`;
  msg += ` (${costAnalysis.saleCount} продаж)\n`;
  msg += `  Себестоимость: <b>${costAnalysis.costPerKg.toLocaleString("es-AR")} ARS/кг</b>\n`;
  msg += `  Целевая маржа: ${Math.round(targetMargin * 100)}%\n\n`;

  if (products.length === 0) {
    msg += `<i>Нет данных о продажах за период.</i>\n`;
    return msg;
  }

  // Таблица по продуктам
  const needsApprovalList = products.filter((p) => p.needsApproval);
  if (needsApprovalList.length > 0) {
    msg += `<b>ТРЕБУЮТ УТВЕРЖДЕНИЯ (L2):</b>\n`;
    for (const p of needsApprovalList) {
      const arrow = p.priceChangePct > 0 ? "+" : "";
      msg += `  ${p.product}: ${p.currentAvgPrice} -> ${p.recommendedPrice} ARS/кг`;
      msg += ` (${arrow}${p.priceChangePct}%)\n`;
    }
    msg += `\n`;
  }

  msg += `<b>Рекомендации по продуктам:</b>\n`;
  for (const p of products) {
    const icon = p.needsApproval
      ? "!!"
      : p.priceChangePct > 5
        ? "+"
        : p.priceChangePct < -5
          ? "-"
          : "=";
    msg += `\n<b>${p.product}</b> [${icon}]\n`;
    msg += `  Текущая: ${p.currentAvgPrice.toLocaleString("es-AR")} ARS/кг`;
    msg += ` (мин ${p.currentMinPrice.toLocaleString("es-AR")}, макс ${p.currentMaxPrice.toLocaleString("es-AR")})\n`;
    msg += `  Рекомендуемая: <b>${p.recommendedPrice.toLocaleString("es-AR")} ARS/кг</b>\n`;
    msg += `  Текущая маржа: ${p.currentMargin}% | Продано: ${p.totalKgSold} кг (${p.saleCount} продаж)\n`;

    if (withCompetitors && p.competitor && p.competitor.avg) {
      msg += `  Конкуренты (ML): avg ${p.competitor.avg.toLocaleString("es-AR")}`;
      msg += `, min ${p.competitor.min.toLocaleString("es-AR")}`;
      msg += `, max ${p.competitor.max.toLocaleString("es-AR")}`;
      msg += ` (${p.competitor.count} листингов)\n`;
    }

    msg += `  -> ${p.recommendation}\n`;
  }

  msg += `\n<i>Автоматическое изменение цен запрещено. Все изменения требуют подтверждения.</i>`;

  return msg;
}

// ── Запись в Sheets ─────────────────────────────────────────────────────────

/**
 * Записывает результаты анализа в лист "Ценовой мониторинг"
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {ProductPricing[]} products
 * @param {CostAnalysis} costAnalysis
 */
async function writeToSheets(sheets, products, costAnalysis) {
  const today = new Date().toISOString().slice(0, 10);

  const rows = products.map((p) => [
    today,
    p.product,
    p.costPerKg,
    p.currentAvgPrice,
    p.recommendedPrice,
    `${p.currentMargin}%`,
    `${Math.round(p.targetMargin * 100)}%`,
    `${p.priceChangePct}%`,
    p.needsApproval ? "L2 APPROVAL" : "AUTO",
    p.recommendation,
    p.competitor ? p.competitor.avg || "—" : "—",
    p.totalKgSold,
    p.saleCount,
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: PEPINO_SHEETS_ID,
      range: `'${PRICING_SHEET}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values: rows },
    });
    console.log(`[OK] Записано ${rows.length} строк в "${PRICING_SHEET}"`);
  } catch (err) {
    if (err.message && err.message.includes("Unable to parse range")) {
      // Лист не существует -- создаём с заголовками
      console.log(`[INFO] Создаю лист "${PRICING_SHEET}"...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: PEPINO_SHEETS_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: PRICING_SHEET } } }],
        },
      });

      const headers = [
        "Дата",
        "Продукт",
        "Себестоимость ARS/кг",
        "Текущая цена ARS/кг",
        "Рекомендуемая цена ARS/кг",
        "Текущая маржа",
        "Целевая маржа",
        "Изменение %",
        "Статус",
        "Рекомендация",
        "Конкуренты avg ARS",
        "Продано кг",
        "Кол-во продаж",
      ];

      await sheets.spreadsheets.values.update({
        spreadsheetId: PEPINO_SHEETS_ID,
        range: `'${PRICING_SHEET}'!A1`,
        valueInputOption: "USER_ENTERED",
        resource: { values: [headers, ...rows] },
      });
      console.log(`[OK] Лист "${PRICING_SHEET}" создан, записано ${rows.length} строк`);
    } else {
      throw err;
    }
  }
}

// ── Основной процесс ───────────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {boolean} [options.dryRun=false]
 * @param {string|null} [options.product=null] -- фильтр по продукту
 * @param {number} [options.margin=0.5] -- целевая маржа (0.0 - 1.0)
 * @param {boolean} [options.withCompetitors=false] -- включить ML анализ
 */
async function runPricingAnalysis(options = {}) {
  const {
    dryRun = false,
    product: filterProduct = null,
    margin: targetMargin = 0.5,
    withCompetitors = false,
  } = options;

  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n=== PEPINO PICK -- ЦЕНОВОЙ АНАЛИЗ ===`);
  console.log(`Дата: ${today}`);
  console.log(`Режим: ${dryRun ? "dry-run (без записи и TG)" : "полный"}`);
  console.log(`Целевая маржа: ${Math.round(targetMargin * 100)}%`);
  console.log(`Конкуренты: ${withCompetitors ? "да" : "нет"}`);
  if (filterProduct) console.log(`Фильтр продукта: ${filterProduct}`);
  console.log("");

  // Шаг 1: Попытка загрузки из farm-state кеша
  let farmState = null;
  try {
    farmState = await require("./farm-state.cjs").getState();
  } catch (err) {
    console.log(`[INFO] farm-state недоступен: ${err.message}`);
  }

  /** @type {import("googleapis").sheets_v4.Sheets|null} */
  let sheets = null;

  // Шаг 2: Чтение продаж
  console.log(`[2/5] Чтение продаж за ${ANALYSIS_DAYS} дней...`);
  /** @type {SaleRecord[]} */
  let sales;

  if (farmState && farmState.sales && farmState.sales.length > 0) {
    // Парсим из farm-state (уже объекты) с фильтрацией по дате
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ANALYSIS_DAYS);
    sales = [];
    for (const row of farmState.sales) {
      const date = parseDate(row["Дата"]);
      if (!date || date < cutoff) continue;
      const product = normalizeProduct(row["Продукт"]);
      if (!product) continue;
      sales.push({
        date,
        client: (row["Клиент"] || "").trim(),
        product,
        kg: parseNum(row["Кол-во кг"]),
        pricePerKg: parseNum(row["Цена ARS/кг"]),
        totalArs: parseNum(row["Сумма ARS"]) || parseNum(row["Итого ARS"]),
        status: (row["Статус"] || "").trim(),
      });
    }
    console.log(`  Найдено ${sales.length} продаж (из farm-state кеша)`);
  } else {
    console.log("[1/5] Подключение к Google Sheets...");
    sheets = await getSheetsClient();
    sales = await readSales(sheets, ANALYSIS_DAYS);
    console.log(`  Найдено ${sales.length} продаж`);
  }

  // Фильтр по продукту если указан
  if (filterProduct) {
    const normalized = normalizeProduct(filterProduct);
    sales = sales.filter((s) => s.product.includes(normalized));
    console.log(`  После фильтра "${filterProduct}": ${sales.length} продаж`);
  }

  // Шаг 3: Чтение расходов
  console.log(`[3/5] Чтение расходов за ${ANALYSIS_DAYS} дней...`);
  /** @type {ExpenseRecord[]} */
  let expenses;

  if (farmState && farmState.expenses && farmState.expenses.length > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ANALYSIS_DAYS);
    expenses = [];
    for (const row of farmState.expenses) {
      const date = parseDate(row["Дата"]);
      if (!date || date < cutoff) continue;
      expenses.push({
        date,
        name: (row["Наименование"] || "").trim(),
        qty: parseNum(row["Кол-во"]),
        unit: (row["Единицы"] || "").trim(),
        amountArs: parseNum(row["Сумма ARS"]),
      });
    }
    console.log(`  Найдено ${expenses.length} записей расходов (из farm-state кеша)`);
  } else {
    if (!sheets) {
      console.log("[1/5] Подключение к Google Sheets...");
      sheets = await getSheetsClient();
    }
    expenses = await readExpenses(sheets, ANALYSIS_DAYS);
    console.log(`  Найдено ${expenses.length} записей расходов`);
  }

  // Шаг 4: Расчёт себестоимости
  console.log("[4/5] Расчёт себестоимости и рекомендаций...");
  const costAnalysis = calculateOverallCost(expenses, sales);
  console.log(`  Себестоимость: ${costAnalysis.costPerKg} ARS/кг`);
  console.log(`  Всего расходов: ${costAnalysis.totalExpensesArs} ARS`);
  console.log(`  Всего продано: ${costAnalysis.totalKgSold} кг`);

  // Опциональный конкурентный анализ
  /** @type {Record<string, {avg: number|null, min: number|null, max: number|null, count: number}>} */
  let competitorPrices = {};
  if (withCompetitors) {
    console.log("  Загрузка цен конкурентов (Mercado Libre)...");
    const productNames = [...new Set(sales.map((s) => s.product))];
    competitorPrices = await fetchCompetitorPrices(productNames);
    const found = Object.values(competitorPrices).filter((c) => c.count > 0).length;
    console.log(`  Найдены конкуренты для ${found}/${productNames.length} продуктов`);
  }

  // Анализ по продуктам
  const products = analyzeProducts(sales, costAnalysis, targetMargin, competitorPrices);
  console.log(`  Проанализировано ${products.length} продуктов\n`);

  // Вывод в консоль
  for (const p of products) {
    const flag = p.needsApproval ? " [L2 APPROVAL]" : "";
    console.log(`  ${p.product}${flag}:`);
    console.log(
      `    Текущая: ${p.currentAvgPrice} ARS/кг | Рекомендуемая: ${p.recommendedPrice} ARS/кг`,
    );
    console.log(`    Маржа: ${p.currentMargin}% | Изменение: ${p.priceChangePct}%`);
    console.log(`    -> ${p.recommendation}`);
  }

  // Шаг 5: Отправка и запись
  console.log("\n[5/5] Формирование отчёта...");

  const report = {
    date: today,
    generated_at: new Date().toISOString(),
    cost_analysis: costAnalysis,
    target_margin: targetMargin,
    products,
    summary: {
      total_products: products.length,
      needs_approval: products.filter((p) => p.needsApproval).length,
      avg_current_margin:
        products.length > 0
          ? Math.round((products.reduce((s, p) => s + p.currentMargin, 0) / products.length) * 10) /
            10
          : 0,
    },
    guardrail: "ТОЛЬКО РЕКОМЕНДАЦИИ. Автоматическое изменение цен запрещено.",
  };

  if (dryRun) {
    console.log("\n[DRY-RUN] JSON-отчёт:");
    console.log(JSON.stringify(report, null, 2));
    console.log("\n[DRY-RUN] Запись в Sheets и Telegram пропущены");
  } else {
    // Запись в Sheets (подключаемся к Sheets если ещё не подключены)
    try {
      if (!sheets) sheets = await getSheetsClient();
      await writeToSheets(sheets, products, costAnalysis);
    } catch (err) {
      console.error(`[ERROR] Запись в Sheets: ${err.message}`);
    }

    // Отправка в Telegram
    const tgMsg = formatTelegramReport(products, costAnalysis, targetMargin, withCompetitors);
    try {
      const tgResult = await sendReport(tgMsg, TG_THREAD_PRICING, "HTML");
      if (tgResult.ok) {
        console.log("[OK] Отчёт отправлен в Telegram");
      } else {
        console.error(`[ERROR] Telegram: ${tgResult.error}`);
      }
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "auto-pricing",
    input: {
      days: ANALYSIS_DAYS,
      target_margin: targetMargin,
      filter_product: filterProduct,
      with_competitors: withCompetitors,
      dry_run: dryRun,
    },
    output: {
      products_analyzed: report.summary.total_products,
      needs_approval: report.summary.needs_approval,
      avg_margin: report.summary.avg_current_margin,
      cost_per_kg: costAnalysis.costPerKg,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", script: "auto-pricing" },
  });

  console.log(`\nГотово за ${durationMs}мс`);
  return report;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withCompetitors = args.includes("--with-competitors");

const productIdx = args.indexOf("--product");
const product = productIdx !== -1 && args[productIdx + 1] ? args[productIdx + 1] : null;

const marginIdx = args.indexOf("--margin");
const margin = marginIdx !== -1 && args[marginIdx + 1] ? parseFloat(args[marginIdx + 1]) : 0.5;

if (isNaN(margin) || margin <= 0 || margin >= 1) {
  console.error("[ERROR] --margin должен быть числом от 0.01 до 0.99 (например 0.5 = 50%)");
  process.exit(1);
}

runPricingAnalysis({ dryRun, product, margin, withCompetitors }).catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
