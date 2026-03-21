#!/usr/bin/env node
/**
 * Pepino Pick — Интерактивные Telegram-команды для быстрых запросов
 *
 * Скрипт обрабатывает одну команду из CLI-аргументов и выводит
 * HTML-форматированный результат в stdout. При флаге --send
 * дополнительно отправляет в Telegram (thread 20).
 *
 * Usage:
 *   node telegram-commands.cjs status
 *   node telegram-commands.cjs stock
 *   node telegram-commands.cjs clients
 *   node telegram-commands.cjs sales [today|week|month]
 *   node telegram-commands.cjs pnl [week|month]
 *   node telegram-commands.cjs help
 *   node telegram-commands.cjs stock --send   # + отправить в Telegram
 *
 * Cron: не предназначен для cron, вызывается on-demand.
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { sendReport } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

// ── Конфигурация ──────────────────────────────────────────────────────────────

const TG_THREAD_COMMANDS = 20; // Стратегия/Директор
const LOGS_DIR = "/home/roman/logs";

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** Безопасное извлечение числа из строки (запятые, пробелы, валютные знаки) */
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
 * Парсит дату из строки. Форматы: DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD
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

/** Начало текущего дня */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Форматирует число с разделителем тысяч */
function fmtNum(n, decimals = 0) {
  return n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Преобразует массив строк из Sheets в массив объектов (первая строка -- заголовки)
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

/** Текущее время в аргентинском часовом поясе */
function nowArgentina() {
  return new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });
}

// ── Динамический импорт sheets.js (ESM из CJS) ───────────────────────────────

/** @returns {Promise<{readSheet: Function, PEPINO_SHEETS_ID: string}>} */
async function loadSheets() {
  try {
    const mod = await import("./sheets.js");
    return { readSheet: mod.readSheet, PEPINO_SHEETS_ID: mod.PEPINO_SHEETS_ID };
  } catch (err) {
    throw new Error(`Не удалось импортировать sheets.js: ${err.message}`);
  }
}

// ── Команда: help ─────────────────────────────────────────────────────────────

function cmdHelp() {
  const lines = [
    "<b>Pepino Pick -- Telegram Commands</b>",
    "",
    "<code>status</code>  -- Здоровье системы (контейнеры, cron, RAM/диск)",
    "<code>stock</code>   -- Остатки склада с days-of-stock",
    "<code>clients</code> -- Обзор клиентов (активные / at risk / churned)",
    "<code>sales [today|week|month]</code> -- Сводка продаж за период",
    "<code>pnl [week|month]</code> -- P&amp;L за период",
    "<code>help</code>    -- Этот список команд",
    "",
    "Добавь <code>--send</code> для отправки в Telegram.",
  ];
  return lines.join("\n");
}

// ── Команда: status ───────────────────────────────────────────────────────────

