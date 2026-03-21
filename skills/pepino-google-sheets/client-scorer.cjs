#!/usr/bin/env node
/**
 * Pepino Pick -- Client Health Scorer & Growth Opportunities
 *
 * Комплексная оценка здоровья клиентов (0-100) на основе RFM-анализа.
 * Использует shared модуль client-analytics.cjs для скоринга.
 * Добавляет: выявление возможностей роста (cross-sell, upsell, win-back).
 *
 * Результаты записываются в лист "Клиенты" и отправляются в Telegram.
 *
 * Cron: 0 11 1,15 * * (1-го и 15-го числа в 11:00)
 * Usage: node client-scorer.cjs [--dry-run] [--telegram]
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { parseNum, daysBetween, rowsToObjects } = require("./helpers.cjs");
const { normalize } = require("./product-aliases.cjs");

const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

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

// ── Анализ возможностей роста ────────────────────────────────────────────────

/**
 * Строит карту сырых заказов по клиентам для анализа возможностей.
 * @param {Array<Record<string,string>>} salesObjects — строки продаж как объекты
 * @returns {Map<string, {orders: Array<{date: Date, total: number, product: string}>, totalRevenue: number, products: string[]}>}
 */
function buildOrderMap(salesObjects) {
  /** @type {Map<string, object>} */
  const clientsMap = new Map();

  for (const sale of salesObjects) {
    const client = (sale["Клиент"] || sale["клиент"] || sale["client"] || "").trim();
    if (!client || client === "Тест" || client === "test") continue;

    const dateStr = sale["Дата"] || sale["дата"] || sale["date"] || "";
    if (!dateStr) continue;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    const total = parseNum(
      sale["Итого ARS"] || sale["Сумма ARS"] || sale["Сумма"] || sale["total_ars"] || sale["Total"],
    );
    const product = normalize(sale["Продукт"] || sale["продукт"] || sale["product"] || "");

    if (!clientsMap.has(client)) {
      clientsMap.set(client, { orders: [], totalRevenue: 0, products: [] });
    }

    const data = clientsMap.get(client);
    data.orders.push({ date, total, product });
    data.totalRevenue += total;
    if (product) data.products.push(product);
  }

  // Сортировка заказов по дате
  for (const [, data] of clientsMap) {
    data.orders.sort((a, b) => a.date - b.date);
  }

  return clientsMap;
}

/**
 * Выявляет возможности роста для каждого клиента.
 * @param {Map<string, object>} clientsMap — карта сырых заказов
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
        priority: data.totalRevenue,
      });
    }

    // Upsell: частота заказов растёт (gap сокращается на 20%+)
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

        if (avgOlderGap > 0 && avgRecentGap < avgOlderGap * 0.8) {
          opportunities.push({
            client: name,
            type: "upsell",
            description: `Частота растёт (gap ${Math.round(avgOlderGap)}д -> ${Math.round(avgRecentGap)}д). Предложить объёмную скидку.`,
            priority: data.totalRevenue * 1.2,
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

// ── Запись в Sheets ─────────────────────────────────────────────────────────

/**
 * Записывает результаты скоринга в лист "Клиенты".
 * @param {Array<object>} clients — клиенты из analyzeClients()
 */
async function writeToSheets(clients) {
  const { writeToSheet, createSheetIfNotExists, PEPINO_SHEETS_ID } = await import("./sheets.js");

  const sheetName = "\u{1F465} \u041A\u043B\u0438\u0435\u043D\u0442\u044B"; // "Клиенты"

  try {
    await createSheetIfNotExists(PEPINO_SHEETS_ID, sheetName);
  } catch (err) {
    console.log(`Sheet check: ${err.message}`);
  }

  const headers = [
    "Клиент",
    "Score",
    "Tier",
    "Дней без заказа",
    "Кол-во заказов",
    "Выручка ARS",
    "Ср. чек ARS",
    "Частота (дни)",
    "Посл. заказ",
    "Уник. продуктов",
    "Статус",
    "Дата обновления",
  ];

  const updateDate = new Date().toISOString().slice(0, 10);
  const rows = clients.map((c) => [
    c.name,
    c.rfmScore,
    c.tier,
    c.daysSinceLast,
    c.orderCount,
    Math.round(c.totalArs),
    c.avgOrderArs,
    c.avgFrequencyDays,
    c.lastOrder || "",
    c.products.length,
    c.status,
    updateDate,
  ]);

  await writeToSheet(PEPINO_SHEETS_ID, [headers, ...rows], sheetName);
  console.log(`[OK] Записано ${rows.length} клиентов в "${sheetName}"`);
}

