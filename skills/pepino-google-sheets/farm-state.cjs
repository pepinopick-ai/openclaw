#!/usr/bin/env node
/**
 * farm-state.cjs — Единый кеш состояния фермы Pepino Pick
 *
 * Проблема: 10+ скриптов читают одни и те же листы Google Sheets,
 *           генерируя 30+ API-вызовов за утренний цикл.
 *
 * Решение: один JSON-файл с TTL=15 мин, обновляемый по cron.
 *          Все скрипты читают кеш вместо прямых вызовов API.
 *
 * Файл состояния: /tmp/pepino-farm-state.json
 *
 * CLI:
 *   node farm-state.cjs refresh          — принудительное обновление
 *   node farm-state.cjs refresh --quiet  — без вывода в stderr
 *
 * API:
 *   const { getState, getClients, getProducts, getFinancials, getStock, refresh }
 *     = require("./farm-state.cjs");
 *
 * Cron: *\/15 * * * * /usr/bin/node /path/to/farm-state.cjs refresh
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { normalize } = require("./product-aliases.cjs");

// -- Константы ----------------------------------------------------------------

const STATE_FILE = "/tmp/pepino-farm-state.json";
const STATE_FILE_TMP = "/tmp/pepino-farm-state.json.tmp";
const TTL_MINUTES = parseInt(process.env.FARM_STATE_TTL, 10) || 15;
const EXCHANGE_RATES_FILE = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  ".exchange-rates.json",
);

/** Листы для загрузки: ключ в state → имя листа в Google Sheets */
const SHEET_MAP = {
  sales: "\u{1F6D2} Продажи",
  production: "\u{1F33F} Производство",
  expenses: "\u{1F4B0} Расходы",
  inventory: "\u{1F4E6} Склад",
  tasks: "\u{1F4CB} Задачи",
  alerts: "\u26A0\uFE0F Алерты",
};

// -- Утилиты ------------------------------------------------------------------

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
 * Поддержка: DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD
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

/** Форматирует Date как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Преобразует массив строк из Sheets в массив объектов.
 * Первая строка — заголовки.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  /** @type {Record<string, string>[]} */
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    /** @type {Record<string, string>} */
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i]?.[j] ?? "";
    }
    result.push(obj);
  }
  return result;
}

/**
 * Атомарная запись файла: пишем во временный, затем rename.
 * @param {string} filePath
 * @param {string} content
 */
