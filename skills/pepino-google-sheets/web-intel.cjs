#!/usr/bin/env node
/**
 * Pepino Pick — Web Intelligence Tool
 *
 * Единый инструмент рыночной разведки: поиск цен, поставщиков, конкурентов,
 * новостей. Результаты сохраняются в Google Sheets и отправляются в Telegram.
 *
 * Команды:
 *   node web-intel.cjs prices "hongos ostra" --country AR
 *   node web-intel.cjs suppliers "sustrato hongos" --country AR
 *   node web-intel.cjs competitors "pepinos frescos cordoba"
 *   node web-intel.cjs news "agricultura argentina invernadero 2026"
 *   node web-intel.cjs report
 *
 * Флаги:
 *   --dry-run    Не записывать в Sheets и не отправлять в Telegram
 *   --country XX Код страны для Mercado Libre (AR, MX, CL и т.д.)
 *
 * Источники: Mercado Libre API, DuckDuckGo Instant Answer API
 * Лист: "📊 Рыночная разведка"
 * Telegram: thread 20 (Стратегия/Директор)
 *
 * Cron: по запросу (не автоматический)
 */

"use strict";

const https = require("https");
const http = require("http");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const INTEL_SHEET = "📊 Рыночная разведка";
const INTEL_HEADERS = [
  "Дата",
  "Тип",
  "Запрос",
  "Источник",
  "Название",
  "Цена",
  "Валюта",
  "URL",
  "Продавец",
  "Продано",
  "Примечание",
];

const TG_THREAD_ID = 20; // Стратегия/Директор

/** Коды сайтов Mercado Libre по странам */
const ML_SITES = {
  AR: "MLA",
  MX: "MLM",
  CL: "MLC",
  CO: "MCO",
  BR: "MLB",
  UY: "MLU",
  PE: "MPE",
};

// ── CLI parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const countryIdx = args.indexOf("--country");
const COUNTRY =
  countryIdx !== -1 && args[countryIdx + 1] ? args[countryIdx + 1].toUpperCase() : "AR";

// Убираем флаги из аргументов, оставляя только позиционные
const positional = args.filter((a, i) => {
  if (a === "--dry-run") return false;
  if (a === "--country") return false;
  if (i > 0 && args[i - 1] === "--country") return false;
  return true;
});

const COMMAND = positional[0] || "";
const QUERY = positional.slice(1).join(" ");

// ── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Выполняет HTTPS GET запрос и возвращает JSON.
 * @param {string} url - Полный URL
 * @param {number} [timeoutMs=15000] - Таймаут в мс
 * @returns {Promise<any>}
 */
function httpsGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;

    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      // Обработка редиректов (Mercado Libre иногда редиректит)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGetJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${parsedUrl.hostname}${parsedUrl.pathname}`));
        return;
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`JSON parse error from ${parsedUrl.hostname}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout ${timeoutMs}ms: ${url}`));
    });
  });
}

// ── Sheets helpers (ESM import из CJS) ──────────────────────────────────────

/** @type {null | {readSheet: Function, appendToSheet: Function, PEPINO_SHEETS_ID: string}} */
let _sheets = null;

async function getSheets() {
  if (!_sheets) {
    _sheets = await import("./sheets.js");
  }
  return _sheets;
}

/**
 * Записывает строки в лист разведки.
 * Автоматически создаёт лист с заголовками при первом обращении (через appendToSheet).
 * @param {string[][]} rows - Массив строк для записи
 */
async function saveToSheet(rows) {
  if (DRY_RUN) {
    console.log(`[dry-run] Пропущена запись ${rows.length} строк в Sheets`);
    return;
  }

  const { appendToSheet, readSheet, PEPINO_SHEETS_ID } = await getSheets();

  // Проверяем, существует ли лист (есть ли заголовки)
  let needHeaders = false;
  try {
    const existing = await readSheet(PEPINO_SHEETS_ID, INTEL_SHEET);
    if (!existing || existing.length === 0) {
      needHeaders = true;
    }
  } catch {
    // Лист не существует — appendToSheet создаст его автоматически
    needHeaders = true;
  }

  const dataToWrite = needHeaders ? [INTEL_HEADERS, ...rows] : rows;
  await appendToSheet(PEPINO_SHEETS_ID, dataToWrite, INTEL_SHEET);
  console.log(`[OK] Записано ${rows.length} строк в "${INTEL_SHEET}"`);
}

