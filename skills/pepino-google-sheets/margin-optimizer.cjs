#!/usr/bin/env node
/**
 * Pepino Pick -- Margin Optimizer
 *
 * Глубокий анализ маржинальности по продуктам, клиентам и расходам.
 * Автоматически генерирует рекомендации по улучшению прибыли.
 *
 * Анализ за последние 90 дней:
 *   1. Маржинальность по продуктам (выручка, аллокированная себестоимость, маржа)
 *   2. Рентабельность по клиентам (выручка, cost-to-serve, чистая маржа)
 *   3. Оптимизация расходов (категории, MoM рост, флаги >20%)
 *   4. Рекомендации (ценообразование, клиенты, расходы, производство)
 *
 * Cron: 0 19 1,15 * * (1-го и 15-го каждого месяца в 19:00)
 * Usage:
 *   node margin-optimizer.cjs                -- полный анализ + TG отчёт
 *   node margin-optimizer.cjs --dry-run      -- только вывод в консоль
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { normalize } = require("./product-aliases.cjs");

// ── Конфигурация ──────────────────────────────────────────────────────────────

const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";
const TG_THREAD_ID = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = !DRY_RUN;

const ANALYSIS_DAYS = 90;
const TARGET_MARGIN_PCT = 40; // целевая маржа по продуктам
const MIN_CLIENT_MARGIN_PCT = 35; // минимальная маржа по клиентам
const EXPENSE_GROWTH_ALERT_PCT = 20; // порог роста расходов MoM
const AVG_DELIVERY_COST_ARS = 2500; // средняя стоимость одной доставки

// ── Хелперы ───────────────────────────────────────────────────────────────────

/** Безопасный парсинг числа из строки (запятые, пробелы, валюта) */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Парсит дату из строки.
 * Поддерживает DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD
 * @param {string} raw
 * @returns {Date|null}
 */
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // DD/MM/YYYY или DD.MM.YYYY или DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  // YYYY-MM-DD
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Дата N дней назад */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Форматирует дату как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM из даты (для группировки по месяцам) */
function fmtMonth(d) {
  return d.toISOString().slice(0, 7);
}

/**
 * Преобразует массив строк из Sheets в массив объектов.
 * Первая строка -- заголовки.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    /** @type {Record<string, string>} */
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] != null ? String(r[i]) : "";
    });
    return obj;
  });
}

/** Извлекает значение из строки по нескольким возможным именам столбцов */
function getField(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== "") return row[k];
  }
  return "";
}

/** Форматирование числа с разделителем тысяч */
function fmtNum(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

// ── Отправка в Telegram ──────────────────────────────────────────────────────

function telegramSend(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: TG_CHAT_ID,
      message_thread_id: TG_THREAD_ID,
      text,
      parse_mode: "HTML",
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15_000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            reject(new Error("TG parse error"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("TG timeout"));
    });
    req.write(payload);
    req.end();
  });
}

// ── Анализ маржинальности по продуктам ───────────────────────────────────────

/**
 * @param {Record<string,string>[]} sales - продажи за 90 дней
 * @param {Record<string,string>[]} production - производство за 90 дней
 * @returns {{ products: Array<{name:string, revenueArs:number, kgSold:number, allocatedCost:number, marginPct:number}>, totalRevenue:number, totalCost:number }}
 */
function analyzeProductMargins(sales, production) {
  // Выручка и кг по продуктам
  /** @type {Record<string, {revenue: number, kg: number}>} */
  const byProduct = {};
  let totalRevenue = 0;

  for (const row of sales) {
    const product = normalize(getField(row, "Продукт", "продукт", "product"));
    if (!product) continue;
    const revenue = parseNum(
      getField(row, "Итого ARS", "Сумма ARS", "Сумма", "total_ars", "Total"),
    );
    const kg = parseNum(getField(row, "Кол-во кг", "Количество", "кг", "kg", "quantity"));

    if (!byProduct[product]) byProduct[product] = { revenue: 0, kg: 0 };
    byProduct[product].revenue += revenue;
    byProduct[product].kg += kg;
    totalRevenue += revenue;
  }

  // Общие затраты на производство
  let totalProductionCost = 0;
  let totalProductionKg = 0;

  for (const row of production) {
    const cost = parseNum(getField(row, "Затраты", "Себестоимость", "Стоимость", "cost", "Cost"));
    const kg = parseNum(getField(row, "Кол-во кг", "Собрано кг", "Урожай кг", "kg", "quantity"));
    totalProductionCost += cost;
    totalProductionKg += kg;
  }

  // Аллокация затрат пропорционально доле кг в продажах
  const totalSoldKg = Object.values(byProduct).reduce((s, p) => s + p.kg, 0);
  const products = [];

  for (const [name, data] of Object.entries(byProduct)) {
    // Аллокация: доля кг этого продукта от общих проданных кг * общие затраты
    const kgShare = totalSoldKg > 0 ? data.kg / totalSoldKg : 0;
    const allocatedCost = totalProductionCost * kgShare;
    const marginPct = data.revenue > 0 ? ((data.revenue - allocatedCost) / data.revenue) * 100 : 0;

    products.push({
      name,
      revenueArs: data.revenue,
      kgSold: data.kg,
      allocatedCost,
      marginPct: Math.round(marginPct * 10) / 10,
    });
  }

  // Сортировка по маржинальности (самые низкие сверху)
  products.sort((a, b) => a.marginPct - b.marginPct);

  return { products, totalRevenue, totalCost: totalProductionCost };
}

