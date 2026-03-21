#!/usr/bin/env node
/**
 * Pepino Pick — Daily Operations Checklist Generator
 *
 * Генерирует ежедневный чеклист для оператора теплицы на основе данных:
 *   1. Утренний обход — контроль микроклимата, осмотр растений, полив/фертигация
 *   2. Сборка заказов — заказы на сегодня, продукты, качество, холодовая цепь
 *   3. Доставка — маршрут, адреса, количества
 *   4. Текущие задачи — открытые задачи по приоритету, просроченные, алерты
 *   5. Вечерний отчёт — что залогировать, пробелы в данных
 *
 * Источники данных (Google Sheets):
 *   - "🌿 Производство" — посадки, урожай, стадии роста
 *   - "🛒 Продажи" — заказы на сегодня
 *   - "📦 Склад" — текущие остатки
 *   - "📋 Задачи" — открытые задачи
 *   - "⚠️ Алерты" — нерешённые алерты
 *
 * Cron: 45 6 * * * (ежедневно 06:45, после delivery-optimizer, до morning brief)
 * Usage: node daily-ops-checklist.cjs [--dry-run] [--telegram]
 */

"use strict";

const http = require("http");
const { trace } = require("./langfuse-trace.cjs");
const { send, sendReport } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");
const { apiHeaders } = require("./api-auth.cjs");

// -- Конфигурация --------------------------------------------------------------

const API_BASE = "http://localhost:4000";
const TG_THREAD_OPS = 20; // Стратегия/Директор

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TG = process.argv.includes("--telegram") || !DRY_RUN;

/** Приблизительные циклы роста до урожая (дней) */
const CROP_CYCLE_DAYS = {
  огурец: 45,
  томат: 60,
  корнишон: 40,
  баклажан: 70,
  "острый перец": 90,
  кабачок: 45,
  укроп: 30,
  базилик: 25,
  тархун: 35,
  щавель: 40,
  мята: 30,
  кинза: 25,
  свекла: 60,
  хрен: 90,
  зелень: 25,
};

/** Продукты, требующие холодовую цепь (термосумка) */
const COLD_CHAIN_PRODUCTS = new Set([
  "огурец",
  "корнишон",
  "томат",
  "зелень",
  "укроп",
  "базилик",
  "мята",
  "кинза",
  "тархун",
  "щавель",
]);

// -- Хелперы -------------------------------------------------------------------

/** Безопасное извлечение числа из строки */
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
 * Парсит дату из строки. Поддерживает DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD.
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

/** Форматирует дату как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Сегодняшняя дата (начало дня) */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Преобразует массив строк из Sheets (первая строка — заголовки) в массив объектов.
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

/**
 * POST JSON к Sheets API (для сохранения задачи).
 * @param {string} path
 * @param {object} body
 * @returns {Promise<object>}
 */
function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${API_BASE}${path}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...apiHeaders(),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// -- Анализ данных -------------------------------------------------------------

/**
 * Определяет культуры, готовые к сбору (дата посадки + цикл роста <= сегодня).
 * @param {Record<string, string>[]} productionRows
 * @returns {Array<{product: string, plantedDate: string, expectedHarvest: string, daysOverdue: number}>}
 */
