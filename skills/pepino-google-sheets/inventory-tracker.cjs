#!/usr/bin/env node
/**
 * Pepino Pick -- Мониторинг запасов, расчёт days-of-stock, алерты нехватки
 *
 * Источники данных (Google Sheets через sheets.js):
 *   - "Склад"        -- текущие остатки
 *   - "Продажи"      -- продажи (для расчёта среднего потребления за 7 дней)
 *   - "Производство"  -- сбор урожая (приход на склад)
 *
 * Алерты:
 *   - <3 дня запаса  → CRITICAL (громкое уведомление)
 *   - <7 дней запаса → WARNING  (тихое уведомление)
 *
 * Usage:
 *   node inventory-tracker.cjs              -- полный запуск с TG-алертами
 *   node inventory-tracker.cjs --dry-run    -- без отправки в Telegram
 *
 * Cron: 0 8 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/inventory-tracker.cjs >> /home/roman/logs/inventory-tracker.log 2>&1
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendAlert, sendStatus, send } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");
const { parseNum, parseDate, fmtDate, rowsToObjects } = require("./helpers.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_INVENTORY = 20;

/** Пороги дней запаса */
const CRITICAL_DAYS = 3;
const WARNING_DAYS = 7;

/** Период для расчёта среднего потребления (дней) */
const CONSUMPTION_WINDOW_DAYS = 7;

// -- Хелперы ------------------------------------------------------------------
// parseNum, parseDate, fmtDate, rowsToObjects импортированы из helpers.cjs

/** Дата N дней назад (начало дня) */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

// -- Основная логика ----------------------------------------------------------

/**
 * Парсит данные склада.
 * Возвращает карту: продукт → текущий остаток (кг).
 * @param {Record<string, string>[]} inventoryRows
 * @returns {Map<string, number>}
 */
function parseInventory(inventoryRows) {
  /** @type {Map<string, number>} */
  const stock = new Map();

  for (const row of inventoryRows) {
    // Пробуем несколько вариантов названий колонок
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Название"] || "").trim();
    const qty = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );

    if (!rawProduct) continue;

    const key = normalize(rawProduct).toLowerCase();
    stock.set(key, (stock.get(key) || 0) + qty);
  }

  return stock;
}

/**
 * Рассчитывает среднее дневное потребление за последние N дней из продаж.
 * Колонки: "Дата", "Продукт", "Кол-во кг"
 * @param {Record<string, string>[]} salesRows
 * @param {number} windowDays
 * @returns {Map<string, number>} продукт → среднее потребление кг/день
 */
function calcAvgConsumption(salesRows, windowDays) {
  const cutoff = daysAgo(windowDays);
  /** @type {Map<string, number>} суммарные продажи за период */
  const totalSold = new Map();

  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;

    const product = normalize(row["Продукт"] || row["Товар"] || "").toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);

    if (!product || qty <= 0) continue;

    totalSold.set(product, (totalSold.get(product) || 0) + qty);
  }

  /** @type {Map<string, number>} */
  const avgPerDay = new Map();
  for (const [product, total] of totalSold) {
    avgPerDay.set(product, total / windowDays);
  }

  return avgPerDay;
}

/**
 * Рассчитывает приход за последние N дней из листа Производство.
 * @param {Record<string, string>[]} productionRows
 * @param {number} windowDays
 * @returns {Map<string, number>} продукт → среднее производство кг/день
 */
function calcAvgProduction(productionRows, windowDays) {
  const cutoff = daysAgo(windowDays);
  /** @type {Map<string, number>} */
  const totalProduced = new Map();

  for (const row of productionRows) {
    const harvestDate = parseDate(row["Дата"] || row["Дата сбора"] || row["Fecha"]);
    if (!harvestDate || harvestDate < cutoff) continue;

    const product = normalize(
      row["Продукт"] || row["Культура"] || row["Товар"] || "",
    ).toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Урожай кг"] || row["Количество"] || 0);

    if (!product || qty <= 0) continue;

    totalProduced.set(product, (totalProduced.get(product) || 0) + qty);
  }

  /** @type {Map<string, number>} */
  const avgPerDay = new Map();
  for (const [product, total] of totalProduced) {
    avgPerDay.set(product, total / windowDays);
  }

  return avgPerDay;
}

/**
 * Рассчитывает коэффициент оборачиваемости запасов (Stock Turnover Rate).
 * Формула: (Продажи за период) / (Средний остаток) * (365 / period_days)
 * Если остаток = 0, возвращает Infinity (нулевой запас при наличии продаж).
 * @param {number} totalSold — продажи за период (кг)
 * @param {number} currentStock — текущий остаток (кг)
 * @param {number} periodDays — длина периода
 * @returns {number|null}
 */
function calcTurnoverRate(totalSold, currentStock, periodDays) {
  if (totalSold <= 0) return null;
  if (currentStock <= 0) return Infinity;
  // Аннуализированная оборачиваемость
  return (totalSold / currentStock) * (365 / periodDays);
}