function cmdStatus() {
  const lines = [];
  lines.push(`<b>System Status</b>`);
  lines.push(`${nowArgentina()}\n`);

  // Контейнеры Docker
  let containerCount = 0;
  let containerDetails = "";
  try {
    const raw = execSync("docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null", {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (raw) {
      const containers = raw.split("\n");
      containerCount = containers.length;
      containerDetails = containers
        .slice(0, 8)
        .map((c) => {
          const [name, ...statusParts] = c.split("\t");
          const status = statusParts.join(" ");
          const icon = status.toLowerCase().includes("up") ? "ok" : "ERR";
          return `  [${icon}] ${name}`;
        })
        .join("\n");
    }
  } catch {
    containerDetails = "  Docker не доступен";
  }
  lines.push(`<b>Docker:</b> ${containerCount} контейнеров`);
  if (containerDetails) lines.push(`<code>${containerDetails}</code>`);

  // Последние 3 cron-выполнения из логов
  lines.push("");
  lines.push("<b>Последние cron-задачи:</b>");
  const logFiles = [
    "pepino-morning-brief.log",
    "daily-pnl.log",
    "inventory-tracker.log",
    "churn-detector.log",
    "sync-sheets.log",
    "data-completeness.log",
  ];

  /** @type {Array<{name: string, time: string, status: string}>} */
  const cronRuns = [];

  for (const logFile of logFiles) {
    const logPath = path.join(LOGS_DIR, logFile);
    try {
      if (!fs.existsSync(logPath)) continue;
      const stat = fs.statSync(logPath);
      if (stat.size === 0) continue;

      // Читаем последние 2KB лога для определения статуса
      const fd = fs.openSync(logPath, "r");
      const bufSize = Math.min(stat.size, 2048);
      const buf = Buffer.alloc(bufSize);
      fs.readSync(fd, buf, 0, bufSize, Math.max(0, stat.size - bufSize));
      fs.closeSync(fd);
      const tail = buf.toString("utf8");

      const hasError = /(?:error|fail|fatal|ошибка)/i.test(tail);
      const scriptName = logFile.replace(".log", "");
      const mtime = stat.mtime.toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });

      cronRuns.push({
        name: scriptName,
        time: mtime,
        status: hasError ? "ERR" : "OK",
      });
    } catch {
      // Пропускаем недоступные логи
    }
  }

  // Сортируем по времени модификации (новейшие первые) и берём 3
  cronRuns.sort((a, b) => b.time.localeCompare(a.time));
  const top3 = cronRuns.slice(0, 3);

  if (top3.length === 0) {
    lines.push("  Логи не найдены");
  } else {
    for (const run of top3) {
      const icon = run.status === "OK" ? "ok" : "!!!";
      lines.push(`  [${icon}] <b>${run.name}</b> -- ${run.time}`);
    }
  }

  // RAM
  lines.push("");
  try {
    const memRaw = execSync("free -m 2>/dev/null", { encoding: "utf8", timeout: 5000 });
    const memMatch = memRaw.match(/Mem:\s+(\d+)\s+(\d+)/);
    if (memMatch) {
      const totalMb = parseInt(memMatch[1], 10);
      const usedMb = parseInt(memMatch[2], 10);
      const pct = Math.round((usedMb / totalMb) * 100);
      const icon = pct > 85 ? "!!!" : pct > 70 ? "!" : "ok";
      lines.push(`<b>RAM:</b> [${icon}] ${fmtNum(usedMb)} / ${fmtNum(totalMb)} MB (${pct}%)`);
    }
  } catch {
    lines.push("<b>RAM:</b> н/д");
  }

  // Диск
  try {
    const dfRaw = execSync("df -h / 2>/dev/null | tail -1", { encoding: "utf8", timeout: 5000 });
    const dfParts = dfRaw.trim().split(/\s+/);
    if (dfParts.length >= 5) {
      const usedPct = parseInt(dfParts[4], 10);
      const icon = usedPct > 90 ? "!!!" : usedPct > 75 ? "!" : "ok";
      lines.push(`<b>Disk:</b> [${icon}] ${dfParts[2]} / ${dfParts[1]} (${dfParts[4]})`);
    }
  } catch {
    lines.push("<b>Disk:</b> н/д");
  }

  // Неразрешённые алерты (проверяем лог-файлы с ошибками)
  const unresolvedCount = cronRuns.filter((r) => r.status === "ERR").length;
  if (unresolvedCount > 0) {
    lines.push(`\n<b>Алерты:</b> ${unresolvedCount} скриптов с ошибками`);
  } else {
    lines.push("\n<b>Алерты:</b> нет");
  }

  return lines.join("\n");
}

// ── Команда: stock ────────────────────────────────────────────────────────────

