#!/usr/bin/env node
/**
 * Pepino Pick -- Client Outreach (proactive follow-up)
 *
 * Автоматизирует проактивное follow-up на основе churn-риска:
 *   1. Читает "🛒 Продажи" для анализа истории клиентов
 *   2. Классифицирует клиентов: active / at_risk / churned / new
 *   3. Создаёт задачи в "📋 Задачи" для at_risk (P2) и churned (P3)
 *   4. Отправляет сводку в Telegram (тред 20)
 *
 * Cron: 0 10 * * 2,5 (вт и пт 10:00)
 * Usage: node client-outreach.cjs [--dry-run]
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_ID = 20; // Стратегия/Директор

// ── Пороги ──────────────────────────────────────────────────────────────────

const DAYS_AT_RISK = 14;
const DAYS_CHURNED = 30;

// ── Утилиты ─────────────────────────────────────────────────────────────────

/** Количество дней между двумя датами */
function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

/** Формат даты YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Добавить N дней к дате, вернуть строку YYYY-MM-DD */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// ── Анализ клиентов ─────────────────────────────────────────────────────────

/**
 * Группировка продаж по клиентам и расчёт метрик.
 * @param {Array<string[]>} rows -- строки из Sheets (без заголовков)
 * @param {string[]} headers -- заголовки листа
 * @returns {Map<string, object>} карта клиентов с метриками
 */
function buildClientMap(rows, headers) {
  const iClient = headers.findIndex((h) => /клиент/i.test(h));
  const iDate = headers.findIndex((h) => /дата/i.test(h));
  const iTotal = headers.findIndex((h) => /итого\s*ars|сумма\s*ars|сумма/i.test(h));
  const iProduct = headers.findIndex((h) => /продукт|товар/i.test(h));
  const iQty = headers.findIndex((h) => /кол-во|количество/i.test(h));

  if (iClient < 0 || iDate < 0) {
    throw new Error(`Не найдены колонки Клиент/Дата. Заголовки: ${headers.join(", ")}`);
  }

  /** @type {Map<string, object>} */
  const clients = new Map();

  for (const row of rows) {
    const clientName = (row[iClient] || "").trim();
    if (!clientName || /^тест$/i.test(clientName)) continue;

    const dateStr = (row[iDate] || "").trim();
    if (!dateStr) continue;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    const total = parseFloat((row[iTotal] || "0").replace(/\s/g, "").replace(",", ".")) || 0;
    const product = iProduct >= 0 ? normalize((row[iProduct] || "").trim()) : "";
    const qty =
      iQty >= 0 ? parseFloat((row[iQty] || "0").replace(/\s/g, "").replace(",", ".")) || 0 : 0;

    if (!clients.has(clientName)) {
      clients.set(clientName, {
        name: clientName,
        orders: [],
        totalRevenue: 0,
        products: new Map(), // product -> суммарный кг
      });
    }

    const c = clients.get(clientName);
    c.orders.push({ date, total, product, qty });
    c.totalRevenue += total;
    if (product) {
      c.products.set(product, (c.products.get(product) || 0) + qty);
    }
  }

  return clients;
}

/**
 * Классификация клиентов по статусу.
 * @param {Map<string, object>} clients
 * @returns {{ active: object[], at_risk: object[], churned: object[], new_clients: object[] }}
 */
function classifyClients(clients) {
  const now = new Date();
  const result = { active: [], at_risk: [], churned: [], new_clients: [] };

  for (const [, data] of clients) {
    data.orders.sort((a, b) => a.date - b.date);
    const lastOrder = data.orders[data.orders.length - 1];
    const daysSince = daysBetween(lastOrder.date, now);
    const orderCount = data.orders.length;

    // Средняя частота заказов (в днях)
    let avgFrequency = null;
    if (orderCount >= 2) {
      const totalSpan = daysBetween(data.orders[0].date, lastOrder.date);
      avgFrequency = Math.round(totalSpan / (orderCount - 1));
    }

    // Средний чек
    const avgOrderValue = Math.round(data.totalRevenue / orderCount);

    // Топ-3 продукта по объёму
    const topProducts = [...data.products.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);

    const summary = {
      name: data.name,
      daysSinceLastOrder: daysSince,
      lastOrderDate: fmtDate(lastOrder.date),
      orderCount,
      avgFrequency,
      avgOrderValue,
      totalRevenue: Math.round(data.totalRevenue),
      topProducts,
    };

    if (orderCount === 1) {
      summary.status = "new";
      result.new_clients.push(summary);
    } else if (daysSince > DAYS_CHURNED) {
      summary.status = "churned";
      result.churned.push(summary);
    } else if (daysSince > DAYS_AT_RISK) {
      summary.status = "at_risk";
      result.at_risk.push(summary);
    } else {
      summary.status = "active";
      result.active.push(summary);
    }
  }

  // Сортировка по LTV (самые ценные первыми)
  result.at_risk.sort((a, b) => b.totalRevenue - a.totalRevenue);
  result.churned.sort((a, b) => b.totalRevenue - a.totalRevenue);

  return result;
}