function findHarvestReady(productionRows) {
  const today = todayStart();
  const results = [];

  for (const row of productionRows) {
    const rawProduct = row["Продукт"] || row["Культура"] || row["Товар"] || "";
    if (!rawProduct) continue;

    const product = normalize(rawProduct);
    const productLower = product.toLowerCase();

    // Ищем дату посадки
    const plantedRaw = row["Дата посадки"] || row["Дата"] || "";
    const plantedDate = parseDate(plantedRaw);
    if (!plantedDate) continue;

    // Если уже есть дата сбора — пропускаем (уже собрано)
    const harvestedRaw = row["Дата сбора"] || row["Дата урожая"] || "";
    if (harvestedRaw && parseDate(harvestedRaw)) continue;

    // Определяем ожидаемую дату урожая
    const cycleDays = CROP_CYCLE_DAYS[productLower] || 45; // 45 дней по умолчанию
    const expectedHarvest = new Date(plantedDate);
    expectedHarvest.setDate(expectedHarvest.getDate() + cycleDays);

    // Готов к сбору, если ожидаемая дата <= сегодня + 3 дня (буфер)
    const bufferDate = new Date(today);
    bufferDate.setDate(bufferDate.getDate() + 3);

    if (expectedHarvest <= bufferDate) {
      const daysOverdue = Math.floor((today - expectedHarvest) / (1000 * 60 * 60 * 24));
      results.push({
        product,
        plantedDate: fmtDate(plantedDate),
        expectedHarvest: fmtDate(expectedHarvest),
        daysOverdue: Math.max(0, daysOverdue),
      });
    }
  }

  // Самые просроченные первыми
  results.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return results;
}

/**
 * Находит заказы на сегодня из продаж.
 * Фильтрует по дате и статусу (не завершённые).
 * @param {Record<string, string>[]} salesRows
 * @returns {Array<{client: string, product: string, qty: number, total: number, status: string}>}
 */
function findTodayOrders(salesRows) {
  const today = fmtDate(new Date());
  const orders = [];

  for (const row of salesRows) {
    const dateRaw = row["Дата"] || row["дата"] || row["date"] || "";
    if (!dateRaw.startsWith(today)) continue;

    // Пропускаем уже доставленные
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    if (status === "доставлено" || status === "delivered" || status === "отменено") continue;

    const client = row["Клиент"] || row["клиент"] || row["client"] || "Неизвестный";
    const rawProduct = row["Продукт"] || row["продукт"] || row["product"] || "";
    const product = normalize(rawProduct);
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || row["qty_kg"] || 0);
    const total = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);

    orders.push({ client, product, qty, total, status: status || "новый" });
  }

  return orders;
}

/**
 * Анализирует текущие остатки на складе.
 * @param {Record<string, string>[]} inventoryRows
 * @returns {Array<{product: string, stock: number, unit: string}>}
 */
function analyzeStock(inventoryRows) {
  const items = [];
  for (const row of inventoryRows) {
    const rawProduct = row["Продукт"] || row["Товар"] || row["Название"] || "";
    if (!rawProduct) continue;

    const product = normalize(rawProduct);
    const stock = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );
    const unit = row["Единица"] || "кг";

    items.push({ product, stock, unit });
  }

  // Минимальные остатки первыми
  items.sort((a, b) => a.stock - b.stock);
  return items;
}

/**
 * Находит открытые задачи, сортирует по приоритету.
 * @param {Record<string, string>[]} taskRows
 * @returns {{overdue: Array, today: Array, upcoming: Array}}
 */
function analyzeTasks(taskRows) {
  const today = todayStart();
  const result = { overdue: [], today: [], upcoming: [] };

  for (const row of taskRows) {
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    if (status === "done" || status === "готово" || status === "выполнено" || status === "закрыта")
      continue;

    const title = row["Задача"] || row["Название"] || row["Описание"] || row["Task"] || "";
    if (!title) continue;

    const priority = row["Приоритет"] || row["Priority"] || "Средний";
    const deadlineRaw = row["Дедлайн"] || row["Deadline"] || row["Срок"] || row["Дата"] || "";
    const deadline = parseDate(deadlineRaw);
    const assignee = row["Ответственный"] || row["Assignee"] || "";

    const task = { title, priority, deadline: deadlineRaw, assignee, status };

    if (deadline && deadline < today) {
      result.overdue.push(task);
    } else if (deadline && fmtDate(deadline) === fmtDate(today)) {
      result.today.push(task);
    } else {
      result.upcoming.push(task);
    }
  }

  // Сортируем по приоритету: Высокий > Средний > Низкий
  const priorityOrder = { высокий: 0, high: 0, средний: 1, medium: 1, низкий: 2, low: 2 };
  const sortByPriority = (a, b) => {
    const pa = priorityOrder[a.priority.toLowerCase()] ?? 1;
    const pb = priorityOrder[b.priority.toLowerCase()] ?? 1;
    return pa - pb;
  };

  result.overdue.sort(sortByPriority);
  result.today.sort(sortByPriority);
  result.upcoming.sort(sortByPriority);

  return result;
}

