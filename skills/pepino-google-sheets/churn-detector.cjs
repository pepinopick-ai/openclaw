#!/usr/bin/env node
/**
 * Pepino Pick — Churn Detection & Client Health Monitor
 *
 * Анализирует историю продаж, выявляет:
 *   1. Клиентов, которые не заказывали >14 дней (at risk)
 *   2. Клиентов, которые не заказывали >30 дней (churned)
 *   3. Снижение частоты заказов (frequency drop)
 *   4. Снижение среднего чека (basket drop)
 *
 * Отправляет алерты в Telegram и записывает в Sheets (⚠️ Алерты)
 *
 * Cron: 0 10 * * 1-5 (пн-пт 10:00)
 * Usage: node churn-detector.cjs [--dry-run] [--telegram]
 */

"use strict";

const http = require("http");
const { apiHeaders } = require("./api-auth.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { normalize } = require("./product-aliases.cjs");
const { send } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

const API_BASE = "http://localhost:4000";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

// ── Thresholds ──────────────────────────────────────────────────────────────

const DAYS_AT_RISK = 14; // >14 дней без заказа = at risk
const DAYS_CHURNED = 30; // >30 дней = churned
const FREQ_DROP_PCT = 30; // снижение частоты >30% = alert
const BASKET_DROP_PCT = 25; // снижение среднего чека >25% = alert
const MIN_ORDERS_FOR_ANALYSIS = 3; // минимум заказов для анализа трендов

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    http
      .get(url, { headers: apiHeaders() }, (res) => {
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

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${API_BASE}${path}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...apiHeaders(),
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
            resolve({ raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function analyzeClients(sales) {
  const now = new Date();
  const clients = {};

  // Group sales by client
  for (const sale of sales) {
    const client = sale["Клиент"] || sale["клиент"] || sale["client"] || "";
    if (!client || client === "Тест" || client === "test") continue;

    const dateStr = sale["Дата"] || sale["дата"] || sale["date"] || "";
    if (!dateStr) continue;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    const total =
      parseFloat(
        sale["Итого ARS"] ||
          sale["Сумма ARS"] ||
          sale["Сумма"] ||
          sale["total_ars"] ||
          sale["Total"] ||
          0,
      ) || 0;
    const qty =
      parseFloat(
        sale["Кол-во кг"] || sale["Кол-во"] || sale["qty_kg"] || sale["Количество"] || 0,
      ) || 0;

    if (!clients[client]) {
      clients[client] = { name: client, orders: [], totalRevenue: 0, totalQty: 0 };
    }
    clients[client].orders.push({ date, total, qty });
    clients[client].totalRevenue += total;
    clients[client].totalQty += qty;
  }

  const results = { atRisk: [], churned: [], freqDrop: [], basketDrop: [], healthy: [] };

  for (const [name, data] of Object.entries(clients)) {
    // Sort orders by date
    data.orders.sort((a, b) => a.date - b.date);

    const lastOrder = data.orders[data.orders.length - 1];
    const daysSinceLast = daysBetween(lastOrder.date, now);
    const orderCount = data.orders.length;
    const avgBasket = data.totalRevenue / orderCount;

    const clientSummary = {
      name,
      lastOrder: lastOrder.date.toISOString().slice(0, 10),
      daysSinceLast,
      orderCount,
      totalRevenue: Math.round(data.totalRevenue),
      avgBasket: Math.round(avgBasket),
    };

    // Churn detection
    if (daysSinceLast > DAYS_CHURNED) {
      clientSummary.status = "CHURNED";
      results.churned.push(clientSummary);
    } else if (daysSinceLast > DAYS_AT_RISK) {
      clientSummary.status = "AT_RISK";
      results.atRisk.push(clientSummary);
    } else {
      clientSummary.status = "HEALTHY";
      results.healthy.push(clientSummary);
    }

    // Frequency analysis (need 3+ orders)
    if (orderCount >= MIN_ORDERS_FOR_ANALYSIS) {
      // Compare avg gap of last 3 orders vs previous
      const gaps = [];
      for (let i = 1; i < data.orders.length; i++) {
        gaps.push(daysBetween(data.orders[i - 1].date, data.orders[i].date));
      }

      if (gaps.length >= 3) {
        const recentGaps = gaps.slice(-2);
        const olderGaps = gaps.slice(0, -2);
        const avgRecent = recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length;
        const avgOlder = olderGaps.reduce((a, b) => a + b, 0) / olderGaps.length;

        if (avgOlder > 0 && avgRecent > avgOlder * (1 + FREQ_DROP_PCT / 100)) {
          clientSummary.freqDropPct = Math.round((avgRecent / avgOlder - 1) * 100);
          clientSummary.avgGapRecent = Math.round(avgRecent);
          clientSummary.avgGapOlder = Math.round(avgOlder);
          results.freqDrop.push(clientSummary);
        }
      }

      // Basket analysis
      if (orderCount >= 4) {
        const recentBaskets = data.orders.slice(-2).map((o) => o.total);
        const olderBaskets = data.orders.slice(0, -2).map((o) => o.total);
        const avgRecentBasket = recentBaskets.reduce((a, b) => a + b, 0) / recentBaskets.length;
        const avgOlderBasket = olderBaskets.reduce((a, b) => a + b, 0) / olderBaskets.length;

        if (avgOlderBasket > 0 && avgRecentBasket < avgOlderBasket * (1 - BASKET_DROP_PCT / 100)) {
          clientSummary.basketDropPct = Math.round((1 - avgRecentBasket / avgOlderBasket) * 100);
          results.basketDrop.push(clientSummary);
        }
      }
    }
  }

  // Sort by revenue (most valuable at risk first)
  results.atRisk.sort((a, b) => b.totalRevenue - a.totalRevenue);
  results.churned.sort((a, b) => b.totalRevenue - a.totalRevenue);
  results.freqDrop.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return results;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatReport(results) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>📊 Churn Report — ${d}</b>\n`);

  if (results.churned.length > 0) {
    lines.push(`<b>🔴 CHURNED (>${DAYS_CHURNED}д без заказа):</b>`);
    for (const c of results.churned.slice(0, 5)) {
      lines.push(
        `  • <b>${c.name}</b> — ${c.daysSinceLast}д, ${c.orderCount} заказов, ${c.totalRevenue.toLocaleString()} ARS`,
      );
    }
    lines.push("");
  }

  if (results.atRisk.length > 0) {
    lines.push(`<b>🟡 AT RISK (>${DAYS_AT_RISK}д без заказа):</b>`);
    for (const c of results.atRisk.slice(0, 5)) {
      lines.push(
        `  • <b>${c.name}</b> — ${c.daysSinceLast}д, посл. ${c.lastOrder}, ср. чек ${c.avgBasket.toLocaleString()} ARS`,
      );
    }
    lines.push("");
  }

  if (results.freqDrop.length > 0) {
    lines.push(`<b>📉 Частота заказов падает:</b>`);
    for (const c of results.freqDrop.slice(0, 3)) {
      lines.push(
        `  • <b>${c.name}</b> — gap ${c.avgGapOlder}д→${c.avgGapRecent}д (+${c.freqDropPct}%)`,
      );
    }
    lines.push("");
  }

  if (results.basketDrop.length > 0) {
    lines.push(`<b>📉 Средний чек падает:</b>`);
    for (const c of results.basketDrop.slice(0, 3)) {
      lines.push(`  • <b>${c.name}</b> — чек упал на ${c.basketDropPct}%`);
    }
    lines.push("");
  }

  const total = results.churned.length + results.atRisk.length;
  if (total === 0) {
    lines.push("✅ Все клиенты активны. Нет риска оттока.");
  } else {
    const atRiskRevenue = results.atRisk.reduce((s, c) => s + c.totalRevenue, 0);
    const churnedRevenue = results.churned.reduce((s, c) => s + c.totalRevenue, 0);
    lines.push(
      `<b>💰 Под угрозой:</b> ${(atRiskRevenue + churnedRevenue).toLocaleString()} ARS выручки`,
    );
    lines.push(`\n<b>Рекомендация:</b> Написать at-risk клиентам сегодня.`);
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Churn detector starting...`);

  // Fetch ALL sales (not just last 20)
  let sales;
  try {
    const { readSheet, PEPINO_SHEETS_ID } = require("./sheets.js");
    // Direct sheet read to get ALL rows, not just last 20 from API
    const rows = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    if (!rows || rows.length < 2) {
      console.log("No sales data found.");
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
    // Fallback: try API
    console.log("Direct sheet read failed, trying API...");
    sales = await fetchJson("/sales");
  }

  console.log(`Loaded ${sales.length} sales records`);

  const results = analyzeClients(sales);

  console.log(`Churned: ${results.churned.length}`);
  console.log(`At risk: ${results.atRisk.length}`);
  console.log(`Freq drop: ${results.freqDrop.length}`);
  console.log(`Basket drop: ${results.basketDrop.length}`);
  console.log(`Healthy: ${results.healthy.length}`);

  const report = formatReport(results);
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Write alerts to Sheets
  if (!DRY_RUN && (results.atRisk.length > 0 || results.churned.length > 0)) {
    for (const c of [...results.churned.slice(0, 3), ...results.atRisk.slice(0, 3)]) {
      try {
        await postJson("/log/alert", {
          type: "churn",
          zone: "CRM",
          description: `${c.status}: ${c.name} — ${c.daysSinceLast} дней без заказа, выручка ${c.totalRevenue.toLocaleString()} ARS`,
          severity: c.status === "CHURNED" ? "4" : "3",
          source: "churn-detector",
        });
      } catch (err) {
        console.error(`Alert write failed for ${c.name}: ${err.message}`);
      }
    }
  }

  // Send Telegram
  if (SEND_TG && (results.atRisk.length > 0 || results.churned.length > 0)) {
    try {
      if (sendThrottled) {
        await sendThrottled(report, {
          thread: TG_THREAD_ID,
          silent: false,
          priority: "normal",
          parseMode: "HTML",
        });
      } else {
        await send(report, {
          silent: false,
          threadId: TG_THREAD_ID,
          parseMode: "HTML",
        });
      }
      console.log("[OK] Report sent to Telegram");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse trace
  await trace({
    name: "churn-detector",
    input: { sales_count: sales.length },
    output: {
      churned: results.churned.length,
      at_risk: results.atRisk.length,
      freq_drop: results.freqDrop.length,
      basket_drop: results.basketDrop.length,
      healthy: results.healthy.length,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "churn-detector" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