// ── Задачи ──────────────────────────────────────────────────────────────────

/**
 * Проверяет, есть ли уже открытая follow-up задача для клиента.
 * @param {Array<string[]>} taskRows -- строки из "📋 Задачи" (без заголовков)
 * @param {string[]} taskHeaders
 * @param {string} clientName
 * @returns {boolean}
 */
function hasOpenTask(taskRows, taskHeaders, clientName) {
  const iTask = taskHeaders.findIndex((h) => /задача|task/i.test(h));
  const iStatus = taskHeaders.findIndex((h) => /статус|status/i.test(h));

  if (iTask < 0) return false;

  const nameLower = clientName.toLowerCase();

  for (const row of taskRows) {
    const taskText = (row[iTask] || "").toLowerCase();
    const status = (row[iStatus] || "").toLowerCase();

    // Считаем задачу открытой, если статус НЕ "выполнено"/"done"/"закрыто"
    const isClosed = /выполнен|done|закрыт|cancel/i.test(status);
    if (isClosed) continue;

    // Ищем follow-up задачу с именем клиента
    if (taskText.includes("follow-up") && taskText.includes(nameLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Генерирует строки задач для append в "📋 Задачи".
 * @param {object[]} atRisk
 * @param {object[]} churned
 * @param {Array<string[]>} taskRows
 * @param {string[]} taskHeaders
 * @returns {{ rows: string[][], created: string[] }}
 */
function generateTasks(atRisk, churned, taskRows, taskHeaders) {
  const today = fmtDate(new Date());
  const deadline = addDays(new Date(), 2);
  const rows = [];
  const created = [];

  // At-risk: P2, deadline +2 дня
  for (const client of atRisk) {
    if (hasOpenTask(taskRows, taskHeaders, client.name)) {
      continue;
    }
    const taskName = `Follow-up: ${client.name} — ${client.daysSinceLastOrder} дней без заказа`;
    rows.push([
      today, // Дата
      taskName, // Задача
      "CRM", // Категория
      "P2", // Приоритет
      deadline, // Дедлайн
      "", // Статус (пустой = новая)
      `LTV ${client.totalRevenue.toLocaleString("ru")} ARS, ` +
        `ср. чек ${client.avgOrderValue.toLocaleString("ru")} ARS, ` +
        `частота ~${client.avgFrequency || "?"}д`,
    ]);
    created.push(taskName);
  }

  // Churned: P3, deadline +2 дня, с деталями
  for (const client of churned) {
    if (hasOpenTask(taskRows, taskHeaders, client.name)) {
      continue;
    }
    const products = client.topProducts.length > 0 ? client.topProducts.join(", ") : "н/д";
    const taskName = `Follow-up: ${client.name} — ${client.daysSinceLastOrder} дней без заказа (churned)`;
    rows.push([
      today,
      taskName,
      "CRM",
      "P3",
      deadline,
      "",
      `CHURNED. Последние продукты: ${products}. ` +
        `LTV ${client.totalRevenue.toLocaleString("ru")} ARS, ` +
        `ср. заказ ${client.avgOrderValue.toLocaleString("ru")} ARS`,
    ]);
    created.push(taskName);
  }

  return { rows, created };
}

// ── Telegram-отчёт ──────────────────────────────────────────────────────────

/**
 * Формирует HTML-сводку для Telegram.
 * @param {object} classified
 * @param {string[]} tasksCreated
 * @returns {string}
 */
function formatTelegramReport(classified, tasksCreated) {
  const lines = [];
  const today = fmtDate(new Date());
  lines.push(`<b>📬 Client Outreach — ${today}</b>\n`);

  lines.push(
    `Активных: ${classified.active.length} | ` +
      `At risk: ${classified.at_risk.length} | ` +
      `Churned: ${classified.churned.length} | ` +
      `Новых: ${classified.new_clients.length}\n`,
  );

  // Топ-5 at_risk по LTV
  if (classified.at_risk.length > 0) {
    lines.push(`<b>🟡 Топ at-risk (по LTV):</b>`);
    for (const c of classified.at_risk.slice(0, 5)) {
      lines.push(
        `  ${c.name} — ${c.daysSinceLastOrder}д, ` + `${c.totalRevenue.toLocaleString("ru")} ARS`,
      );
    }
    lines.push("");
  }

  // Топ churned
  if (classified.churned.length > 0) {
    lines.push(`<b>🔴 Churned (топ-5):</b>`);
    for (const c of classified.churned.slice(0, 5)) {
      const prods = c.topProducts.length > 0 ? ` [${c.topProducts.join(", ")}]` : "";
      lines.push(
        `  ${c.name} — ${c.daysSinceLastOrder}д, ` +
          `${c.totalRevenue.toLocaleString("ru")} ARS${prods}`,
      );
    }
    lines.push("");
  }

  // Созданные задачи
  if (tasksCreated.length > 0) {
    lines.push(`<b>📝 Задачи созданы (${tasksCreated.length}):</b>`);
    for (const t of tasksCreated.slice(0, 8)) {
      lines.push(`  - ${t}`);
    }
    if (tasksCreated.length > 8) {
      lines.push(`  ...и ещё ${tasksCreated.length - 8}`);
    }
  } else {
    lines.push("Новых задач нет (все follow-up уже существуют).");
  }

  if (DRY_RUN) {
    lines.push("\n<i>[DRY RUN — задачи НЕ записаны]</i>");
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Client outreach starting...`);
  if (DRY_RUN) console.log("[DRY RUN] Задачи не будут записаны в Sheets");

  // Загрузка sheets.js (ESM из CJS)
  const { readSheet, appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");

  // 1. Чтение продаж
  const salesRows = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
  if (!salesRows || salesRows.length < 2) {
    console.log("Нет данных о продажах.");
    return;
  }
  const salesHeaders = salesRows[0];
  const salesData = salesRows.slice(1);
  console.log(`Загружено ${salesData.length} строк продаж`);

  // 2. Анализ клиентов
  const clientMap = buildClientMap(salesData, salesHeaders);
  const classified = classifyClients(clientMap);

  console.log(`Active: ${classified.active.length}`);
  console.log(`At risk: ${classified.at_risk.length}`);
  console.log(`Churned: ${classified.churned.length}`);
  console.log(`New: ${classified.new_clients.length}`);

  // 3. Чтение существующих задач (для дедупликации)
  let taskRows = [];
  let taskHeaders = [];
  try {
    const tasksData = await readSheet(PEPINO_SHEETS_ID, "📋 Задачи");
    if (tasksData && tasksData.length >= 1) {
      taskHeaders = tasksData[0];
      taskRows = tasksData.slice(1);
    }
  } catch (err) {
    console.error(`Не удалось прочитать задачи: ${err.message}`);
    // Продолжаем без дедупликации -- лучше дубль, чем пропуск
  }
  console.log(`Существующих задач: ${taskRows.length}`);

  // 4. Генерация задач
  const { rows: newTaskRows, created: tasksCreated } = generateTasks(
    classified.at_risk,
    classified.churned,
    taskRows,
    taskHeaders,
  );

  // 5. Запись задач в Sheets
  if (!DRY_RUN && newTaskRows.length > 0) {
    try {
      await appendToSheet(PEPINO_SHEETS_ID, newTaskRows, "📋 Задачи");
      console.log(`[OK] Записано ${newTaskRows.length} задач в "📋 Задачи"`);
    } catch (err) {
      console.error(`[ERROR] Запись задач: ${err.message}`);
    }
  } else if (DRY_RUN && newTaskRows.length > 0) {
    console.log(`[DRY RUN] Пропущена запись ${newTaskRows.length} задач`);
    for (const t of tasksCreated) {
      console.log(`  -> ${t}`);
    }
  }

  // 6. Telegram-отчёт
  const report = formatTelegramReport(classified, tasksCreated);
  console.log("\n" + report.replace(/<[^>]+>/g, "") + "\n");

  if (!DRY_RUN) {
    try {
      const tgResult = await sendReport(report, TG_THREAD_ID, "HTML");
      if (tgResult.ok) {
        console.log("[OK] Отчёт отправлен в Telegram");
      } else {
        console.error(`[ERROR] Telegram: ${tgResult.error}`);
      }
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  }

  // 7. Langfuse trace
  const durationMs = Date.now() - startMs;
  await trace({
    name: "client-outreach",
    input: {
      sales_count: salesData.length,
      clients_total: clientMap.size,
      dry_run: DRY_RUN,
    },
    output: {
      active: classified.active.length,
      at_risk: classified.at_risk.length,
      churned: classified.churned.length,
      new_clients: classified.new_clients.length,
      tasks_created: tasksCreated.length,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", cron: "client-outreach" },
  }).catch(() => {});

  console.log(`Done in ${durationMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