// ── Форматирование отчёта ───────────────────────────────────────────────────

/**
 * Формирует Telegram-отчёт со сводкой по tier-ам и топ-5 возможностями.
 * @param {Array<object>} clients — клиенты из analyzeClients()
 * @param {object} summary — сводка из analyzeClients()
 * @param {Array<object>} opportunities — возможности роста
 * @returns {string}
 */
function formatReport(clients, summary, opportunities) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>Client Health Scores -- ${d}</b>\n`);

  // Группировка по tier-ам
  const tiers = { A: [], B: [], C: [], D: [] };
  for (const c of clients) {
    if (tiers[c.tier]) tiers[c.tier].push(c);
  }

  // Сводка по tier-ам
  const tierEmojis = { A: "\u{1F451}", B: "\u{1F7E2}", C: "\u{1F7E1}", D: "\u{1F534}" };
  const tierLabels = {
    A: "VIP, priority service",
    B: "Core, maintain & grow",
    C: "Develop, increase freq",
    D: "At risk / inactive",
  };

  for (const t of ["A", "B", "C", "D"]) {
    const tierClients = tiers[t];
    if (tierClients.length === 0) continue;

    const totalRev = tierClients.reduce((s, c) => s + c.totalArs, 0);
    lines.push(
      `${tierEmojis[t]} <b>Tier ${t}</b> (${tierLabels[t]}): ${tierClients.length} кл., ${Math.round(totalRev).toLocaleString()} ARS`,
    );

    // Показываем до 3 клиентов в каждом tier-е
    for (const c of tierClients.slice(0, 3)) {
      lines.push(
        `  - ${c.name}: ${c.rfmScore} pts, ${c.orderCount} заказов, ${Math.round(c.totalArs).toLocaleString()} ARS`,
      );
    }
    if (tierClients.length > 3) {
      lines.push(`  ... и ещё ${tierClients.length - 3}`);
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
  lines.push(
    `<b>Итого:</b> ${summary.total} клиентов, ср. score ${summary.avgScore}, выручка ${Math.round(summary.totalRevenue).toLocaleString()} ARS`,
  );

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Client scorer starting...`);

  // 1. Получаем скоринг клиентов из shared модуля
  const { clients, summary } = await analyzeClients();

  if (clients.length === 0) {
    console.log("Нет данных для анализа.");
    return;
  }

  // Сортируем по rfmScore (лучшие сверху) вместо дефолтной сортировки по totalArs
  clients.sort((a, b) => b.rfmScore - a.rfmScore);

  console.log(`Загружено ${summary.total} клиентов`);
  console.log(`  Tier A (VIP): ${summary.tierA}`);
  console.log(`  Tier B (Core): ${summary.tierB}`);
  console.log(`  Tier C (Develop): ${summary.tierC}`);
  console.log(`  Tier D (At Risk): ${summary.tierD}`);

  // 2. Для выявления возможностей роста нужны сырые заказы
  let opportunities = [];
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(
      PEPINO_SHEETS_ID,
      "\u{1F6D2} \u041F\u0440\u043E\u0434\u0430\u0436\u0438",
    );
    const salesObjects = rowsToObjects(rows);
    const orderMap = buildOrderMap(salesObjects);
    opportunities = findOpportunities(orderMap);
    console.log(`  Возможностей роста: ${opportunities.length}`);
  } catch (err) {
    console.error(`[WARN] Не удалось построить карту возможностей: ${err.message}`);
  }

  // 3. Топ-10 клиентов в консоль
  console.log(`\nТоп-10 клиентов:`);
  for (const c of clients.slice(0, 10)) {
    console.log(
      `  ${c.tier} ${c.name}: ${c.rfmScore} pts -- ${Math.round(c.totalArs).toLocaleString()} ARS`,
    );
  }

  // 4. Запись в Sheets
  if (!DRY_RUN) {
    try {
      await writeToSheets(clients);
    } catch (err) {
      console.error(`[ERROR] Sheets write: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Пропуск записи в Sheets");
  }

  // 5. Telegram отчёт
  const report = formatReport(clients, summary, opportunities);

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

  // 6. Langfuse trace
  await trace({
    name: "client-scorer",
    input: { clients_total: summary.total },
    output: {
      total_clients: summary.total,
      tier_a: summary.tierA,
      tier_b: summary.tierB,
      tier_c: summary.tierC,
      tier_d: summary.tierD,
      opportunities: opportunities.length,
      avg_score: summary.avgScore,
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