/**
 * Находит нерешённые алерты.
 * @param {Record<string, string>[]} alertRows
 * @returns {Array<{type: string, description: string, severity: string, date: string}>}
 */
function findUnresolvedAlerts(alertRows) {
  const alerts = [];

  for (const row of alertRows) {
    const status = (row["Статус"] || row["статус"] || row["Status"] || "").toLowerCase();
    if (status === "resolved" || status === "решено" || status === "закрыта") continue;

    const description = row["Описание"] || row["Description"] || row["Alert"] || "";
    if (!description) continue;

    const type = row["Тип"] || row["Type"] || row["Категория"] || "";
    const severity = row["Severity"] || row["Критичность"] || row["Приоритет"] || "";
    const dateRaw = row["Дата"] || row["Date"] || "";

    alerts.push({ type, description, severity, date: dateRaw });
  }

  // Высокая критичность первой
  alerts.sort((a, b) => parseNum(b.severity) - parseNum(a.severity));
  return alerts;
}

// -- Определение нужды холодовой цепи ------------------------------------------

/**
 * Проверяет, нужна ли термосумка для набора продуктов.
 * @param {string[]} products
 * @returns {boolean}
 */
function needsColdChain(products) {
  return products.some((p) => COLD_CHAIN_PRODUCTS.has(p.toLowerCase()));
}

// -- Форматирование чеклиста ---------------------------------------------------

/**
 * Генерирует полный HTML чеклист для Telegram.
 * @param {object} data
 * @returns {string}
 */
