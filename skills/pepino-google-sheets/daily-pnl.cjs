#!/usr/bin/env node
/**
 * Pepino Pick — Daily P&L Auto-Tracker
 *
 * Ежедневный автоматический расчёт:
 *   1. Выручка за день (по клиентам и продуктам)
 *   2. Расходы за день
 *   3. Маржа по клиенту и по продукту
 *   4. Алерт если маржа <35%
 *   5. Тренд: растём или падаем (7-day rolling)
 *
 * Cron: 0 21 * * * (каждый вечер в 21:00)
 * Usage: node daily-pnl.cjs [--dry-run] [--telegram]
 */

"use strict";

const http = require("http");
const { apiHeaders } = require("./api-auth.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { normalize } = require("./product-aliases.cjs");
const { send } = require("./telegram-helper.cjs");
const { parseNum, rowsToObjects, fmtDate } = require("./helpers.cjs");

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

const MARGIN_ALERT_THRESHOLD = 35; // alert if below 35%

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${API_BASE}${path}`, { headers: apiHeaders() }, (res) => {
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
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            resolve({ raw: d });
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

/** Дата в формате YYYY-MM-DD для N дней назад */
function nDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

function analyzePnL(sales, expenses) {
  const today = fmtDate(new Date());
  const week7 = nDaysAgo(7);
  const week14 = nDaysAgo(14);

  // Today's sales
  const todaySales = sales.filter((r) => {
    const d = r["Дата"] || r["дата"] || r["date"] || "";
    return d.startsWith(today);
  });

  // Today's expenses
  const todayExpenses = expenses.filter((r) => {
    const d = r["Дата"] || r["дата"] || r["date"] || "";
    return d.startsWith(today);
  });

  // Revenue by client (today)
  const byClient = {};
  let todayRevenue = 0;
  for (const s of todaySales) {
    const client = s["Клиент"] || s["клиент"] || s["client"] || "Unknown";
    const total = parseNum(
      s["Итого ARS"] || s["Сумма ARS"] || s["Сумма"] || s["total_ars"] || s["Total"],
    );
    todayRevenue += total;
    byClient[client] = (byClient[client] || 0) + total;
  }

  // Revenue by product (today)
  const byProduct = {};
  for (const s of todaySales) {
    const product = normalize(s["Продукт"] || s["продукт"] || s["product"] || "Unknown");
    const total = parseNum(
      s["Итого ARS"] || s["Сумма ARS"] || s["Сумма"] || s["total_ars"] || s["Total"],
    );
    byProduct[product] = (byProduct[product] || 0) + total;
  }

  // Total expenses today
  let todayExpenseTotal = 0;
  for (const e of todayExpenses) {
    todayExpenseTotal += parseNum(
      e["Итого ARS"] || e["Сумма ARS"] || e["Сумма"] || e["amount_ars"] || e["Amount"],
    );
  }

  // Gross margin today
  const todayMargin =
    todayRevenue > 0 ? Math.round((1 - todayExpenseTotal / todayRevenue) * 100) : 0;

  // 7-day rolling
  const last7Sales = sales.filter((r) => {
    const d = r["Дата"] || r["дата"] || "";
    return d >= week7 && d <= today;
  });
  const last7Revenue = last7Sales.reduce(
    (s, r) =>
      s + parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || r["total_ars"] || r["Total"]),
    0,
  );

  const last7Expenses = expenses.filter((r) => {
    const d = r["Дата"] || r["дата"] || "";
    return d >= week7 && d <= today;
  });
  const last7ExpTotal = last7Expenses.reduce(
    (s, r) =>
      s +
      parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || r["amount_ars"] || r["Amount"]),
    0,
  );
  const last7Margin = last7Revenue > 0 ? Math.round((1 - last7ExpTotal / last7Revenue) * 100) : 0;

  // Previous 7-day (for trend)
  const prev7Sales = sales.filter((r) => {
    const d = r["Дата"] || r["дата"] || "";
    return d >= week14 && d < week7;
  });
  const prev7Revenue = prev7Sales.reduce(
    (s, r) =>
      s + parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || r["total_ars"] || r["Total"]),
    0,
  );

  const trend = prev7Revenue > 0 ? Math.round((last7Revenue / prev7Revenue - 1) * 100) : null;

  return {
    today: {
      revenue: todayRevenue,
      expenses: todayExpenseTotal,
      margin: todayMargin,
      salesCount: todaySales.length,
      byClient,
      byProduct,
    },
    rolling7: {
      revenue: last7Revenue,
      expenses: last7ExpTotal,
      margin: last7Margin,
      trend,
    },
    alerts: [],
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatPnL(pnl) {
  const lines = [];
  const d = fmtDate(new Date());
  lines.push(`<b>💰 Daily P&L — ${d}</b>\n`);

  // Today
  lines.push(`<b>Сегодня:</b>`);
  if (pnl.today.salesCount === 0) {
    lines.push(`  Продаж нет`);
  } else {
    lines.push(
      `  Выручка: ${Math.round(pnl.today.revenue).toLocaleString()} ARS (${pnl.today.salesCount} продаж)`,
    );
    lines.push(`  Расходы: ${Math.round(pnl.today.expenses).toLocaleString()} ARS`);
    const marginEmoji = pnl.today.margin >= 50 ? "🟢" : pnl.today.margin >= 35 ? "🟡" : "🔴";
    lines.push(`  Маржа: ${marginEmoji} ${pnl.today.margin}%`);

    // Предупреждение если расходы за день не внесены
    if (pnl.today.expenses <= 0 && pnl.today.revenue > 0) {
      lines.push(`  ⚠️ Расходы не внесены за последние 7 дней — маржа может быть завышена`);
    }

    // Top clients
    const clients = Object.entries(pnl.today.byClient).sort((a, b) => b[1] - a[1]);
    if (clients.length > 0) {
      lines.push(`\n<b>По клиентам:</b>`);
      for (const [name, rev] of clients.slice(0, 5)) {
        lines.push(`  • ${name}: ${Math.round(rev).toLocaleString()} ARS`);
      }
    }
  }

  // 7-day rolling
  lines.push(`\n<b>7 дней (rolling):</b>`);
  lines.push(`  Выручка: ${Math.round(pnl.rolling7.revenue).toLocaleString()} ARS`);
  const m7Emoji = pnl.rolling7.margin >= 50 ? "🟢" : pnl.rolling7.margin >= 35 ? "🟡" : "🔴";
  lines.push(`  Маржа: ${m7Emoji} ${pnl.rolling7.margin}%`);

  // Предупреждение если расходы не внесены за последние 7 дней
  if (pnl.rolling7.expenses <= 0 && pnl.rolling7.revenue > 0) {
    lines.push(`  ⚠️ Расходы не внесены за последние 7 дней — маржа может быть завышена`);
  }

  if (pnl.rolling7.trend !== null) {
    const trendEmoji = pnl.rolling7.trend > 5 ? "📈" : pnl.rolling7.trend < -5 ? "📉" : "➡️";
    lines.push(
      `  Тренд: ${trendEmoji} ${pnl.rolling7.trend > 0 ? "+" : ""}${pnl.rolling7.trend}% vs прошлая неделя`,
    );
  }

  // Alerts
  if (pnl.today.margin > 0 && pnl.today.margin < MARGIN_ALERT_THRESHOLD) {
    lines.push(`\n⚠️ <b>Маржа ${pnl.today.margin}% ниже порога ${MARGIN_ALERT_THRESHOLD}%!</b>`);
  }
  if (pnl.rolling7.margin > 0 && pnl.rolling7.margin < MARGIN_ALERT_THRESHOLD) {
    lines.push(`⚠️ <b>7-дневная маржа ${pnl.rolling7.margin}% ниже порога!</b>`);
  }
  if (pnl.rolling7.trend !== null && pnl.rolling7.trend < -15) {
    lines.push(`⚠️ <b>Выручка упала на ${Math.abs(pnl.rolling7.trend)}% за неделю!</b>`);
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Daily P&L starting...`);

  // Источник данных: farm-state кеш -> sheets.js -> HTTP API
  let sales, expenses;
  let farmState = null;
  try {
    farmState = await require("./farm-state.cjs").getState();
  } catch (err) {
    console.log(`[INFO] farm-state недоступен: ${err.message}`);
  }

  if (farmState && farmState.sales && farmState.expenses) {
    sales = farmState.sales;
    expenses = farmState.expenses;
    console.log("[INFO] Данные загружены из farm-state кеша");
  } else {
    try {
      const { readSheet, PEPINO_SHEETS_ID } = require("./sheets.js");
      const [salesRows, expRows] = await Promise.all([
        readSheet(PEPINO_SHEETS_ID, "🛒 Продажи"),
        readSheet(PEPINO_SHEETS_ID, "💰 Расходы"),
      ]);
      sales = rowsToObjects(salesRows);
      expenses = rowsToObjects(expRows);
    } catch {
      console.log("Direct read failed, using API...");
      [sales, expenses] = await Promise.all([fetchJson("/sales"), fetchJson("/expenses")]);
    }
  }

  console.log(`Sales: ${sales.length}, Expenses: ${expenses.length}`);

  const pnl = analyzePnL(sales, expenses);
  const report = formatPnL(pnl);

  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Alert if margin low
  if (!DRY_RUN && pnl.today.margin > 0 && pnl.today.margin < MARGIN_ALERT_THRESHOLD) {
    await postJson("/log/alert", {
      type: "financial",
      zone: "P&L",
      description: `Маржа ${pnl.today.margin}% ниже порога ${MARGIN_ALERT_THRESHOLD}%. Выручка: ${Math.round(pnl.today.revenue)} ARS, Расходы: ${Math.round(pnl.today.expenses)} ARS`,
      severity: "4",
      source: "daily-pnl",
    }).catch((e) => console.error("Alert:", e.message));
  }

  // Telegram
  if (SEND_TG) {
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
      console.log("[OK] P&L sent to Telegram");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // Langfuse
  await trace({
    name: "daily-pnl",
    input: { sales: sales.length, expenses: expenses.length },
    output: {
      today_revenue: pnl.today.revenue,
      today_margin: pnl.today.margin,
      rolling7_revenue: pnl.rolling7.revenue,
      rolling7_margin: pnl.rolling7.margin,
      trend: pnl.rolling7.trend,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "daily-pnl" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
