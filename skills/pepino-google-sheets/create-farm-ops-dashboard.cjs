#!/usr/bin/env node
/**
 * create-farm-ops-dashboard.cjs — Создает дашборд Farm Ops в Grafana
 * Одноразовый скрипт. После создания данные обновляются через sync-dashboard.cjs
 */

const http = require("http");

const GRAFANA_USER = process.env.GRAFANA_USER || "pepino";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "PepinoGrafana2026"; // TODO: remove fallback after env migration
const INFINITY_DS = { type: "yesoreyeram-infinity-datasource", uid: "dfgjicgykuxa8b" };

function grafanaPost(path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString("base64");
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost",
      port: 3000,
      path,
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Parse error: ${body.slice(0, 300)}`)); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Хелпер для создания stat-панели
function statPanel(id, title, gridPos, thresholdSteps, unit = "none") {
  return {
    id,
    type: "stat",
    title,
    gridPos,
    datasource: INFINITY_DS,
    fieldConfig: {
      defaults: {
        unit,
        thresholds: { steps: thresholdSteps },
      },
    },
    options: {
      colorMode: "background",
      graphMode: "none",
      reduceOptions: { calcs: ["lastNotNull"] },
      textMode: "value",
    },
    targets: [{
      refId: "A",
      datasource: INFINITY_DS,
      type: "json",
      source: "inline",
      format: "table",
      data: "[{\"value\": 0}]",
      columns: [{ selector: "value", text: title, type: "number" }],
    }],
  };
}

const dashboard = {
  uid: "pepino-farm-ops",
  title: "Farm Ops - Pepino Pick",
  tags: ["pepino", "farm-ops"],
  timezone: "browser",
  schemaVersion: 39,
  refresh: "5m",
  panels: [
    // === Row 1: KPI stat-панели ===
    statPanel(1, "Урожай сегодня кг", { h: 5, w: 6, x: 0, y: 0 }, [
      { color: "red", value: null },
      { color: "yellow", value: 10 },
      { color: "green", value: 30 },
    ]),
    statPanel(2, "Отход %", { h: 5, w: 6, x: 6, y: 0 }, [
      { color: "green", value: null },
      { color: "yellow", value: 10 },
      { color: "red", value: 20 },
    ], "percent"),
    statPanel(3, "Активные алерты", { h: 5, w: 6, x: 12, y: 0 }, [
      { color: "green", value: null },
      { color: "yellow", value: 1 },
      { color: "red", value: 3 },
    ]),
    statPanel(4, "Продукция в работе", { h: 5, w: 6, x: 18, y: 0 }, [
      { color: "blue", value: null },
      { color: "green", value: 3 },
    ]),

    // === Row 2: Лог производства ===
    {
      id: 5,
      type: "table",
      title: "Лог производства (LIVE)",
      gridPos: { h: 8, w: 24, x: 0, y: 5 },
      datasource: INFINITY_DS,
      targets: [{
        refId: "A",
        datasource: INFINITY_DS,
        type: "json",
        source: "inline",
        format: "table",
        data: "[]",
        columns: [
          { selector: "date", text: "Дата", type: "string" },
          { selector: "product", text: "Продукт", type: "string" },
          { selector: "harvest_kg", text: "Урожай кг", type: "number" },
          { selector: "waste_kg", text: "Отход кг", type: "number" },
          { selector: "waste_pct", text: "% отхода", type: "number" },
          { selector: "greenhouse", text: "Теплица", type: "string" },
        ],
      }],
    },

    // === Row 3: Активные алерты ===
    {
      id: 6,
      type: "table",
      title: "Алерты фермы (LIVE)",
      gridPos: { h: 6, w: 24, x: 0, y: 13 },
      datasource: INFINITY_DS,
      targets: [{
        refId: "A",
        datasource: INFINITY_DS,
        type: "json",
        source: "inline",
        format: "table",
        data: "[]",
        columns: [
          { selector: "date", text: "Дата", type: "string" },
          { selector: "type", text: "Тип", type: "string" },
          { selector: "zone", text: "Зона", type: "string" },
          { selector: "description", text: "Описание", type: "string" },
        ],
      }],
    },

    // === Row 4: Графики ===
    {
      id: 7,
      type: "barchart",
      title: "Урожай по продуктам",
      gridPos: { h: 8, w: 12, x: 0, y: 19 },
      datasource: INFINITY_DS,
      fieldConfig: {
        defaults: { unit: "none" },
        overrides: [{
          matcher: { id: "byName", options: "harvest_kg" },
          properties: [{ id: "color", value: { fixedColor: "green", mode: "fixed" } }],
        }],
      },
      options: { barWidth: 0.5, orientation: "vertical" },
      targets: [{
        refId: "A",
        datasource: INFINITY_DS,
        type: "json",
        source: "inline",
        format: "table",
        data: "[]",
        columns: [
          { selector: "product", text: "product", type: "string" },
          { selector: "harvest_kg", text: "harvest_kg", type: "number" },
        ],
      }],
    },
    {
      id: 8,
      type: "barchart",
      title: "Расходы по месяцам",
      gridPos: { h: 8, w: 12, x: 12, y: 19 },
      datasource: INFINITY_DS,
      fieldConfig: {
        defaults: { unit: "none" },
        overrides: [{
          matcher: { id: "byName", options: "amount_ars" },
          properties: [{ id: "color", value: { fixedColor: "orange", mode: "fixed" } }],
        }],
      },
      options: { barWidth: 0.5, orientation: "vertical" },
      targets: [{
        refId: "A",
        datasource: INFINITY_DS,
        type: "json",
        source: "inline",
        format: "table",
        data: "[]",
        columns: [
          { selector: "month", text: "month", type: "string" },
          { selector: "amount_ars", text: "amount_ars", type: "number" },
        ],
      }],
    },
  ],
};

async function main() {
  console.log("Creating Farm Ops dashboard...");

  const result = await grafanaPost("/api/dashboards/db", {
    dashboard,
    overwrite: true,
  });

  if (result.status === "success") {
    console.log(`Dashboard created successfully!`);
    console.log(`  UID: ${result.uid}`);
    console.log(`  URL: http://localhost:3000${result.url}`);
    console.log(`  Version: ${result.version}`);
    console.log(`  Panels: ${dashboard.panels.length}`);
  } else {
    console.error("Failed to create dashboard:", JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main();
