#!/usr/bin/env node
/**
 * create-ai-costs-dashboard.cjs — Создание Grafana-дашборда AI Costs для Pepino Pick
 *
 * Использует Grafana API для создания дашборда с панелями мониторинга
 * расходов LLM Router. Данные берутся из llm-cost-report.cjs.
 *
 * Запуск: node create-ai-costs-dashboard.cjs
 */

const http = require("http");
const fs = require("fs");

const GRAFANA_URL = "http://localhost:3000";
const GRAFANA_USER = process.env.GRAFANA_USER || "pepino";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "PepinoGrafana2026"; // TODO: remove fallback after env migration
const DASHBOARD_UID = "pepino-ai-costs";
const INFINITY_DS = { type: "yesoreyeram-infinity-datasource", uid: "dfgjicgykuxa8b" };

// Загружаем отчёт из /tmp если есть, иначе используем пустышки
let report = null;
try {
  const raw = fs.readFileSync("/tmp/llm-cost-report.json", "utf-8");
  report = JSON.parse(raw);
} catch {
  console.log("[INFO] /tmp/llm-cost-report.json не найден, используем заглушки");
}

function grafanaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString("base64");
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "localhost",
      port: 3000,
      path: path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Построение inline-данных из отчёта ───────────────────────────────────────

function getStatData(key, fallback) {
  if (!report) return JSON.stringify([{ value: fallback }]);

  switch (key) {
    case "total_cost":
      return JSON.stringify([{ value: report.daily_summary?.total_cost_usd ?? 0 }]);
    case "avg_cost":
      return JSON.stringify([{ value: report.daily_summary?.avg_cost_per_task_usd ?? 0 }]);
    case "tasks_today":
      return JSON.stringify([{ value: report.daily_summary?.total_tasks ?? 0 }]);
    case "cheap_pass_rate":
      return JSON.stringify([{ value: report.cheap_pass_rate ?? 0 }]);
    case "budget_pct":
      return JSON.stringify([{ value: report.budget?.spent_pct ?? 0 }]);
    default:
      return JSON.stringify([{ value: fallback }]);
  }
}

function getTierData() {
  if (!report || !report.tier_distribution) {
    return JSON.stringify([
      { tier: "T1", pct: 50, cost_usd: 0.001 },
      { tier: "T2", pct: 30, cost_usd: 0.01 },
      { tier: "T3", pct: 15, cost_usd: 0.05 },
      { tier: "T4", pct: 5, cost_usd: 0.20 },
    ]);
  }
  return JSON.stringify(report.tier_distribution);
}

function getSkillCostData() {
  if (!report || !report.top_skills) {
    return JSON.stringify([
      { skill: "shadow-ceo", cost_usd: 0.05 },
      { skill: "procurement", cost_usd: 0.02 },
      { skill: "knowledge", cost_usd: 0.01 },
    ]);
  }
  return JSON.stringify(report.top_skills.slice(0, 5));
}

function getRecentTasks() {
  if (!report || !report.recent_tasks) {
    return JSON.stringify([]);
  }
  return JSON.stringify(report.recent_tasks);
}

function getModelUsageData() {
  if (!report || !report.model_usage) {
    return JSON.stringify([
      { model: "gemini-2.0-flash", count: 10, cost_usd: 0.001 },
      { model: "claude-3.5-haiku", count: 8, cost_usd: 0.02 },
      { model: "claude-sonnet-4", count: 3, cost_usd: 0.05 },
    ]);
  }
  return JSON.stringify(report.model_usage);
}

function getBudgetData() {
  if (!report || !report.budget) {
    return JSON.stringify([{
      monthly_budget_usd: 80,
      spent_usd: 0,
      spent_pct: 0,
      remaining_usd: 80,
      projected_usd: 0,
    }]);
  }
  return JSON.stringify([report.budget]);
}

// ── Определение панелей дашборда ─────────────────────────────────────────────

