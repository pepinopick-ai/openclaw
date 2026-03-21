#!/usr/bin/env node
/**
 * Pepino Pick -- Трекер потерь и отходов производства
 *
 * Рассчитывает потери по формуле:
 *   waste = produced - sold - current_stock (приблизительно)
 *
 * Анализ:
 *   - Процент потерь по каждому продукту
 *   - Тренд потерь (текущая неделя vs прошлая)
 *   - Финансовые потери (waste_kg * avg_price_per_kg)
 *   - Рекомендации по оптимизации
 *
 * Источники данных (Google Sheets через sheets.js):
 *   - "Производство" -- произведено
 *   - "Продажи"      -- продано
 *   - "Склад"        -- текущие остатки
 *
 * Usage:
 *   node waste-tracker.cjs              -- полный запуск с отправкой в Telegram
 *   node waste-tracker.cjs --dry-run    -- без отправки в Telegram
 *
 * Cron: 0 17 * * 5 /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/waste-tracker.cjs >> /home/roman/logs/waste-tracker.log 2>&1
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendReport, send } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_WASTE = 20;

/** Порог высоких потерь (%) */
const HIGH_WASTE_THRESHOLD = 20;

/** Период анализа (дней) -- текущая неделя */
const CURRENT_WINDOW_DAYS = 7;

/** Период анализа (дней) -- прошлая неделя (для тренда) */
const PREVIOUS_WINDOW_DAYS = 14;

// -- Хелперы ------------------------------------------------------------------

/** Безопасное извлечение числа из строки (поддержка запятых, пробелов, валюты) */
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
 * Парсит дату из строки. Поддерживает форматы:
 *   - DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
 *   - YYYY-MM-DD
 * @param {string} raw
 * @returns {Date|null}
 */
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Дата N дней назад (начало дня) */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
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
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i]?.[j] ?? "";
    }
    result.push(obj);
  }
  return result;
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -- Агрегация данных ---------------------------------------------------------

/**
 * Суммирует произведённые кг по продуктам за период [cutoffStart, cutoffEnd).
 * @param {Record<string, string>[]} productionRows
 * @param {Date} cutoffStart
 * @param {Date} cutoffEnd
 * @returns {Map<string, number>}
 */
function sumProduced(productionRows, cutoffStart, cutoffEnd) {
  /** @type {Map<string, number>} */
  const totals = new Map();

  for (const row of productionRows) {
    const d = parseDate(row["Дата"] || row["Дата сбора"] || row["Fecha"]);
    if (!d || d < cutoffStart || d >= cutoffEnd) continue;

    const product = normalize(
      row["Продукт"] || row["Культура"] || row["Товар"] || "",
    ).toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Урожай кг"] || row["Количество"] || 0);

    if (!product || qty <= 0) continue;
    totals.set(product, (totals.get(product) || 0) + qty);
  }

  return totals;
}

/**
 * Суммирует проданные кг по продуктам за период [cutoffStart, cutoffEnd).
 * Также собирает выручку для расчёта средней цены за кг.
 * @param {Record<string, string>[]} salesRows
 * @param {Date} cutoffStart
 * @param {Date} cutoffEnd
 * @returns {{ soldKg: Map<string, number>, revenueArs: Map<string, number> }}
 */
function sumSold(salesRows, cutoffStart, cutoffEnd) {
  /** @type {Map<string, number>} */
  const soldKg = new Map();
  /** @type {Map<string, number>} */
  const revenueArs = new Map();

  for (const row of salesRows) {
    const d = parseDate(row["Дата"]);
    if (!d || d < cutoffStart || d >= cutoffEnd) continue;

    const product = normalize(row["Продукт"] || row["Товар"] || "").toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);
    const revenue = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);

    if (!product || qty <= 0) continue;

    soldKg.set(product, (soldKg.get(product) || 0) + qty);
    revenueArs.set(product, (revenueArs.get(product) || 0) + revenue);
  }

  return { soldKg, revenueArs };
}

/**
 * Парсит текущие остатки склада.
 * @param {Record<string, string>[]} inventoryRows
 * @returns {Map<string, number>}
 */
