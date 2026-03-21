#!/usr/bin/env node
/**
 * Pepino Pick -- Client Health Scorer & Growth Opportunities
 *
 * Комплексная оценка здоровья клиентов (0-100) на основе RFM-анализа:
 *   - Recency (30 pts): давность последнего заказа
 *   - Frequency (30 pts): частота заказов в месяц
 *   - Monetary (30 pts): общая выручка
 *   - Growth (10 pts): тренд размера заказов
 *
 * Классификация по tier-ам: A (VIP), B (Core), C (Develop), D (At Risk)
 * Выявление возможностей: cross-sell, upsell, win-back
 *
 * Результаты записываются в лист "Клиенты" и отправляются в Telegram.
 *
 * Cron: 0 11 1,15 * * (1-го и 15-го числа в 11:00)
 * Usage: node client-scorer.cjs [--dry-run] [--telegram]
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");

const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

// ── Пороги скоринга ─────────────────────────────────────────────────────────

const RECENCY_THRESHOLDS = [
  { maxDays: 7, points: 30 },
  { maxDays: 14, points: 20 },
  { maxDays: 30, points: 10 },
  { maxDays: Infinity, points: 0 },
];

const FREQUENCY_THRESHOLDS = [
  { minPerMonth: 4, points: 30 },
  { minPerMonth: 2, points: 20 },
  { minPerMonth: 1, points: 10 },
  { minPerMonth: 0, points: 5 },
];

const MONETARY_THRESHOLDS = [
  { minTotal: 500_000, points: 30 },
  { minTotal: 200_000, points: 20 },
  { minTotal: 50_000, points: 10 },
  { minTotal: 0, points: 5 },
];

const TIER_RANGES = [
  { min: 80, tier: "A", label: "VIP, priority service" },
  { min: 60, tier: "B", label: "Core, maintain and grow" },
  { min: 40, tier: "C", label: "Develop, increase frequency" },
  { min: 0, tier: "D", label: "At risk or inactive" },
];

const MIN_ORDERS_FOR_TREND = 4; // минимум заказов для анализа тренда

// ── Telegram helper ─────────────────────────────────────────────────────────

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

// ── Утилиты ─────────────────────────────────────────────────────────────────

function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v || "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "");
  return parseFloat(s) || 0;
}

function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

/** Преобразует массив строк из Sheets в массив объектов */
function rowsToJson(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || "";
    });
    return obj;
  });
}

// ── Скоринг ─────────────────────────────────────────────────────────────────

/**
 * Подсчитывает баллы за давность последнего заказа.
 * @param {number} daysSinceLast - дней с последнего заказа
 * @returns {number} баллы (0-30)
 */
function scoreRecency(daysSinceLast) {
  for (const t of RECENCY_THRESHOLDS) {
    if (daysSinceLast <= t.maxDays) return t.points;
  }
  return 0;
}

/**
 * Подсчитывает баллы за частоту заказов.
 * @param {number} ordersPerMonth - среднее кол-во заказов в месяц
 * @returns {number} баллы (5-30)
 */
function scoreFrequency(ordersPerMonth) {
  for (const t of FREQUENCY_THRESHOLDS) {
    if (ordersPerMonth >= t.minPerMonth) return t.points;
  }
  return 5;
}

/**
 * Подсчитывает баллы за общую выручку.
 * @param {number} totalRevenue - суммарная выручка ARS
 * @returns {number} баллы (5-30)
 */
function scoreMonetary(totalRevenue) {
  for (const t of MONETARY_THRESHOLDS) {
    if (totalRevenue >= t.minTotal) return t.points;
  }
  return 5;
}

/**
 * Подсчитывает баллы за тренд роста размера заказов.
 * Сравнивает средний размер последних 2 заказов с предыдущими.
 * @param {Array<{total: number}>} orders - отсортированные по дате заказы
 * @returns {{points: number, trend: string}} баллы (0-10) и направление тренда
 */
function scoreGrowth(orders) {
  if (orders.length < MIN_ORDERS_FOR_TREND) {
    return { points: 5, trend: "stable" };
  }

  const splitIdx = Math.floor(orders.length / 2);
  const olderOrders = orders.slice(0, splitIdx);
  const recentOrders = orders.slice(splitIdx);

  const avgOlder = olderOrders.reduce((s, o) => s + o.total, 0) / olderOrders.length;
  const avgRecent = recentOrders.reduce((s, o) => s + o.total, 0) / recentOrders.length;

  if (avgOlder === 0) return { points: 5, trend: "stable" };

  const changePct = ((avgRecent - avgOlder) / avgOlder) * 100;

  // >10% рост = increasing, <-10% = decreasing, иначе stable
  if (changePct > 10) return { points: 10, trend: "increasing" };
  if (changePct < -10) return { points: 0, trend: "decreasing" };
  return { points: 5, trend: "stable" };
}