function formatChecklist(data) {
  const { harvestReady, todayOrders, stock, tasks, alerts, date } = data;
  const lines = [];

  lines.push(`<b>📋 Чеклист дня — ${date}</b>`);
  lines.push("");

  // -- 1. Утренний обход --
  lines.push(`<b>🌱 Утренний обход (07:00-08:00)</b>`);
  lines.push(`  ☐ Проверить температуру/влажность в каждой зоне`);
  lines.push(`  ☐ Осмотр растений на вредителей/болезни`);
  lines.push(`  ☐ Полив/фертигация по графику`);

  if (harvestReady.length > 0) {
    lines.push(`  <b>Готовы к сбору:</b>`);
    for (const crop of harvestReady) {
      const overdueTag = crop.daysOverdue > 0 ? ` (просрочен ${crop.daysOverdue}д!)` : "";
      lines.push(
        `  ☐ ${crop.product} — посадка ${crop.plantedDate}, план ${crop.expectedHarvest}${overdueTag}`,
      );
    }
  } else {
    lines.push(`  ℹ️ Нет культур, готовых к сбору сегодня`);
  }
  lines.push("");

  // -- 2. Сборка заказов --
  lines.push(`<b>📦 Сборка заказов (08:00-10:00)</b>`);
  if (todayOrders.length > 0) {
    // Группируем по клиенту
    /** @type {Map<string, Array>} */
    const byClient = new Map();
    for (const order of todayOrders) {
      if (!byClient.has(order.client)) byClient.set(order.client, []);
      byClient.get(order.client).push(order);
    }

    let orderNum = 0;
    for (const [client, clientOrders] of byClient) {
      orderNum++;
      const clientTotal = clientOrders.reduce((s, o) => s + o.total, 0);
      lines.push(
        `  <b>${orderNum}. ${client}</b> (${Math.round(clientTotal).toLocaleString()} ARS)`,
      );

      for (const o of clientOrders) {
        lines.push(`    ☐ ${o.product}: ${o.qty} кг`);
      }

      // Проверяем наличие на складе
      const allProducts = clientOrders.map((o) => o.product);
      for (const o of clientOrders) {
        const stockItem = stock.find((s) => s.product.toLowerCase() === o.product.toLowerCase());
        if (!stockItem || stockItem.stock < o.qty) {
          const available = stockItem ? stockItem.stock : 0;
          lines.push(`    ⚠️ ${o.product}: на складе ${available} кг, нужно ${o.qty} кг`);
        }
      }

      // Холодовая цепь
      if (needsColdChain(allProducts)) {
        lines.push(`    ☐ Термосумка для ${client}`);
      }
    }

    lines.push(`  ☐ Контроль качества перед упаковкой`);
  } else {
    lines.push(`  ℹ️ Заказов на сегодня нет`);
  }
  lines.push("");

  // -- 3. Доставка --
  lines.push(`<b>🚛 Доставка (10:00-14:00)</b>`);
  if (todayOrders.length > 0) {
    const clients = [...new Set(todayOrders.map((o) => o.client))];
    lines.push(`  Доставок: ${clients.length}`);
    for (const client of clients) {
      const clientOrders = todayOrders.filter((o) => o.client === client);
      const totalKg = clientOrders.reduce((s, o) => s + o.qty, 0);
      lines.push(`  ☐ ${client} — ${totalKg} кг`);
    }
    lines.push(`  ☐ Проверить маршрут (delivery-optimizer)`);
  } else {
    lines.push(`  ℹ️ Доставок не запланировано`);
  }
  lines.push("");

  // -- 4. Текущие задачи --
  lines.push(`<b>🔧 Текущие задачи (14:00-17:00)</b>`);

  if (tasks.overdue.length > 0) {
    lines.push(`  <b>⚠️ Просроченные (${tasks.overdue.length}):</b>`);
    for (const t of tasks.overdue.slice(0, 5)) {
      const assigneeTag = t.assignee ? ` [${t.assignee}]` : "";
      lines.push(`  ☐ ${t.title} (срок: ${t.deadline})${assigneeTag}`);
    }
    if (tasks.overdue.length > 5) {
      lines.push(`  ... и ещё ${tasks.overdue.length - 5}`);
    }
  }

  if (tasks.today.length > 0) {
    lines.push(`  <b>На сегодня (${tasks.today.length}):</b>`);
    for (const t of tasks.today.slice(0, 5)) {
      const assigneeTag = t.assignee ? ` [${t.assignee}]` : "";
      lines.push(`  ☐ ${t.title}${assigneeTag}`);
    }
  }

  if (tasks.upcoming.length > 0) {
    const upcomingCount = Math.min(3, tasks.upcoming.length);
    lines.push(`  <b>Ближайшие (показаны ${upcomingCount} из ${tasks.upcoming.length}):</b>`);
    for (const t of tasks.upcoming.slice(0, 3)) {
      lines.push(`  • ${t.title} (${t.deadline || "без срока"})`);
    }
  }

  if (tasks.overdue.length === 0 && tasks.today.length === 0 && tasks.upcoming.length === 0) {
    lines.push(`  ✅ Нет открытых задач`);
  }

  // Нерешённые алерты
  if (alerts.length > 0) {
    lines.push("");
    lines.push(`  <b>⚠️ Нерешённые алерты (${alerts.length}):</b>`);
    for (const a of alerts.slice(0, 5)) {
      const typeTag = a.type ? `[${a.type}] ` : "";
      lines.push(`  ☐ ${typeTag}${a.description}`);
    }
    if (alerts.length > 5) {
      lines.push(`  ... и ещё ${alerts.length - 5}`);
    }
  }
  lines.push("");

  // -- 5. Вечерний отчёт --
  lines.push(`<b>📊 Вечерний отчёт (17:00-18:00)</b>`);
  lines.push(`  ☐ Записать сбор урожая (🌿 Производство)`);
  lines.push(`  ☐ Записать продажи/расходы (🛒 Продажи, 💰 Расходы)`);
  lines.push(`  ☐ Обновить остатки склада (📦 Склад)`);

  // Подсказка о пробелах в данных
  const lowStockItems = stock.filter((s) => s.stock <= 0);
  if (lowStockItems.length > 0) {
    lines.push(`  ⚠️ Нулевые остатки: ${lowStockItems.map((s) => s.product).join(", ")}`);
  }

  // Итого
  lines.push("");
  const totalTasks = tasks.overdue.length + tasks.today.length;
  const summary = [];
  if (todayOrders.length > 0) summary.push(`${todayOrders.length} заказ(ов)`);
  if (harvestReady.length > 0) summary.push(`${harvestReady.length} к сбору`);
  if (totalTasks > 0) summary.push(`${totalTasks} задач`);
  if (alerts.length > 0) summary.push(`${alerts.length} алертов`);

  if (summary.length > 0) {
    lines.push(`<b>Итого:</b> ${summary.join(" | ")}`);
  } else {
    lines.push(`<b>Итого:</b> спокойный день, фокус на обслуживании теплицы`);
  }

  return lines.join("\n");
}