// ── Анализ рентабельности по клиентам ────────────────────────────────────────

/**
 * @param {Record<string,string>[]} sales - продажи за 90 дней
 * @returns {Array<{name:string, revenue:number, deliveries:number, costToServe:number, netMargin:number, marginPct:number}>}
 */
function analyzeClientProfitability(sales) {
  /** @type {Record<string, {revenue: number, deliveryDates: Set<string>}>} */
  const byClient = {};

  for (const row of sales) {
    const client = getField(row, "Клиент", "клиент", "client") || "Unknown";
    const revenue = parseNum(
      getField(row, "Итого ARS", "Сумма ARS", "Сумма", "total_ars", "Total"),
    );
    const dateStr = getField(row, "Дата", "дата", "date");

    if (!byClient[client]) byClient[client] = { revenue: 0, deliveryDates: new Set() };
    byClient[client].revenue += revenue;
    if (dateStr) byClient[client].deliveryDates.add(dateStr);
  }

  const clients = [];
  for (const [name, data] of Object.entries(byClient)) {
    const deliveries = data.deliveryDates.size;
    const costToServe = deliveries * AVG_DELIVERY_COST_ARS;
    const netMargin = data.revenue - costToServe;
    const marginPct = data.revenue > 0 ? (netMargin / data.revenue) * 100 : 0;

    clients.push({
      name,
      revenue: data.revenue,
      deliveries,
      costToServe,
      netMargin,
      marginPct: Math.round(marginPct * 10) / 10,
    });
  }

  // Сортировка по марже (самые низкие сверху)
  clients.sort((a, b) => a.marginPct - b.marginPct);
  return clients;
}

// ── Анализ расходов ──────────────────────────────────────────────────────────

/**
 * @param {Record<string,string>[]} expenses - расходы за 90 дней
 * @returns {{ categories: Array<{name:string, totalArs:number, monthlyAmounts:Record<string,number>, momGrowthPct:number|null}>, topCategories: string[] }}
 */
function analyzeExpenses(expenses) {
  /** @type {Record<string, Record<string, number>>} */
  const byCategory = {};

  for (const row of expenses) {
    const category = getField(row, "Категория", "категория", "category", "Тип") || "Прочее";
    const amount = parseNum(
      getField(row, "Итого ARS", "Сумма ARS", "Сумма", "amount_ars", "Amount"),
    );
    const dateRaw = getField(row, "Дата", "дата", "date");
    const d = parseDate(dateRaw);
    if (!d) continue;

    const month = fmtMonth(d);
    if (!byCategory[category]) byCategory[category] = {};
    byCategory[category][month] = (byCategory[category][month] || 0) + amount;
  }

  // Определяем два последних месяца для MoM-сравнения
  const allMonths = new Set();
  for (const months of Object.values(byCategory)) {
    for (const m of Object.keys(months)) allMonths.add(m);
  }
  const sortedMonths = [...allMonths].sort();
  const lastMonth = sortedMonths[sortedMonths.length - 1] || null;
  const prevMonth = sortedMonths.length >= 2 ? sortedMonths[sortedMonths.length - 2] : null;

  const categories = [];
  for (const [name, monthlyAmounts] of Object.entries(byCategory)) {
    const totalArs = Object.values(monthlyAmounts).reduce((s, v) => s + v, 0);

    let momGrowthPct = null;
    if (lastMonth && prevMonth && monthlyAmounts[prevMonth] > 0) {
      const lastVal = monthlyAmounts[lastMonth] || 0;
      const prevVal = monthlyAmounts[prevMonth];
      momGrowthPct = Math.round((lastVal / prevVal - 1) * 100);
    }

    categories.push({ name, totalArs, monthlyAmounts, momGrowthPct });
  }

  // Сортировка по общей сумме (самые затратные сверху)
  categories.sort((a, b) => b.totalArs - a.totalArs);

  const topCategories = categories.slice(0, 3).map((c) => c.name);

  return { categories, topCategories };
}