/**
 * Определяет tier клиента по composite score.
 * @param {number} score - composite score (0-100)
 * @returns {{tier: string, label: string}}
 */
function classifyTier(score) {
  for (const t of TIER_RANGES) {
    if (score >= t.min) return { tier: t.tier, label: t.label };
  }
  return { tier: "D", label: "At risk or inactive" };
}

// ── Анализ возможностей роста ────────────────────────────────────────────────

/**
 * Выявляет возможности роста для каждого клиента.
 * @param {Map<string, object>} clientsMap - данные клиентов
 * @returns {Array<{client: string, type: string, description: string, priority: number}>}
 */
function findOpportunities(clientsMap) {
  const opportunities = [];

  for (const [name, data] of clientsMap) {
    const uniqueProducts = new Set(data.products);

    // Cross-sell: клиент покупает 1-2 продукта
    if (uniqueProducts.size <= 2 && data.orders.length >= 3) {
      opportunities.push({
        client: name,
        type: "cross-sell",
        description: `Покупает только ${uniqueProducts.size} прод. (${[...uniqueProducts].join(", ")}). Предложить ассортимент.`,
        priority: data.totalRevenue, // приоритет по выручке
      });
    }

    // Upsell: частота заказов растёт
    if (data.orders.length >= MIN_ORDERS_FOR_TREND) {
      const splitIdx = Math.floor(data.orders.length / 2);
      const olderGaps = [];
      const recentGaps = [];

      for (let i = 1; i < data.orders.length; i++) {
        const gap = daysBetween(data.orders[i - 1].date, data.orders[i].date);
        if (i <= splitIdx) olderGaps.push(gap);
        else recentGaps.push(gap);
      }

      if (olderGaps.length > 0 && recentGaps.length > 0) {
        const avgOlderGap = olderGaps.reduce((a, b) => a + b, 0) / olderGaps.length;
        const avgRecentGap = recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length;

        // Частота растёт = gap сокращается на 20%+
        if (avgOlderGap > 0 && avgRecentGap < avgOlderGap * 0.8) {
          opportunities.push({
            client: name,
            type: "upsell",
            description: `Частота растёт (gap ${Math.round(avgOlderGap)}д -> ${Math.round(avgRecentGap)}д). Предложить объёмную скидку.`,
            priority: data.totalRevenue * 1.2, // бонус за растущий клиент
          });
        }
      }
    }

    // Win-back: клиент перестал покупать конкретный продукт
    if (data.orders.length >= 5) {
      const halfIdx = Math.floor(data.orders.length / 2);
      const olderProducts = new Set(
        data.orders
          .slice(0, halfIdx)
          .map((o) => o.product)
          .filter(Boolean),
      );
      const recentProducts = new Set(
        data.orders
          .slice(halfIdx)
          .map((o) => o.product)
          .filter(Boolean),
      );

      const droppedProducts = [...olderProducts].filter((p) => !recentProducts.has(p));
      if (droppedProducts.length > 0) {
        opportunities.push({
          client: name,
          type: "win-back",
          description: `Перестал покупать: ${droppedProducts.join(", ")}. Уточнить причину.`,
          priority: data.totalRevenue * 0.8,
        });
      }
    }
  }

  // Сортировка по приоритету (выручка) — самые ценные возможности первыми
  opportunities.sort((a, b) => b.priority - a.priority);
  return opportunities;
}

// ── Основной анализ ─────────────────────────────────────────────────────────

/**
 * Анализирует все продажи и возвращает скоринг клиентов.
 * @param {Array<object>} sales - строки из листа "Продажи"
 * @returns {{scored: Array<object>, tiers: object, opportunities: Array<object>}}
 */
