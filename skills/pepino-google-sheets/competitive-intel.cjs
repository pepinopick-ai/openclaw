/**
 * competitive-intel.cjs -- Конкурентная разведка цен Pepino Pick
 *
 * Логика:
 * 1. Поиск конкурентов на Mercado Libre по ключевым запросам
 *    (hongos ostra, setas, girgolas, microverdes, brotes)
 * 2. Чтение наших текущих цен из "🛒 Продажи"
 * 3. Сравнение: наша цена vs рынок (позиция, отклонение)
 * 4. Запись истории в "Ценовой мониторинг" с пометкой COMPETITIVE
 * 5. Telegram-отчёт в thread 20 (Ценообразование)
 * 6. Langfuse tracing
 *
 * Использование:
 *   node competitive-intel.cjs                   -- полный анализ + TG
 *   node competitive-intel.cjs --dry-run          -- только вывод в консоль
 *   node competitive-intel.cjs --category mushrooms -- только грибы
 *   node competitive-intel.cjs --category greens    -- только микрозелень
 *
 * Расписание: еженедельно понедельник 11:00
 */

"use strict";

const fs = require("fs");
const https = require("https");
const { google } = require("googleapis");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");

// ── Конфигурация ──────────────────────────────────────────────────────────────

const PEPINO_SHEETS_ID = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";

const SALES_SHEET = "🛒 Продажи";
const MONITORING_SHEET = "Ценовой мониторинг";

/** Telegram thread для ценообразования */
const TG_THREAD_PRICING = 20;

/** Mercado Libre API -- Аргентина */
const ML_API_BASE = "https://api.mercadolibre.com/sites/MLA/search";

/** Период для расчёта наших средних цен (дни) */
const OUR_PRICE_DAYS = 30;

/**
 * Категории продуктов и поисковые запросы для Mercado Libre.
 * Каждая категория содержит:
 *   queries -- массив поисковых запросов для ML
 *   ourProducts -- массив наших названий продуктов (для сопоставления из Sheets)
 *   exclude -- регулярки для фильтрации нерелевантных результатов
 *   unitNormalize -- функция нормализации цены к "за кг" (если нужно)
 */