async function cmdStock() {
  const { readSheet, PEPINO_SHEETS_ID } = await loadSheets();

  const [inventoryRaw, salesRaw] = await Promise.all([
    readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} Склад"),
    readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи"),
  ]);

  const inventoryRows = rowsToObjects(inventoryRaw);
  const salesRows = rowsToObjects(salesRaw);

  // Текущие остатки
  /** @type {Map<string, number>} */
  const stock = new Map();
  for (const row of inventoryRows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Название"] || "").trim();
    const qty = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );
    if (!rawProduct) continue;
    const key = normalize(rawProduct);
    stock.set(key, (stock.get(key) || 0) + qty);
  }

  // Среднее потребление за 7 дней
  const windowDays = 7;
  const cutoff = daysAgo(windowDays);
  /** @type {Map<string, number>} */
  const totalSold = new Map();
  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;
    const product = normalize(row["Продукт"] || row["Товар"] || "");
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);
    if (!product || qty <= 0) continue;
    totalSold.set(product, (totalSold.get(product) || 0) + qty);
  }

  // Собираем данные
  const allProducts = new Set([...stock.keys(), ...totalSold.keys()]);
  /** @type {Array<{product: string, qty: number, daysOfStock: number|null, status: string}>} */
  const items = [];

  for (const product of allProducts) {
    const qty = stock.get(product) || 0;
    const sold = totalSold.get(product) || 0;
    const avgDaily = sold / windowDays;

    let daysOfStock = null;
    if (avgDaily > 0) {
      daysOfStock = qty / avgDaily;
    }

    let status = "ok";
    if (daysOfStock !== null) {
      if (daysOfStock < 3) status = "critical";
      else if (daysOfStock < 7) status = "warning";
    } else if (qty <= 0 && sold > 0) {
      status = "critical";
    }

    items.push({ product, qty, daysOfStock, status });
  }

  // Сортировка: критичные первыми
  const order = { critical: 0, warning: 1, ok: 2 };
  items.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (a.daysOfStock ?? 9999) - (b.daysOfStock ?? 9999);
  });

  // Формирование отчёта
  const statusEmoji = { critical: "\u{1F534}", warning: "\u{1F7E1}", ok: "\u{1F7E2}" };
  const lines = [];
  lines.push(`<b>Склад Pepino Pick</b>`);
  lines.push(`${nowArgentina()}\n`);

  for (const item of items) {
    const emoji = statusEmoji[item.status];
    const daysStr = item.daysOfStock !== null ? `${item.daysOfStock.toFixed(1)} дн.` : "--";
    lines.push(`${emoji} <b>${item.product}</b>: ${item.qty.toFixed(1)} кг | ${daysStr}`);
  }

  const counts = {
    critical: items.filter((i) => i.status === "critical").length,
    warning: items.filter((i) => i.status === "warning").length,
    ok: items.filter((i) => i.status === "ok").length,
  };
  lines.push("");
  lines.push(`<b>Итого:</b> ${items.length} позиций`);
  if (counts.critical > 0) lines.push(`  \u{1F534} Критично: ${counts.critical}`);
  if (counts.warning > 0) lines.push(`  \u{1F7E1} Внимание: ${counts.warning}`);
  lines.push(`  \u{1F7E2} ОК: ${counts.ok}`);

  return lines.join("\n");
}

// ── Команда: clients ──────────────────────────────────────────────────────────

async function cmdClients() {
  const { readSheet, PEPINO_SHEETS_ID } = await loadSheets();
  const salesRaw = await readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи");
  const salesRows = rowsToObjects(salesRaw);

  const now = new Date();

  // Собираем данные по клиентам
  /** @type {Map<string, {lastDate: Date, orderCount: number, totalRevenue: number}>} */
  const clients = new Map();

  for (const row of salesRows) {
    const client = (row["Клиент"] || row["Покупатель"] || row["Cliente"] || "").trim();
    if (!client) continue;

    const saleDate = parseDate(row["Дата"]);
    if (!saleDate) continue;

    const revenue = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);

    const existing = clients.get(client);
    if (!existing) {
      clients.set(client, { lastDate: saleDate, orderCount: 1, totalRevenue: revenue });
    } else {
      if (saleDate > existing.lastDate) existing.lastDate = saleDate;
      existing.orderCount++;
      existing.totalRevenue += revenue;
    }
  }

  // Классификация
  let active = 0;
  let atRisk = 0;
  let churned = 0;
  /** @type {Array<{name: string, daysSince: number, orderCount: number, totalRevenue: number, status: string}>} */
  const clientList = [];

  for (const [name, data] of clients) {
    const daysSince = Math.floor((now.getTime() - data.lastDate.getTime()) / (1000 * 60 * 60 * 24));
    let status = "active";
    if (daysSince > 30) {
      status = "churned";
      churned++;
    } else if (daysSince > 14) {
      status = "at_risk";
      atRisk++;
    } else {
      active++;
    }
    clientList.push({
      name,
      daysSince,
      orderCount: data.orderCount,
      totalRevenue: data.totalRevenue,
      status,
    });
  }

  // Сортировка: активные по недавности
  clientList.sort((a, b) => a.daysSince - b.daysSince);

  const lines = [];
  lines.push(`<b>Клиенты Pepino Pick</b>`);
  lines.push(`${nowArgentina()}\n`);

  lines.push(`\u{1F7E2} Активные: <b>${active}</b>`);
  lines.push(`\u{1F7E1} At risk (>14 дн.): <b>${atRisk}</b>`);
  lines.push(`\u{1F534} Churned (>30 дн.): <b>${churned}</b>`);
  lines.push(`Всего: <b>${clients.size}</b>\n`);

  // Топ-5 по недавней активности
  lines.push("<b>Топ-5 по активности:</b>");
  const top5 = clientList.slice(0, 5);
  for (let i = 0; i < top5.length; i++) {
    const c = top5[i];
    const statusEmoji =
      c.status === "active" ? "\u{1F7E2}" : c.status === "at_risk" ? "\u{1F7E1}" : "\u{1F534}";
    lines.push(
      `${i + 1}. ${statusEmoji} <b>${c.name}</b> -- ${c.daysSince} дн. назад, ` +
        `${c.orderCount} заказов, ${fmtNum(c.totalRevenue)} ARS`,
    );
  }

  // At risk клиенты
  const atRiskClients = clientList.filter((c) => c.status === "at_risk");
  if (atRiskClients.length > 0) {
    lines.push("\n<b>At risk:</b>");
    for (const c of atRiskClients) {
      lines.push(`  \u{1F7E1} ${c.name} -- ${c.daysSince} дн. без заказа`);
    }
  }

  return lines.join("\n");
}