function scoreClients(sales) {
  const now = new Date();
  /** @type {Map<string, {orders: Array, totalRevenue: number, products: string[]}>} */
  const clientsMap = new Map();

  // Группировка продаж по клиентам
  for (const sale of sales) {
    const client = sale["Клиент"] || sale["клиент"] || sale["client"] || "";
    if (!client || client === "Тест" || client === "test") continue;

    const dateStr = sale["Дата"] || sale["дата"] || sale["date"] || "";
    if (!dateStr) continue;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    const total = parseNum(
      sale["Итого ARS"] || sale["Сумма ARS"] || sale["Сумма"] || sale["total_ars"] || sale["Total"],
    );
    const product = sale["Продукт"] || sale["продукт"] || sale["product"] || "";

    if (!clientsMap.has(client)) {
      clientsMap.set(client, { orders: [], totalRevenue: 0, products: [] });
    }

    const data = clientsMap.get(client);
    data.orders.push({ date, total, product });
    data.totalRevenue += total;
    if (product) data.products.push(product);
  }

  const scored = [];

  for (const [name, data] of clientsMap) {
    // Сортировка заказов по дате
    data.orders.sort((a, b) => a.date - b.date);

    const lastOrder = data.orders[data.orders.length - 1];
    const daysSinceLast = daysBetween(lastOrder.date, now);
    const orderCount = data.orders.length;

    // Считаем кол-во месяцев между первым и последним заказом
    const firstOrder = data.orders[0];
    const monthsActive = Math.max(1, daysBetween(firstOrder.date, now) / 30);
    const ordersPerMonth = orderCount / monthsActive;

    // Считаем баллы по каждой метрике
    const recencyPts = scoreRecency(daysSinceLast);
    const frequencyPts = scoreFrequency(ordersPerMonth);
    const monetaryPts = scoreMonetary(data.totalRevenue);
    const growthResult = scoreGrowth(data.orders);

    const compositeScore = recencyPts + frequencyPts + monetaryPts + growthResult.points;
    const tierInfo = classifyTier(compositeScore);

    scored.push({
      name,
      score: compositeScore,
      tier: tierInfo.tier,
      tierLabel: tierInfo.label,
      recencyPts,
      frequencyPts,
      monetaryPts,
      growthPts: growthResult.points,
      growthTrend: growthResult.trend,
      daysSinceLast,
      orderCount,
      ordersPerMonth: Math.round(ordersPerMonth * 10) / 10,
      totalRevenue: Math.round(data.totalRevenue),
      avgBasket: Math.round(data.totalRevenue / orderCount),
      lastOrder: lastOrder.date.toISOString().slice(0, 10),
      uniqueProducts: new Set(data.products).size,
    });
  }

  // Сортировка по score (лучшие сверху)
  scored.sort((a, b) => b.score - a.score);

  // Подсчёт по tier-ам
  const tiers = { A: [], B: [], C: [], D: [] };
  for (const c of scored) {
    tiers[c.tier].push(c);
  }

  // Выявление возможностей роста
  const opportunities = findOpportunities(clientsMap);

  return { scored, tiers, opportunities };
}

// ── Запись в Sheets ─────────────────────────────────────────────────────────

/**
 * Записывает результаты скоринга в лист "Клиенты".
 * Создаёт лист если не существует, перезаписывает данные.
 */
async function writeToSheets(scored) {
  const { writeToSheet, createSheetIfNotExists, PEPINO_SHEETS_ID } = await import("./sheets.js");

  const sheetName = "\u{1F465} \u041A\u043B\u0438\u0435\u043D\u0442\u044B"; // "Клиенты"

  // Создаём лист, если ещё нет
  try {
    await createSheetIfNotExists(PEPINO_SHEETS_ID, sheetName);
  } catch (err) {
    console.log(`Sheet check: ${err.message}`);
  }

  const headers = [
    "Клиент",
    "Score",
    "Tier",
    "Tier Label",
    "Recency",
    "Frequency",
    "Monetary",
    "Growth",
    "Тренд роста",
    "Дней без заказа",
    "Кол-во заказов",
    "Заказов/мес",
    "Выручка ARS",
    "Ср. чек ARS",
    "Посл. заказ",
    "Уник. продуктов",
    "Дата обновления",
  ];

  const updateDate = new Date().toISOString().slice(0, 10);
  const rows = scored.map((c) => [
    c.name,
    c.score,
    c.tier,
    c.tierLabel,
    c.recencyPts,
    c.frequencyPts,
    c.monetaryPts,
    c.growthPts,
    c.growthTrend,
    c.daysSinceLast,
    c.orderCount,
    c.ordersPerMonth,
    c.totalRevenue,
    c.avgBasket,
    c.lastOrder,
    c.uniqueProducts,
    updateDate,
  ]);

  await writeToSheet(PEPINO_SHEETS_ID, [headers, ...rows], sheetName);
  console.log(`[OK] Записано ${rows.length} клиентов в "${sheetName}"`);
}

// ── Форматирование отчёта ───────────────────────────────────────────────────

/**
 * Формирует Telegram-отчёт со сводкой по tier-ам и топ-5 возможностями.
 */
