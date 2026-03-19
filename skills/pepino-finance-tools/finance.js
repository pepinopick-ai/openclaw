#!/usr/bin/env node
/**
 * Pepino Pick — Finance Tool
 * Курсы валют, юнит-экономика, NPV, инфляция, сценарный анализ
 *
 * node finance.js rates                                  — все курсы ARS
 * node finance.js convert <сумма> <из> <в>               — конвертация валют
 * node finance.js inflation                              — инфляция IPC (INDEC)
 * node finance.js unit <продукт>                        — юнит-экономика
 * node finance.js npv <инвестиция> <ставка%> <CF1,CF2..> — NPV / ROI
 * node finance.js scenario <базовый_CF> <переменная> <%> — сценарный анализ
 * node finance.js margin <выручка> <cogs> <opex>         — маржинальность
 * node finance.js breakeven <fix_costs> <price> <var_cost> — точка безубыточности
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, "workspace/tools/.rates-cache.json");

// ── Currency APIs ─────────────────────────────────────────────────────────────
async function fetchRates(forceRefresh = false) {
  // Cache for 30 minutes
  if (!forceRefresh && existsSync(CACHE)) {
    const cache = JSON.parse(readFileSync(CACHE, "utf8"));
    if (Date.now() - cache.ts < 30 * 60 * 1000) return cache.data;
  }
  const res = await fetch("https://dolarapi.com/v1/dolares");
  if (!res.ok) throw new Error(`dolarapi.com: HTTP ${res.status}`);
  const data = await res.json();
  writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

// ── rates ─────────────────────────────────────────────────────────────────────
async function rates() {
  const data = await fetchRates();
  const date = new Date(data[0]?.fechaActualizacion || Date.now());
  const dateStr = date.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

  console.log(`\n💱 КУРСЫ ARS/USD — ${dateStr}\n`);
  console.log("  " + "Тип".padEnd(28) + "Покупка".padStart(10) + "  " + "Продажа".padStart(10));
  console.log("  " + "─".repeat(52));

  const order = [
    "Oficial",
    "Blue",
    "Mayorista",
    "Bolsa",
    "Contado con liquidación",
    "Cripto",
    "Tarjeta",
  ];
  const emoji = {
    Oficial: "🏦",
    Blue: "💵",
    Mayorista: "🏭",
    Bolsa: "📈",
    "Contado con liquidación": "🌐",
    Cripto: "₿",
    Tarjeta: "💳",
  };

  for (const name of order) {
    const d = data.find((x) => x.nombre === name);
    if (!d) continue;
    const e = emoji[name] || "•";
    console.log(
      `  ${e} ${name.padEnd(26)} ${String(d.compra).padStart(10)}  ${String(d.venta).padStart(10)}`,
    );
  }

  const blue = data.find((x) => x.nombre === "Blue");
  const oficial = data.find((x) => x.nombre === "Oficial");
  if (blue && oficial) {
    const spread = ((blue.venta / oficial.venta - 1) * 100).toFixed(1);
    console.log(`\n  📊 Blue premium vs Oficial: +${spread}%`);
    console.log(
      `  💡 Совет: для оценки реального USD-эквивалента используй Blue (${blue.venta} ARS)`,
    );
  }
  return data;
}

// ── convert ───────────────────────────────────────────────────────────────────
async function convert(amount, from, to) {
  const amt = parseFloat(amount);
  if (isNaN(amt)) throw new Error(`Неверная сумма: ${amount}`);

  const data = await fetchRates();
  const blue = data.find((x) => x.nombre === "Blue");
  const oficial = data.find((x) => x.nombre === "Oficial");
  const tarjeta = data.find((x) => x.nombre === "Tarjeta");

  from = from.toUpperCase();
  to = to.toUpperCase();

  let result;
  if (from === "ARS" && to === "USD") {
    result = { blue: amt / blue.venta, oficial: amt / oficial.venta, tarjeta: amt / tarjeta.venta };
    console.log(`\n💱 ${amt.toLocaleString("es-AR")} ARS =`);
    console.log(`   💵 Blue:    USD ${result.blue.toFixed(2)}`);
    console.log(`   🏦 Oficial: USD ${result.oficial.toFixed(2)}`);
    console.log(`   💳 Tarjeta: USD ${result.tarjeta.toFixed(2)}`);
  } else if (from === "USD" && to === "ARS") {
    result = { blue: amt * blue.venta, oficial: amt * oficial.venta };
    console.log(`\n💱 USD ${amt.toLocaleString("en-US")} =`);
    console.log(`   💵 Blue:    ARS ${result.blue.toLocaleString("es-AR")}`);
    console.log(`   🏦 Oficial: ARS ${result.oficial.toLocaleString("es-AR")}`);
  } else {
    throw new Error("Поддерживается только ARS↔USD");
  }
  return result;
}

// ── inflation (INDEC + Firecrawl fallback) ────────────────────────────────────
async function inflation() {
  console.log("\n📈 ИНФЛЯЦИЯ АРГЕНТИНА\n");

  // Try INDEC datos.gob.ar with sort=desc to get most recent data first
  let monthlyPct = null,
    yoyPct = null,
    lastDate = null;
  try {
    const INDEC = "https://apis.datos.gob.ar/series/api/series/";
    const url = `${INDEC}?ids=148.3_INIVELNAL_DICI_M_26&limit=14&sort=desc&format=json`;
    const res = await fetch(url);
    const d = await res.json();
    const data = d?.data || [];
    // sort=desc: data[0] = most recent, data[1] = previous month, data[12] = year ago
    if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[0])) {
      const current = data[0]; // [date, value]
      const prevMonth = data[1];
      const yearAgo = data[13] || data[data.length - 1];

      monthlyPct = ((current[1] / prevMonth[1] - 1) * 100).toFixed(1);
      yoyPct = yearAgo ? ((current[1] / yearAgo[1] - 1) * 100).toFixed(1) : null;
      lastDate = current[0];

      console.log(`  📅 Данные INDEC: ${lastDate}`);
      console.log(`  Месячная (mom): ${monthlyPct}%`);
      if (yoyPct) console.log(`  Годовая  (yoy): ${yoyPct}%`);

      // Bar chart last months
      const months = data.slice(0, 7).reverse();
      console.log("\n  Последние месяцы (IPC mom%):");
      months.forEach(([date, val], i, arr) => {
        if (i === 0) return;
        const m = ((val / arr[i - 1][1] - 1) * 100).toFixed(1);
        const n = parseFloat(m);
        const bar = n > 0 ? "█".repeat(Math.min(Math.round(n), 30)) : "";
        console.log(`    ${date}:  ${m.padStart(5)}%  ${bar}`);
      });
    }
  } catch {
    // API blocked or unavailable — use Firecrawl to scrape latest headline
    try {
      const fcKey = process.env.FIRECRAWL_API_KEY;
      if (fcKey) {
        const res = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "inflacion IPC Argentina INDEC mensual 2026",
            limit: 3,
            lang: "es",
            country: "ar",
          }),
        });
        const d = await res.json();
        const snippet = d.data?.[0]?.markdown?.slice(0, 300) || d.data?.[0]?.description || "";
        console.log(`  📰 Последние данные (веб):\n  ${snippet}`);
        // Extract percentage from text
        const match = snippet.match(/(\d+[.,]\d+)\s*%/);
        if (match) monthlyPct = parseFloat(match[1].replace(",", ".")).toFixed(1);
      }
    } catch {}
    if (!monthlyPct) {
      console.log("  ⚠️  API недоступен. Используется оценка на основе последних публикаций.");
      monthlyPct = "2.7"; // Conservative estimate March 2026
    }
  }

  // Load env for Firecrawl key
  try {
    readFileSync(join(ROOT, ".env"), "utf8")
      .split("\n")
      .forEach((line) => {
        const [k, ...v] = line.split("=");
        if (k?.trim() && v.length) process.env[k.trim()] ??= v.join("=").trim();
      });
  } catch {}

  // Impact on Pepino Pick costs
  const ratesData = await fetchRates().catch(() => null);
  const blueRate = ratesData?.find((x) => x.nombre === "Blue")?.venta || 1415;
  const monthly = parseFloat(monthlyPct || "3");
  const annual = (Math.pow(1 + monthly / 100, 12) - 1) * 100;

  console.log(`\n  💡 ВЛИЯНИЕ НА PEPINO PICK (при ${monthly}%/мес = ${annual.toFixed(0)}%/год):\n`);
  console.log(
    `  ${"Статья затрат".padEnd(28)} ${"Сейчас".padStart(10)} ${"3 мес".padStart(10)} ${"6 мес".padStart(10)} ${"12 мес".padStart(10)}`,
  );
  console.log(`  ${"─".repeat(62)}`);
  const costs = [
    ["Субстрат (ARS/кг)", 500],
    ["Труд (ARS/час)", 800],
    ["Упаковка (ARS/кг)", 150],
    ["Nafta (ARS/л)", 1500],
    ["Цена вешенки (ARS/кг)", 23000],
  ];
  costs.forEach(([label, price]) => {
    const m3 = Math.round(price * Math.pow(1 + monthly / 100, 3));
    const m6 = Math.round(price * Math.pow(1 + monthly / 100, 6));
    const m12 = Math.round(price * Math.pow(1 + monthly / 100, 12));
    console.log(
      `  ${label.padEnd(28)} ${String(price).padStart(10)} ${String(m3).padStart(10)} ${String(m6).padStart(10)} ${String(m12).padStart(10)}`,
    );
  });

  console.log(`\n  🎯 Правило: поднимай цены минимум на ${monthly}%/мес`);
  console.log(`  📊 Эквивалент USD/месяц не меняется — потери только в ARS-марже`);
  console.log(`  💡 Контракты с ресторанами: фиксируй в USD, выставляй в ARS по Blue`);
}

// ── unit economics ─────────────────────────────────────────────────────────────
async function unit(product, ...flags) {
  // Default cost structures for Pepino Pick products
  const defaults = {
    veshyonka: {
      substrate_kg: 0.25, // кг субстрата на кг грибов
      substrate_price_ars: 500, // ARS/кг субстрата
      labor_min: 8, // минут труда на кг
      labor_hour_ars: 800, // ARS/час
      packaging_ars: 150, // ARS/кг упаковка
      electricity_ars: 80, // ARS/кг электричество
      logistics_ars: 200, // ARS/кг логистика
      sale_price_ars: 0, // заполнится ниже
    },
    microgreens: {
      seed_per_tray: 30, // г семян на лоток 25×50см
      seed_price_kg_ars: 15000, // ARS/кг семян
      substrate_tray_ars: 120, // ARS/лоток субстрат
      labor_min: 15, // минут на лоток
      labor_hour_ars: 800,
      electricity_ars: 60,
      packaging_ars: 200, // ARS/лоток
      yield_g_per_tray: 120, // г с лотка
    },
    pepino: {
      seed_per_plant: 1,
      plant_cost_ars: 180,
      substrate_per_plant_ars: 400,
      fertilizer_per_kg_ars: 120, // YaraTera / MKP
      labor_min_per_kg: 5,
      labor_hour_ars: 800,
      electricity_per_kg_ars: 150,
      packaging_ars: 80,
      yield_kg_per_plant: 12,
    },
  };

  const costs = defaults[product.toLowerCase()] || {};
  const data = await fetchRates();
  const blueRate = data.find((x) => x.nombre === "Blue")?.venta || 1400;
  const oficialRate = data.find((x) => x.nombre === "Oficial")?.venta || 1390;

  console.log(`\n📊 ЮНИТ-ЭКОНОМИКА: ${product.toUpperCase()}`);
  console.log(`   Курс Blue: ${blueRate} ARS/USD | Oficial: ${oficialRate} ARS/USD\n`);

  if (product.toLowerCase() === "veshyonka") {
    const salePrice = 23000; // ARS/kg (рыночная цена ML март 2026)
    const subst = costs.substrate_kg * costs.substrate_price_ars;
    const labor = (costs.labor_min / 60) * costs.labor_hour_ars;
    const total_cogs =
      subst + labor + costs.packaging_ars + costs.electricity_ars + costs.logistics_ars;
    const margin_ars = salePrice - total_cogs;
    const margin_pct = ((margin_ars / salePrice) * 100).toFixed(1);

    console.log("  ПРЯМЫЕ ЗАТРАТЫ на 1 кг вешенки:");
    console.log(
      `    Субстрат:      ${subst.toFixed(0).padStart(8)} ARS  (${costs.substrate_kg}кг × ${costs.substrate_price_ars})`,
    );
    console.log(
      `    Труд:          ${labor.toFixed(0).padStart(8)} ARS  (${costs.labor_min}мин × ${costs.labor_hour_ars}/ч)`,
    );
    console.log(`    Упаковка:      ${costs.packaging_ars.toString().padStart(8)} ARS`);
    console.log(`    Электричество: ${costs.electricity_ars.toString().padStart(8)} ARS`);
    console.log(`    Логистика:     ${costs.logistics_ars.toString().padStart(8)} ARS`);
    console.log(`    ${"─".repeat(40)}`);
    console.log(`    COGS total:    ${total_cogs.toFixed(0).padStart(8)} ARS`);
    console.log(`\n  ЦЕНА ПРОДАЖИ:  ${salePrice.toString().padStart(8)} ARS/кг  (рынок ML)`);
    console.log(`  МАРЖА:         ${margin_ars.toFixed(0).padStart(8)} ARS/кг  (${margin_pct}%)`);
    console.log(`  В USD (blue):  ${(margin_ars / blueRate).toFixed(2).padStart(8)} USD/кг`);

    // Scenarios
    console.log("\n  📈 СЦЕНАРНЫЙ АНАЛИЗ (цена продажи):");
    for (const price of [18000, 20000, 23000, 26000, 30000]) {
      const m = price - total_cogs;
      const mp = ((m / price) * 100).toFixed(0);
      const usd = (m / blueRate).toFixed(2);
      const bar = m > 0 ? "▓".repeat(Math.round(m / 2000)) : "░░░";
      console.log(
        `    ${price.toString().padStart(6)} ARS → маржа: ${m.toFixed(0).padStart(7)} ARS (${mp}%) / USD ${usd} ${bar}`,
      );
    }

    console.log("\n  💡 РЕКОМЕНДАЦИИ:");
    if (margin_pct < 30)
      console.log("    ⚠️  Маржа ниже 30% — пересмотри ценообразование или снижай COGS");
    if (margin_pct >= 40) console.log("    ✅ Хорошая маржа — можно масштабировать производство");
    console.log(`    🎯 Цена безубыточности: ${total_cogs.toFixed(0)} ARS/кг`);
    console.log(`    🏆 Целевая цена (+50% margin): ${(total_cogs * 1.5).toFixed(0)} ARS/кг`);
  } else {
    console.log(`  Шаблон для "${product}" не настроен. Доступны: veshyonka, microgreens, pepino`);
    console.log("  Добавь данные через: node finance.js unit <продукт> --costs ./my-costs.json");
  }
}

// ── NPV calculator ────────────────────────────────────────────────────────────
async function npv(investment, rateStr, cashflowsStr) {
  const inv = parseFloat(investment);
  const rate = parseFloat(rateStr) / 100;
  const cfs = cashflowsStr.split(",").map(Number);

  const data = await fetchRates();
  const blueRate = data.find((x) => x.nombre === "Blue")?.venta || 1400;

  let npvVal = -inv;
  let irr_approx = 0;
  const details = [];

  cfs.forEach((cf, i) => {
    const year = i + 1;
    const pv = cf / Math.pow(1 + rate, year);
    npvVal += pv;
    details.push({ year, cf, pv });
  });

  const totalCF = cfs.reduce((a, b) => a + b, 0);
  const payback = inv / (totalCF / cfs.length);

  const currency = inv > 100000 ? "ARS" : "USD";
  const mult = currency === "ARS" ? 1 : blueRate;

  console.log(`\n📈 NPV АНАЛИЗ — ${currency === "USD" ? `USD (Blue: ${blueRate})` : "ARS"}\n`);
  console.log(`  Инвестиция:   ${inv.toLocaleString("es-AR")} ${currency}`);
  console.log(`  Ставка диск.: ${(rate * 100).toFixed(0)}%`);
  console.log(`  Период:       ${cfs.length} лет\n`);

  console.log("  Год │ Cash Flow        │ PV дисконт.     │");
  console.log("  ────┼──────────────────┼─────────────────┤");
  details.forEach(({ year, cf, pv }) => {
    const cfStr = cf.toLocaleString("es-AR").padStart(16);
    const pvStr = pv.toFixed(0).padStart(16);
    console.log(`   ${year}  │ ${cfStr} ${currency} │ ${pvStr} ${currency} │`);
  });
  console.log("  ────┴──────────────────┴─────────────────┘");

  const sign = npvVal >= 0 ? "✅" : "❌";
  console.log(`\n  ${sign} NPV:              ${npvVal.toFixed(0).padStart(16)} ${currency}`);
  console.log(`  📅 Окупаемость:     ${payback.toFixed(1)} лет`);
  console.log(`  💰 Суммарный CF:    ${totalCF.toLocaleString("es-AR").padStart(16)} ${currency}`);
  console.log(`  📊 ROI:             ${(((totalCF - inv) / inv) * 100).toFixed(1)}%`);

  if (npvVal >= 0) {
    console.log(`\n  ✅ Проект ПРИБЫЛЬНЫЙ при ставке ${(rate * 100).toFixed(0)}%`);
  } else {
    console.log(`\n  ❌ Проект УБЫТОЧНЫЙ — NPV отрицательный`);
    console.log(
      `  💡 Нужно увеличить CF на ${Math.abs(npvVal / cfs.length).toFixed(0)} ${currency}/год для выхода в плюс`,
    );
  }
}

// ── margin ────────────────────────────────────────────────────────────────────
async function margin(revenue, cogs, opex) {
  const r = parseFloat(revenue),
    c = parseFloat(cogs),
    o = parseFloat(opex);
  const data = await fetchRates();
  const blueRate = data.find((x) => x.nombre === "Blue")?.venta || 1400;

  const grossMargin = r - c;
  const grossPct = ((grossMargin / r) * 100).toFixed(1);
  const ebitda = r - c - o;
  const ebitdaPct = ((ebitda / r) * 100).toFixed(1);

  console.log(`\n📊 МАРЖИНАЛЬНОСТЬ\n`);
  console.log(`  Выручка:          ${r.toLocaleString("es-AR").padStart(15)} ARS`);
  console.log(`  COGS:            -${c.toLocaleString("es-AR").padStart(15)} ARS`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(
    `  Валовая маржа:    ${grossMargin.toLocaleString("es-AR").padStart(15)} ARS  (${grossPct}%)`,
  );
  console.log(`  OPEX:            -${o.toLocaleString("es-AR").padStart(15)} ARS`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(
    `  EBITDA:           ${ebitda.toLocaleString("es-AR").padStart(15)} ARS  (${ebitdaPct}%)`,
  );
  console.log(
    `  EBITDA в USD:     ${(ebitda / blueRate).toFixed(2).padStart(15)} USD  (Blue ${blueRate})`,
  );

  const label =
    ebitdaPct >= 25 ? "✅ Отлично" : ebitdaPct >= 15 ? "🟡 Нормально" : "❌ Нужно улучшить";
  console.log(`\n  ${label} — EBITDA margin ${ebitdaPct}%`);
  console.log(`  🏆 Цель для агробизнеса: >20% EBITDA`);
}

// ── breakeven ─────────────────────────────────────────────────────────────────
async function breakeven(fixedCosts, pricePerUnit, varCostPerUnit) {
  const fc = parseFloat(fixedCosts);
  const p = parseFloat(pricePerUnit);
  const vc = parseFloat(varCostPerUnit);

  if (p <= vc) throw new Error("Цена должна быть выше переменных затрат");

  const contributionMargin = p - vc;
  const be_units = fc / contributionMargin;
  const be_revenue = be_units * p;
  const data = await fetchRates();
  const blueRate = data.find((x) => x.nombre === "Blue")?.venta || 1400;

  console.log(`\n🎯 ТОЧКА БЕЗУБЫТОЧНОСТИ\n`);
  console.log(`  Постоянные затраты: ${fc.toLocaleString("es-AR")} ARS`);
  console.log(`  Цена за ед.:        ${p.toLocaleString("es-AR")} ARS`);
  console.log(`  Переменные/ед.:     ${vc.toLocaleString("es-AR")} ARS`);
  console.log(`  Маржа вклада/ед.:   ${contributionMargin.toLocaleString("es-AR")} ARS\n`);
  console.log(`  ✅ Безубыточность:`);
  console.log(`     Объём: ${be_units.toFixed(1)} ед. / мес`);
  console.log(`     Выручка: ${be_revenue.toLocaleString("es-AR")} ARS / мес`);
  console.log(`     В USD:   ${(be_revenue / blueRate).toFixed(2)} USD / мес (Blue)`);

  console.log(`\n  📊 Сценарии (объём → прибыль):`);
  for (const mult of [0.5, 0.75, 1, 1.5, 2, 3]) {
    const units = Math.round(be_units * mult);
    const profit = units * contributionMargin - fc;
    const label = profit < 0 ? "❌" : profit === 0 ? "⚖️" : "✅";
    console.log(
      `     ${String(units).padStart(6)} ед → ${profit >= 0 ? "+" : ""}${profit.toFixed(0).padStart(10)} ARS  ${label}`,
    );
  }
}

// ── scenario ──────────────────────────────────────────────────────────────────
async function scenario(baseCF, variable, changeStr) {
  const base = parseFloat(baseCF);
  const change = parseFloat(changeStr) / 100;
  const data = await fetchRates();
  const blueRate = data.find((x) => x.nombre === "Blue")?.venta || 1400;

  console.log(`\n🔮 СЦЕНАРНЫЙ АНАЛИЗ — ${variable}\n`);
  console.log(`  Базовый CF: ${base.toLocaleString("es-AR")} ARS/мес`);
  console.log(`  Переменная: ${variable}\n`);

  const scenarios = [
    { name: "Pessimistic (-30%)", factor: -0.3 },
    { name: "Conservative (-15%)", factor: -0.15 },
    { name: "Base (0%)", factor: 0 },
    { name: "Optimistic (+15%)", factor: 0.15 },
    { name: "Best case (+30%)", factor: 0.3 },
  ];

  const customFactor = change;
  const customCF = base * (1 + customFactor);

  console.log("  Сценарий              │ Изменение CF ARS  │ USD (Blue)  │");
  console.log("  ──────────────────────┼───────────────────┼─────────────┤");

  scenarios.forEach(({ name, factor }) => {
    const cf = base * (1 + factor);
    const delta = cf - base;
    const sign = delta >= 0 ? "+" : "";
    const mark = factor === 0 ? "◄ текущий" : "";
    console.log(
      `  ${name.padEnd(22)}│ ${sign}${delta.toFixed(0).padStart(15)} ARS │ ${(cf / blueRate).toFixed(0).padStart(10)} USD │ ${mark}`,
    );
  });

  console.log(
    `\n  🎯 Твой сценарий (${variable} ${changeStr}%): ${customCF.toFixed(0)} ARS/мес = USD ${(customCF / blueRate).toFixed(2)}`,
  );
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const [, , cmd, ...args] = process.argv;
const commands = { rates, convert, inflation, unit, npv, margin, breakeven, scenario };

if (!cmd || !commands[cmd]) {
  console.log("Использование: node finance.js <команда>\n");
  console.log("  rates                                   Курсы ARS/USD (Blue, Oficial, все)");
  console.log("  inflation                               Инфляция IPC INDEC + прогноз цен");
  console.log("  convert <сумма> <ARS|USD> <USD|ARS>     Конвертация валют");
  console.log("  unit    <veshyonka|microgreens|pepino>  Юнит-экономика продукта");
  console.log("  npv     <инвест> <ставка%> <CF1,CF2..>  NPV и окупаемость");
  console.log("  margin  <выручка> <COGS> <OPEX>         Маржинальность P&L");
  console.log("  breakeven <fix> <цена> <перем>          Точка безубыточности");
  console.log("  scenario  <baseCF> <переменная> <%>     Сценарный анализ\n");
  console.log("Примеры:");
  console.log("  node finance.js rates");
  console.log("  node finance.js convert 500000 ARS USD");
  console.log("  node finance.js unit veshyonka");
  console.log("  node finance.js npv 2000000 15 800000,900000,1000000,1100000,1200000");
  console.log("  node finance.js margin 3000000 1500000 600000");
  console.log("  node finance.js breakeven 800000 23000 8000");
  console.log('  node finance.js scenario 1000000 "цена_субстрата" +20');
  process.exit(0);
}

try {
  await commands[cmd](...args);
} catch (e) {
  console.error("❌ Ошибка:", e.message);
  process.exit(1);
}