/**
 * Читает все данные из листа разведки.
 * @returns {Promise<{headers: string[], rows: object[]}>}
 */
async function readIntelSheet() {
  const { readSheet, PEPINO_SHEETS_ID } = await getSheets();
  const raw = await readSheet(PEPINO_SHEETS_ID, INTEL_SHEET);
  if (!raw || raw.length < 2) {
    return { headers: INTEL_HEADERS, rows: [] };
  }
  const headers = raw[0];
  const rows = raw.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] || "";
    });
    return obj;
  });
  return { headers, rows };
}

// ── Mercado Libre API ───────────────────────────────────────────────────────

/**
 * Поиск товаров на Mercado Libre.
 * @param {string} query - Поисковый запрос
 * @param {string} siteId - Код сайта ML (MLA, MLM и т.д.)
 * @param {number} [limit=20] - Количество результатов
 * @returns {Promise<object[]>} - Массив результатов
 */
async function searchMercadoLibre(query, siteId, limit = 20) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.mercadolibre.com/sites/${siteId}/search?q=${encoded}&limit=${limit}`;
  console.log(`[ML] Запрос: ${url}`);

  const data = await httpsGetJson(url);

  if (!data.results || !Array.isArray(data.results)) {
    console.warn("[ML] Нет результатов или неожиданный формат ответа");
    return [];
  }

  return data.results.map((item) => ({
    title: item.title || "",
    price: item.price || 0,
    currency: item.currency_id || "",
    seller: item.seller?.nickname || item.seller?.id?.toString() || "N/A",
    sellerReputation: item.seller?.seller_reputation?.level_id || "",
    sellerLocation: item.seller?.address?.city || item.address?.city_name || "",
    permalink: item.permalink || "",
    condition: item.condition || "",
    soldQuantity: item.sold_quantity || 0,
    availableQuantity: item.available_quantity || 0,
    listingType: item.listing_type_id || "",
    categoryId: item.category_id || "",
  }));
}

// ── DuckDuckGo API ──────────────────────────────────────────────────────────

/**
 * Поиск через DuckDuckGo Instant Answer API.
 * Возвращает абстракт и связанные темы.
 * @param {string} query
 * @returns {Promise<{abstract: string, topics: object[]}>}
 */
async function searchDuckDuckGo(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
  console.log(`[DDG] Запрос: ${url}`);

  const data = await httpsGetJson(url);

  const topics = [];

  // RelatedTopics могут содержать вложенные группы
  if (Array.isArray(data.RelatedTopics)) {
    for (const topic of data.RelatedTopics) {
      if (topic.Text && topic.FirstURL) {
        topics.push({
          text: topic.Text,
          url: topic.FirstURL,
        });
      }
      // Вложенные подтемы
      if (Array.isArray(topic.Topics)) {
        for (const sub of topic.Topics) {
          if (sub.Text && sub.FirstURL) {
            topics.push({
              text: sub.Text,
              url: sub.FirstURL,
            });
          }
        }
      }
    }
  }

  return {
    abstract: data.Abstract || data.AbstractText || "",
    abstractSource: data.AbstractSource || "",
    abstractUrl: data.AbstractURL || "",
    topics,
  };
}

// ── Команда: prices ─────────────────────────────────────────────────────────

async function cmdPrices(query) {
  const siteId = ML_SITES[COUNTRY] || "MLA";
  console.log(`\n--- Поиск цен: "${query}" (${COUNTRY}/${siteId}) ---\n`);

  const results = await searchMercadoLibre(query, siteId);

  if (results.length === 0) {
    console.log("Результатов не найдено.");
    return { rows: [], summary: "Нет результатов" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = results.map((r) => [
    today,
    "Цена",
    query,
    `ML-${siteId}`,
    r.title,
    String(r.price),
    r.currency,
    r.permalink,
    r.seller,
    String(r.soldQuantity),
    r.condition === "new" ? "Новый" : r.condition === "used" ? "Б/у" : r.condition,
  ]);

  // Статистика
  const prices = results.map((r) => r.price).filter((p) => p > 0);
  const avgPrice =
    prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const currency = results[0]?.currency || "ARS";
  const totalSold = results.reduce((s, r) => s + r.soldQuantity, 0);

  const summary = [
    `Найдено: ${results.length} товаров`,
    `Цена: ${minPrice.toLocaleString()} - ${maxPrice.toLocaleString()} ${currency} (ср. ${avgPrice.toLocaleString()})`,
    `Всего продано: ${totalSold}`,
  ].join("\n");

  console.log("\n" + summary);

  // Топ-5 по продажам
  const topSold = [...results].sort((a, b) => b.soldQuantity - a.soldQuantity).slice(0, 5);
  if (topSold.length > 0) {
    console.log("\nТоп по продажам:");
    for (const r of topSold) {
      console.log(
        `  ${r.price.toLocaleString()} ${r.currency} | ${r.soldQuantity} продано | ${r.title.slice(0, 60)}`,
      );
    }
  }

  await saveToSheet(rows);

  return { rows, summary, avgPrice, minPrice, maxPrice, currency, totalSold };
}

// ── Команда: suppliers ──────────────────────────────────────────────────────

async function cmdSuppliers(query) {
  const siteId = ML_SITES[COUNTRY] || "MLA";
  console.log(`\n--- Поиск поставщиков: "${query}" (${COUNTRY}/${siteId}) ---\n`);

  const results = await searchMercadoLibre(query, siteId, 20);

  if (results.length === 0) {
    console.log("Результатов не найдено.");
    return { rows: [], summary: "Нет результатов" };
  }

  // Фильтруем оптовых/бизнес продавцов:
  // - gold/platinum репутация (устоявшиеся продавцы)
  // - большое кол-во в наличии (оптовики обычно держат запас)
  // - ключевые слова: mayorista, por mayor, bulk, x kg, x unidades
  const wholesaleKeywords = /mayor|bulk|lote|pack|x\s*\d+|kg|kilos?|granel|fardo|bolsa/i;

  const suppliers = results
    .map((r) => {
      let score = 0;
      if (["5_green", "gold", "platinum"].includes(r.sellerReputation)) score += 2;
      if (r.availableQuantity > 10) score += 1;
      if (wholesaleKeywords.test(r.title)) score += 2;
      if (r.soldQuantity > 25) score += 1;
      return { ...r, wholesaleScore: score };
    })
    .filter((r) => r.wholesaleScore >= 1)
    .sort((a, b) => b.wholesaleScore - a.wholesaleScore);

  const today = new Date().toISOString().slice(0, 10);
  const rows = suppliers.map((r) => [
    today,
    "Поставщик",
    query,
    `ML-${siteId}`,
    r.title,
    String(r.price),
    r.currency,
    r.permalink,
    r.seller,
    String(r.soldQuantity),
    `Rep: ${r.sellerReputation || "N/A"}, Loc: ${r.sellerLocation || "N/A"}, Score: ${r.wholesaleScore}`,
  ]);

  // Если нет подходящих под фильтр — сохраняем все, но помечаем
  const allRows = results.map((r) => [
    today,
    "Поставщик",
    query,
    `ML-${siteId}`,
    r.title,
    String(r.price),
    r.currency,
    r.permalink,
    r.seller,
    String(r.soldQuantity),
    `Rep: ${r.sellerReputation || "N/A"}, Loc: ${r.sellerLocation || "N/A"}`,
  ]);

  const rowsToSave = suppliers.length > 0 ? rows : allRows;

  const summary = [
    `Всего результатов: ${results.length}`,
    `Потенциальных оптовиков: ${suppliers.length}`,
    suppliers.length > 0
      ? `Лучшие:\n${suppliers
          .slice(0, 5)
          .map(
            (r) =>
              `  ${r.seller} | ${r.price.toLocaleString()} ${r.currency} | ${r.title.slice(0, 50)}`,
          )
          .join("\n")}`
      : "Оптовых фильтров не прошёл ни один — сохранены все результаты",
  ].join("\n");

  console.log("\n" + summary);

  await saveToSheet(rowsToSave);

  return { rows: rowsToSave, summary, supplierCount: suppliers.length };
}

// ── Команда: competitors ────────────────────────────────────────────────────

async function cmdCompetitors(query) {
  const siteId = ML_SITES[COUNTRY] || "MLA";
  console.log(`\n--- Анализ конкурентов: "${query}" (${COUNTRY}/${siteId}) ---\n`);

  const results = await searchMercadoLibre(query, siteId, 20);

  if (results.length === 0) {
    console.log("Результатов не найдено.");
    return { rows: [], summary: "Нет результатов" };
  }

  // Загружаем наши цены из листа продаж для сравнения
  let ourPrices = {};
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await getSheets();
    const salesData = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    if (salesData && salesData.length > 1) {
      const headers = salesData[0];
      const productIdx = headers.findIndex((h) => h === "Продукт" || h === "продукт");
      const priceIdx = headers.findIndex(
        (h) => h === "Цена за кг" || h === "Цена" || h === "Price",
      );
      if (productIdx !== -1 && priceIdx !== -1) {
        // Собираем последнюю цену по каждому продукту
        for (const row of salesData.slice(1)) {
          const product = (row[productIdx] || "").toLowerCase().trim();
          const price = parseFloat(
            String(row[priceIdx] || "0")
              .replace(/[^\d.,]/g, "")
              .replace(",", "."),
          );
          if (product && price > 0) {
            ourPrices[product] = price;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[WARN] Не удалось загрузить наши цены: ${err.message}`);
  }

  const ourPriceKeys = Object.keys(ourPrices);
  const today = new Date().toISOString().slice(0, 10);

  // Группируем по продавцам для анализа позиционирования
  const bySeller = {};
  for (const r of results) {
    if (!bySeller[r.seller]) {
      bySeller[r.seller] = { items: [], totalSold: 0 };
    }
    bySeller[r.seller].items.push(r);
    bySeller[r.seller].totalSold += r.soldQuantity;
  }

  const rows = results.map((r) => {
    // Пытаемся найти совпадение с нашим продуктом для пометки
    const titleLower = r.title.toLowerCase();
    let note = "";
    for (const key of ourPriceKeys) {
      if (titleLower.includes(key)) {
        const diff = r.price - ourPrices[key];
        const pct = ourPrices[key] > 0 ? Math.round((diff / ourPrices[key]) * 100) : 0;
        const sign = diff > 0 ? "+" : "";
        note = `vs наша: ${sign}${Math.round(diff)} (${sign}${pct}%)`;
        break;
      }
    }
    if (!note) {
      note = `Seller sold total: ${bySeller[r.seller]?.totalSold || 0}`;
    }

    return [
      today,
      "Конкурент",
      query,
      `ML-${siteId}`,
      r.title,
      String(r.price),
      r.currency,
      r.permalink,
      r.seller,
      String(r.soldQuantity),
      note,
    ];
  });

  // Сортируем продавцов по суммарным продажам
  const topSellers = Object.entries(bySeller)
    .sort((a, b) => b[1].totalSold - a[1].totalSold)
    .slice(0, 5);

  const prices = results.map((r) => r.price).filter((p) => p > 0);
  const avgPrice =
    prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const currency = results[0]?.currency || "ARS";

  const summary = [
    `Найдено: ${results.length} товаров от ${Object.keys(bySeller).length} продавцов`,
    `Ценовой диапазон: ${Math.min(...prices).toLocaleString()} - ${Math.max(...prices).toLocaleString()} ${currency}`,
    `Средняя цена: ${avgPrice.toLocaleString()} ${currency}`,
    ourPriceKeys.length > 0
      ? `Наших продуктов для сравнения: ${ourPriceKeys.length}`
      : "Наши цены не найдены для автосравнения",
    "",
    "Топ продавцы:",
    ...topSellers.map(
      ([name, data]) => `  ${name} — ${data.items.length} товаров, ${data.totalSold} продано`,
    ),
  ].join("\n");

  console.log("\n" + summary);

  await saveToSheet(rows);

  return { rows, summary, avgPrice, sellerCount: Object.keys(bySeller).length };
}