// -- Сохранение чеклиста в задачи -----------------------------------------------

/**
 * Сохраняет сгенерированный чеклист как задачу в лист "📋 Задачи".
 * @param {string} date — дата в формате YYYY-MM-DD
 * @param {number} ordersCount
 * @param {number} tasksCount
 * @param {number} alertsCount
 * @returns {Promise<void>}
 */
async function saveChecklistAsTask(date, ordersCount, tasksCount, alertsCount) {
  try {
    const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    await appendToSheet(PEPINO_SHEETS_ID, "📋 Задачи", [
      [
        date, // Дата
        `Чеклист дня ${date}`, // Задача
        "daily-ops-checklist", // Источник
        "Средний", // Приоритет
        "В работе", // Статус
        "", // Ответственный
        `Заказов: ${ordersCount}, Задач: ${tasksCount}, Алертов: ${alertsCount}`, // Описание
        date, // Дедлайн
      ],
    ]);
    console.error(`[daily-ops-checklist] Чеклист сохранён в "📋 Задачи"`);
  } catch (err) {
    console.error(`[daily-ops-checklist] Ошибка сохранения задачи: ${err.message}`);
    // Фоллбэк через API
    try {
      await postJson("/log/task", {
        date,
        title: `Чеклист дня ${date}`,
        source: "daily-ops-checklist",
        priority: "Средний",
        status: "В работе",
        description: `Заказов: ${ordersCount}, Задач: ${tasksCount}, Алертов: ${alertsCount}`,
      });
      console.error(`[daily-ops-checklist] Чеклист сохранён через API`);
    } catch (apiErr) {
      console.error(`[daily-ops-checklist] API фоллбэк не удался: ${apiErr.message}`);
    }
  }
}

// -- Главная функция -----------------------------------------------------------

