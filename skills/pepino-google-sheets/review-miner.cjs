#!/usr/bin/env node
/**
 * Pepino Pick -- Review Miner (Mercado Libre)
 *
 * Собирает и анализирует отзывы о конкурентах и поставщиках с Mercado Libre.
 *
 * Алгоритм:
 *   1. Поиск товаров по запросу через MLA API
 *   2. Загрузка отзывов по каждому товару
 *   3. Извлечение: рейтинг, дата, текст, verified_purchase
 *   4. Анализ паттернов: средний рейтинг, жалобы, похвала, sentiment по продавцу
 *   5. Запись в лист "📊 Рыночная разведка"
 *   6. Отправка сводки в Telegram (thread 20)
 *
 * Cron: 0 14 1 * * (1-е число каждого месяца в 14:00)
 * Usage: node review-miner.cjs "hongos ostra frescos" [--limit 5] [--dry-run]
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");

/** Ключевые слова жалоб */
const COMPLAINT_KEYWORDS = ["malo", "roto", "tarde", "no llego", "podrido", "viejo"];

/** Ключевые слова похвалы */
const PRAISE_KEYWORDS = ["fresco", "bueno", "rapido", "calidad", "recomiendo"];

const SHEET_NAME =
  "\u{1F4CA} \u0420\u044B\u043D\u043E\u0447\u043D\u0430\u044F \u0440\u0430\u0437\u0432\u0435\u0434\u043A\u0430"; // "📊 Рыночная разведка"

// ── CLI-аргументы ───────────────────────────────────────────────────────────

/**
 * Парсит поисковый запрос и лимит из argv.
 * @returns {{ query: string, limit: number }}
 */
function parseArgs() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const query = args[0] || "";
  if (!query) {
    console.error('Usage: node review-miner.cjs "hongos ostra frescos" [--limit 5] [--dry-run]');
    process.exit(1);
  }

  let limit = 10;
  const limitIdx = process.argv.indexOf("--limit");
  if (limitIdx !== -1 && process.argv[limitIdx + 1]) {
    const parsed = parseInt(process.argv[limitIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
      limit = parsed;
    }
  }

  return { query, limit };
}

// ── HTTPS helpers ───────────────────────────────────────────────────────────

/**
 * GET-запрос по HTTPS, возвращает распарсенный JSON.
 * @param {string} url -- полный URL
 * @returns {Promise<object>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 15_000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`JSON parse error from ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject)
      .on("timeout", function () {
        this.destroy(new Error(`Timeout fetching ${url}`));
      });
  });
}

/**
 * Пауза между запросами, чтобы не нарваться на rate-limit.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mercado Libre API ───────────────────────────────────────────────────────

/**
 * Поиск товаров в MLA (Аргентина).
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, title: string, price: number, seller_id: number, seller_nickname: string, permalink: string }>>}
 */
async function searchItems(query, limit) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encoded}&limit=${limit}`;
  console.log(`[search] ${url}`);

  const data = await fetchJson(url);
  if (!data.results || !Array.isArray(data.results)) {
    console.warn("[search] Пустой результат поиска");
    return [];
  }

  return data.results.map((item) => ({
    id: item.id,
    title: item.title || "",
    price: item.price || 0,
    seller_id: item.seller?.id || 0,
    seller_nickname: item.seller?.nickname || "unknown",
    permalink: item.permalink || "",
  }));
}

/**
 * Загрузка отзывов по товару.
 * @param {string} itemId
 * @returns {Promise<Array<{ rating: number, date: string, content: string, verified: boolean }>>}
 */
async function fetchReviews(itemId) {
  const url = `https://api.mercadolibre.com/reviews/item/${itemId}`;
  try {
    const data = await fetchJson(url);
    if (!data.reviews || !Array.isArray(data.reviews)) {
      return [];
    }
    return data.reviews.map((r) => ({
      rating: r.rate || 0,
      date: r.date_created ? r.date_created.slice(0, 10) : "",
      content: (r.content || r.title || "").toLowerCase(),
      verified: Boolean(r.verified_purchase),
    }));
  } catch (err) {
    // Некоторые товары не имеют отзывов -- не критично
    console.warn(`[reviews] Не удалось загрузить отзывы для ${itemId}: ${err.message}`);
    return [];
  }
}