function buildDashboard() {
  return {
    uid: DASHBOARD_UID,
    title: "AI Costs -- Pepino Pick",
    tags: ["pepino", "ai", "costs", "llm"],
    timezone: "browser",
    schemaVersion: 39,
    editable: true,
    refresh: "5m",
    time: { from: "now-24h", to: "now" },
    panels: [
      // ── Row 1: Stat Panels ──────────────────────────────────────────────
      makeStatPanel(1, "Total Cost Today ($)", "total_cost", 0, 0, 5, 4, {
        unit: "currencyUSD",
        decimals: 4,
        thresholds: [
          { color: "green", value: null },
          { color: "yellow", value: 1 },
          { color: "red", value: 5 },
        ],
      }),
      makeStatPanel(2, "Avg Cost/Task ($)", "avg_cost", 5, 0, 4, 4, {
        unit: "currencyUSD",
        decimals: 4,
        thresholds: [
          { color: "green", value: null },
          { color: "yellow", value: 0.01 },
          { color: "red", value: 0.05 },
        ],
      }),
      makeStatPanel(3, "Tasks Today", "tasks_today", 9, 0, 4, 4, {
        unit: "short",
        decimals: 0,
        thresholds: [
          { color: "blue", value: null },
          { color: "green", value: 10 },
        ],
      }),
      makeStatPanel(4, "Cheap Pass Rate (%)", "cheap_pass_rate", 13, 0, 4, 4, {
        unit: "percent",
        decimals: 1,
        thresholds: [
          { color: "red", value: null },
          { color: "yellow", value: 70 },
          { color: "green", value: 90 },
        ],
      }),
      makeStatPanel(5, "Budget Used (%)", "budget_pct", 17, 0, 7, 4, {
        unit: "percent",
        decimals: 1,
        thresholds: [
          { color: "green", value: null },
          { color: "yellow", value: 50 },
          { color: "orange", value: 75 },
          { color: "red", value: 90 },
        ],
      }),

      // ── Row 2: Tier Distribution (pie) + Cost by Skill (bar) + Model Usage (bar) ──
      {
        id: 6,
        title: "Tier Distribution",
        type: "piechart",
        gridPos: { h: 8, w: 8, x: 0, y: 4 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {
            color: { mode: "palette-classic" },
          },
          overrides: [],
        },
        options: {
          reduceOptions: { calcs: ["lastNotNull"] },
          pieType: "pie",
          tooltip: { mode: "single" },
          legend: { displayMode: "list", placement: "right" },
        },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "inline",
            format: "table",
            data: getTierData(),
            columns: [
              { selector: "tier", text: "tier", type: "string" },
              { selector: "pct", text: "pct", type: "number" },
            ],
          },
        ],
      },
      {
        id: 7,
        title: "Cost by Skill (Top 5)",
        type: "barchart",
        gridPos: { h: 8, w: 8, x: 8, y: 4 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {
            color: { mode: "palette-classic" },
            unit: "currencyUSD",
            decimals: 4,
          },
          overrides: [],
        },
        options: {
          orientation: "horizontal",
          xTickLabelRotation: 0,
          showValue: "auto",
          barWidth: 0.8,
          tooltip: { mode: "single" },
          legend: { displayMode: "list", placement: "bottom" },
        },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "inline",
            format: "table",
            data: getSkillCostData(),
            columns: [
              { selector: "skill", text: "skill", type: "string" },
              { selector: "cost_usd", text: "cost_usd", type: "number" },
            ],
          },
        ],
      },
      {
        id: 8,
        title: "Model Usage",
        type: "barchart",
        gridPos: { h: 8, w: 8, x: 16, y: 4 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {
            color: { mode: "palette-classic" },
          },
          overrides: [],
        },
        options: {
          orientation: "horizontal",
          showValue: "auto",
          barWidth: 0.8,
          tooltip: { mode: "single" },
          legend: { displayMode: "list", placement: "bottom" },
        },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "inline",
            format: "table",
            data: getModelUsageData(),
            columns: [
              { selector: "model", text: "model", type: "string" },
              { selector: "count", text: "count", type: "number" },
              { selector: "cost_usd", text: "cost_usd", type: "number" },
            ],
          },
        ],
      },

      // ── Row 3: Budget Details + Recent Tasks ──────────────────────────
      {
        id: 9,
        title: "Budget Tracker",
        type: "table",
        gridPos: { h: 4, w: 24, x: 0, y: 12 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {},
          overrides: [
            { matcher: { id: "byName", options: "spent_pct" }, properties: [{ id: "unit", value: "percent" }] },
            { matcher: { id: "byName", options: "spent_usd" }, properties: [{ id: "unit", value: "currencyUSD" }] },
            { matcher: { id: "byName", options: "remaining_usd" }, properties: [{ id: "unit", value: "currencyUSD" }] },
            { matcher: { id: "byName", options: "projected_usd" }, properties: [{ id: "unit", value: "currencyUSD" }] },
            { matcher: { id: "byName", options: "monthly_budget_usd" }, properties: [{ id: "unit", value: "currencyUSD" }] },
          ],
        },
        options: { showHeader: true, footer: { show: false } },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "inline",
            format: "table",
            data: getBudgetData(),
            columns: [
              { selector: "monthly_budget_usd", text: "monthly_budget_usd", type: "number" },
              { selector: "spent_usd", text: "spent_usd", type: "number" },
              { selector: "spent_pct", text: "spent_pct", type: "number" },
              { selector: "remaining_usd", text: "remaining_usd", type: "number" },
              { selector: "projected_usd", text: "projected_usd", type: "number" },
            ],
          },
        ],
      },
      {
        id: 10,
        title: "Recent Tasks",
        type: "table",
        gridPos: { h: 10, w: 24, x: 0, y: 16 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {},
          overrides: [
            { matcher: { id: "byName", options: "cost_usd" }, properties: [{ id: "unit", value: "currencyUSD" }, { id: "decimals", value: 4 }] },
            { matcher: { id: "byName", options: "latency_ms" }, properties: [{ id: "unit", value: "ms" }] },
          ],
        },
        options: {
          showHeader: true,
          sortBy: [{ displayName: "timestamp", desc: true }],
          footer: { show: false },
        },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "inline",
            format: "table",
            data: getRecentTasks(),
            columns: [
              { selector: "timestamp", text: "timestamp", type: "string" },
              { selector: "skill", text: "skill", type: "string" },
              { selector: "intent", text: "intent", type: "string" },
              { selector: "tier", text: "tier", type: "string" },
              { selector: "model", text: "model", type: "string" },
              { selector: "cost_usd", text: "cost_usd", type: "number" },
              { selector: "latency_ms", text: "latency_ms", type: "number" },
              { selector: "quality", text: "quality", type: "string" },
              { selector: "escalated", text: "escalated", type: "string" },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Создание stat-панели
 */
function makeStatPanel(id, title, dataKey, x, y, w, h, opts) {
  return {
    id,
    title,
    type: "stat",
    gridPos: { h, w, x, y },
    datasource: INFINITY_DS,
    fieldConfig: {
      defaults: {
        unit: opts.unit || "short",
        decimals: opts.decimals ?? 0,
        thresholds: {
          mode: "absolute",
          steps: (opts.thresholds || []).map((t) => ({
            color: t.color,
            value: t.value,
          })),
        },
      },
      overrides: [],
    },
    options: {
      reduceOptions: { values: false, calcs: ["lastNotNull"], fields: "" },
      orientation: "auto",
      textMode: "auto",
      colorMode: "background",
      graphMode: "none",
      justifyMode: "auto",
    },
    targets: [
      {
        datasource: INFINITY_DS,
        refId: "A",
        type: "json",
        source: "inline",
        format: "table",
        data: getStatData(dataKey, 0),
        columns: [{ selector: "value", text: title, type: "number" }],
      },
    ],
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const dashboard = buildDashboard();

    const resp = await grafanaRequest("POST", "/api/dashboards/db", {
      dashboard,
      overwrite: true,
      folderId: 0,
    });

    if (resp.status === 200 || resp.status === 201) {
      console.log(`[OK] Dashboard created: ${GRAFANA_URL}/d/${DASHBOARD_UID}`);
      console.log(`     Status: ${resp.data.status}, Version: ${resp.data.version}`);
    } else {
      console.error(`[ERROR] HTTP ${resp.status}:`, JSON.stringify(resp.data));
      process.exit(1);
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