async function main() {
  const startMs = Date.now();
  const today = fmtDate(new Date());
  console.error(
    `[${new Date().toISOString()}] Daily ops checklist starting...${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  // Импорт sheets.js (ESM из CJS)
  /** @type {{ readSheet: Function, appendToSheet: Function, PEPINO_SHEETS_ID: string }} */
  let readSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[daily-ops-checklist] Не удалось импортировать sheets.js: ${err.message}`);
    process.exit(1);
  }

  // Параллельное чтение всех листов
  let productionRaw, salesRaw, inventoryRaw, tasksRaw, alertsRaw;
  try {
    [productionRaw, salesRaw, inventoryRaw, tasksRaw, alertsRaw] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "🌿 Производство"),
      readSheet(PEPINO_SHEETS_ID, "🛒 Продажи"),
      readSheet(PEPINO_SHEETS_ID, "📦 Склад"),
      readSheet(PEPINO_SHEETS_ID, "📋 Задачи"),
      readSheet(PEPINO_SHEETS_ID, "⚠️ Алерты"),
    ]);
  } catch (err) {
    const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
    console.error(`[daily-ops-checklist] ${msg}`);
    if (!DRY_RUN) {
      await send(`⚠️ Daily Ops Checklist FAIL\n${msg}`, {
        silent: false,
        threadId: TG_THREAD_OPS,
        parseMode: "HTML",
      });
    }
    process.exit(1);
  }

  // Парсинг строк в объекты
  const productionRows = rowsToObjects(productionRaw);
  const salesRows = rowsToObjects(salesRaw);
  const inventoryRows = rowsToObjects(inventoryRaw);
  const taskRows = rowsToObjects(tasksRaw);
  const alertRows = rowsToObjects(alertsRaw);

  console.error(
    `[daily-ops-checklist] Загружено: производство=${productionRows.length}, ` +
      `продажи=${salesRows.length}, склад=${inventoryRows.length}, ` +
      `задачи=${taskRows.length}, алерты=${alertRows.length}`,
  );

  // Анализ данных
  const harvestReady = findHarvestReady(productionRows);
  const todayOrders = findTodayOrders(salesRows);
  const stock = analyzeStock(inventoryRows);
  const tasks = analyzeTasks(taskRows);
  const alerts = findUnresolvedAlerts(alertRows);

  console.error(
    `[daily-ops-checklist] Анализ: к сбору=${harvestReady.length}, ` +
      `заказов=${todayOrders.length}, просрочено задач=${tasks.overdue.length}, ` +
      `алертов=${alerts.length}`,
  );

  // Генерация чеклиста
  const checklist = formatChecklist({
    harvestReady,
    todayOrders,
    stock,
    tasks,
    alerts,
    date: today,
  });

  // Вывод в консоль (plain text)
  console.log("\n" + checklist.replace(/<[^>]+>/g, "") + "\n");

  // Сохранение в задачи
  if (!DRY_RUN) {
    const totalTasks = tasks.overdue.length + tasks.today.length;
    await saveChecklistAsTask(today, todayOrders.length, totalTasks, alerts.length);
  } else {
    console.error("[daily-ops-checklist] DRY RUN: пропуск сохранения задачи");
  }

  // Отправка в Telegram
  if (SEND_TG) {
    try {
      const result = await send(checklist, {
        silent: false,
        threadId: TG_THREAD_OPS,
        parseMode: "HTML",
      });
      if (result.ok) {
        console.error("[daily-ops-checklist] Чеклист отправлен в Telegram");
      } else {
        console.error(`[daily-ops-checklist] Telegram ошибка: ${result.error}`);
      }
    } catch (err) {
      console.error(`[daily-ops-checklist] Ошибка отправки в Telegram: ${err.message}`);
    }
  } else {
    console.error("[daily-ops-checklist] DRY RUN: пропуск отправки в Telegram");
  }

  // Langfuse trace
  const durationMs = Date.now() - startMs;
  await trace({
    name: "daily-ops-checklist",
    input: {
      sheets: ["Производство", "Продажи", "Склад", "Задачи", "Алерты"],
      dry_run: DRY_RUN,
    },
    output: {
      harvest_ready: harvestReady.length,
      today_orders: todayOrders.length,
      stock_items: stock.length,
      overdue_tasks: tasks.overdue.length,
      today_tasks: tasks.today.length,
      unresolved_alerts: alerts.length,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "daily-ops-checklist",
    },
  }).catch(() => {});

  console.error(
    `[daily-ops-checklist] Завершено за ${durationMs}мс. ` +
      `Заказов: ${todayOrders.length}, к сбору: ${harvestReady.length}, ` +
      `задач: ${tasks.overdue.length + tasks.today.length}, алертов: ${alerts.length}`,
  );
}

// -- Запуск --------------------------------------------------------------------

main().catch((err) => {
  console.error(`[daily-ops-checklist] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