// ── Анализ ──────────────────────────────────────────────────────────────────

/**
 * Подсчёт вхождений ключевых слов в массиве текстов.
 * @param {string[]} texts
 * @param {string[]} keywords
 * @returns {Record<string, number>}
 */
function countKeywords(texts, keywords) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const kw of keywords) {
    counts[kw] = 0;
  }
  for (const text of texts) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        counts[kw]++;
      }
    }
  }
  return counts;
}

/**
 * Простой sentiment score: +1 за каждое слово похвалы, -1 за жалобу.
 * Нормализуется на количество отзывов (-1..+1).
 * @param {string[]} texts
 * @returns {number}
 */
function sentimentScore(texts) {
  if (texts.length === 0) return 0;
  let score = 0;
  for (const text of texts) {
    for (const kw of PRAISE_KEYWORDS) {
      if (text.includes(kw)) score++;
    }
    for (const kw of COMPLAINT_KEYWORDS) {
      if (text.includes(kw)) score--;
    }
  }
  return Math.max(-1, Math.min(1, score / texts.length));
}

/**
 * @typedef {object} SellerAnalysis
 * @property {string} nickname
 * @property {number} avgRating
 * @property {number} reviewCount
 * @property {number} verifiedPct
 * @property {number} sentiment
 * @property {Record<string, number>} complaints
 * @property {Record<string, number>} praises
 * @property {string[]} items
 */

/**
 * Анализирует все собранные данные по продавцам.
 * @param {Array<{ item: object, reviews: object[] }>} collected
 * @returns {{ sellers: SellerAnalysis[], totalReviews: number, totalItems: number, avgRating: number, topComplaints: [string, number][], topPraises: [string, number][] }}
 */
function analyzeData(collected) {
  /** @type {Record<string, { reviews: object[], items: string[], nickname: string }>} */
  const bySeller = {};
  const allTexts = [];
  let allRatings = [];

  for (const { item, reviews } of collected) {
    const key = String(item.seller_id);
    if (!bySeller[key]) {
      bySeller[key] = { reviews: [], items: [], nickname: item.seller_nickname };
    }
    bySeller[key].items.push(item.title.slice(0, 60));
    for (const r of reviews) {
      bySeller[key].reviews.push(r);
      if (r.content) allTexts.push(r.content);
      if (r.rating > 0) allRatings.push(r.rating);
    }
  }

  // Анализ по продавцам
  /** @type {SellerAnalysis[]} */
  const sellers = [];
  for (const [, data] of Object.entries(bySeller)) {
    const texts = data.reviews.map((r) => r.content).filter(Boolean);
    const ratings = data.reviews.map((r) => r.rating).filter((r) => r > 0);
    const verified = data.reviews.filter((r) => r.verified).length;

    sellers.push({
      nickname: data.nickname,
      avgRating: ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
      reviewCount: data.reviews.length,
      verifiedPct: data.reviews.length > 0 ? Math.round((verified / data.reviews.length) * 100) : 0,
      sentiment: sentimentScore(texts),
      complaints: countKeywords(texts, COMPLAINT_KEYWORDS),
      praises: countKeywords(texts, PRAISE_KEYWORDS),
      items: data.items,
    });
  }

  // Сортировка: больше отзывов = выше
  sellers.sort((a, b) => b.reviewCount - a.reviewCount);

  // Глобальные паттерны
  const globalComplaints = countKeywords(allTexts, COMPLAINT_KEYWORDS);
  const globalPraises = countKeywords(allTexts, PRAISE_KEYWORDS);

  const topComplaints = Object.entries(globalComplaints)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const topPraises = Object.entries(globalPraises)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const avgRating =
    allRatings.length > 0 ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length : 0;

  return {
    sellers,
    totalReviews: allRatings.length,
    totalItems: collected.length,
    avgRating,
    topComplaints,
    topPraises,
  };
}

// ── Sheets ──────────────────────────────────────────────────────────────────