// ── Команда: news ───────────────────────────────────────────────────────────

async function cmdNews(query) {
  console.log(`\n--- Поиск новостей: "${query}" ---\n`);

  const ddg = await searchDuckDuckGo(query);

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  // Добавляем абстракт, если есть
  if (ddg.abstract) {
    rows.push([
      today,
      "Новость",
      query,
      ddg.abstractSource || "DDG",
      `[Abstract] ${ddg.abstract.slice(0, 200)}`,
      "",
      "",
      ddg.abstractUrl,
      ddg.abstractSource,
      "",
      "Основной результат",
    ]);
  }

  // Добавляем связанные темы
  for (const topic of ddg.topics.slice(0, 15)) {
    rows.push([
      today,
      "Новость",
      query,
      "DDG",
      topic.text.slice(0, 200),
      "",
      "",
      topic.url,
      "",
      "",
      "",
    ]);
  }

  if (rows.length === 0) {
    console.log("DuckDuckGo не вернул результатов по этому запросу.");
    console.log("Совет: попробуйте более общий запрос на английском.");
    return { rows: [], summary: "Нет результатов" };
  }

  const summary = [
    ddg.abstract ? `Abstract: ${ddg.abstract.slice(0, 150)}...` : "Нет абстракта",
    `Связанных тем: ${ddg.topics.length}`,
    ddg.topics.length > 0
      ? `Первые:\n${ddg.topics
          .slice(0, 3)
          .map((t) => `  - ${t.text.slice(0, 80)}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  console.log("\n" + summary);

  await saveToSheet(rows);

  return { rows, summary, topicCount: ddg.topics.length };
}

// ── Команда: report ─────────────────────────────────────────────────────────

async function cmdReport() {
  console.log("\n--- Сводный отчёт рыночной разведки ---\n");

  const { rows } = await readIntelSheet();

  if (rows.length === 0) {
    console.log("Лист разведки пуст. Сначала выполните сбор данных.");
    return;
  }

  // Группируем по типу
  const byType = {};
  for (const row of rows) {
    const type = row["Тип"] || "Другое";
    if (!byType[type]) byType[type] = [];
    byType[type].push(row);
  }

  const lines = [];
  lines.push(`<b>📊 Сводка рыночной разведки</b>`);
  lines.push(`Всего записей: ${rows.length}\n`);

  // Средние цены конкурентов
  const priceEntries = [...(byType["Цена"] || []), ...(byType["Конкурент"] || [])];
  if (priceEntries.length > 0) {
    const prices = priceEntries.map((r) => parseFloat(r["Цена"])).filter((p) => p > 0);
    if (prices.length > 0) {
      const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      lines.push(`<b>💰 Цены конкурентов:</b>`);
      lines.push(`  Средняя: ${avg.toLocaleString()}`);
      lines.push(`  Диапазон: ${min.toLocaleString()} - ${max.toLocaleString()}`);
      lines.push(`  Записей: ${prices.length}\n`);
    }
  }

  // Поставщики
  const supplierEntries = byType["Поставщик"] || [];
  if (supplierEntries.length > 0) {
    const uniqueSellers = new Set(supplierEntries.map((r) => r["Продавец"]).filter(Boolean));
    lines.push(`<b>🏭 Поставщики:</b>`);
    lines.push(`  Найдено: ${uniqueSellers.size} уникальных`);
    lines.push(`  Записей: ${supplierEntries.length}\n`);
  }

  // Новости
  const newsEntries = byType["Новость"] || [];
  if (newsEntries.length > 0) {
    lines.push(`<b>📰 Новости:</b>`);
    lines.push(`  Записей: ${newsEntries.length}`);
    // Последние 3
    const latest = newsEntries.slice(-3);
    for (const n of latest) {
      const title = (n["Название"] || "").slice(0, 80);
      lines.push(`  - ${title}`);
    }
    lines.push("");
  }

  // Последняя дата обновления
  const dates = rows
    .map((r) => r["Дата"])
    .filter(Boolean)
    .sort();
  if (dates.length > 0) {
    lines.push(`<i>Данные: ${dates[0]} — ${dates[dates.length - 1]}</i>`);
  }

  const report = lines.join("\n");
  console.log(report.replace(/<[^>]+>/g, ""));

  // Отправляем в Telegram
  if (!DRY_RUN) {
    try {
      await sendReport(report, TG_THREAD_ID, "HTML");
      console.log("\n[OK] Отчёт отправлен в Telegram (thread 20)");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("\n[dry-run] Telegram отправка пропущена");
  }

  return { report };
}

// ── Main ────────────────────────────────────────────────────────────────────

const USAGE = `
Pepino Pick — Web Intelligence Tool

Использование:
  node web-intel.cjs prices "запрос" [--country AR] [--dry-run]
  node web-intel.cjs suppliers "запрос" [--country AR] [--dry-run]
  node web-intel.cjs competitors "запрос" [--dry-run]
  node web-intel.cjs news "запрос" [--dry-run]
  node web-intel.cjs report [--dry-run]

Примеры:
  node web-intel.cjs prices "hongos ostra" --country AR
  node web-intel.cjs suppliers "sustrato hongos" --country AR
  node web-intel.cjs competitors "pepinos frescos cordoba"
  node web-intel.cjs news "agricultura argentina invernadero 2026"
  node web-intel.cjs report
`.trim();

async function main() {
  const startMs = Date.now();

  if (!COMMAND || COMMAND === "help" || COMMAND === "--help") {
    console.log(USAGE);
    return;
  }

  const validCommands = ["prices", "suppliers", "competitors", "news", "report"];
  if (!validCommands.includes(COMMAND)) {
    console.error(`Неизвестная команда: "${COMMAND}"\n`);
    console.log(USAGE);
    process.exit(1);
  }

  if (COMMAND !== "report" && !QUERY) {
    console.error(`Команда "${COMMAND}" требует поисковый запрос.\n`);
    console.log(USAGE);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("[dry-run] Запись в Sheets и Telegram отключены\n");
  }

  let result;
  try {
    switch (COMMAND) {
      case "prices":
        result = await cmdPrices(QUERY);
        break;
      case "suppliers":
        result = await cmdSuppliers(QUERY);
        break;
      case "competitors":
        result = await cmdCompetitors(QUERY);
        break;
      case "news":
        result = await cmdNews(QUERY);
        break;
      case "report":
        result = await cmdReport();
        break;
    }
  } catch (err) {
    console.error(`\n[ERROR] ${COMMAND}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }

  // Langfuse трейс
  await trace({
    name: "web-intel",
    input: { command: COMMAND, query: QUERY, country: COUNTRY, dryRun: DRY_RUN },
    output: {
      rowsCount: result?.rows?.length || 0,
      summary: result?.summary?.slice(0, 500) || "",
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", tool: "web-intel", command: COMMAND },
  }).catch(() => {});

  console.log(`\nГотово за ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