function parseInventory(inventoryRows) {
  /** @type {Map<string, number>} */
  const stock = new Map();

  for (const row of inventoryRows) {
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

// -- Анализ потерь ------------------------------------------------------------

/**
 * @typedef {Object} WasteItem
 * @property {string} product -- название продукта
 * @property {number} produced -- произведено (кг) за текущую неделю
 * @property {number} sold -- продано (кг) за текущую неделю
 * @property {number} stock -- текущий остаток (кг)
 * @property {number} waste -- потери (кг) = produced - sold - stock (если > 0)
 * @property {number} wastePercent -- процент потерь от произведённого
 * @property {number} prevWastePercent -- процент потерь за прошлую неделю (для тренда)
 * @property {number|null} trendDelta -- изменение % потерь (текущая - прошлая)
 * @property {number} avgPricePerKg -- средняя цена за кг (ARS)
 * @property {number} financialLoss -- финансовые потери (ARS)
 * @property {string} recommendation -- рекомендация
 */

/**
 * Рассчитывает потери по каждому продукту.
 * @param {Map<string, number>} produced -- за текущую неделю
 * @param {{ soldKg: Map<string, number>, revenueArs: Map<string, number> }} salesData -- за текущую неделю
 * @param {Map<string, number>} stock -- текущие остатки
 * @param {Map<string, number>} prevProduced -- за прошлую неделю
 * @param {{ soldKg: Map<string, number> }} prevSalesData -- за прошлую неделю
 * @returns {WasteItem[]}
 */
function calculateWaste(produced, salesData, stock, prevProduced, prevSalesData) {
  // Собираем все продукты, которые были в производстве (хотя бы за одну из недель)
  const allProducts = new Set([...produced.keys(), ...prevProduced.keys()]);

  /** @type {WasteItem[]} */
  const items = [];

  for (const product of allProducts) {
    const prod = produced.get(product) || 0;
    const sold = salesData.soldKg.get(product) || 0;
    const currentStock = stock.get(product) || 0;
    const revenue = salesData.revenueArs.get(product) || 0;

    // Потери = произведено - продано - остаток на складе
    // Если отрицательное -- значит продали из старых запасов, потерь нет
    const rawWaste = prod - sold - currentStock;
    const waste = Math.max(0, rawWaste);
    const wastePercent = prod > 0 ? (waste / prod) * 100 : 0;

    // Средняя цена за кг для оценки финансовых потерь
    const avgPricePerKg = sold > 0 ? revenue / sold : 0;
    const financialLoss = waste * avgPricePerKg;

    // Тренд: потери прошлой недели
    const prevProd = prevProduced.get(product) || 0;
    const prevSold = prevSalesData.soldKg.get(product) || 0;
    // Для прошлой недели остаток неизвестен, считаем потери без учёта склада
    const prevWaste = Math.max(0, prevProd - prevSold);
    const prevWastePercent = prevProd > 0 ? (prevWaste / prevProd) * 100 : 0;

    const trendDelta = prod > 0 || prevProd > 0 ? wastePercent - prevWastePercent : null;

    // Рекомендации
    const recommendation = generateRecommendation(wastePercent, currentStock, sold, prod);

    items.push({
      product,
      produced: prod,
      sold,
      stock: currentStock,
      waste,
      wastePercent,
      prevWastePercent,
      trendDelta,
      avgPricePerKg,
      financialLoss,
      recommendation,
    });
  }

  // Сортируем по проценту потерь (самые убыточные вверху)
  items.sort((a, b) => b.wastePercent - a.wastePercent);

  return items;
}

/**
 * Генерирует рекомендацию на основании показателей.
 * @param {number} wastePercent
 * @param {number} stock
 * @param {number} sold
 * @param {number} produced
 * @returns {string}
 */
function generateRecommendation(wastePercent, stock, sold, produced) {
  if (wastePercent <= HIGH_WASTE_THRESHOLD) {
    return "Оптимально";
  }

  // Высокие потери + низкий остаток на складе -> перепроизводство
  // (продукция портится быстрее, чем продаётся, запас при этом пуст)
  if (stock < produced * 0.1) {
    return "Перепроизводство: сократить посадку / сбор";
  }

  // Высокие потери + высокий остаток -> медленные продажи
  if (stock > produced * 0.3) {
    return "Медленные продажи: снизить цену или найти новых клиентов";
  }

  // Общий случай высоких потерь
  return "Высокие потери: проверить хранение и логистику";
}

// -- Форматирование отчёта ----------------------------------------------------

/**
 * Формирует HTML-сообщение для Telegram.
 * @param {WasteItem[]} items
 * @param {{ totalProduced: number, totalSold: number, totalWaste: number, totalLoss: number, avgWastePercent: number }} summary
 * @returns {string}
 */
function formatTelegramReport(items, summary) {
  const now = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });

  const lines = [];
  lines.push(`<b>Потери и отходы Pepino Pick</b>`);
  lines.push(`${now}\n`);

  // Общая сводка
  lines.push(`<b>Итого за 7 дней:</b>`);
  lines.push(`  Произведено: ${summary.totalProduced.toFixed(1)} кг`);
  lines.push(`  Продано: ${summary.totalSold.toFixed(1)} кг`);
  lines.push(
    `  Потери: ${summary.totalWaste.toFixed(1)} кг (${summary.avgWastePercent.toFixed(1)}%)`,
  );

  if (summary.totalLoss > 0) {
    lines.push(`  Финансовые потери: ~${Math.round(summary.totalLoss).toLocaleString()} ARS`);
  }

  // Продукты с высокими потерями
  const highWaste = items.filter((i) => i.wastePercent > HIGH_WASTE_THRESHOLD && i.produced > 0);
  if (highWaste.length > 0) {
    lines.push(`\n<b>Высокие потери (>${HIGH_WASTE_THRESHOLD}%):</b>`);
    for (const item of highWaste) {
      const trendStr = formatTrend(item.trendDelta);
      lines.push(
        `  !!! <b>${capitalize(item.product)}</b>: ${item.wastePercent.toFixed(1)}% ${trendStr}`,
      );
      lines.push(
        `      ${item.produced.toFixed(1)} кг произв. | ${item.sold.toFixed(1)} кг прод. | ` +
          `${item.waste.toFixed(1)} кг потерь`,
      );
      if (item.financialLoss > 0) {
        lines.push(`      Убыток: ~${Math.round(item.financialLoss).toLocaleString()} ARS`);
      }
      lines.push(`      -> ${item.recommendation}`);
    }
  }

  // Все продукты -- краткий список
  const producedItems = items.filter((i) => i.produced > 0);
  if (producedItems.length > 0) {
    lines.push(`\n<b>Все продукты:</b>`);
    for (const item of producedItems) {
      const icon = item.wastePercent > HIGH_WASTE_THRESHOLD ? "!!!" : "ok";
      const trendStr = formatTrend(item.trendDelta);
      lines.push(
        `[${icon}] ${capitalize(item.product)}: ` +
          `${item.wastePercent.toFixed(1)}% потерь ${trendStr} | ` +
          `${item.produced.toFixed(1)} -> ${item.sold.toFixed(1)} кг`,
      );
    }
  }

  // Продукты без производства, но с остатком (информационно)
  const stockOnly = items.filter((i) => i.produced === 0 && i.stock > 0);
  if (stockOnly.length > 0) {
    lines.push(`\n<i>Без производства (только остаток):</i>`);
    for (const item of stockOnly) {
      lines.push(`  ${capitalize(item.product)}: ${item.stock.toFixed(1)} кг на складе`);
    }
  }

  return lines.join("\n");
}

