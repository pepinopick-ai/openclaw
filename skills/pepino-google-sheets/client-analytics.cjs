/**
 * client-analytics.cjs — Shared client analysis module
 *
 * Consolidates client logic from churn-detector, client-outreach, client-scorer.
 * All 3 scripts were independently analyzing the same sales data.
 * Now they import from here.
 *
 * Usage:
 *   const { analyzeClients } = require("./client-analytics.cjs");
 *   const analysis = await analyzeClients(); // or pass sales data
 */

"use strict";

const { normalize } = require("./product-aliases.cjs");

/**
 * Analyze all clients from sales data.
 * @param {Record<string,string>[]} [salesRows] — pre-loaded sales data (optional, will read from Sheets if not provided)
 * @returns {Promise<ClientAnalysis>}
 */
async function analyzeClients(salesRows) {
  let rows = salesRows;
  if (!rows) {
    // Try farm-state cache first
    try {
      const { getState } = require("./farm-state.cjs");
      const state = await getState();
      if (state && state.sales && state.sales.length > 0) {
        rows = state.sales;
      }
    } catch {
      /* fallback to direct read */
    }

    if (!rows) {
      const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
      const raw = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
      rows = rowsToObjects(raw);
    }
  }

  const now = Date.now();
  const DAY_MS = 86400000;

  /** @type {Map<string, ClientData>} */
  const clients = new Map();

  for (const row of rows) {
    const name = (row["Клиент"] || row["клиент"] || row["client"] || "").trim();
    if (!name) continue;

    const dateStr = row["Дата"] || row["дата"] || row["date"] || "";
    const date = parseDate(dateStr);
    const kg = parseNum(row["Кол-во кг"] || row["кг"] || row["qty_kg"] || 0);
    const ars = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["total_ars"] || 0);
    const product = normalize(row["Продукт"] || row["продукт"] || row["product"] || "");

    if (!clients.has(name)) {
      clients.set(name, {
        name,
        orders: [],
        total_kg: 0,
        total_ars: 0,
        products: new Set(),
        first_order: null,
        last_order: null,
      });
    }

    const c = clients.get(name);
    if (date) {
      c.orders.push({ date, kg, ars, product });
      if (!c.first_order || date < c.first_order) c.first_order = date;
      if (!c.last_order || date > c.last_order) c.last_order = date;
    }
    c.total_kg += kg;
    c.total_ars += ars;
    if (product) c.products.add(product);
  }

  const results = [];

  for (const [name, c] of clients) {
    const daysSinceLast = c.last_order ? Math.floor((now - c.last_order.getTime()) / DAY_MS) : 999;
    const orderCount = c.orders.length;

    // Status
    let status = "active";
    if (daysSinceLast > 30) status = "churned";
    else if (daysSinceLast > 14) status = "at_risk";
    else if (orderCount <= 1) status = "new";

    // Frequency (avg days between orders)
    let avgFrequencyDays = 0;
    if (c.orders.length >= 2) {
      const sorted = c.orders.map((o) => o.date.getTime()).sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push((sorted[i] - sorted[i - 1]) / DAY_MS);
      }
      avgFrequencyDays = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    }

    // Average order
    const avgOrderArs = orderCount > 0 ? Math.round(c.total_ars / orderCount) : 0;
    const avgOrderKg = orderCount > 0 ? Math.round((c.total_kg / orderCount) * 10) / 10 : 0;

    // RFM Score (0-100)
    let rfmScore = 0;
    // Recency (30 pts)
    if (daysSinceLast <= 7) rfmScore += 30;
    else if (daysSinceLast <= 14) rfmScore += 20;
    else if (daysSinceLast <= 30) rfmScore += 10;
    // Frequency (30 pts)
    const ordersPerMonth =
      orderCount / Math.max(1, (now - (c.first_order?.getTime() || now)) / DAY_MS / 30);
    if (ordersPerMonth >= 4) rfmScore += 30;
    else if (ordersPerMonth >= 2) rfmScore += 20;
    else if (ordersPerMonth >= 1) rfmScore += 10;
    else rfmScore += 5;
    // Monetary (30 pts)
    if (c.total_ars >= 500000) rfmScore += 30;
    else if (c.total_ars >= 200000) rfmScore += 20;
    else if (c.total_ars >= 50000) rfmScore += 10;
    else rfmScore += 5;
    // Growth (10 pts)
    if (c.orders.length >= 4) {
      const half = Math.floor(c.orders.length / 2);
      const firstHalfAvg = c.orders.slice(0, half).reduce((s, o) => s + o.ars, 0) / half;
      const secondHalfAvg =
        c.orders.slice(half).reduce((s, o) => s + o.ars, 0) / (c.orders.length - half);
      if (secondHalfAvg > firstHalfAvg * 1.1) rfmScore += 10;
      else if (secondHalfAvg >= firstHalfAvg * 0.9) rfmScore += 5;
    }

    // Tier
    let tier = "D";
    if (rfmScore >= 80) tier = "A";
    else if (rfmScore >= 60) tier = "B";
    else if (rfmScore >= 40) tier = "C";

    // Expected next order
    let expectedNextOrder = null;
    if (avgFrequencyDays > 0 && c.last_order) {
      expectedNextOrder = new Date(c.last_order.getTime() + avgFrequencyDays * DAY_MS);
    }

    results.push({
      name,
      status,
      tier,
      rfmScore,
      orderCount,
      totalArs: c.total_ars,
      totalKg: c.total_kg,
      avgOrderArs,
      avgOrderKg,
      avgFrequencyDays,
      daysSinceLast,
      firstOrder: c.first_order ? fmt(c.first_order) : null,
      lastOrder: c.last_order ? fmt(c.last_order) : null,
      products: [...c.products],
      expectedNextOrder: expectedNextOrder ? fmt(expectedNextOrder) : null,
    });
  }

  // Sort by total_ars descending
  results.sort((a, b) => b.totalArs - a.totalArs);

  // Summary
  const summary = {
    total: results.length,
    active: results.filter((c) => c.status === "active").length,
    at_risk: results.filter((c) => c.status === "at_risk").length,
    churned: results.filter((c) => c.status === "churned").length,
    new: results.filter((c) => c.status === "new").length,
    tierA: results.filter((c) => c.tier === "A").length,
    tierB: results.filter((c) => c.tier === "B").length,
    tierC: results.filter((c) => c.tier === "C").length,
    tierD: results.filter((c) => c.tier === "D").length,
    totalRevenue: results.reduce((s, c) => s + c.totalArs, 0),
    avgScore:
      results.length > 0
        ? Math.round(results.reduce((s, c) => s + c.rfmScore, 0) / results.length)
        : 0,
  };

  return { clients: results, summary };
}

// -- Helpers --

function parseNum(val) {
  if (typeof val === "number") return val;
  const s = String(val || "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "");
  return parseFloat(s) || 0;
}

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
  // YYYY-MM-DD
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((key, i) => {
      obj[key] = row[i] ?? "";
    });
    return obj;
  });
}

module.exports = { analyzeClients, parseNum, parseDate, rowsToObjects };