// ── Генерация рекомендаций ───────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof analyzeProductMargins>} productAnalysis
 * @param {ReturnType<typeof analyzeClientProfitability>} clientAnalysis
 * @param {ReturnType<typeof analyzeExpenses>} expenseAnalysis
 * @returns {string[]}
 */
function generateRecommendations(productAnalysis, clientAnalysis, expenseAnalysis) {
  /** @type {string[]} */
  const recs = [];

  // 1. Продукты с низкой маржой -- рекомендовать повышение цены
  for (const p of productAnalysis.products) {
    if (p.marginPct < TARGET_MARGIN_PCT && p.revenueArs > 0) {
      // Рассчитываем необходимое повышение цены
      // Текущая: revenue = cost / (1 - margin/100)
      // Целевая: new_revenue = cost / (1 - target/100)
      // Повышение: (new_revenue / revenue - 1) * 100
      const currentCostRatio = 1 - p.marginPct / 100;
      const targetCostRatio = 1 - TARGET_MARGIN_PCT / 100;
      const priceIncrease =
        targetCostRatio > 0 ? Math.round((currentCostRatio / targetCostRatio - 1) * 100) : 0;

      if (priceIncrease > 0) {
        recs.push(
          `Повысить цену на <b>${p.name}</b> на ${priceIncrease}% для достижения маржи ${TARGET_MARGIN_PCT}% (текущая: ${p.marginPct}%)`,
        );
      }
    }
  }

  // 2. Клиенты с маржой ниже минимума
  for (const c of clientAnalysis) {
    if (c.marginPct < MIN_CLIENT_MARGIN_PCT && c.revenue > 0) {
      recs.push(
        `Клиент <b>${c.name}</b> имеет маржу ${c.marginPct}% (ниже ${MIN_CLIENT_MARGIN_PCT}%) -- пересмотреть цены или условия доставки`,
      );
    }
  }

  // 3. Категории расходов с ростом >20%
  for (const cat of expenseAnalysis.categories) {
    if (cat.momGrowthPct !== null && cat.momGrowthPct > EXPENSE_GROWTH_ALERT_PCT) {
      recs.push(
        `Расходы <b>${cat.name}</b> выросли на ${cat.momGrowthPct}% за месяц -- расследовать причину`,
      );
    }
  }

  // 4. Продукты с высокой себестоимостью и малой выручкой (потенциальные отходы)
  const totalRevenue = productAnalysis.totalRevenue;
  for (const p of productAnalysis.products) {
    if (totalRevenue > 0 && p.allocatedCost > 0) {
      const costShare = (p.allocatedCost / productAnalysis.totalCost) * 100;
      const revenueShare = (p.revenueArs / totalRevenue) * 100;
      // Если доля затрат значительно превышает долю выручки -- перепроизводство
      if (costShare > revenueShare * 1.5 && costShare > 5) {
        const reduceBy = Math.round(costShare - revenueShare);
        recs.push(
          `<b>${p.name}</b> занимает ${Math.round(costShare)}% затрат при ${Math.round(revenueShare)}% выручки -- сократить производство на ~${reduceBy}%`,
        );
      }
    }
  }

  return recs;
}

// ── Форматирование HTML-отчёта ───────────────────────────────────────────────

/**
 * @param {ReturnType<typeof analyzeProductMargins>} productAnalysis
 * @param {ReturnType<typeof analyzeClientProfitability>} clientAnalysis
 * @param {ReturnType<typeof analyzeExpenses>} expenseAnalysis
 * @param {string[]} recommendations
 * @returns {string}
 */