/**
 * Форматирует тренд потерь.
 * @param {number|null} delta
 * @returns {string}
 */
function formatTrend(delta) {
  if (delta === null) return "";
  if (Math.abs(delta) < 2) return "(=)";
  if (delta > 0) return `(+${delta.toFixed(0)}% vs прошл. нед.)`;
  return `(${delta.toFixed(0)}% vs прошл. нед.)`;
}

// -- Главная функция ----------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Запуск waste-tracker...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Динамический импорт ESM-модуля sheets.js из CJS
  /** @type {{ readSheet: Function, PEPINO_SHEETS_ID: string }} */
  let readSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[waste-tracker] Не удалось импортировать sheets.js: ${err.message}`);
    process.exit(1);
  }

  // Параллельное чтение трёх листов
  let productionRaw, salesRaw, inventoryRaw;
  try {
    [productionRaw, salesRaw, inventoryRaw] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "\u{1F33F} Производство"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} Склад"),
    ]);
  } catch (err) {
    const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
    console.error(`[waste-tracker] ${msg}`);
    if (!DRY_RUN) {
      const { sendAlert } = require("./telegram-helper.cjs");
      await sendAlert(`!!! Waste Tracker FAIL\n${msg}`, TG_THREAD_WASTE);
    }
    process.exit(1);
  }

  // Парсинг строк в объекты
  const productionRows = rowsToObjects(productionRaw);
  const salesRows = rowsToObjects(salesRaw);
  const inventoryRows = rowsToObjects(inventoryRaw);

  console.error(
    `[waste-tracker] Загружено: производство=${productionRows.length}, ` +
      `продажи=${salesRows.length}, склад=${inventoryRows.length}`,
  );

  // Временные границы
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const weekStart = daysAgo(CURRENT_WINDOW_DAYS);
  const prevWeekStart = daysAgo(PREVIOUS_WINDOW_DAYS);

  // Данные текущей недели
  const currentProduced = sumProduced(productionRows, weekStart, now);
  const currentSales = sumSold(salesRows, weekStart, now);
  const stock = parseInventory(inventoryRows);

  // Данные прошлой недели (для тренда)
  const prevProduced = sumProduced(productionRows, prevWeekStart, weekStart);
  const prevSales = sumSold(salesRows, prevWeekStart, weekStart);

  // Расчёт потерь
  const wasteItems = calculateWaste(currentProduced, currentSales, stock, prevProduced, prevSales);

  // Агрегация итогов
  const totalProduced = wasteItems.reduce((s, i) => s + i.produced, 0);
  const totalSold = wasteItems.reduce((s, i) => s + i.sold, 0);
  const totalWaste = wasteItems.reduce((s, i) => s + i.waste, 0);
  const totalLoss = wasteItems.reduce((s, i) => s + i.financialLoss, 0);
  const avgWastePercent = totalProduced > 0 ? (totalWaste / totalProduced) * 100 : 0;

  const summary = { totalProduced, totalSold, totalWaste, totalLoss, avgWastePercent };

  const highWasteCount = wasteItems.filter(
    (i) => i.wastePercent > HIGH_WASTE_THRESHOLD && i.produced > 0,
  ).length;

  // JSON-отчёт в stdout
  const result = {
    timestamp,
    dry_run: DRY_RUN,
    summary: {
      total_produced_kg: Math.round(totalProduced * 10) / 10,
      total_sold_kg: Math.round(totalSold * 10) / 10,
      total_waste_kg: Math.round(totalWaste * 10) / 10,
      waste_percent: Math.round(avgWastePercent * 10) / 10,
      financial_loss_ars: Math.round(totalLoss),
      high_waste_products: highWasteCount,
      analysis_window_days: CURRENT_WINDOW_DAYS,
    },
    products: wasteItems
      .filter((i) => i.produced > 0)
      .map((i) => ({
        product: i.product,
        produced_kg: Math.round(i.produced * 10) / 10,
        sold_kg: Math.round(i.sold * 10) / 10,
        stock_kg: Math.round(i.stock * 10) / 10,
        waste_kg: Math.round(i.waste * 10) / 10,
        waste_percent: Math.round(i.wastePercent * 10) / 10,
        trend_delta: i.trendDelta !== null ? Math.round(i.trendDelta * 10) / 10 : null,
        avg_price_per_kg: Math.round(i.avgPricePerKg),
        financial_loss_ars: Math.round(i.financialLoss),
        recommendation: i.recommendation,
      })),
    data_sources: {
      production_rows: productionRows.length,
      sales_rows: salesRows.length,
      inventory_rows: inventoryRows.length,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  // Отправка отчёта в Telegram
  if (!DRY_RUN) {
    const report = formatTelegramReport(wasteItems, summary);
    try {
      await send(report, {
        silent: highWasteCount === 0,
        threadId: TG_THREAD_WASTE,
        parseMode: "HTML",
      });
      console.error("[waste-tracker] Отчёт отправлен в Telegram");
    } catch (err) {
      console.error(`[waste-tracker] Ошибка отправки в Telegram: ${err.message}`);
    }
  } else {
    console.error("[waste-tracker] DRY RUN: пропуск отправки Telegram");
    console.error(formatTelegramReport(wasteItems, summary));
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "waste-tracker",
    input: {
      sheets: ["Производство", "Продажи", "Склад"],
      window_days: CURRENT_WINDOW_DAYS,
      dry_run: DRY_RUN,
    },
    output: {
      total_produced_kg: totalProduced,
      total_waste_kg: totalWaste,
      waste_percent: avgWastePercent,
      financial_loss_ars: totalLoss,
      high_waste_products: highWasteCount,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "waste-tracker",
    },
  }).catch(() => {});

  console.error(
    `[waste-tracker] Завершено за ${durationMs}мс. ` +
      `Произведено: ${totalProduced.toFixed(1)} кг, потери: ${totalWaste.toFixed(1)} кг (${avgWastePercent.toFixed(1)}%), ` +
      `высокие потери: ${highWasteCount} продуктов`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[waste-tracker] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
