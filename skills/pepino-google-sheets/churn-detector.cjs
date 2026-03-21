#!/usr/bin/env node
/**
 * Pepino Pick — Churn Detection & Client Health Monitor
 *
 * Использует shared модуль client-analytics.cjs для анализа клиентов.
 * Выявляет:
 *   1. Клиентов со статусом "churned" (>30 дней без заказа)
 *   2. Клиентов со статусом "at_risk" (>14 дней без заказа)
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
const { send } = require("./telegram-helper.cjs");
const { analyzeClients } = require("./client-analytics.cjs");

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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ── Formatting ───────────────────────────────────────────────────────────────

function formatReport(churned, atRisk, summary) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>📊 Churn Report — ${d}</b>\n`);

  if (churned.length > 0) {
    lines.push(`<b>🔴 CHURNED (>30д без заказа):</b>`);
    for (const c of churned.slice(0, 5)) {
      lines.push(
        `  • <b>${c.name}</b> — ${c.daysSinceLast}д, ${c.orderCount} заказов, ${Math.round(c.totalArs).toLocaleString()} ARS`,
      );
    }
    lines.push("");
  }

  if (atRisk.length > 0) {
    lines.push(`<b>🟡 AT RISK (>14д без заказа):</b>`);
    for (const c of atRisk.slice(0, 5)) {
      lines.push(
        `  • <b>${c.name}</b> — ${c.daysSinceLast}д, посл. ${c.lastOrder}, ср. чек ${c.avgOrderArs.toLocaleString()} ARS`,
      );
    }
    lines.push("");
  }

  const total = churned.length + atRisk.length;
  if (total === 0) {
    lines.push("✅ Все клиенты активны. Нет риска оттока.");
  } else {
    const atRiskRevenue = atRisk.reduce((s, c) => s + c.totalArs, 0);
    const churnedRevenue = churned.reduce((s, c) => s + c.totalArs, 0);
    lines.push(
      `<b>💰 Под угрозой:</b> ${Math.round(atRiskRevenue + churnedRevenue).toLocaleString()} ARS выручки`,
    );
    lines.push(`\n<b>Рекомендация:</b> Написать at-risk клиентам сегодня.`);
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Churn detector starting...`);

  // analyzeClients() сам читает данные из farm-state или Sheets
  const { clients, summary } = await analyzeClients();

  // Фильтрация по статусу (уже отсортированы по totalArs в shared модуле)
  const churned = clients.filter((c) => c.status === "churned");
  const atRisk = clients.filter((c) => c.status === "at_risk");
  const active = clients.filter((c) => c.status === "active" || c.status === "new");

  console.log(`Total clients: ${summary.total}`);
  console.log(`Churned: ${churned.length}`);
  console.log(`At risk: ${atRisk.length}`);
  console.log(`Active: ${active.length}`);

  const report = formatReport(churned, atRisk, summary);
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Write alerts to Sheets
  if (!DRY_RUN && (atRisk.length > 0 || churned.length > 0)) {
    for (const c of [...churned.slice(0, 3), ...atRisk.slice(0, 3)]) {
      const statusLabel = c.status === "churned" ? "CHURNED" : "AT_RISK";
      try {
        await postJson("/log/alert", {
          type: "churn",
          zone: "CRM",
          description: `${statusLabel}: ${c.name} — ${c.daysSinceLast} дней без заказа, выручка ${Math.round(c.totalArs).toLocaleString()} ARS`,
          severity: c.status === "churned" ? "4" : "3",
          source: "churn-detector",
        });
      } catch (err) {
        console.error(`Alert write failed for ${c.name}: ${err.message}`);
      }
    }
  }

  // Send Telegram
  if (SEND_TG && (atRisk.length > 0 || churned.length > 0)) {
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
    input: { total_clients: summary.total },
    output: {
      churned: churned.length,
      at_risk: atRisk.length,
      active: active.length,
      avg_rfm_score: summary.avgScore,
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