function formatReport(productAnalysis, clientAnalysis, expenseAnalysis, recommendations) {
  const lines = [];
  const today = fmtDate(new Date());

  lines.push(`<b>Margin Optimizer -- ${today}</b>`);
  lines.push(`Период: ${ANALYSIS_DAYS} дней\n`);

  // ── Продукты ──
  lines.push(`<b>1. Маржа по продуктам</b>`);
  if (productAnalysis.products.length === 0) {
    lines.push(`  Нет данных о продажах`);
  } else {
    for (const p of productAnalysis.products.slice(0, 10)) {
      const emoji = p.marginPct >= 50 ? "+" : p.marginPct >= TARGET_MARGIN_PCT ? "~" : "!";
      lines.push(
        `  [${emoji}] ${p.name}: ${fmtNum(p.revenueArs)} ARS, ${p.kgSold.toFixed(1)} кг, маржа ${p.marginPct}%`,
      );
    }
    lines.push(
      `  Итого выручка: ${fmtNum(productAnalysis.totalRevenue)} ARS, затраты: ${fmtNum(productAnalysis.totalCost)} ARS`,
    );
  }

  // ── Клиенты ──
  lines.push(`\n<b>2. Рентабельность клиентов</b>`);
  if (clientAnalysis.length === 0) {
    lines.push(`  Нет данных`);
  } else {
    for (const c of clientAnalysis.slice(0, 10)) {
      const emoji = c.marginPct >= 50 ? "+" : c.marginPct >= MIN_CLIENT_MARGIN_PCT ? "~" : "!";
      lines.push(
        `  [${emoji}] ${c.name}: ${fmtNum(c.revenue)} ARS, ${c.deliveries} доставок, маржа ${c.marginPct}%`,
      );
    }
  }

  // ── Расходы ──
  lines.push(`\n<b>3. Расходы по категориям</b>`);
  if (expenseAnalysis.categories.length === 0) {
    lines.push(`  Нет данных`);
  } else {
    for (const cat of expenseAnalysis.categories.slice(0, 5)) {
      const growth =
        cat.momGrowthPct !== null
          ? ` (MoM: ${cat.momGrowthPct > 0 ? "+" : ""}${cat.momGrowthPct}%)`
          : "";
      const flag =
        cat.momGrowthPct !== null && cat.momGrowthPct > EXPENSE_GROWTH_ALERT_PCT ? " !!!" : "";
      lines.push(`  ${cat.name}: ${fmtNum(cat.totalArs)} ARS${growth}${flag}`);
    }
    lines.push(`  Top-3: ${expenseAnalysis.topCategories.join(", ")}`);
  }

  // ── Рекомендации ──
  lines.push(`\n<b>4. Рекомендации</b>`);
  if (recommendations.length === 0) {
    lines.push(`  Критических проблем не выявлено`);
  } else {
    for (let i = 0; i < recommendations.length; i++) {
      lines.push(`  ${i + 1}. ${recommendations[i]}`);
    }
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Margin Optimizer starting...`);

  // Загрузка данных из Sheets
  let salesRows, expenseRows, productionRows;
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    [salesRows, expenseRows, productionRows] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "🛒 Продажи"),
      readSheet(PEPINO_SHEETS_ID, "💰 Расходы"),
      readSheet(PEPINO_SHEETS_ID, "🌿 Производство"),
    ]);
  } catch (err) {
    console.error(`[FATAL] Не удалось загрузить данные из Sheets: ${err.message}`);
    process.exit(1);
  }

  const sales = rowsToObjects(salesRows);
  const expenses = rowsToObjects(expenseRows);
  const production = rowsToObjects(productionRows);

  console.log(
    `Загружено: продажи=${sales.length}, расходы=${expenses.length}, производство=${production.length}`,
  );

  // Фильтрация за последние 90 дней
  const cutoff = daysAgo(ANALYSIS_DAYS);

  /** @param {Record<string,string>} row */
  const isRecent = (row) => {
    const d = parseDate(getField(row, "Дата", "дата", "date"));
    return d !== null && d >= cutoff;
  };

  const recentSales = sales.filter(isRecent);
  const recentExpenses = expenses.filter(isRecent);
  const recentProduction = production.filter(isRecent);

  console.log(
    `За ${ANALYSIS_DAYS} дней: продажи=${recentSales.length}, расходы=${recentExpenses.length}, производство=${recentProduction.length}`,
  );

  // Анализ
  const productAnalysis = analyzeProductMargins(recentSales, recentProduction);
  const clientAnalysis = analyzeClientProfitability(recentSales);
  const expenseAnalysis = analyzeExpenses(recentExpenses);
  const recommendations = generateRecommendations(productAnalysis, clientAnalysis, expenseAnalysis);

  // Формирование отчёта
  const report = formatReport(productAnalysis, clientAnalysis, expenseAnalysis, recommendations);

  // Вывод в консоль (без HTML-тегов)
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  // Отправка в Telegram
  if (SEND_TG) {
    try {
      await telegramSend(report);
      console.log("[OK] Отчёт отправлен в Telegram (thread 20)");
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Telegram-отправка пропущена");
  }

  // Langfuse tracing
  const durationMs = Date.now() - startMs;
  await trace({
    name: "margin-optimizer",
    input: {
      sales_count: recentSales.length,
      expenses_count: recentExpenses.length,
      production_count: recentProduction.length,
      analysis_days: ANALYSIS_DAYS,
    },
    output: {
      products_analyzed: productAnalysis.products.length,
      clients_analyzed: clientAnalysis.length,
      expense_categories: expenseAnalysis.categories.length,
      recommendations_count: recommendations.length,
      total_revenue: productAnalysis.totalRevenue,
      total_cost: productAnalysis.totalCost,
      low_margin_products: productAnalysis.products.filter((p) => p.marginPct < TARGET_MARGIN_PCT)
        .length,
      low_margin_clients: clientAnalysis.filter((c) => c.marginPct < MIN_CLIENT_MARGIN_PCT).length,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", cron: "margin-optimizer" },
  }).catch(() => {});

  console.log(`Done in ${durationMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