// ── Команда: sales ────────────────────────────────────────────────────────────

async function cmdSales(period = "today") {
  const { readSheet, PEPINO_SHEETS_ID } = await loadSheets();
  const salesRaw = await readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи");
  const salesRows = rowsToObjects(salesRaw);

  // Определяем временное окно
  let cutoff;
  let periodLabel;
  switch (period) {
    case "week":
      cutoff = daysAgo(7);
      periodLabel = "за неделю";
      break;
    case "month":
      cutoff = daysAgo(30);
      periodLabel = "за месяц";
      break;
    case "today":
    default:
      cutoff = todayStart();
      periodLabel = "за сегодня";
      break;
  }

  // Фильтрация и агрегация
  let totalRevenue = 0;
  let orderCount = 0;
  /** @type {Map<string, {qty: number, revenue: number}>} */
  const byProduct = new Map();
  /** @type {Set<string>} уникальные заказы (дата+клиент) */
  const uniqueOrders = new Set();

  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;

    const revenue = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);
    const product = normalize(row["Продукт"] || row["Товар"] || "");
    const client = (row["Клиент"] || row["Покупатель"] || "").trim();

    totalRevenue += revenue;

    // Уникальный заказ = дата + клиент
    const orderKey = `${saleDate.toISOString().slice(0, 10)}_${client}`;
    uniqueOrders.add(orderKey);

    if (product) {
      const existing = byProduct.get(product) || { qty: 0, revenue: 0 };
      existing.qty += qty;
      existing.revenue += revenue;
      byProduct.set(product, existing);
    }
  }

  orderCount = uniqueOrders.size;
  const avgOrderSize = orderCount > 0 ? totalRevenue / orderCount : 0;

  // Топ продукты по объёму
  const productList = [...byProduct.entries()]
    .map(([name, data]) => ({ name, qty: data.qty, revenue: data.revenue }))
    .sort((a, b) => b.qty - a.qty);

  const lines = [];
  lines.push(`<b>Продажи Pepino Pick</b> (${periodLabel})`);
  lines.push(`${nowArgentina()}\n`);

  lines.push(`<b>Выручка:</b> ${fmtNum(totalRevenue)} ARS`);
  lines.push(`<b>Заказов:</b> ${orderCount}`);
  lines.push(`<b>Средний чек:</b> ${fmtNum(avgOrderSize)} ARS\n`);

  if (productList.length > 0) {
    lines.push("<b>Топ продукты (по объёму):</b>");
    const top = productList.slice(0, 7);
    for (const p of top) {
      lines.push(`  ${p.name}: ${p.qty.toFixed(1)} кг | ${fmtNum(p.revenue)} ARS`);
    }
  } else {
    lines.push("<i>Нет продаж за указанный период</i>");
  }

  return lines.join("\n");
}

// ── Команда: pnl ──────────────────────────────────────────────────────────────

