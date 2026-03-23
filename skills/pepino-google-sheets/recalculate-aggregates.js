#!/usr/bin/env node
/**
 * Pepino Auto-Recalculator
 * Aggregates raw data from production/sales/expenses into P&L, KPI, and LK_* sheets
 *
 * Runs at 07:00 and 20:00 daily (cron)
 * Usage: node recalculate-aggregates.js
 */

import {
  readSheet,
  writeToSheet,
  clearSheet,
  PEPINO_SHEETS_ID,
} from "./sheets.js";
import { trace } from "./langfuse-trace.js";

function sheetToJson(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

function num(v) {
  if (!v) return 0;
  return parseFloat(v.toString().replace(",", ".").replace(/[^\d.-]/g, "")) || 0;
}

function pct(val, total) {
  if (!total) return 0;
  return Math.round((val / total) * 100) / 100;
}

async function getBlueRate() {
  // Try to fetch current blue rate, fallback to 1430
  try {
    const resp = await fetch("https://dolarapi.com/v1/dolares/blue");
    const data = await resp.json();
    return data.venta || 1430;
  } catch {
    return 1430;
  }
}

async function recalculate() {
  const startMs = Date.now();
  console.log("Reading raw sheets...");

  const [salesRaw, expensesRaw, productionRaw, blueRate] = await Promise.all([
    readSheet(PEPINO_SHEETS_ID, "🛒 Продажи").catch(() => []),
    readSheet(PEPINO_SHEETS_ID, "💰 Расходы").catch(() => []),
    readSheet(PEPINO_SHEETS_ID, "🌿 Производство").catch(() => []),
    getBlueRate(),
  ]);

  console.log(`Blue rate: ${blueRate}`);
  console.log(
    `Raw data: ${salesRaw.length - 1} sales, ${expensesRaw.length - 1} expenses, ${productionRaw.length - 1} production`,
  );

  const sales = sheetToJson(salesRaw);
  const expenses = sheetToJson(expensesRaw);
  const production = sheetToJson(productionRaw);

  // Group by month (YYYY-MM)
  const months = new Set();
  sales.forEach((r) => r["Дата"] && months.add(r["Дата"].slice(0, 7)));
  expenses.forEach((r) => r["Дата"] && months.add(r["Дата"].slice(0, 7)));
  production.forEach((r) => r["Дата"] && months.add(r["Дата"].slice(0, 7)));

  const sortedMonths = [...months].sort();
  if (sortedMonths.length === 0) {
    console.log("No data to aggregate");
    return;
  }

  // ── Calculate P&L per month ──
  const pnlRows = [
    [
      "Месяц",
      "Выручка ARS",
      "Выручка USD",
      "COGS ARS",
      "Валовая маржа ARS",
      "Валовая маржа %",
      "OPEX ARS",
      "EBITDA ARS",
      "EBITDA %",
      "Курс Blue",
      "Налоги ARS",
      "Чистая прибыль ARS",
    ],
  ];

  const kpiRows = [
    [
      "Месяц",
      "Урожай вешенка кг",
      "Урожай микрозелень кг",
      "Выручка ARS",
      "Себестоимость ARS/кг",
      "Цена ARS/кг",
      "Маржа %",
      "Клиентов активных",
      "Биоэффективность %",
      "Курс Blue",
      "Выручка USD",
    ],
  ];

  const lkKpiRows = [
    [
      "month",
      "revenue_ars",
      "revenue_usd",
      "cogs_ars",
      "gross_margin_ars",
      "gross_margin_pct",
      "opex_ars",
      "ebitda_ars",
      "ebitda_pct",
      "harvest_mushroom_kg",
      "harvest_microgreens_kg",
      "active_clients",
      "blue_rate",
    ],
  ];

  const lkPnlRows = [
    ["month", "revenue", "cogs", "gross_margin", "opex", "ebitda", "ebitda_pct"],
  ];

  for (const month of sortedMonths) {
    const monthSales = sales.filter(
      (r) => r["Дата"] && r["Дата"].startsWith(month),
    );
    const monthExpenses = expenses.filter(
      (r) => r["Дата"] && r["Дата"].startsWith(month),
    );
    const monthProd = production.filter(
      (r) => r["Дата"] && r["Дата"].startsWith(month),
    );

    const revenue = monthSales.reduce((s, r) => s + num(r["Сумма ARS"]), 0);
    const revenueUsd = Math.round(revenue / blueRate);

    // COGS: substrate, raw materials — estimate as 48% of revenue if no expense data
    const cogsExpenses = monthExpenses.filter((r) =>
      /субстрат|удобрен|мицелий|семен|сырь|материал/i.test(
        r["Категория"] || r["Описание"] || "",
      ),
    );
    const cogsFromExpenses = cogsExpenses.reduce(
      (s, r) => s + num(r["Сумма ARS"] || r["amount_ars"] || 0),
      0,
    );
    const cogs = cogsFromExpenses > 0 ? cogsFromExpenses : Math.round(revenue * 0.48);

    const grossMargin = revenue - cogs;
    const grossMarginPct = pct(grossMargin, revenue);

    // OPEX: all other expenses
    const opexExpenses = monthExpenses.filter(
      (r) =>
        !/субстрат|удобрен|мицелий|семен|сырь|материал/i.test(
          r["Категория"] || r["Описание"] || "",
        ),
    );
    const opex =
      opexExpenses.reduce(
        (s, r) => s + num(r["Сумма ARS"] || r["amount_ars"] || 0),
        0,
      ) || Math.round(revenue * 0.25);

    const ebitda = grossMargin - opex;
    const ebitdaPct = pct(ebitda, revenue);
    const taxes = Math.round(Math.max(0, ebitda) * 0.05); // monotributo ~5%
    const netProfit = ebitda - taxes;

    // Production metrics
    const mushroomKg = monthProd
      .filter((r) => /вешенк|гриб|mushroom/i.test(r["Продукт"] || ""))
      .reduce((s, r) => s + num(r["Урожай кг"]), 0);
    const microKg = monthProd
      .filter((r) => /микрозелен|microgreen/i.test(r["Продукт"] || ""))
      .reduce((s, r) => s + num(r["Урожай кг"]), 0);
    const cucumberKg = monthProd
      .filter((r) => /огурц|огурец|cucumber|pepino/i.test(r["Продукт"] || ""))
      .reduce((s, r) => s + num(r["Урожай кг"]), 0);
    const totalKg = mushroomKg + microKg + cucumberKg;

    const activeClients = new Set(
      monthSales.map((r) => r["Клиент"]).filter(Boolean),
    ).size;
    const avgPricePerKg =
      totalKg > 0 ? Math.round(revenue / totalKg) : 0;
    const avgCostPerKg =
      totalKg > 0 ? Math.round(cogs / totalKg) : 0;
    const marginPct = grossMarginPct;

    pnlRows.push([
      month,
      revenue,
      revenueUsd,
      cogs,
      grossMargin,
      grossMarginPct,
      opex,
      ebitda,
      ebitdaPct,
      blueRate,
      taxes,
      netProfit,
    ]);

    kpiRows.push([
      month,
      mushroomKg,
      microKg,
      revenue,
      avgCostPerKg,
      avgPricePerKg,
      marginPct,
      activeClients,
      mushroomKg > 0 ? Math.round((mushroomKg / Math.max(1, num(monthProd.length))) * 100) : "",
      blueRate,
      revenueUsd,
    ]);

    lkKpiRows.push([
      month,
      revenue,
      revenueUsd,
      cogs,
      grossMargin,
      grossMarginPct,
      opex,
      ebitda,
      ebitdaPct,
      mushroomKg,
      microKg,
      activeClients,
      blueRate,
    ]);

    lkPnlRows.push([
      month,
      revenue,
      cogs,
      grossMargin,
      opex,
      ebitda,
      ebitdaPct,
    ]);
  }

  // ── LK_Products (static/semi-static, recalculate from production data) ──
  const products = {};
  production.forEach((r) => {
    const p = r["Продукт"] || "unknown";
    if (!products[p]) products[p] = { kg: 0, records: 0 };
    products[p].kg += num(r["Урожай кг"]);
    products[p].records++;
  });

  const lkProductsRows = [
    [
      "product",
      "profit_per_m2_usd",
      "margin_pct",
      "area_m2",
      "annual_profit_usd",
      "priority",
      "cycles_per_year",
      "yield_kg_per_m2_cycle",
    ],
  ];

  // Product economics (estimates based on Argentine urban farming)
  const productEconomics = {
    вешенка: {
      margin: 0.55,
      area: 15,
      cycles: 6,
      yield_per_m2: 8,
      price_usd: 7,
    },
    микрозелень: {
      margin: 0.61,
      area: 8,
      cycles: 24,
      yield_per_m2: 2,
      price_usd: 15,
    },
    огурец: {
      margin: 0.45,
      area: 20,
      cycles: 3,
      yield_per_m2: 12,
      price_usd: 2.5,
    },
    "съедобные цветы": {
      margin: 0.65,
      area: 5,
      cycles: 12,
      yield_per_m2: 0.5,
      price_usd: 30,
    },
  };

  for (const [name, eco] of Object.entries(productEconomics)) {
    const annualYield = eco.area * eco.cycles * eco.yield_per_m2;
    const annualRevenue = annualYield * eco.price_usd;
    const annualProfit = annualRevenue * eco.margin;
    const profitPerM2 = annualProfit / eco.area;

    lkProductsRows.push([
      name,
      Math.round(profitPerM2 * 100) / 100,
      eco.margin,
      eco.area,
      Math.round(annualProfit),
      annualProfit > 500 ? "HIGH" : annualProfit > 200 ? "MEDIUM" : "LOW",
      eco.cycles,
      eco.yield_per_m2,
    ]);
  }

  // ── Write all aggregated sheets ──
  console.log("Writing aggregated sheets...");

  const writes = [
    { name: "📊 P&L", data: pnlRows },
    { name: "⚙️ KPI", data: kpiRows },
    { name: "LK_KPI", data: lkKpiRows },
    { name: "LK_PnL", data: lkPnlRows },
    { name: "LK_Products", data: lkProductsRows },
  ];

  for (const w of writes) {
    try {
      await clearSheet(PEPINO_SHEETS_ID, w.name);
      await writeToSheet(PEPINO_SHEETS_ID, w.data, w.name);
      console.log(`  ✅ ${w.name}: ${w.data.length - 1} rows`);
    } catch (err) {
      console.error(`  ❌ ${w.name}: ${err.message}`);
    }
  }

  // Langfuse trace
  await trace({
    name: "recalculate-aggregates",
    input: { sheets_written: writes.map((w) => w.name) },
    output: { rows_written: writes.reduce((s, w) => s + w.data.length - 1, 0) },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "recalculate-aggregates" },
  }).catch(() => {});

  console.log("Recalculation complete!");
}

recalculate().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
