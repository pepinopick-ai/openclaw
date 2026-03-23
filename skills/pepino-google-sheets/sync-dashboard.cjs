#!/usr/bin/env node
/**
 * sync-dashboard.cjs — Syncs Grafana CEO Dashboard inline data from Sheets API
 * Runs via cron every 5 minutes.
 *
 * Architecture: Sheets API → fetch JSON → update Grafana dashboard inline data → POST to Grafana
 * Workaround: Infinity plugin has a bug where frontend sends source=inline
 * instead of source=url, so we pre-populate inline data from the API.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const { apiHeaders } = require("./api-auth.cjs");
const { trace } = require("./langfuse-trace.cjs");

const SHEETS_API = "http://localhost:4000";
const GRAFANA_URL = "http://localhost:3000";
const GRAFANA_USER = process.env.GRAFANA_USER || "pepino";
const GRAFANA_PASS = process.env.GRAFANA_PASS || "PepinoGrafana2026"; // TODO: remove fallback after env migration
const DASHBOARD_UIDS = [
  "4e227602-6905-4c10-a057-52e5b71e18e7",  // CEO Dashboard
  "pepino-ceo-live",                         // Панель управления (LIVE)
  "pepino-farm-ops",                         // Farm Ops Dashboard
  "pepino-system-health",                    // System Health Dashboard
  "pepino-ai-costs",                         // AI Costs Dashboard
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const isLocal = url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
    mod.get(url, { ...(isLocal ? { headers: apiHeaders() } : {}) }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error from ${url}: ${data.slice(0, 200)}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
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
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Grafana parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Panel title -> inline JSON data (supports EN + RU titles)
function getPanelMappings(kpi, alerts, products, pnl, roi, production) {
  // Filter out malformed dates (e.g. "27/11/2002") — only keep YYYY-MM format
  const validKpi = kpi.filter(r => /^\d{4}-\d{2}/.test(r.month || ""));
  const latestKpi = validKpi[validKpi.length - 1] || {};
  const latestMonth = latestKpi.month || "";

  // Aggregate harvest from production log for the latest KPI month
  let harvestKg = 0;
  for (const r of (production || [])) {
    const date = r["Дата"] || "";
    if (date.startsWith(latestMonth)) {
      harvestKg += Number(r["Урожай кг"]) || 0;
    }
  }

  // ROI is array of {metric, value, unit} — build lookup by metric name
  const roiMap = {};
  for (const r of (roi || [])) {
    roiMap[r.metric] = r.value;
  }

  // Рассчитываем сегодняшний урожай и отход для Farm Ops
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let harvestToday = 0;
  let wasteToday = 0;
  const productSet = new Set();
  for (const r of (production || [])) {
    const date = r["Дата"] || "";
    productSet.add(r["Продукт"] || "");
    if (date === today || date.startsWith(today)) {
      harvestToday += Number(r["Урожай кг"]) || 0;
      wasteToday += Number(r["Отход кг"]) || 0;
    }
  }
  const wastePctToday = harvestToday > 0 ? Math.round((wasteToday / harvestToday) * 100) : 0;

  return {
    // CEO Dashboard (EN)
    "Revenue ARS (Mar)": JSON.stringify([{ value: Number(latestKpi.revenue_ars) || 0 }]),
    "EBITDA ARS (Mar)": JSON.stringify([{ value: Number(latestKpi.ebitda_ars) || 0 }]),
    "Margin %": JSON.stringify([{ value: Math.round((Number(latestKpi.gross_margin_pct) || 0) * 100) }]),
    "Active Clients": JSON.stringify([{ value: Number(latestKpi.active_clients) || 0 }]),
    "Open Alerts": JSON.stringify([{ value: alerts.length }]),
    "Blue Rate": JSON.stringify([{ value: Number(latestKpi.blue_rate) || 0 }]),
    "AI Budget": JSON.stringify([{ value: Number(latestKpi.revenue_usd) || 0 }]),
    // Панель управления (RU)
    "Выручка ARS": JSON.stringify([{ value: Number(latestKpi.revenue_ars) || 0 }]),
    "EBITDA ARS": JSON.stringify([{ value: Number(latestKpi.ebitda_ars) || 0 }]),
    "Маржа %": JSON.stringify([{ value: Number(latestKpi.gross_margin_pct) || 0 }]),
    "Клиенты": JSON.stringify([{ value: Number(latestKpi.active_clients) || 0 }]),
    "Алерты": JSON.stringify([{ value: alerts.length }]),
    "Курс Blue": JSON.stringify([{ value: Number(latestKpi.blue_rate) || 0 }]),
    "Урожай кг": JSON.stringify([{ value: harvestKg }]),
    "CAPEX теплицы": JSON.stringify([{ value: Number(roiMap["CAPEX на теплицу"]) || 0 }]),
    "ROI годовой": JSON.stringify([{ value: Number(roiMap["ROI годовой"]) || 0 }]),
    "Окупаемость": JSON.stringify([{ value: Number(roiMap["Окупаемость"]) || 0 }]),
    "Прибыль факт": JSON.stringify([{ value: Number(roiMap["Прибыль факт"]) || 0 }]),
    "EBITDA средн/мес": JSON.stringify([{ value: Number(roiMap["EBITDA средн/мес"]) || 0 }]),
    // Farm Ops Dashboard — stat-панели
    "Урожай сегодня кг": JSON.stringify([{ value: harvestToday }]),
    "Отход %": JSON.stringify([{ value: wastePctToday }]),
    "Активные алерты": JSON.stringify([{ value: alerts.length }]),
    "Продукция в работе": JSON.stringify([{ value: productSet.size }]),
  };
}

function getChartMappings(kpi, alerts, products, pnl, roi, capex, production, expenses) {
  // Revenue & EBITDA by Month (filter out malformed dates)
  const revenueChart = kpi
    .filter((r) => /^\d{4}-\d{2}/.test(r.month || ""))
    .map((r) => ({
      month: (r.month || "").replace("2025-", "").replace("2026-", ""),
      revenue: Number(r.revenue_ars) || 0,
      ebitda: Number(r.ebitda_ars) || 0,
    }));

  // Profit per m²
  const profitChart = products.map((p) => ({
    product: p.product || p.name || "?",
    profit: Number(p.profit_per_m2_usd) || 0,
  }));

  // P&L Monthly
  const pnlChart = pnl.map((r) => ({
    month: r.month || "",
    revenue: Number(r.revenue) || 0,
    cogs: Number(r.cogs) || 0,
    gross_margin: Number(r.gross_margin) || 0,
    opex: Number(r.opex) || 0,
    ebitda: Number(r.ebitda) || 0,
  }));

  // Active Alerts table
  const alertsTable = alerts.map((a) => ({
    date: a.date || "",
    type: a.type || "",
    zone: a.zone || "",
    description: a.description || a.desc || "",
  }));

  // Area Allocation
  const areaChart = products.map((p) => ({
    product: p.product || p.name || "?",
    area: Number(p.area_m2) || 0,
  }));

  // ROI summary — avoid "value" as field name (reserved in Infinity plugin)
  const roiTable = (roi || []).map((r) => ({
    metric: r.metric || "",
    amount: r.value ?? "",
    unit: r.unit || "",
  }));

  // CAPEX detail — API returns Russian keys: Наименование, Стоимость ARS, Категория, Кол-во, Цена шт ARS
  const capexTable = (capex || []).map((c) => ({
    name: c["Наименование"] || c.category || c.item || "",
    category: c["Категория"] || "",
    qty: Number(c["Кол-во"]) || 0,
    unit_price: Number(c["Цена шт ARS"]) || 0,
    amount: Number(c["Стоимость ARS"]) || Number(c.amount) || 0,
    note: c["Примечание"] || "",
  }));

  // Products table — API: product, profit_per_m2_usd, margin_pct, area_m2, annual_profit_usd, priority, cycles_per_year, yield_kg_per_m2_cycle
  const productsTable = products.map((p) => ({
    product: p.product || p.name || "?",
    profit_m2_usd: Number(p.profit_per_m2_usd) || 0,
    margin: Number(p.margin_pct) || 0,
    area_m2: Number(p.area_m2) || 0,
    profit_yr: Number(p.annual_profit_usd) || 0,
    priority: p.priority || "",
    cycles: Number(p.cycles_per_year) || 0,
    yield_kg: Number(p.yield_kg_per_m2_cycle) || 0,
  }));

  // Farm Ops: Лог производства (из /production)
  const productionLog = (production || []).map((r) => ({
    date: r["Дата"] || "",
    product: r["Продукт"] || "",
    harvest_kg: Number(r["Урожай кг"]) || 0,
    waste_kg: Number(r["Отход кг"]) || 0,
    waste_pct: Number(r["% отхода"]) || 0,
    greenhouse: r["Теплица"] || "",
  }));

  // Farm Ops: Алерты фермы (из /alerts, русские ключи)
  const farmAlertsTable = alerts.map((a) => ({
    date: a["дата"] || a.date || "",
    type: a["тип"] || a.type || "",
    zone: a["зона"] || a.zone || "",
    description: a["описание"] || a.description || a.desc || "",
  }));

  // Farm Ops: Урожай по продуктам (агрегация из production)
  const harvestByProduct = {};
  for (const r of (production || [])) {
    const prod = r["Продукт"] || "Другое";
    harvestByProduct[prod] = (harvestByProduct[prod] || 0) + (Number(r["Урожай кг"]) || 0);
  }
  const harvestChart = Object.entries(harvestByProduct).map(([product, harvest_kg]) => ({
    product,
    harvest_kg,
  }));

  // Farm Ops: Расходы по месяцам (агрегация из /expenses)
  const expensesByMonth = {};
  for (const r of (expenses || [])) {
    const date = r["Дата"] || "";
    const month = date.slice(0, 7); // YYYY-MM
    if (month) {
      expensesByMonth[month] = (expensesByMonth[month] || 0) + (Number(r["Сумма ARS"]) || 0);
    }
  }
  const expensesChart = Object.entries(expensesByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount_ars]) => ({ month, amount_ars }));

  return {
    revenue_chart: JSON.stringify(revenueChart),
    profit_chart: JSON.stringify(profitChart),
    pnl_chart: JSON.stringify(pnlChart),
    alerts_table: JSON.stringify(alertsTable),
    area_chart: JSON.stringify(areaChart),
    roi_table: JSON.stringify(roiTable),
    capex_table: JSON.stringify(capexTable),
    products_table: JSON.stringify(productsTable),
    // Farm Ops
    production_log: JSON.stringify(productionLog),
    farm_alerts_table: JSON.stringify(farmAlertsTable),
    harvest_chart: JSON.stringify(harvestChart),
    expenses_chart: JSON.stringify(expensesChart),
  };
}

async function main() {
  const startTime = Date.now();

  try {
    // 1. Fetch all data from Sheets API
    const [kpi, alerts, products, pnl, roi, capex, production, expenses] = await Promise.all([
      fetch(`${SHEETS_API}/kpi`),
      fetch(`${SHEETS_API}/alerts`),
      fetch(`${SHEETS_API}/products`),
      fetch(`${SHEETS_API}/pnl`),
      fetch(`${SHEETS_API}/roi`).catch(() => []),
      fetch(`${SHEETS_API}/capex`).catch(() => []),
      fetch(`${SHEETS_API}/production`).catch(() => []),
      fetch(`${SHEETS_API}/expenses`).catch(() => []),
    ]);

    // Читаем health-status.json для System Health дашборда
    let healthData = null;
    try {
      const raw = fs.readFileSync("/tmp/health-status.json", "utf-8");
      healthData = JSON.parse(raw);
    } catch {
      console.log(`[${new Date().toISOString()}] health-status.json not available, skipping health panels`);
    }

    // Читаем llm-cost-report.json для AI Costs дашборда
    let costReport = null;
    try {
      const raw = fs.readFileSync("/tmp/llm-cost-report.json", "utf-8");
      costReport = JSON.parse(raw);
    } catch {
      console.log(`[${new Date().toISOString()}] llm-cost-report.json not available, skipping AI cost panels`);
    }

    console.log(`[${new Date().toISOString()}] Fetched: kpi=${kpi.length} alerts=${alerts.length} products=${products.length} pnl=${pnl.length} roi=${roi.length} capex=${capex.length} production=${production.length} expenses=${expenses.length}`);

    // 2. Process each dashboard
    for (const DASHBOARD_UID of DASHBOARD_UIDS) {
    const dashResp = await grafanaRequest("GET", `/api/dashboards/uid/${DASHBOARD_UID}`);
    const dash = dashResp.dashboard;
    if (!dash) {
      console.log(`Dashboard ${DASHBOARD_UID} not found, skipping`);
      continue;
    }

    // 3. Map data to panels
    const statMappings = getPanelMappings(kpi, alerts, products, pnl, roi, production);
    const chartMappings = getChartMappings(kpi, alerts, products, pnl, roi, capex, production, expenses);

    const INFINITY_DS = { type: "yesoreyeram-infinity-datasource", uid: "dfgjicgykuxa8b" };

    let updated = 0;
    for (const p of dash.panels) {
      const title = p.title || "";
      const targets = p.targets || [];
      if (!targets.length) continue;
      const t = targets[0];

      // Always reset datasource to Infinity (fix for JSON API migration)
      p.datasource = INFINITY_DS;
      t.datasource = INFINITY_DS;

      // Stat panels — single value, selector must be "value"
      if (statMappings[title] !== undefined) {
        t.source = "inline";
        t.data = statMappings[title];
        t.type = "json";
        t.format = "table";
        t.columns = [{ selector: "value", text: title, type: "number" }];
        delete t.url;
        delete t.urlPath;
        delete t.url_options;
        delete t.fields;
        updated++;
        continue;
      }

      // Chart panels (match by keyword)
      const tl = title.toLowerCase();
      if ((tl.includes("revenue") || tl.includes("выручка")) && (tl.includes("ebitda")) && (tl.includes("month") || tl.includes("месяц"))) {
        t.source = "inline";
        t.data = chartMappings.revenue_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "month", text: "month", type: "string" },
          { selector: "revenue", text: "revenue", type: "number" },
          { selector: "ebitda", text: "ebitda", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("profit") || tl.includes("прибыль на м")) {
        t.source = "inline";
        t.data = chartMappings.profit_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "product", text: "product", type: "string" },
          { selector: "profit", text: "profit", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("p&l") || tl.includes("p\u0026l") || tl.includes("p&l")) {
        t.source = "inline";
        t.data = chartMappings.pnl_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "month", text: "month", type: "string" },
          { selector: "revenue", text: "revenue", type: "number" },
          { selector: "cogs", text: "cogs", type: "number" },
          { selector: "gross_margin", text: "gross_margin", type: "number" },
          { selector: "opex", text: "opex", type: "number" },
          { selector: "ebitda", text: "ebitda", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if ((tl.includes("alert") || tl.includes("алерт")) && !statMappings[title]) {
        t.source = "inline";
        t.data = chartMappings.alerts_table;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "date", text: "Date", type: "string" },
          { selector: "type", text: "Type", type: "string" },
          { selector: "zone", text: "Zone", type: "string" },
          { selector: "description", text: "Description", type: "string" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("area") || tl.includes("allocation") || tl.includes("площад")) {
        t.source = "inline";
        t.data = chartMappings.area_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "product", text: "product", type: "string" },
          { selector: "area", text: "area", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("продукци")) {
        t.source = "inline";
        t.data = chartMappings.products_table;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "product", text: "Product", type: "string" },
          { selector: "profit_m2_usd", text: "$/m2/yr", type: "number" },
          { selector: "margin", text: "Margin", type: "number" },
          { selector: "area_m2", text: "Area m2", type: "number" },
          { selector: "profit_yr", text: "Profit/yr $", type: "number" },
          { selector: "priority", text: "Priority", type: "string" },
          { selector: "cycles", text: "Cycles", type: "number" },
          { selector: "yield_kg", text: "Yield kg", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("инвестиционная сводка") || tl.includes("roi summary")) {
        t.source = "inline";
        t.data = chartMappings.roi_table;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "metric", text: "Показатель", type: "string" },
          { selector: "amount", text: "Значение", type: "number" },
          { selector: "unit", text: "Ед.", type: "string" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("лог производства")) {
        // Farm Ops: таблица лога производства
        t.source = "inline";
        t.data = chartMappings.production_log;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "date", text: "Дата", type: "string" },
          { selector: "product", text: "Продукт", type: "string" },
          { selector: "harvest_kg", text: "Урожай кг", type: "number" },
          { selector: "waste_kg", text: "Отход кг", type: "number" },
          { selector: "waste_pct", text: "% отхода", type: "number" },
          { selector: "greenhouse", text: "Теплица", type: "string" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("алерты фермы")) {
        // Farm Ops: таблица алертов фермы
        t.source = "inline";
        t.data = chartMappings.farm_alerts_table;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "date", text: "Дата", type: "string" },
          { selector: "type", text: "Тип", type: "string" },
          { selector: "zone", text: "Зона", type: "string" },
          { selector: "description", text: "Описание", type: "string" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("урожай по продуктам")) {
        // Farm Ops: bar chart урожай по продуктам
        t.source = "inline";
        t.data = chartMappings.harvest_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "product", text: "product", type: "string" },
          { selector: "harvest_kg", text: "harvest_kg", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("расходы по месяцам")) {
        // Farm Ops: bar chart расходы по месяцам
        t.source = "inline";
        t.data = chartMappings.expenses_chart;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "month", text: "month", type: "string" },
          { selector: "amount_ars", text: "amount_ars", type: "number" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      } else if (tl.includes("capex") || tl.includes("детализ")) {
        t.source = "inline";
        t.data = chartMappings.capex_table;
        t.type = "json";
        t.format = "table";
        t.columns = [
          { selector: "name", text: "Наименование", type: "string" },
          { selector: "category", text: "Категория", type: "string" },
          { selector: "qty", text: "Кол-во", type: "number" },
          { selector: "unit_price", text: "Цена шт", type: "number" },
          { selector: "amount", text: "Стоимость ARS", type: "number" },
          { selector: "note", text: "Примечание", type: "string" },
        ];
        delete t.url;
        delete t.urlPath;
        updated++;
      }

      // ── System Health Dashboard: маппинг данных из health-status.json ────
      if (healthData) {
        const hs = healthData.services_summary || {};
        const res = healthData.resources || {};

        // Stat-панели сервисов
        if (title === "Sheets API") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: hs.sheets_api || "error" }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Status", type: "string" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Grafana" && DASHBOARD_UID === "pepino-system-health") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: hs.grafana || "error" }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Status", type: "string" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "n8n") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: hs.n8n || "error" }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Status", type: "string" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Контейнеры") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: hs.containers_running || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Running", type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        }
        // Таблица контейнеров
        else if (title === "Список контейнеров") {
          t.source = "inline";
          t.data = JSON.stringify(healthData.containers || []);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "name", text: "name", type: "string" },
            { selector: "state", text: "state", type: "string" },
            { selector: "status", text: "status", type: "string" },
            { selector: "uptime", text: "uptime", type: "string" },
            { selector: "ports", text: "ports", type: "string" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        }
        // Таблица cron-задач
        else if (title === "Статус Cron-задач") {
          t.source = "inline";
          t.data = JSON.stringify(healthData.cron_jobs || []);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "name", text: "name", type: "string" },
            { selector: "last_run", text: "last_run", type: "string" },
            { selector: "status", text: "status", type: "string" },
            { selector: "next_run", text: "next_run", type: "string" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        }
        // Ресурсы — stat-панели
        else if (title === "Диск %") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: res.disk_pct >= 0 ? res.disk_pct : 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Disk %", type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Память %") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: res.memory_pct >= 0 ? res.memory_pct : 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "Memory %", type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "CPU Load %") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: res.cpu_pct >= 0 ? res.cpu_pct : 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: "CPU %", type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        }
      }

      // ── AI Costs Dashboard: маппинг данных из llm-cost-report.json ────
      if (costReport && DASHBOARD_UID === "pepino-ai-costs") {
        const cr = costReport;
        const ds = cr.daily_summary || {};
        const bgt = cr.budget || {};

        // Stat-панели
        if (title === "Total Cost Today ($)") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: ds.total_cost_usd || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: title, type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Avg Cost/Task ($)") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: ds.avg_cost_per_task_usd || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: title, type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Tasks Today") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: ds.total_tasks || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: title, type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Cheap Pass Rate (%)") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: cr.cheap_pass_rate || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: title, type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Budget Used (%)") {
          t.source = "inline";
          t.data = JSON.stringify([{ value: bgt.spent_pct || 0 }]);
          t.type = "json"; t.format = "table";
          t.columns = [{ selector: "value", text: title, type: "number" }];
          delete t.url; delete t.urlPath;
          updated++;
        }
        // Chart/table панели
        else if (title === "Tier Distribution") {
          t.source = "inline";
          t.data = JSON.stringify(cr.tier_distribution || []);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "tier", text: "tier", type: "string" },
            { selector: "pct", text: "pct", type: "number" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Cost by Skill (Top 5)") {
          t.source = "inline";
          t.data = JSON.stringify((cr.top_skills || []).slice(0, 5));
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "skill", text: "skill", type: "string" },
            { selector: "cost_usd", text: "cost_usd", type: "number" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Model Usage") {
          t.source = "inline";
          t.data = JSON.stringify(cr.model_usage || []);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "model", text: "model", type: "string" },
            { selector: "count", text: "count", type: "number" },
            { selector: "cost_usd", text: "cost_usd", type: "number" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Budget Tracker") {
          t.source = "inline";
          t.data = JSON.stringify([bgt]);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "monthly_budget_usd", text: "monthly_budget_usd", type: "number" },
            { selector: "spent_usd", text: "spent_usd", type: "number" },
            { selector: "spent_pct", text: "spent_pct", type: "number" },
            { selector: "remaining_usd", text: "remaining_usd", type: "number" },
            { selector: "projected_usd", text: "projected_usd", type: "number" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        } else if (title === "Recent Tasks") {
          t.source = "inline";
          t.data = JSON.stringify(cr.recent_tasks || []);
          t.type = "json"; t.format = "table";
          t.columns = [
            { selector: "timestamp", text: "timestamp", type: "string" },
            { selector: "skill", text: "skill", type: "string" },
            { selector: "intent", text: "intent", type: "string" },
            { selector: "tier", text: "tier", type: "string" },
            { selector: "model", text: "model", type: "string" },
            { selector: "cost_usd", text: "cost_usd", type: "number" },
            { selector: "latency_ms", text: "latency_ms", type: "number" },
            { selector: "quality", text: "quality", type: "string" },
            { selector: "escalated", text: "escalated", type: "string" },
          ];
          delete t.url; delete t.urlPath;
          updated++;
        }
      }
    }

    // 4. Save dashboard
    delete dash.id;
    delete dash.version;
    const saveResp = await grafanaRequest("POST", "/api/dashboards/db", {
      dashboard: dash,
      overwrite: true,
    });

    console.log(
      `[${new Date().toISOString()}] [${DASHBOARD_UID}] Updated ${updated} panels. ` +
      `Grafana: status=${saveResp.status} v${saveResp.version}`
    );
    } // end for DASHBOARD_UIDS

    const elapsed = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] All dashboards synced in ${elapsed}ms`);

    await trace({
      name: "sync-dashboard",
      input: { dashboards: DASHBOARD_UIDS.length },
      output: { dashboardsSynced: DASHBOARD_UIDS.length, elapsed_ms: elapsed },
      duration_ms: elapsed,
      metadata: { skill: "pepino-google-sheets", cron: "sync-dashboard" },
    }).catch(() => {});
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
    process.exit(1);
  }
}

main();
