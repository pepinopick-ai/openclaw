#!/usr/bin/env node
/**
 * create-business-dashboard.cjs — Создание Grafana-дашборда Business Intelligence
 *
 * Панели:
 *   Row 1 — Key Metrics: Revenue Today, Margin %, Open Alerts, Stock Critical Count
 *   Row 2 — Client Health: Active / At Risk / Churned (таблица)
 *   Row 3 — Cash Flow: 7-day Forecast, Best Day of Week
 *
 * Данные: JSON datasource -> Sheets API (http://127.0.0.1:4000)
 * Запуск: node create-business-dashboard.cjs
 */

const http = require("http");

const GRAFANA_URL = "http://localhost:3000";
const GRAFANA_USER = process.env.GRAFANA_USER || "pepino";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "PepinoGrafana2026";
const DASHBOARD_UID = "pepino-business-intel";

// Infinity datasource, настроенный на Sheets API
const INFINITY_DS = { type: "yesoreyeram-infinity-datasource", uid: "dfgjicgykuxa8b" };

// Базовый URL Sheets API для URL-запросов Infinity
const SHEETS_API_BASE = "http://127.0.0.1:4000";

/**
 * HTTP-запрос к Grafana API
 * @param {string} method - HTTP метод
 * @param {string} path - путь API
 * @param {object|null} body - тело запроса
 * @returns {Promise<{status: number, data: any}>}
 */
function grafanaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString("base64");
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "localhost",
      port: 3000,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseBody) });
        } catch {
          resolve({ status: res.statusCode, data: responseBody });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Хелперы для построения панелей ──────────────────────────────────────────

/**
 * Stat-панель с URL-источником данных из Sheets API
 * @param {number} id - ID панели
 * @param {string} title - заголовок
 * @param {string} endpoint - эндпоинт Sheets API (например /dashboard)
 * @param {string} selector - JSON-поле для извлечения значения
 * @param {number} x - позиция X в сетке
 * @param {number} y - позиция Y
 * @param {number} w - ширина
 * @param {number} h - высота
 * @param {object} opts - unit, decimals, thresholds, colorMode
 * @returns {object} Grafana panel definition
 */
function makeStatPanel(id, title, endpoint, selector, x, y, w, h, opts) {
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
      colorMode: opts.colorMode || "background",
      graphMode: "none",
      justifyMode: "auto",
    },
    targets: [
      {
        datasource: INFINITY_DS,
        refId: "A",
        type: "json",
        source: "url",
        url: `${SHEETS_API_BASE}${endpoint}`,
        format: "table",
        columns: [{ selector, text: title, type: "number" }],
      },
    ],
  };
}

// ── Определение дашборда ────────────────────────────────────────────────────

function buildDashboard() {
  return {
    uid: DASHBOARD_UID,
    title: "Business Intelligence -- Pepino Pick",
    tags: ["pepino", "business", "intelligence", "bi"],
    timezone: "browser",
    schemaVersion: 39,
    editable: true,
    refresh: "5m",
    time: { from: "now-24h", to: "now" },
    panels: [
      // ── Row 1: Key Metrics (stat-панели из /dashboard) ──────────────────

      makeStatPanel(1, "Revenue Today (ARS)", "/dashboard", "revenue_today_ars", 0, 0, 6, 5, {
        unit: "short",
        decimals: 0,
        thresholds: [
          { color: "red", value: null },
          { color: "yellow", value: 10000 },
          { color: "green", value: 50000 },
        ],
      }),

      makeStatPanel(2, "Margin %", "/dashboard", "margin_pct", 6, 0, 6, 5, {
        unit: "percent",
        decimals: 1,
        thresholds: [
          { color: "red", value: null },
          { color: "yellow", value: 20 },
          { color: "green", value: 40 },
        ],
      }),

      makeStatPanel(3, "Open Alerts", "/dashboard", "open_alerts", 12, 0, 6, 5, {
        unit: "short",
        decimals: 0,
        thresholds: [
          { color: "green", value: null },
          { color: "yellow", value: 1 },
          { color: "red", value: 3 },
        ],
      }),

      makeStatPanel(4, "Stock Critical", "/dashboard", "stock_critical_count", 18, 0, 6, 5, {
        unit: "short",
        decimals: 0,
        thresholds: [
          { color: "green", value: null },
          { color: "orange", value: 1 },
          { color: "red", value: 3 },
        ],
      }),

      // ── Row 2: Client Health (таблица из /clients) ────────────────────

      {
        id: 5,
        title: "Client Health",
        type: "table",
        gridPos: { h: 6, w: 24, x: 0, y: 5 },
        datasource: INFINITY_DS,
        fieldConfig: {
          defaults: {},
          overrides: [
            {
              matcher: { id: "byName", options: "active" },
              properties: [
                { id: "custom.displayMode", value: "color-background" },
                {
                  id: "thresholds",
                  value: { mode: "absolute", steps: [{ color: "green", value: null }] },
                },
              ],
            },
            {
              matcher: { id: "byName", options: "at_risk" },
              properties: [
                { id: "custom.displayMode", value: "color-background" },
                {
                  id: "thresholds",
                  value: { mode: "absolute", steps: [{ color: "yellow", value: null }] },
                },
              ],
            },
            {
              matcher: { id: "byName", options: "churned" },
              properties: [
                { id: "custom.displayMode", value: "color-background" },
                {
                  id: "thresholds",
                  value: { mode: "absolute", steps: [{ color: "red", value: null }] },
                },
              ],
            },
          ],
        },
        options: {
          showHeader: true,
          footer: { show: false },
        },
        targets: [
          {
            datasource: INFINITY_DS,
            refId: "A",
            type: "json",
            source: "url",
            url: `${SHEETS_API_BASE}/clients`,
            format: "table",
            columns: [
              { selector: "active", text: "Active", type: "number" },
              { selector: "at_risk", text: "At Risk", type: "number" },
              { selector: "churned", text: "Churned", type: "number" },
            ],
          },
        ],
      },

      // ── Row 3: Cash Flow (stat-панели из /forecast) ───────────────────

      makeStatPanel(6, "7-day Forecast (ARS)", "/forecast", "forecast_7d_ars", 0, 11, 12, 5, {
        unit: "short",
        decimals: 0,
        colorMode: "value",
        thresholds: [
          { color: "red", value: null },
          { color: "yellow", value: 50000 },
          { color: "green", value: 150000 },
        ],
      }),

      makeStatPanel(7, "Best Day of Week", "/forecast", "best_day_of_week", 12, 11, 12, 5, {
        unit: "none",
        decimals: 0,
        colorMode: "value",
        thresholds: [{ color: "blue", value: null }],
      }),
    ],
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

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
      console.log(`     Title: ${dashboard.title}`);
      console.log(`     Panels: ${dashboard.panels.length}`);
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