async function cmdPnl(period = "week") {
  const { readSheet, PEPINO_SHEETS_ID } = await loadSheets();

  const [salesRaw, expensesRaw] = await Promise.all([
    readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи"),
    readSheet(PEPINO_SHEETS_ID, "\u{1F4B0} Расходы"),
  ]);

  const salesRows = rowsToObjects(salesRaw);
  const expensesRows = rowsToObjects(expensesRaw);

  // Определяем период
  let cutoff;
  let periodLabel;
  switch (period) {
    case "month":
      cutoff = daysAgo(30);
      periodLabel = "за месяц";
      break;
    case "week":
    default:
      cutoff = daysAgo(7);
      periodLabel = "за неделю";
      break;
  }

  // Выручка
  let totalRevenue = 0;
  /** @type {Map<string, number>} выручка по продуктам */
  const revenueByProduct = new Map();

  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;

    const revenue = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
    const product = normalize(row["Продукт"] || row["Товар"] || "");

    totalRevenue += revenue;
    if (product) {
      revenueByProduct.set(product, (revenueByProduct.get(product) || 0) + revenue);
    }
  }

  // Расходы
  let totalExpenses = 0;
  /** @type {Map<string, number>} расходы по категориям */
  const expenseByCategory = new Map();

  for (const row of expensesRows) {
    const expDate = parseDate(row["Дата"]);
    if (!expDate || expDate < cutoff) continue;

    const amount = parseNum(row["Сумма ARS"] || row["Сумма"] || row["Итого ARS"] || 0);
    const category = (row["Категория"] || row["Тип"] || "Прочее").trim();

    totalExpenses += amount;
    expenseByCategory.set(category, (expenseByCategory.get(category) || 0) + amount);
  }

  // P&L
  const profit = totalRevenue - totalExpenses;
  const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

  const lines = [];
  lines.push(`<b>P&amp;L Pepino Pick</b> (${periodLabel})`);
  lines.push(`${nowArgentina()}\n`);

  lines.push(`<b>Выручка:</b> ${fmtNum(totalRevenue)} ARS`);
  lines.push(`<b>Расходы:</b> ${fmtNum(totalExpenses)} ARS`);
  lines.push(`<b>Прибыль:</b> ${fmtNum(profit)} ARS`);

  const marginIcon = margin < 35 ? "\u{1F534}" : margin < 50 ? "\u{1F7E1}" : "\u{1F7E2}";
  lines.push(`<b>Маржа:</b> ${marginIcon} ${margin.toFixed(1)}%`);

  // Предупреждение если расходы не внесены
  if (totalExpenses === 0 && totalRevenue > 0) {
    lines.push("\n<i>Расходы не внесены за этот период -- маржа может быть завышена</i>");
  }

  // Топ расходы по категориям
  if (expenseByCategory.size > 0) {
    lines.push("\n<b>Расходы по категориям:</b>");
    const categories = [...expenseByCategory.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, amount] of categories.slice(0, 5)) {
      const pct = totalExpenses > 0 ? ((amount / totalExpenses) * 100).toFixed(0) : 0;
      lines.push(`  ${cat}: ${fmtNum(amount)} ARS (${pct}%)`);
    }
  }

  // Топ продукты по выручке
  if (revenueByProduct.size > 0) {
    lines.push("\n<b>Выручка по продуктам:</b>");
    const products = [...revenueByProduct.entries()].sort((a, b) => b[1] - a[1]);
    for (const [prod, rev] of products.slice(0, 5)) {
      lines.push(`  ${prod}: ${fmtNum(rev)} ARS`);
    }
  }

  return lines.join("\n");
}

// ── Маршрутизация команд ──────────────────────────────────────────────────────

async function main() {
  // Парсим аргументы: node telegram-commands.cjs <command> [args...] [--send]
  const args = process.argv.slice(2).filter((a) => a !== "--send");
  const shouldSend = process.argv.includes("--send");
  const command = (args[0] || "help").toLowerCase();
  const subArg = (args[1] || "").toLowerCase();

  /** @type {string} */
  let result;

  try {
    switch (command) {
      case "help":
        result = cmdHelp();
        break;
      case "status":
        result = cmdStatus();
        break;
      case "stock":
        result = await cmdStock();
        break;
      case "clients":
        result = await cmdClients();
        break;
      case "sales":
        result = await cmdSales(subArg || "today");
        break;
      case "pnl":
        result = await cmdPnl(subArg || "week");
        break;
      default:
        result = `Неизвестная команда: <code>${command}</code>\n\n${cmdHelp()}`;
        break;
    }
  } catch (err) {
    result = `<b>Ошибка при выполнении команды "${command}":</b>\n<code>${err.message}</code>`;
    console.error(`[telegram-commands] ${err.stack || err.message}`);
  }

  // Вывод в stdout
  console.log(result);

  // Отправка в Telegram при --send
  if (shouldSend) {
    try {
      const res = await sendReport(result, TG_THREAD_COMMANDS, "HTML");
      if (res.ok) {
        console.error(`[telegram-commands] Отправлено в Telegram (msg #${res.messageId})`);
      } else {
        console.error(`[telegram-commands] Ошибка Telegram: ${res.error}`);
      }
    } catch (err) {
      console.error(`[telegram-commands] Ошибка отправки: ${err.message}`);
    }
  }
}

// ── Запуск ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[telegram-commands] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
