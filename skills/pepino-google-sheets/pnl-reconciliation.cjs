#!/usr/bin/env node
/**
 * Pepino Pick — Ежедневная сверка P&L (reconciliation)
 *
 * Проверяет консистентность данных между продажами, расходами,
 * производством и P&L. Выявляет расхождения и аномалии.
 *
 * Зависимости: только Node.js http (без внешних модулей)
 * Требует: работающий sheets-api.js на localhost:4000
 *
 * Usage:  node pnl-reconciliation.cjs
 * Cron:   0 22 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/pnl-reconciliation.cjs >> /home/roman/logs/pnl-reconciliation.log 2>&1
 */

"use strict";

const http = require("http");
const { apiHeaders } = require("./api-auth.cjs");

// ── Настройки ────────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:4000";
const THRESHOLD_SALES_VS_REVENUE = 5;   // %, Check 1
const THRESHOLD_EXPENSES_VS_COGS = 10;  // %, Check 2
const THRESHOLD_VOLUME_OVERSOLD = 0;    // кг, продано > собрано = ошибка
const THRESHOLD_VOLUME_WASTE = 50;      // %, собрано >> продано = потери
const THRESHOLD_MARGIN_DIFF = 5;        // %, Check 4

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** HTTP GET запрос через http модуль, возвращает распарсенный JSON */
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    http.get(url, { headers: apiHeaders() }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Ошибка парсинга ответа ${path}: ${err.message}`));
        }
      });
    }).on("error", (err) => {
      reject(new Error(`Ошибка запроса ${path}: ${err.message}`));
    });
  });
}

/**
 * HTTP GET с полными данными (без лимита slice(-20))
 * sheets-api возвращает только последние 20 записей для /sales, /expenses, /production.
 * Для сверки нужны ВСЕ записи текущего месяца — загружаем через /kpi и /pnl,
 * а для детализации используем то что есть. Если API отдает срез — помечаем.
 */

/** Текущая дата в формате YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Текущий месяц в формате YYYY-MM */
function currentMonth() {
  return today().slice(0, 7);
}

/** Безопасное извлечение числа из значения */
function toNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const s = String(val).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Вычисление процентного расхождения */
function diffPct(expected, actual) {
  if (expected === 0 && actual === 0) return 0;
  if (expected === 0) return 100;
  return Math.abs((actual - expected) / expected) * 100;
}

/** Статус проверки по порогу */
function statusByThreshold(diffPercent, warnThreshold) {
  if (diffPercent <= warnThreshold) return "ok";
  if (diffPercent <= warnThreshold * 2) return "warning";
  return "error";
}

// ── Проверки ─────────────────────────────────────────────────────────────────

/**
 * Check 1: Продажи vs Выручка (KPI)
 * Суммируем "Сумма ARS" из /sales за текущий месяц,
 * сравниваем с revenue_ars из /kpi за последний месяц.
 */
async function checkSalesVsRevenue(sales, kpi) {
  const month = currentMonth();

  // Сумма продаж за месяц (из данных API — может быть неполной если >20 записей)
  const monthlySales = sales.filter((r) => {
    const d = String(r["Дата"] || "");
    return d.startsWith(month);
  });
  const salesTotal = monthlySales.reduce((sum, r) => sum + toNum(r["Сумма ARS"]), 0);

  // Выручка из KPI — последняя запись с данными
  const latestKpi = kpi.length > 0 ? kpi[kpi.length - 1] : {};
  const revenueKpi = toNum(latestKpi["revenue_ars"] || latestKpi["Revenue ARS"] || latestKpi["Выручка ARS"] || 0);

  const diff = diffPct(revenueKpi, salesTotal);
  const truncatedWarning = sales.length >= 20
    ? " (API возвращает max 20 записей — сумма может быть неполной)"
    : "";

  return {
    name: "sales_vs_revenue",
    status: revenueKpi === 0 && salesTotal === 0
      ? "ok"
      : statusByThreshold(diff, THRESHOLD_SALES_VS_REVENUE),
    expected: revenueKpi,
    actual: salesTotal,
    diff_pct: Math.round(diff * 100) / 100,
    detail: `Продажи (сумма ARS): ${salesTotal}, KPI выручка: ${revenueKpi}${truncatedWarning}`,
  };
}

/**
 * Check 2: Расходы vs COGS + OPEX (KPI)
 * Суммируем "Сумма ARS" из /expenses за текущий месяц,
 * сравниваем с (cogs_ars + opex_ars) из KPI.
 */
async function checkExpensesVsCogs(expenses, kpi) {
  const month = currentMonth();

  const monthlyExpenses = expenses.filter((r) => {
    const d = String(r["Дата"] || "");
    return d.startsWith(month);
  });
  const expensesTotal = monthlyExpenses.reduce((sum, r) => sum + toNum(r["Сумма ARS"]), 0);

  const latestKpi = kpi.length > 0 ? kpi[kpi.length - 1] : {};
  const cogsKpi = toNum(latestKpi["cogs_ars"] || latestKpi["COGS ARS"] || latestKpi["Себестоимость ARS"] || 0);
  const opexKpi = toNum(latestKpi["opex_ars"] || latestKpi["OPEX ARS"] || latestKpi["Операционные ARS"] || 0);
  const kpiTotal = cogsKpi + opexKpi;

  const diff = diffPct(kpiTotal, expensesTotal);
  const truncatedWarning = expenses.length >= 20
    ? " (API возвращает max 20 записей — сумма может быть неполной)"
    : "";

  return {
    name: "expenses_vs_cogs_opex",
    status: kpiTotal === 0 && expensesTotal === 0
      ? "ok"
      : statusByThreshold(diff, THRESHOLD_EXPENSES_VS_COGS),
    expected: kpiTotal,
    actual: expensesTotal,
    diff_pct: Math.round(diff * 100) / 100,
    detail: `Расходы (сумма ARS): ${expensesTotal}, KPI (COGS+OPEX): ${kpiTotal}${truncatedWarning}`,
  };
}

/**
 * Check 3: Производство vs Продажи (объем по продуктам)
 * Группируем по продукту, сравниваем урожай и продажи в кг.
 * Флаги: продано > собрано, или собрано >> продано.
 */
async function checkProductionVsSales(production, sales) {
  const month = currentMonth();

  // Группировка производства по продукту
  const harvestByProduct = {};
  production.filter((r) => String(r["Дата"] || "").startsWith(month)).forEach((r) => {
    const product = String(r["Продукт"] || "неизвестно").trim();
    harvestByProduct[product] = (harvestByProduct[product] || 0) + toNum(r["Урожай кг"]);
  });

  // Группировка продаж по продукту
  const soldByProduct = {};
  sales.filter((r) => String(r["Дата"] || "").startsWith(month)).forEach((r) => {
    const product = String(r["Продукт"] || "неизвестно").trim();
    soldByProduct[product] = (soldByProduct[product] || 0) + toNum(r["Кол-во кг"]);
  });

  // Объединяем все продукты
  const allProducts = new Set([...Object.keys(harvestByProduct), ...Object.keys(soldByProduct)]);
  const flags = [];
  let worstStatus = "ok";

  for (const product of allProducts) {
    const harvested = harvestByProduct[product] || 0;
    const sold = soldByProduct[product] || 0;

    // Продано больше чем собрано — невозможно без запасов
    if (sold > harvested && harvested > 0) {
      const overPct = ((sold - harvested) / harvested) * 100;
      flags.push(`${product}: продано ${sold}кг > собрано ${harvested}кг (+${Math.round(overPct)}%)`);
      worstStatus = "error";
    } else if (sold > harvested && harvested === 0) {
      flags.push(`${product}: продано ${sold}кг, но нет данных сбора`);
      worstStatus = "error";
    }

    // Собрано сильно больше чем продано — риск потерь
    if (harvested > 0 && sold < harvested) {
      const wastePct = ((harvested - sold) / harvested) * 100;
      if (wastePct > THRESHOLD_VOLUME_WASTE) {
        flags.push(`${product}: собрано ${harvested}кг, продано ${sold}кг (потери ${Math.round(wastePct)}%)`);
        if (worstStatus !== "error") worstStatus = "warning";
      }
    }
  }

  return {
    name: "production_vs_sales_volume",
    status: flags.length === 0 ? "ok" : worstStatus,
    expected: harvestByProduct,
    actual: soldByProduct,
    diff_pct: null,
    detail: flags.length > 0
      ? flags.join("; ")
      : `Объемы сходятся по ${allProducts.size} продуктам`,
  };
}

/**
 * Check 4: Консистентность маржи
 * Считаем gross margin = выручка - расходы из сырых данных,
 * сравниваем с gross_margin из P&L.
 */
async function checkMarginConsistency(sales, expenses, pnl) {
  const month = currentMonth();

  // Расчет маржи из сырых данных
  const salesTotal = sales
    .filter((r) => String(r["Дата"] || "").startsWith(month))
    .reduce((sum, r) => sum + toNum(r["Сумма ARS"]), 0);

  const expensesTotal = expenses
    .filter((r) => String(r["Дата"] || "").startsWith(month))
    .reduce((sum, r) => sum + toNum(r["Сумма ARS"]), 0);

  const calculatedMargin = salesTotal - expensesTotal;

  // Gross margin из P&L — ищем строку текущего месяца или последнюю
  let pnlMargin = 0;
  const pnlRow = pnl.find((r) => String(r["month"] || r["Месяц"] || "").startsWith(month));
  if (pnlRow) {
    pnlMargin = toNum(pnlRow["gross_margin"] || pnlRow["Валовая маржа"] || 0);
  } else if (pnl.length > 0) {
    // Берем последнюю строку если текущий месяц не найден
    const last = pnl[pnl.length - 1];
    pnlMargin = toNum(last["gross_margin"] || last["Валовая маржа"] || 0);
  }

  const diff = diffPct(pnlMargin, calculatedMargin);

  return {
    name: "margin_consistency",
    status: pnlMargin === 0 && calculatedMargin === 0
      ? "ok"
      : statusByThreshold(diff, THRESHOLD_MARGIN_DIFF),
    expected: pnlMargin,
    actual: calculatedMargin,
    diff_pct: Math.round(diff * 100) / 100,
    detail: `Расчетная маржа: ${calculatedMargin} ARS, P&L маржа: ${pnlMargin} ARS`,
  };
}

/**
 * Check 5: Полнота данных (data completeness)
 * - Продажи без дат
 * - Расходы без сумм
 * - Производство с 0 урожаем но положительным отходом
 */
async function checkDataCompleteness(sales, expenses, production) {
  const issues = [];

  // Продажи без дат
  const salesNoDates = sales.filter((r) => {
    const d = String(r["Дата"] || "").trim();
    return d === "" || d === "undefined";
  });
  if (salesNoDates.length > 0) {
    issues.push(`${salesNoDates.length} продаж без даты`);
  }

  // Расходы без сумм
  const expensesNoAmount = expenses.filter((r) => {
    return toNum(r["Сумма ARS"]) === 0 && String(r["Наименование"] || r["Категория"] || "").trim() !== "";
  });
  if (expensesNoAmount.length > 0) {
    issues.push(`${expensesNoAmount.length} расходов без суммы`);
  }

  // Производство: 0 урожай но положительный отход
  const badProduction = production.filter((r) => {
    const harvest = toNum(r["Урожай кг"]);
    const waste = toNum(r["Отход кг"]);
    return harvest === 0 && waste > 0;
  });
  if (badProduction.length > 0) {
    issues.push(`${badProduction.length} записей производства с отходом но без урожая`);
  }

  // Дополнительно: пустые продукты в продажах
  const salesNoProduct = sales.filter((r) => {
    return String(r["Продукт"] || "").trim() === "";
  });
  if (salesNoProduct.length > 0) {
    issues.push(`${salesNoProduct.length} продаж без указания продукта`);
  }

  return {
    name: "data_completeness",
    status: issues.length === 0 ? "ok" : (issues.length >= 3 ? "error" : "warning"),
    expected: "Все записи заполнены",
    actual: issues.length === 0 ? "Все записи заполнены" : issues.join("; "),
    diff_pct: null,
    detail: issues.length === 0
      ? "Данные полные, аномалий не найдено"
      : `Найдено ${issues.length} проблем: ${issues.join("; ")}`,
  };
}

// ── Основной процесс ────────────────────────────────────────────────────────

async function runReconciliation() {
  const startTime = Date.now();
  const dateStr = today();
  const month = currentMonth();

  console.log(`[${dateStr}] Запуск сверки P&L для месяца ${month}...`);

  // Загружаем все данные параллельно
  let sales, expenses, production, kpi, pnl;
  try {
    [sales, expenses, production, kpi, pnl] = await Promise.all([
      apiGet("/sales"),
      apiGet("/expenses"),
      apiGet("/production"),
      apiGet("/kpi"),
      apiGet("/pnl"),
    ]);
  } catch (err) {
    const errorResult = {
      date: dateStr,
      month: month,
      checks: [],
      summary: `ОШИБКА: не удалось загрузить данные — ${err.message}`,
      error: true,
      elapsed_ms: Date.now() - startTime,
    };
    console.error(JSON.stringify(errorResult, null, 2));
    process.exit(1);
  }

  // Валидация: убеждаемся что получили массивы
  if (!Array.isArray(sales)) sales = [];
  if (!Array.isArray(expenses)) expenses = [];
  if (!Array.isArray(production)) production = [];
  if (!Array.isArray(kpi)) kpi = [];
  if (!Array.isArray(pnl)) pnl = [];

  // Запускаем все проверки
  const checks = [];
  const checkFns = [
    () => checkSalesVsRevenue(sales, kpi),
    () => checkExpensesVsCogs(expenses, kpi),
    () => checkProductionVsSales(production, sales),
    () => checkMarginConsistency(sales, expenses, pnl),
    () => checkDataCompleteness(sales, expenses, production),
  ];

  for (const fn of checkFns) {
    try {
      const result = await fn();
      checks.push(result);
    } catch (err) {
      checks.push({
        name: fn.name || "unknown",
        status: "error",
        expected: null,
        actual: null,
        diff_pct: null,
        detail: `Ошибка выполнения проверки: ${err.message}`,
      });
    }
  }

  // Подсчет итогов
  const passed = checks.filter((c) => c.status === "ok").length;
  const warnings = checks.filter((c) => c.status === "warning").length;
  const errors = checks.filter((c) => c.status === "error").length;
  const total = checks.length;

  const summaryParts = [];
  summaryParts.push(`${passed}/${total} проверок пройдено`);
  if (warnings > 0) summaryParts.push(`${warnings} предупреждений`);
  if (errors > 0) summaryParts.push(`${errors} ошибок`);

  const result = {
    date: dateStr,
    month: month,
    checks: checks,
    summary: summaryParts.join(", "),
    elapsed_ms: Date.now() - startTime,
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ── Запуск ───────────────────────────────────────────────────────────────────

runReconciliation().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