function formatReport(scored, tiers, opportunities) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>Client Health Scores -- ${d}</b>\n`);

  // Сводка по tier-ам
  const tierEmojis = { A: "\u{1F451}", B: "\u{1F7E2}", C: "\u{1F7E1}", D: "\u{1F534}" };
  const tierLabels = {
    A: "VIP, priority service",
    B: "Core, maintain & grow",
    C: "Develop, increase freq",
    D: "At risk / inactive",
  };

  for (const t of ["A", "B", "C", "D"]) {
    const clients = tiers[t];
    if (clients.length === 0) continue;

    const totalRev = clients.reduce((s, c) => s + c.totalRevenue, 0);
    lines.push(
      `${tierEmojis[t]} <b>Tier ${t}</b> (${tierLabels[t]}): ${clients.length} кл., ${totalRev.toLocaleString()} ARS`,
    );

    // Показываем до 3 клиентов в каждом tier-е
    for (const c of clients.slice(0, 3)) {
      lines.push(
        `  - ${c.name}: ${c.score} pts, ${c.orderCount} заказов, ${c.totalRevenue.toLocaleString()} ARS`,
      );
    }
    if (clients.length > 3) {
      lines.push(`  ... и ещё ${clients.length - 3}`);
    }
    lines.push("");
  }

  // Топ-5 возможностей роста
  if (opportunities.length > 0) {
    lines.push(`<b>Top-5 возможностей роста:</b>`);
    const opEmojis = { "cross-sell": "\u{1F6D2}", upsell: "\u{1F4C8}", "win-back": "\u{1F504}" };

    for (const op of opportunities.slice(0, 5)) {
      const emoji = opEmojis[op.type] || "\u{1F4A1}";
      lines.push(`${emoji} <b>${op.client}</b> [${op.type}]`);
      lines.push(`  ${op.description}`);
    }
    lines.push("");
  }

  // Итого
  const totalClients = scored.length;
  const totalRevenue = scored.reduce((s, c) => s + c.totalRevenue, 0);
  const avgScore =
    totalClients > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / totalClients) : 0;

  lines.push(
    `<b>Итого:</b> ${totalClients} клиентов, ср. score ${avgScore}, выручка ${totalRevenue.toLocaleString()} ARS`,
  );

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Client scorer starting...`);

  // Чтение продаж из Sheets напрямую
  let sales;
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(
      PEPINO_SHEETS_ID,
      "\u{1F6D2} \u041F\u0440\u043E\u0434\u0430\u0436\u0438",
    ); // "Продажи"
    sales = rowsToJson(rows);
  } catch (err) {
    console.error(`[FATAL] Не удалось прочитать продажи: ${err.message}`);
    process.exit(1);
  }

  console.log(`Загружено ${sales.length} записей продаж`);

  if (sales.length === 0) {
    console.log("Нет данных для анализа.");
    return;
  }

  // Скоринг
  const { scored, tiers, opportunities } = scoreClients(sales);

  console.log(`\nРезультаты скоринга:`);
  console.log(`  Tier A (VIP): ${tiers.A.length}`);
  console.log(`  Tier B (Core): ${tiers.B.length}`);
  console.log(`  Tier C (Develop): ${tiers.C.length}`);
  console.log(`  Tier D (At Risk): ${tiers.D.length}`);
  console.log(`  Возможностей роста: ${opportunities.length}`);

  // Топ-10 клиентов в консоль
  console.log(`\nТоп-10 клиентов:`);
  for (const c of scored.slice(0, 10)) {
    console.log(
      `  ${c.tier} ${c.name}: ${c.score} pts (R${c.recencyPts} F${c.frequencyPts} M${c.monetaryPts} G${c.growthPts}) -- ${c.totalRevenue.toLocaleString()} ARS`,
    );
  }

  // Запись в Sheets
  if (!DRY_RUN) {
    try {
      await writeToSheets(scored);
    } catch (err) {
      console.error(`[ERROR] Sheets write: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Пропуск записи в Sheets");
  }

  // Telegram отчёт
  const report = formatReport(scored, tiers, opportunities);

  if (DRY_RUN) {
    console.log("\n--- Telegram preview ---");
    console.log(report.replace(/<[^>]+>/g, ""));
    console.log("--- end preview ---\n");
  }

  if (SEND_TG) {
    try {
      await telegramSend(report);
      console.log("[OK] Отчёт отправлен в Telegram (thread 20)");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse trace
  await trace({
    name: "client-scorer",
    input: { sales_count: sales.length },
    output: {
      total_clients: scored.length,
      tier_a: tiers.A.length,
      tier_b: tiers.B.length,
      tier_c: tiers.C.length,
      tier_d: tiers.D.length,
      opportunities: opportunities.length,
      avg_score:
        scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "client-scorer" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
