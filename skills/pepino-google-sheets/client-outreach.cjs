#!/usr/bin/env node
/**
 * Pepino Pick -- Client Outreach (proactive follow-up)
 *
 * Автоматизирует проактивное follow-up на основе churn-риска.
 * Использует shared модуль client-analytics.cjs для анализа клиентов.
 *
 *   1. Получает классификацию клиентов (active / at_risk / churned / new)
 *   2. Создаёт задачи в "📋 Задачи" для at_risk (P2) и churned (P3)
 *   3. Отправляет сводку в Telegram (тред 20)
 *
 * Cron: 0 10 * * 2,5 (вт и пт 10:00)
 * Usage: node client-outreach.cjs [--dry-run]
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");
const { analyzeClients } = require("./client-analytics.cjs");

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_ID = 20; // Стратегия/Директор

// ── Утилиты ─────────────────────────────────────────────────────────────────

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

// ── Задачи ──────────────────────────────────────────────────────────────────

/**
 * Проверяет, есть ли уже открытая follow-up задача для клиента.
 * @param {Array<string[]>} taskRows — строки из "📋 Задачи" (без заголовков)
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
 * @param {object[]} atRisk — клиенты at_risk из analyzeClients
 * @param {object[]} churned — клиенты churned из analyzeClients
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
    const taskName = `Follow-up: ${client.name} — ${client.daysSinceLast} дней без заказа`;
    rows.push([
      today, // Дата
      taskName, // Задача
      "CRM", // Категория
      "P2", // Приоритет
      deadline, // Дедлайн
      "", // Статус (пустой = новая)
      `LTV ${Math.round(client.totalArs).toLocaleString("ru")} ARS, ` +
        `ср. чек ${client.avgOrderArs.toLocaleString("ru")} ARS, ` +
        `частота ~${client.avgFrequencyDays || "?"}д`,
    ]);
    created.push(taskName);
  }

  // Churned: P3, deadline +2 дня, с деталями
  for (const client of churned) {
    if (hasOpenTask(taskRows, taskHeaders, client.name)) {
      continue;
    }
    const products = client.products.length > 0 ? client.products.slice(0, 3).join(", ") : "н/д";
    const taskName = `Follow-up: ${client.name} — ${client.daysSinceLast} дней без заказа (churned)`;
    rows.push([
      today,
      taskName,
      "CRM",
      "P3",
      deadline,
      "",
      `CHURNED. Последние продукты: ${products}. ` +
        `LTV ${Math.round(client.totalArs).toLocaleString("ru")} ARS, ` +
        `ср. заказ ${client.avgOrderArs.toLocaleString("ru")} ARS`,
    ]);
    created.push(taskName);
  }

  return { rows, created };
}

// ── Telegram-отчёт ──────────────────────────────────────────────────────────

/**
 * Формирует HTML-сводку для Telegram.
 * @param {object} classified — объект с active/at_risk/churned/new_clients массивами
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
        `  ${c.name} — ${c.daysSinceLast}д, ` +
          `${Math.round(c.totalArs).toLocaleString("ru")} ARS`,
      );
    }
    lines.push("");
  }

  // Топ churned
  if (classified.churned.length > 0) {
    lines.push(`<b>🔴 Churned (топ-5):</b>`);
    for (const c of classified.churned.slice(0, 5)) {
      const prods = c.products.length > 0 ? ` [${c.products.slice(0, 3).join(", ")}]` : "";
      lines.push(
        `  ${c.name} — ${c.daysSinceLast}д, ` +
          `${Math.round(c.totalArs).toLocaleString("ru")} ARS${prods}`,
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

  // 1. Анализ клиентов через shared модуль
  const { clients, summary } = await analyzeClients();

  if (clients.length === 0) {
    console.log("Нет данных о клиентах.");
    return;
  }

  // 2. Классификация (analyzeClients уже присваивает status)
  const classified = {
    active: clients.filter((c) => c.status === "active"),
    at_risk: clients.filter((c) => c.status === "at_risk"),
    churned: clients.filter((c) => c.status === "churned"),
    new_clients: clients.filter((c) => c.status === "new"),
  };

  // Сортировка at_risk и churned по LTV (самые ценные первыми)
  classified.at_risk.sort((a, b) => b.totalArs - a.totalArs);
  classified.churned.sort((a, b) => b.totalArs - a.totalArs);

  console.log(`Active: ${classified.active.length}`);
  console.log(`At risk: ${classified.at_risk.length}`);
  console.log(`Churned: ${classified.churned.length}`);
  console.log(`New: ${classified.new_clients.length}`);

  // 3. Чтение существующих задач (для дедупликации)
  const { readSheet, appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");

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
    // Продолжаем без дедупликации — лучше дубль, чем пропуск
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
      clients_total: summary.total,
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