function atomicWriteSync(filePath, content) {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Загружает курсы валют из файла обменных курсов.
 * @returns {{ blue_buy: number, blue_sell: number } | null}
 */
function loadExchangeRates() {
  try {
    const raw = fs.readFileSync(EXCHANGE_RATES_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      blue_buy: data.blue_buy || 0,
      blue_sell: data.blue_sell || 0,
    };
  } catch {
    return null;
  }
}

// -- Аналитика ----------------------------------------------------------------

/**
 * Рассчитывает аналитику по клиентам на основе продаж.
 * @param {Record<string, string>[]} salesRows
 * @returns {Record<string, { orders: number, total: number, last: string, status: string }>}
 */
function computeClients(salesRows) {
  /** @type {Record<string, { orders: number, total: number, last: string, lastDate: Date|null }>} */
  const map = {};
  const now = new Date();

  for (const row of salesRows) {
    const client = (row["Клиент"] || row["Cliente"] || "").trim();
    if (!client) continue;

    const total = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
    const dateRaw = row["Дата"] || row["Fecha"] || "";
    const date = parseDate(dateRaw);

    if (!map[client]) {
      map[client] = { orders: 0, total: 0, last: "", lastDate: null };
    }
    map[client].orders += 1;
    map[client].total += total;

    if (date && (!map[client].lastDate || date > map[client].lastDate)) {
      map[client].lastDate = date;
      map[client].last = fmtDate(date);
    }
  }

  // Определяем статус клиента
  /** @type {Record<string, { orders: number, total: number, last: string, status: string }>} */
  const result = {};
  for (const [client, data] of Object.entries(map)) {
    let status = "active";
    if (data.lastDate) {
      const daysSince = Math.floor(
        (now.getTime() - data.lastDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysSince > 30) status = "churned";
      else if (daysSince > 14) status = "at_risk";
    }
    result[client] = {
      orders: data.orders,
      total: data.total,
      last: data.last,
      status,
    };
  }

  return result;
}

/**
 * Рассчитывает аналитику по продуктам (нормализованные имена).
 * @param {Record<string, string>[]} salesRows
 * @returns {Record<string, { kg: number, ars: number, avg_price: number }>}
 */
function computeProducts(salesRows) {
  /** @type {Record<string, { kg: number, ars: number }>} */
  const map = {};

  for (const row of salesRows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Producto"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);

    const kg = parseNum(row["Кол-во кг"] || row["Cantidad kg"] || row["Кг"] || 0);
    const ars = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);

    if (!map[product]) {
      map[product] = { kg: 0, ars: 0 };
    }
    map[product].kg += kg;
    map[product].ars += ars;
  }

  /** @type {Record<string, { kg: number, ars: number, avg_price: number }>} */
  const result = {};
  for (const [product, data] of Object.entries(map)) {
    result[product] = {
      kg: Math.round(data.kg * 100) / 100,
      ars: Math.round(data.ars),
      avg_price: data.kg > 0 ? Math.round(data.ars / data.kg) : 0,
    };
  }

  return result;
}

/**
 * Рассчитывает финансовые показатели за неделю и месяц.
 * @param {Record<string, string>[]} salesRows
 * @param {Record<string, string>[]} expenseRows
 * @returns {{ week: { revenue: number, expenses: number, margin: number }, month: { revenue: number, expenses: number, margin: number } }}
 */
function computeFinancials(salesRows, expenseRows) {
  const now = new Date();

  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);

  const monthAgo = new Date(now);
  monthAgo.setDate(monthAgo.getDate() - 30);
  monthAgo.setHours(0, 0, 0, 0);

  let weekRevenue = 0;
  let monthRevenue = 0;
  for (const row of salesRows) {
    const date = parseDate(row["Дата"] || row["Fecha"] || "");
    if (!date) continue;
    const amount = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
    if (date >= weekAgo) weekRevenue += amount;
    if (date >= monthAgo) monthRevenue += amount;
  }

  let weekExpenses = 0;
  let monthExpenses = 0;
  for (const row of expenseRows) {
    const date = parseDate(row["Дата"] || row["Fecha"] || "");
    if (!date) continue;
    const amount = parseNum(row["Сумма"] || row["Сумма ARS"] || row["Monto"] || 0);
    if (date >= weekAgo) weekExpenses += amount;
    if (date >= monthAgo) monthExpenses += amount;
  }

  /**
   * Маржа: (revenue - expenses) / revenue. Если revenue = 0, маржа = 0.
   * @param {number} rev
   * @param {number} exp
   * @returns {number}
   */
  function margin(rev, exp) {
    if (rev <= 0) return 0;
    return Math.round(((rev - exp) / rev) * 100) / 100;
  }

  return {
    week: {
      revenue: Math.round(weekRevenue),
      expenses: Math.round(weekExpenses),
      margin: margin(weekRevenue, weekExpenses),
    },
    month: {
      revenue: Math.round(monthRevenue),
      expenses: Math.round(monthExpenses),
      margin: margin(monthRevenue, monthExpenses),
    },
  };
}

/**
 * Рассчитывает аналитику склада: остатки, days-of-stock по среднему расходу за 7 дней.
 * @param {Record<string, string>[]} inventoryRows
 * @param {Record<string, string>[]} salesRows
 * @returns {Record<string, { kg: number, days: number, status: string }>}
 */