// -- Форматирование отчёта для Telegram ---------------------------------------

/**
 * Формирует HTML-сообщение с отчётом по запасам.
 * @param {Array<{product: string, stock: number, avgConsumption: number, daysOfStock: number|null, turnoverRate: number|null, severity: string}>} items
 * @param {{critical: number, warning: number, ok: number}} counts
 * @returns {string}
 */
function formatTelegramReport(items, counts) {
  const now = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });

  const lines = [];
  lines.push(`<b>Запасы Pepino Pick</b>`);
  lines.push(`${now}\n`);

  // Сначала критичные и предупреждения
  const alerts = items.filter((i) => i.severity !== "ok");
  if (alerts.length > 0) {
    for (const item of alerts) {
      const icon = item.severity === "critical" ? "!!!" : "!";
      const daysStr = item.daysOfStock !== null ? `${item.daysOfStock.toFixed(1)} дн.` : "N/A";
      lines.push(
        `${icon} <b>${capitalize(item.product)}</b>: ${item.stock.toFixed(1)} кг | ` +
          `${daysStr} запаса | ` +
          `расход ${item.avgConsumption.toFixed(1)} кг/дн.`,
      );
    }
    lines.push("");
  }

  // Итого
  lines.push(`<b>Итого:</b> ${items.length} позиций`);
  if (counts.critical > 0) {
    lines.push(`  !!! Критично: ${counts.critical}`);
  }
  if (counts.warning > 0) {
    lines.push(`  ! Внимание: ${counts.warning}`);
  }
  lines.push(`  ОК: ${counts.ok}`);

  // Все позиции кратко
  lines.push("\n<b>Полный список:</b>");
  for (const item of items) {
    const statusIcon =
      item.severity === "critical" ? "!!!" : item.severity === "warning" ? "!" : "ok";
    const daysStr = item.daysOfStock !== null ? `${item.daysOfStock.toFixed(1)}д` : "-";
    const turnover =
      item.turnoverRate !== null
        ? !isFinite(item.turnoverRate) || isNaN(item.turnoverRate)
          ? "—"
          : `${item.turnoverRate.toFixed(1)}x`
        : "—";
    lines.push(
      `[${statusIcon}] ${capitalize(item.product)}: ${item.stock.toFixed(1)} кг | ` +
        `${daysStr} | оборач. ${turnover}`,
    );
  }

  return lines.join("\n");
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -- Главная функция ----------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Запуск inventory-tracker...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Источник данных: farm-state кеш -> sheets.js (fallback)
  let inventoryRows, salesRows, productionRows;
  let farmState = null;
  try {
    farmState = await require("./farm-state.cjs").getState();
  } catch (err) {
    console.error(`[inventory-tracker] farm-state недоступен: ${err.message}`);
  }

  if (farmState && farmState.inventory && farmState.sales && farmState.production) {
    inventoryRows = farmState.inventory;
    salesRows = farmState.sales;
    productionRows = farmState.production;
    console.error("[inventory-tracker] Данные загружены из farm-state кеша");
  } else {
    // Fallback: прямое чтение из Google Sheets
    /** @type {{ readSheet: Function, PEPINO_SHEETS_ID: string }} */
    let readSheet, PEPINO_SHEETS_ID;
    try {
      const sheetsModule = await import("./sheets.js");
      readSheet = sheetsModule.readSheet;
      PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
    } catch (err) {
      console.error(`[inventory-tracker] Не удалось импортировать sheets.js: ${err.message}`);
      process.exit(1);
    }

    let inventoryRaw, salesRaw, productionRaw;
    try {
      [inventoryRaw, salesRaw, productionRaw] = await Promise.all([
        readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} Склад"),
        readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи"),
        readSheet(PEPINO_SHEETS_ID, "\u{1F33F} Производство"),
      ]);
    } catch (err) {
      const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
      console.error(`[inventory-tracker] ${msg}`);
      if (!DRY_RUN) {
        await sendAlert(`!!! Inventory Tracker FAIL\n${msg}`, TG_THREAD_INVENTORY);
      }
      process.exit(1);
    }

    inventoryRows = rowsToObjects(inventoryRaw);
    salesRows = rowsToObjects(salesRaw);
    productionRows = rowsToObjects(productionRaw);
  }

  console.error(
    `[inventory-tracker] Загружено: склад=${inventoryRows.length}, ` +
      `продажи=${salesRows.length}, производство=${productionRows.length}`,
  );

  // Расчёт
  const stock = parseInventory(inventoryRows);
  const avgConsumption = calcAvgConsumption(salesRows, CONSUMPTION_WINDOW_DAYS);
  const avgProduction = calcAvgProduction(productionRows, CONSUMPTION_WINDOW_DAYS);

  // Суммарные продажи за период (для turnover rate)
  const cutoff = daysAgo(CONSUMPTION_WINDOW_DAYS);
  /** @type {Map<string, number>} */
  const totalSoldMap = new Map();
  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;
    const product = normalize(row["Продукт"] || row["Товар"] || "").toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);
    if (product && qty > 0) {
      totalSoldMap.set(product, (totalSoldMap.get(product) || 0) + qty);
    }
  }

  // Собираем все известные продукты (объединение склада, продаж, производства)
  const allProducts = new Set([...stock.keys(), ...avgConsumption.keys(), ...avgProduction.keys()]);

  /** @type {Array<{product: string, stock: number, avgConsumption: number, avgProduction: number, daysOfStock: number|null, turnoverRate: number|null, severity: string}>} */
  const items = [];
  const counts = { critical: 0, warning: 0, ok: 0 };

  for (const product of allProducts) {
    const currentStock = stock.get(product) || 0;
    const dailyConsumption = avgConsumption.get(product) || 0;
    const dailyProduction = avgProduction.get(product) || 0;
    const totalSold = totalSoldMap.get(product) || 0;

    // Days of stock: запас / среднее потребление в день
    let daysOfStock = null;
    if (dailyConsumption > 0) {
      daysOfStock = currentStock / dailyConsumption;
    }

    // Оборачиваемость (аннуализированная)
    const turnoverRate = calcTurnoverRate(totalSold, currentStock, CONSUMPTION_WINDOW_DAYS);

    // Определяем severity
    let severity = "ok";
    if (daysOfStock !== null) {
      if (daysOfStock < CRITICAL_DAYS) severity = "critical";
      else if (daysOfStock < WARNING_DAYS) severity = "warning";
    } else if (currentStock <= 0 && totalSold > 0) {
      // Нет остатка, но были продажи — критично
      severity = "critical";
    }

    counts[severity]++;

    items.push({
      product,
      stock: currentStock,
      avgConsumption: dailyConsumption,
      avgProduction: dailyProduction,
      daysOfStock,
      turnoverRate,
      severity,
    });
  }

  // Сортируем: критичные первыми, затем по дням запаса
  items.sort((a, b) => {
    const order = { critical: 0, warning: 1, ok: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    // Внутри группы: меньше дней = выше
    const da = a.daysOfStock ?? 9999;
    const db = b.daysOfStock ?? 9999;
    return da - db;
  });

  // JSON-отчёт в stdout
  const result = {
    timestamp,
    dry_run: DRY_RUN,
    summary: {
      total_products: items.length,
      critical: counts.critical,
      warning: counts.warning,
      ok: counts.ok,
    },
    items: items.map((i) => ({
      product: i.product,
      stock_kg: Math.round(i.stock * 10) / 10,
      avg_consumption_kg_day: Math.round(i.avgConsumption * 10) / 10,
      avg_production_kg_day: Math.round(i.avgProduction * 10) / 10,
      days_of_stock: i.daysOfStock !== null ? Math.round(i.daysOfStock * 10) / 10 : null,
      turnover_rate_annual:
        i.turnoverRate !== null
          ? i.turnoverRate === Infinity
            ? "Infinity"
            : Math.round(i.turnoverRate * 10) / 10
          : null,
      severity: i.severity,
    })),
    data_sources: {
      inventory_rows: inventoryRows.length,
      sales_rows: salesRows.length,
      production_rows: productionRows.length,
      consumption_window_days: CONSUMPTION_WINDOW_DAYS,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  // Telegram-алерт
  const hasCritical = counts.critical > 0;
  const hasWarning = counts.warning > 0;

  if (!DRY_RUN && (hasCritical || hasWarning)) {
    const report = formatTelegramReport(items, counts);
    try {
      const priority = hasCritical ? "critical" : "normal";
      const silent = !hasCritical;
      if (sendThrottled) {
        await sendThrottled(report, {
          thread: TG_THREAD_INVENTORY,
          silent,
          priority,
          parseMode: "HTML",
        });
      } else {
        await send(report, {
          silent,
          threadId: TG_THREAD_INVENTORY,
          parseMode: "HTML",
        });
      }
      console.error("[inventory-tracker] Telegram-алерт отправлен");
    } catch (err) {
      console.error(`[inventory-tracker] Ошибка отправки в Telegram: ${err.message}`);
    }
  } else if (DRY_RUN && (hasCritical || hasWarning)) {
    console.error("[inventory-tracker] DRY RUN: пропуск отправки Telegram");
    console.error(formatTelegramReport(items, counts));
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "inventory-tracker",
    input: {
      sheets: ["Склад", "Продажи", "Производство"],
      consumption_window: CONSUMPTION_WINDOW_DAYS,
      dry_run: DRY_RUN,
    },
    output: {
      products: items.length,
      critical: counts.critical,
      warning: counts.warning,
      ok: counts.ok,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "inventory-tracker",
    },
  });

  console.error(
    `[inventory-tracker] Завершено за ${durationMs}мс. ` +
      `Продуктов: ${items.length}, критично: ${counts.critical}, внимание: ${counts.warning}`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[inventory-tracker] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