const CATEGORIES = {
  mushrooms: {
    label: "Грибы (вешенка / girgolas)",
    queries: [
      "hongos ostra frescos",
      "hongos girgolas frescas",
      "setas frescas kg",
      "hongos ostra kg",
      "girgolas frescas bandeja",
    ],
    ourProducts: ["вешенка", "гриб", "oyster", "girgola"],
    exclude: [
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
      /libro/i,
      /conserva/i,
      /enlatado/i,
      /lata/i,
      /deco/i,
    ],
  },
  greens: {
    label: "Микрозелень / Brotes",
    queries: [
      "microverdes bandeja",
      "microgreens frescos",
      "brotes frescos bandeja",
      "brotes alfalfa",
      "germinados frescos",
    ],
    ourProducts: ["микрозелень", "microgreen", "brotes", "зелень"],
    exclude: [
      /semilla/i,
      /seed/i,
      /kit.*cultivo/i,
      /germinador/i,
      /libro/i,
      /suplemento/i,
      /capsula/i,
      /en polvo/i,
      /deshidratado/i,
      /maceta/i,
      /planta/i,
    ],
  },
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * GET-запрос к HTTPS endpoint, возвращает распарсенный JSON
 * @param {string} url
 * @returns {Promise<Object>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} от ${url}: ${data.slice(0, 200)}`));
          return;
        }
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

// ── Google Sheets клиент ──────────────────────────────────────────────────────

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

// ── Парсинг ───────────────────────────────────────────────────────────────────

/**
 * Парсит дату из формата DD/MM/YYYY или YYYY-MM-DD
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const str = dateStr.trim();

  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return new Date(parseInt(slashMatch[3]), parseInt(slashMatch[2]) - 1, parseInt(slashMatch[1]));
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  return null;
}

/**
 * Парсит число из строки (поддержка запятых как разделителя десятичных)
 * @param {string} val
 * @returns {number}
 */
function parseNum(val) {
  if (!val) return 0;
  const cleaned = val.toString().replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ── Поиск конкурентов на Mercado Libre ────────────────────────────────────────

/**
 * @typedef {Object} MLListing
 * @property {string} title     -- название листинга
 * @property {number} price     -- цена в ARS
 * @property {string} permalink -- ссылка на товар
 * @property {string} seller    -- имя продавца
 * @property {string} condition -- new/used
 * @property {number} soldQty   -- количество проданных
 */

/**
 * Ищет товары на Mercado Libre по одному запросу
 * @param {string} query -- поисковый запрос
 * @param {RegExp[]} excludePatterns -- шаблоны для фильтрации
 * @returns {Promise<MLListing[]>}
 */
async function searchML(query, excludePatterns) {
  const encoded = encodeURIComponent(query);
  const url = `${ML_API_BASE}?q=${encoded}&limit=15`;

  try {
    const data = await fetchJson(url);
    const items = data.results || [];

    /** @type {MLListing[]} */
    const listings = [];

    for (const item of items) {
      const title = (item.title || "").toLowerCase();

      // Фильтрация нерелевантных результатов
      const isExcluded = excludePatterns.some((p) => p.test(title));
      if (isExcluded) continue;

      if (item.price > 0) {
        listings.push({
          title: item.title || "",
          price: item.price,
          permalink: item.permalink || "",
          seller: item.seller?.nickname || "unknown",
          condition: item.condition || "unknown",
          soldQty: item.sold_quantity || 0,
        });
      }
    }

    return listings;
  } catch (err) {
    console.error(`  [WARN] ML "${query}": ${err.message}`);
    return [];
  }
}

/**
 * @typedef {Object} CategoryResult
 * @property {string} categoryKey   -- ключ категории
 * @property {string} label         -- человеко-читаемое название
 * @property {MLListing[]} listings -- все найденные листинги
 * @property {{avg: number, median: number, min: number, max: number, count: number, p25: number, p75: number}|null} stats
 * @property {string[]} queriesUsed -- какие запросы отработали
 */

/**
 * Собирает данные по всем запросам для одной категории
 * @param {string} categoryKey
 * @param {typeof CATEGORIES[keyof typeof CATEGORIES]} category
 * @returns {Promise<CategoryResult>}
 */
async function fetchCategoryPrices(categoryKey, category) {
  /** @type {MLListing[]} */
  let allListings = [];
  /** @type {string[]} */
  const queriesUsed = [];

  for (const query of category.queries) {
    const listings = await searchML(query, category.exclude);
    if (listings.length > 0) {
      queriesUsed.push(query);
      allListings = allListings.concat(listings);
    }

    // Уважаем rate limit ML API (макс 2 req/s)
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  // Дедупликация по permalink
  const seen = new Set();
  allListings = allListings.filter((l) => {
    if (seen.has(l.permalink)) return false;
    seen.add(l.permalink);
    return true;
  });

  // Статистика по ценам
  if (allListings.length === 0) {
    return { categoryKey, label: category.label, listings: [], stats: null, queriesUsed };
  }

  const prices = allListings.map((l) => l.price).sort((a, b) => a - b);
  const sum = prices.reduce((s, p) => s + p, 0);
  const median =
    prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];

  return {
    categoryKey,
    label: category.label,
    listings: allListings,
    stats: {
      avg: Math.round(sum / prices.length),
      median: Math.round(median),
      min: prices[0],
      max: prices[prices.length - 1],
      count: prices.length,
      p25: Math.round(p25),
      p75: Math.round(p75),
    },
    queriesUsed,
  };
}

// ── Чтение наших текущих цен ──────────────────────────────────────────────────

/**
 * @typedef {Object} OurPriceInfo
 * @property {string} product           -- название продукта
 * @property {number} avgPrice          -- средняя цена за период
 * @property {number} lastPrice         -- цена последней продажи
 * @property {number} totalKg           -- объём продаж (кг)
 * @property {number} saleCount         -- количество продаж
 */

/**
 * Читает наши текущие цены из листа продаж за последние N дней.
 * Группирует по продукту и возвращает словарь.
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {number} days
 * @returns {Promise<Record<string, OurPriceInfo>>}
 */
async function readOurPrices(sheets, days) {
  const allRows = await readSheetAsObjects(sheets, SALES_SHEET);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  /** @type {Record<string, {prices: number[], kg: number, count: number, lastDate: Date, lastPrice: number}>} */
  const byProduct = {};

  for (const row of allRows) {
    const date = parseDate(row["Дата"]);
    if (!date || date < cutoff) continue;

    const product = (row["Продукт"] || "").toLowerCase().trim();
    if (!product) continue;

    const pricePerKg = parseNum(row["Цена ARS/кг"]);
    const kg = parseNum(row["Кол-во кг"]);

    if (pricePerKg <= 0) continue;

    if (!byProduct[product]) {
      byProduct[product] = { prices: [], kg: 0, count: 0, lastDate: date, lastPrice: pricePerKg };
    }

    byProduct[product].prices.push(pricePerKg);
    byProduct[product].kg += kg;
    byProduct[product].count += 1;

    if (date > byProduct[product].lastDate) {
      byProduct[product].lastDate = date;
      byProduct[product].lastPrice = pricePerKg;
    }
  }

  /** @type {Record<string, OurPriceInfo>} */
  const result = {};
  for (const [product, data] of Object.entries(byProduct)) {
    const avg = Math.round(data.prices.reduce((s, p) => s + p, 0) / data.prices.length);
    result[product] = {
      product,
      avgPrice: avg,
      lastPrice: data.lastPrice,
      totalKg: Math.round(data.kg * 100) / 100,
      saleCount: data.count,
    };
  }

  return result;
}

/**
 * Находит наши цены для продуктов, соответствующих категории
 * @param {Record<string, OurPriceInfo>} ourPrices
 * @param {string[]} productPatterns -- паттерны для поиска наших продуктов
 * @returns {OurPriceInfo|null}
 */
function matchOurPrice(ourPrices, productPatterns) {
  for (const [product, info] of Object.entries(ourPrices)) {
    for (const pattern of productPatterns) {
      if (product.includes(pattern.toLowerCase())) {
        return info;
      }
    }
  }
  return null;
}

// ── Сравнительный анализ ──────────────────────────────────────────────────────

/**
 * @typedef {Object} CompetitiveAnalysis
 * @property {string} category       -- категория
 * @property {string} label          -- название
 * @property {OurPriceInfo|null} ourPrice
 * @property {{avg: number, median: number, min: number, max: number, count: number, p25: number, p75: number}|null} marketStats
 * @property {number|null} priceDiffPct -- отклонение нашей цены от рыночной медианы (%)
 * @property {string} position       -- BELOW_MARKET | AT_MARKET | ABOVE_MARKET | NO_DATA
 * @property {string} insight        -- текстовая рекомендация
 * @property {MLListing[]} topListings -- топ-5 листингов (для отчёта)
 */

/**
 * Формирует сравнительный анализ по категории
 * @param {CategoryResult} categoryResult
 * @param {Record<string, OurPriceInfo>} ourPrices
 * @returns {CompetitiveAnalysis}
 */
function buildAnalysis(categoryResult, ourPrices) {
  const { categoryKey, label, stats, listings } = categoryResult;
  const ourPrice = matchOurPrice(ourPrices, CATEGORIES[categoryKey].ourProducts);

  // Топ-5 по количеству продаж (самые популярные конкуренты)
  const topListings = [...listings].sort((a, b) => b.soldQty - a.soldQty).slice(0, 5);

  if (!stats) {
    return {
      category: categoryKey,
      label,
      ourPrice,
      marketStats: null,
      priceDiffPct: null,
      position: "NO_DATA",
      insight: "Нет данных о конкурентах на Mercado Libre",
      topListings,
    };
  }

  if (!ourPrice) {
    return {
      category: categoryKey,
      label,
      ourPrice: null,
      marketStats: stats,
      priceDiffPct: null,
      position: "NO_DATA",
      insight: `Рынок: ${stats.median} ARS (медиана). Нет наших продаж для сравнения.`,
      topListings,
    };
  }

  // Сравнение с медианой рынка
  const diffPct = Math.round(((ourPrice.avgPrice - stats.median) / stats.median) * 1000) / 10;

  /** @type {string} */
  let position;
  /** @type {string} */
  let insight;

  if (diffPct < -15) {
    position = "BELOW_MARKET";
    insight =
      `Наша цена НИЖЕ рынка на ${Math.abs(diffPct)}%. ` +
      `Есть потенциал повышения до ${stats.p25} ARS (P25) без потери конкурентности.`;
  } else if (diffPct > 15) {
    position = "ABOVE_MARKET";
    insight =
      `Наша цена ВЫШЕ рынка на ${diffPct}%. ` +
      `Медиана рынка ${stats.median} ARS. Проверить обоснованность премиума.`;
  } else {
    position = "AT_MARKET";
    insight =
      `Наша цена на уровне рынка (${diffPct > 0 ? "+" : ""}${diffPct}% от медианы). ` +
      `Позиция конкурентная.`;
  }

  return {
    category: categoryKey,
    label,
    ourPrice,
    marketStats: stats,
    priceDiffPct: diffPct,
    position,
    insight,
    topListings,
  };
}

// ── Запись в Sheets ───────────────────────────────────────────────────────────

/**
 * Записывает результаты конкурентного анализа в лист "Ценовой мониторинг"
 * @param {import("googleapis").sheets_v4.Sheets} sheets
 * @param {CompetitiveAnalysis[]} analyses
 */
async function writeToSheets(sheets, analyses) {
  const today = new Date().toISOString().slice(0, 10);

  const rows = analyses
    .filter((a) => a.marketStats)
    .map((a) => [
      today,
      `[COMPETITIVE] ${a.label}`,
      a.ourPrice ? a.ourPrice.avgPrice : "—",
      a.marketStats ? a.marketStats.median : "—",
      a.marketStats ? a.marketStats.avg : "—",
      a.marketStats ? a.marketStats.min : "—",
      a.marketStats ? a.marketStats.max : "—",
      a.priceDiffPct !== null ? `${a.priceDiffPct}%` : "—",
      a.position,
      a.insight,
      a.marketStats ? a.marketStats.count : 0,
      a.ourPrice ? a.ourPrice.totalKg : "—",
      a.ourPrice ? a.ourPrice.saleCount : "—",
    ]);

  if (rows.length === 0) {
    console.log("[INFO] Нет данных для записи в Sheets");
    return;
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: PEPINO_SHEETS_ID,
      range: `'${MONITORING_SHEET}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values: rows },
    });
    console.log(`[OK] Записано ${rows.length} строк в "${MONITORING_SHEET}"`);
  } catch (err) {
    if (err.message && err.message.includes("Unable to parse range")) {
      // Лист не существует -- создаём с заголовками
      console.log(`[INFO] Создаю лист "${MONITORING_SHEET}"...`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: PEPINO_SHEETS_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: MONITORING_SHEET } } }],
        },
      });

      const headers = [
        "Дата",
        "Категория",
        "Наша цена ARS/кг",
        "Медиана рынка ARS",
        "Средняя рынка ARS",
        "Мин рынка ARS",
        "Макс рынка ARS",
        "Отклонение %",
        "Позиция",
        "Инсайт",
        "Кол-во листингов",
        "Наши продажи кг",
        "Наши кол-во продаж",
      ];

      await sheets.spreadsheets.values.update({
        spreadsheetId: PEPINO_SHEETS_ID,
        range: `'${MONITORING_SHEET}'!A1`,
        valueInputOption: "USER_ENTERED",
        resource: { values: [headers, ...rows] },
      });
      console.log(`[OK] Лист "${MONITORING_SHEET}" создан, записано ${rows.length} строк`);
    } else {
      throw err;
    }
  }
}