function computeStock(inventoryRows, salesRows) {
  // Текущие остатки
  /** @type {Map<string, number>} */
  const stockMap = new Map();
  for (const row of inventoryRows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Название"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const qty = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );
    stockMap.set(product, (stockMap.get(product) || 0) + qty);
  }

  // Среднее потребление за 7 дней
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);

  /** @type {Map<string, number>} */
  const consumption7d = new Map();
  for (const row of salesRows) {
    const date = parseDate(row["Дата"] || row["Fecha"] || "");
    if (!date || date < weekAgo) continue;
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Producto"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const kg = parseNum(row["Кол-во кг"] || row["Cantidad kg"] || row["Кг"] || 0);
    consumption7d.set(product, (consumption7d.get(product) || 0) + kg);
  }

  /** @type {Record<string, { kg: number, days: number, status: string }>} */
  const result = {};

  // Объединяем все продукты (из склада + из продаж за неделю)
  const allProducts = new Set([...stockMap.keys(), ...consumption7d.keys()]);

  for (const product of allProducts) {
    const kg = stockMap.get(product) || 0;
    const weeklyConsumption = consumption7d.get(product) || 0;
    const dailyConsumption = weeklyConsumption / 7;

    let days = 0;
    if (dailyConsumption > 0) {
      days = Math.round((kg / dailyConsumption) * 10) / 10;
    } else if (kg > 0) {
      // Есть запас, но нет потребления — бесконечный запас
      days = 999;
    }

    let status = "ok";
    if (days < 3) status = "critical";
    else if (days < 7) status = "warning";

    result[product] = {
      kg: Math.round(kg * 100) / 100,
      days,
      status,
    };
  }

  return result;
}

// -- Обновление состояния -----------------------------------------------------

/**
 * Читает все листы из Google Sheets, рассчитывает аналитику,
 * сохраняет в /tmp/pepino-farm-state.json.
 * @param {{ quiet?: boolean }} [options]
 * @returns {Promise<object>} полный объект состояния
 */