/**
 * Записывает результаты анализа в лист "📊 Рыночная разведка".
 * @param {string} query -- поисковый запрос
 * @param {object} analysis -- результат analyzeData()
 */
async function writeToSheets(query, analysis) {
  const { appendToSheet, createSheetIfNotExists, PEPINO_SHEETS_ID } = await import("./sheets.js");

  await createSheetIfNotExists(PEPINO_SHEETS_ID, SHEET_NAME);

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const rows = [];

  for (const seller of analysis.sellers) {
    const topComplaint =
      Object.entries(seller.complaints)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}(${v})`)
        .join(", ") || "-";

    const topPraise =
      Object.entries(seller.praises)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}(${v})`)
        .join(", ") || "-";

    rows.push([
      now,
      query,
      seller.nickname,
      seller.reviewCount,
      seller.avgRating.toFixed(1),
      `${seller.verifiedPct}%`,
      seller.sentiment.toFixed(2),
      topComplaint,
      topPraise,
      seller.items.join("; ").slice(0, 200),
    ]);
  }

  if (rows.length === 0) {
    console.log("[sheets] Нет данных для записи");
    return;
  }

  // Проверяем, есть ли заголовки (первая запись)
  const { readSheet } = await import("./sheets.js");
  const existing = await readSheet(PEPINO_SHEETS_ID, SHEET_NAME);
  if (!existing || existing.length === 0) {
    const headers = [
      "Дата",
      "Запрос",
      "Продавец",
      "Отзывов",
      "Ср. рейтинг",
      "Verified %",
      "Sentiment",
      "Жалобы",
      "Похвала",
      "Товары",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [headers], SHEET_NAME);
  }

  await appendToSheet(PEPINO_SHEETS_ID, rows, SHEET_NAME);
  console.log(`[sheets] Записано ${rows.length} строк в "${SHEET_NAME}"`);
}

// ── Telegram ────────────────────────────────────────────────────────────────

/**
 * Формирует и отправляет сводку в Telegram.
 * @param {string} query
 * @param {object} analysis
 */
async function sendTelegramSummary(query, analysis) {
  const lines = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`<b>🔍 Review Miner -- ${date}</b>`);
  lines.push(`Запрос: <b>${escapeHtml(query)}</b>`);
  lines.push(
    `Товаров: ${analysis.totalItems} | Отзывов: ${analysis.totalReviews} | Ср. рейтинг: ${analysis.avgRating.toFixed(1)}\n`,
  );

  // Топ жалобы
  if (analysis.topComplaints.length > 0) {
    lines.push("<b>🔴 Частые жалобы:</b>");
    for (const [kw, count] of analysis.topComplaints.slice(0, 5)) {
      lines.push(`  ${kw}: ${count}`);
    }
    lines.push("");
  }

  // Топ похвала
  if (analysis.topPraises.length > 0) {
    lines.push("<b>🟢 Частая похвала:</b>");
    for (const [kw, count] of analysis.topPraises.slice(0, 5)) {
      lines.push(`  ${kw}: ${count}`);
    }
    lines.push("");
  }

  // Топ-5 продавцов
  if (analysis.sellers.length > 0) {
    lines.push("<b>📊 Продавцы (топ-5):</b>");
    for (const s of analysis.sellers.slice(0, 5)) {
      const sentLabel = s.sentiment > 0.2 ? "+" : s.sentiment < -0.2 ? "-" : "~";
      lines.push(
        `  ${escapeHtml(s.nickname)} -- ⭐${s.avgRating.toFixed(1)} | ${s.reviewCount} отз. | sent: ${sentLabel}${Math.abs(s.sentiment).toFixed(1)}`,
      );
    }
    lines.push("");
  }

  // Выводы
  if (analysis.totalReviews === 0) {
    lines.push("⚠️ Отзывы не найдены. Возможно, товар слишком специфичный.");
  } else {
    const worstSeller = analysis.sellers
      .filter((s) => s.reviewCount >= 2)
      .sort((a, b) => a.avgRating - b.avgRating)[0];
    const bestSeller = analysis.sellers
      .filter((s) => s.reviewCount >= 2)
      .sort((a, b) => b.avgRating - a.avgRating)[0];

    if (bestSeller) {
      lines.push(
        `<b>Лучший:</b> ${escapeHtml(bestSeller.nickname)} (⭐${bestSeller.avgRating.toFixed(1)})`,
      );
    }
    if (worstSeller && worstSeller !== bestSeller) {
      lines.push(
        `<b>Худший:</b> ${escapeHtml(worstSeller.nickname)} (⭐${worstSeller.avgRating.toFixed(1)})`,
      );
    }
  }

  const text = lines.join("\n");
  console.log("\n" + text.replace(/<[^>]+>/g, "") + "\n");

  const result = await sendReport(text, TG_THREAD_ID, "HTML");
  if (result.ok) {
    console.log("[OK] Сводка отправлена в Telegram");
  } else {
    console.error(`[ERROR] Telegram: ${result.error}`);
  }
}