// ── Telegram-отчёт ────────────────────────────────────────────────────────────

/**
 * Форматирует HTML-отчёт для Telegram
 * @param {CompetitiveAnalysis[]} analyses
 * @returns {string}
 */
function formatTelegramReport(analyses) {
  const today = new Date().toISOString().slice(0, 10);

  let msg = `<b>КОНКУРЕНТНАЯ РАЗВЕДКА</b>\n`;
  msg += `${today} | Mercado Libre Argentina\n\n`;

  for (const a of analyses) {
    const positionIcon =
      a.position === "BELOW_MARKET"
        ? "[LOW]"
        : a.position === "ABOVE_MARKET"
          ? "[HIGH]"
          : a.position === "AT_MARKET"
            ? "[OK]"
            : "[?]";

    msg += `<b>${a.label}</b> ${positionIcon}\n`;

    if (!a.marketStats) {
      msg += `  Конкуренты не найдены\n\n`;
      continue;
    }

    // Рыночные данные
    msg += `  Рынок: медиана ${fmtArs(a.marketStats.median)}`;
    msg += ` (${fmtArs(a.marketStats.min)} - ${fmtArs(a.marketStats.max)})\n`;
    msg += `  P25: ${fmtArs(a.marketStats.p25)} | P75: ${fmtArs(a.marketStats.p75)}`;
    msg += ` | ${a.marketStats.count} листингов\n`;

    // Наша цена
    if (a.ourPrice) {
      msg += `  Наша цена: <b>${fmtArs(a.ourPrice.avgPrice)}</b>`;
      msg += ` (последняя: ${fmtArs(a.ourPrice.lastPrice)})\n`;
      msg += `  Отклонение: <b>${a.priceDiffPct > 0 ? "+" : ""}${a.priceDiffPct}%</b> от медианы\n`;
    } else {
      msg += `  Наша цена: <i>нет данных о продажах</i>\n`;
    }

    msg += `  -> ${a.insight}\n`;

    // Топ-3 конкурента
    if (a.topListings.length > 0) {
      msg += `  <b>Топ конкуренты:</b>\n`;
      for (const l of a.topListings.slice(0, 3)) {
        const shortTitle = l.title.length > 40 ? l.title.slice(0, 40) + "..." : l.title;
        msg += `    ${fmtArs(l.price)} -- ${shortTitle}`;
        if (l.soldQty > 0) msg += ` (${l.soldQty} продано)`;
        msg += `\n`;
      }
    }

    msg += `\n`;
  }

  msg += `<i>Данные: Mercado Libre API (публичный поиск). Цены могут не отражать оптовые условия.</i>`;

  return msg;
}