async function refresh(options = {}) {
  const { quiet = false } = options;
  const startTime = Date.now();

  if (!quiet) {
    console.error(`[farm-state] Обновление кеша...`);
  }

  // Динамический импорт ESM-модуля sheets.js из CJS
  /** @type {{ readSheet: Function }} */
  let readSheet;
  /** @type {string} */
  let PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    throw new Error(`Не удалось импортировать sheets.js: ${err.message}`);
  }

  // Параллельное чтение всех листов
  /** @type {Record<string, string[][]>} */
  const rawData = {};
  const entries = Object.entries(SHEET_MAP);
  const promises = entries.map(([key, sheetName]) =>
    readSheet(PEPINO_SHEETS_ID, sheetName)
      .then((/** @type {string[][]} */ rows) => {
        rawData[key] = rows;
      })
      .catch((/** @type {Error} */ err) => {
        // Лист может не существовать — не блокируем весь refresh
        if (!quiet) {
          console.error(`[farm-state] Ошибка чтения листа "${sheetName}": ${err.message}`);
        }
        rawData[key] = [];
      }),
  );
  await Promise.all(promises);

  // Преобразование в объекты
  const salesRows = rowsToObjects(rawData.sales);
  const productionRows = rowsToObjects(rawData.production);
  const expenseRows = rowsToObjects(rawData.expenses);
  const inventoryRows = rowsToObjects(rawData.inventory);

  // Рассчёт аналитики
  const clients = computeClients(salesRows);
  const products = computeProducts(salesRows);
  const financials = computeFinancials(salesRows, expenseRows);
  const stock = computeStock(inventoryRows, salesRows);

  // Курсы валют
  const exchangeRate = loadExchangeRates() || { blue_buy: 0, blue_sell: 0 };

  // Формируем объект состояния
  const state = {
    refreshed_at: new Date().toISOString(),
    ttl_minutes: TTL_MINUTES,

    // Сырые строки (уже как объекты)
    sales: salesRows,
    production: productionRows,
    expenses: expenseRows,
    inventory: inventoryRows,
    tasks: rowsToObjects(rawData.tasks),
    alerts: rowsToObjects(rawData.alerts),

    // Предрассчитанная аналитика
    analytics: {
      clients,
      products,
      financial: financials,
      stock,
    },

    exchange_rate: exchangeRate,
  };

  // Атомарная запись
  try {
    atomicWriteSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    throw new Error(`Не удалось записать ${STATE_FILE}: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  const sheetCounts = entries.map(([k]) => `${k}=${(rawData[k] || []).length}`).join(", ");
  if (!quiet) {
    console.error(`[farm-state] Готово за ${elapsed}ms. Строки: ${sheetCounts}`);
    console.error(
      `[farm-state] Клиенты: ${Object.keys(clients).length}, продукты: ${Object.keys(products).length}`,
    );
  }

  return state;
}

// -- Чтение кеша --------------------------------------------------------------

/**
 * Проверяет, актуален ли кеш (файл существует и не старше TTL).
 * @returns {boolean}
 */
function isCacheFresh() {
  try {
    const stat = fs.statSync(STATE_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < TTL_MINUTES * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Читает кеш из файла. Возвращает null если файл не существует или невалидный.
 * @returns {object|null}
 */
function readCache() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Возвращает полное состояние фермы.
 * Если кеш отсутствует или устарел — автоматически обновляет.
 * @returns {Promise<object>}
 */
async function getState() {
  if (isCacheFresh()) {
    const cached = readCache();
    if (cached) return cached;
  }
  // Кеш устарел или повреждён — обновляем
  return refresh({ quiet: true });
}

/**
 * Возвращает аналитику по клиентам.
 * @returns {Promise<Record<string, { orders: number, total: number, last: string, status: string }>>}
 */
async function getClients() {
  const state = await getState();
  return state.analytics?.clients || {};
}

/**
 * Возвращает аналитику по продуктам.
 * @returns {Promise<Record<string, { kg: number, ars: number, avg_price: number }>>}
 */
async function getProducts() {
  const state = await getState();
  return state.analytics?.products || {};
}

/**
 * Возвращает финансовые показатели (неделя/месяц).
 * @returns {Promise<{ week: object, month: object }>}
 */
async function getFinancials() {
  const state = await getState();
  return state.analytics?.financial || { week: {}, month: {} };
}

/**
 * Возвращает аналитику склада.
 * @returns {Promise<Record<string, { kg: number, days: number, status: string }>>}
 */
async function getStock() {
  const state = await getState();
  return state.analytics?.stock || {};
}

// -- CLI ----------------------------------------------------------------------

if (require.main === module) {
  const command = process.argv[2];
  const quiet = process.argv.includes("--quiet");

  if (command === "refresh") {
    refresh({ quiet })
      .then((state) => {
        if (!quiet) {
          const clientCount = Object.keys(state.analytics?.clients || {}).length;
          const productCount = Object.keys(state.analytics?.products || {}).length;
          const fin = state.analytics?.financial?.month || {};
          console.error(`[farm-state] Итого: ${clientCount} клиентов, ${productCount} продуктов`);
          console.error(
            `[farm-state] Месяц: выручка ${fin.revenue?.toLocaleString("ru") || 0} ARS, ` +
              `расходы ${fin.expenses?.toLocaleString("ru") || 0} ARS, ` +
              `маржа ${Math.round((fin.margin || 0) * 100)}%`,
          );
        }
      })
      .catch((err) => {
        console.error(`[farm-state] ОШИБКА: ${err.message}`);
        process.exit(1);
      });
  } else {
    console.error("Usage: node farm-state.cjs refresh [--quiet]");
    console.error("");
    console.error("  refresh        Обновить кеш из Google Sheets");
    console.error("  --quiet        Без вывода в stderr");
    process.exit(1);
  }
}

// -- Экспорт ------------------------------------------------------------------

module.exports = {
  getState,
  getClients,
  getProducts,
  getFinancials,
  getStock,
  refresh,
  // Утилиты (для тестов и переиспользования)
  parseNum,
  parseDate,
  fmtDate,
  rowsToObjects,
  isCacheFresh,
  STATE_FILE,
  TTL_MINUTES,
};