/**
 * Экранирование спецсимволов для HTML в Telegram.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const { query, limit } = parseArgs();

  console.log(`[${new Date().toISOString()}] Review Miner starting...`);
  console.log(`Query: "${query}", limit: ${limit}, dry-run: ${DRY_RUN}`);

  // 1. Поиск товаров
  const items = await searchItems(query, limit);
  console.log(`[search] Найдено ${items.length} товаров`);

  if (items.length === 0) {
    console.log("Нет результатов поиска. Завершение.");
    return;
  }

  // 2. Загрузка отзывов по каждому товару (с паузой между запросами)
  /** @type {Array<{ item: object, reviews: object[] }>} */
  const collected = [];
  for (const item of items) {
    console.log(`[reviews] ${item.id}: ${item.title.slice(0, 50)}...`);
    const reviews = await fetchReviews(item.id);
    collected.push({ item, reviews });
    console.log(`  -> ${reviews.length} отзывов`);
    // Пауза 300ms между запросами, чтобы не нарваться на rate-limit
    if (items.indexOf(item) < items.length - 1) {
      await sleep(300);
    }
  }

  // 3. Анализ
  const analysis = analyzeData(collected);

  console.log(`\n--- Итоги ---`);
  console.log(`Товаров: ${analysis.totalItems}`);
  console.log(`Отзывов: ${analysis.totalReviews}`);
  console.log(`Ср. рейтинг: ${analysis.avgRating.toFixed(2)}`);
  console.log(`Продавцов: ${analysis.sellers.length}`);
  console.log(
    `Жалобы: ${analysis.topComplaints.map(([k, v]) => `${k}(${v})`).join(", ") || "нет"}`,
  );
  console.log(`Похвала: ${analysis.topPraises.map(([k, v]) => `${k}(${v})`).join(", ") || "нет"}`);

  // 4. Запись в Sheets
  if (!DRY_RUN) {
    try {
      await writeToSheets(query, analysis);
    } catch (err) {
      console.error(`[ERROR] Sheets: ${err.message}`);
    }
  } else {
    console.log("[dry-run] Пропуск записи в Sheets");
  }

  // 5. Telegram
  if (!DRY_RUN) {
    try {
      await sendTelegramSummary(query, analysis);
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("[dry-run] Пропуск отправки в Telegram");
    // Всё равно выводим сводку в консоль
    const date = new Date().toISOString().slice(0, 10);
    console.log(`\n[dry-run] Сводка за ${date}:`);
    for (const s of analysis.sellers.slice(0, 5)) {
      console.log(
        `  ${s.nickname}: rating=${s.avgRating.toFixed(1)}, reviews=${s.reviewCount}, sentiment=${s.sentiment.toFixed(2)}`,
      );
    }
  }

  // 6. Langfuse trace
  await trace({
    name: "review-miner",
    input: { query, limit, items_found: items.length },
    output: {
      total_items: analysis.totalItems,
      total_reviews: analysis.totalReviews,
      avg_rating: parseFloat(analysis.avgRating.toFixed(2)),
      sellers_count: analysis.sellers.length,
      top_complaints: analysis.topComplaints.slice(0, 3),
      top_praises: analysis.topPraises.slice(0, 3),
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "review-miner", dry_run: DRY_RUN },
  }).catch(() => {});

  console.log(`\nDone in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