/**
 * Форматирует число как ARS
 * @param {number} n
 * @returns {string}
 */
function fmtArs(n) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("es-AR") + " ARS";
}

// ── Основной процесс ─────────────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {boolean} [options.dryRun=false]
 * @param {string|null} [options.category=null] -- фильтр: "mushrooms" | "greens"
 */
async function runCompetitiveIntel(options = {}) {
  const { dryRun = false, category: filterCategory = null } = options;

  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n=== PEPINO PICK -- КОНКУРЕНТНАЯ РАЗВЕДКА ===`);
  console.log(`Дата: ${today}`);
  console.log(`Режим: ${dryRun ? "dry-run (без записи и TG)" : "полный"}`);
  if (filterCategory) console.log(`Категория: ${filterCategory}`);
  console.log("");

  // Определяем категории для анализа
  /** @type {[string, typeof CATEGORIES[keyof typeof CATEGORIES]][]} */
  let categoriesToProcess = Object.entries(CATEGORIES);
  if (filterCategory) {
    if (!CATEGORIES[filterCategory]) {
      console.error(`[ERROR] Неизвестная категория: ${filterCategory}`);
      console.error(`  Доступные: ${Object.keys(CATEGORIES).join(", ")}`);
      process.exit(1);
    }
    categoriesToProcess = [[filterCategory, CATEGORIES[filterCategory]]];
  }

  // Шаг 1: Подключение к Google Sheets
  console.log("[1/4] Подключение к Google Sheets...");
  const sheets = await getSheetsClient();

  // Шаг 2: Чтение наших текущих цен
  console.log(`[2/4] Чтение наших цен за ${OUR_PRICE_DAYS} дней...`);
  const ourPrices = await readOurPrices(sheets, OUR_PRICE_DAYS);
  const productCount = Object.keys(ourPrices).length;
  console.log(`  Найдено ${productCount} продуктов с ценами`);

  // Шаг 3: Поиск конкурентов на Mercado Libre
  console.log("[3/4] Поиск конкурентов на Mercado Libre...");
  /** @type {CompetitiveAnalysis[]} */
  const analyses = [];

  for (const [key, cat] of categoriesToProcess) {
    console.log(`  Категория: ${cat.label}...`);
    const categoryResult = await fetchCategoryPrices(key, cat);
    console.log(
      `    Найдено ${categoryResult.listings.length} листингов (запросы: ${categoryResult.queriesUsed.length}/${cat.queries.length})`,
    );

    const analysis = buildAnalysis(categoryResult, ourPrices);
    analyses.push(analysis);

    // Вывод в консоль
    if (analysis.marketStats) {
      console.log(`    Медиана рынка: ${analysis.marketStats.median} ARS`);
      if (analysis.ourPrice) {
        console.log(
          `    Наша цена: ${analysis.ourPrice.avgPrice} ARS (${analysis.priceDiffPct > 0 ? "+" : ""}${analysis.priceDiffPct}%)`,
        );
      }
      console.log(`    Позиция: ${analysis.position}`);
    } else {
      console.log(`    Конкуренты не найдены`);
    }
  }

  // Шаг 4: Отправка и запись
  console.log("\n[4/4] Формирование отчёта...");

  const report = {
    date: today,
    generated_at: new Date().toISOString(),
    categories: analyses.map((a) => ({
      category: a.category,
      label: a.label,
      position: a.position,
      priceDiffPct: a.priceDiffPct,
      marketStats: a.marketStats,
      ourAvgPrice: a.ourPrice ? a.ourPrice.avgPrice : null,
      listingsCount: a.topListings.length,
      insight: a.insight,
    })),
    summary: {
      total_categories: analyses.length,
      with_data: analyses.filter((a) => a.marketStats).length,
      below_market: analyses.filter((a) => a.position === "BELOW_MARKET").length,
      above_market: analyses.filter((a) => a.position === "ABOVE_MARKET").length,
      at_market: analyses.filter((a) => a.position === "AT_MARKET").length,
    },
  };

  if (dryRun) {
    console.log("\n[DRY-RUN] JSON-отчёт:");
    console.log(JSON.stringify(report, null, 2));
    console.log("\n[DRY-RUN] Telegram-отчёт:");
    console.log(formatTelegramReport(analyses));
    console.log("\n[DRY-RUN] Запись в Sheets и Telegram пропущены");
  } else {
    // Запись в Sheets
    try {
      await writeToSheets(sheets, analyses);
    } catch (err) {
      console.error(`[ERROR] Запись в Sheets: ${err.message}`);
    }

    // Отправка в Telegram
    const tgMsg = formatTelegramReport(analyses);
    try {
      const tgResult = await sendReport(tgMsg, TG_THREAD_PRICING, "HTML");
      if (tgResult.ok) {
        console.log("[OK] Отчёт отправлен в Telegram (thread 20)");
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
    name: "competitive-intel",
    input: {
      categories: categoriesToProcess.map(([k]) => k),
      our_price_days: OUR_PRICE_DAYS,
      dry_run: dryRun,
    },
    output: {
      categories_analyzed: report.summary.total_categories,
      with_market_data: report.summary.with_data,
      below_market: report.summary.below_market,
      above_market: report.summary.above_market,
      at_market: report.summary.at_market,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", script: "competitive-intel" },
  });

  console.log(`\nГотово за ${durationMs}мс`);
  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const categoryIdx = args.indexOf("--category");
const category = categoryIdx !== -1 && args[categoryIdx + 1] ? args[categoryIdx + 1] : null;

runCompetitiveIntel({ dryRun, category }).catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
