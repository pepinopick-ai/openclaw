/**
 * Daily Dashboard Auto-Update Script
 * Runs via cron: reads KPI, P&L, Alerts → updates CEO Dashboard sheet
 *
 * Usage: node daily-dashboard-update.js
 * Cron:  0 7 * * * cd /home/roman/openclaw/skills/pepino-google-sheets && node daily-dashboard-update.js >> /tmp/pepino-daily.log 2>&1
 */

import { trace } from "./langfuse-trace.js";
import { readSheet, writeToSheet, listSheets, PEPINO_SHEETS_ID } from "./sheets.js";

async function updateDashboard() {
  const sid = PEPINO_SHEETS_ID;
  const now = new Date().toISOString().slice(0, 10);
  console.log(`[${now}] Starting daily dashboard update...`);

  try {
    // Read source data
    const [kpi, pl, alerts, sales] = await Promise.all([
      readSheet(sid, "⚙️ KPI"),
      readSheet(sid, "📊 P&L"),
      readSheet(sid, "⚠️ Алерты"),
      readSheet(sid, "🛒 Продажи"),
    ]);

    // Get latest KPI row (skip header)
    const latestKpi = kpi.length > 1 ? kpi[kpi.length - 1] : [];
    const prevKpi = kpi.length > 2 ? kpi[kpi.length - 2] : [];

    // Get latest P&L
    const latestPl = pl.length > 1 ? pl[pl.length - 1] : [];

    // Count open alerts
    const openAlerts = alerts.filter((r) => r[6] === "открыт").length;

    // Today's sales
    const todaySales = sales.filter((r) => r[0] === now);
    const todayRevenue = todaySales.reduce((sum, r) => sum + (parseFloat(r[5]) || 0), 0);

    // Calculate trends
    const revTrend =
      prevKpi[3] && latestKpi[3]
        ? Math.round(((latestKpi[3] - prevKpi[3]) / prevKpi[3]) * 100) + "%"
        : "N/A";

    // Build dashboard
    const dashboard = [
      ["CEO DASHBOARD Pepino Pick", "", "", "", "", "Updated:", now],
      [],
      ["KPI SUMMARY"],
      ["Metric", "Current Month", "Previous", "Trend", "Target", "Status"],
      ["Revenue ARS", latestKpi[3] || 0, prevKpi[3] || 0, revTrend, 700000, ""],
      ["Margin %", latestKpi[6] || "0%", prevKpi[6] || "0%", "", "55%", ""],
      ["Active clients", latestKpi[7] || 0, prevKpi[7] || 0, "", 10, ""],
      ["Open Alerts", openAlerts, "", "", 0, openAlerts > 3 ? "CRIT" : "OK"],
      ["Today Revenue", todayRevenue, "", "", "", ""],
      [],
      ["MARGIN PER M2 (annual)"],
      ["Product", "Profit/m2/yr USD", "Margin %", "Area m2", "Profit/yr USD", "Priority"],
      ["Microgreens", 207.57, "61%", 60, 12454, "MAX"],
      ["Oyster mushroom", 122.67, "57%", 50, 6134, "HIGH"],
      ["Shiitake", 112.11, "56%", 40, 4484, "MED"],
      ["Edible flowers", 48.06, "50%", 30, 1442, "MED"],
      ["Cucumbers", 27.48, "40%", 20, 550, "LOW"],
      ["TOTAL", "", "63%", 200, 25064, ""],
      [],
      ["LATEST P&L"],
      ["Month", "Revenue", "COGS", "Gross Margin", "OPEX", "EBITDA", "EBITDA %"],
      latestPl.length > 0 ? latestPl : ["No data"],
      [],
      ["ACTIVE ALERTS: " + openAlerts],
      ...alerts.filter((r) => r[6] === "открыт").map((r) => [r[0], r[1], r[3], r[4], r[5]]),
    ];

    await writeToSheet(sid, dashboard, "CEO Dashboard");
    console.log(
      `[${now}] Dashboard updated. Alerts: ${openAlerts}, Today sales: ${todaySales.length}`,
    );

    // Langfuse trace
    await trace({
      name: "daily-dashboard-update",
      input: { date: now },
      output: { alerts: openAlerts, today_sales: todaySales.length },
      metadata: { skill: "pepino-google-sheets", cron: "daily-dashboard-update" },
    }).catch(() => {});
  } catch (err) {
    console.error(`[${now}] ERROR: ${err.message}`);
    process.exit(1);
  }
}

updateDashboard();
