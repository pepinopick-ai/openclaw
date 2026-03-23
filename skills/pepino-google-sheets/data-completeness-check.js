#!/usr/bin/env node
/**
 * Pepino Data Completeness Agent
 * Runs at 20:00 daily — checks what data is missing and sends reminder to Telegram
 *
 * Checks:
 * 1. Production records for today
 * 2. Sales records (if expected)
 * 3. Overdue tasks
 * 4. Open alerts without response
 * 5. Missing weekly data (expenses, inventory)
 *
 * Usage: node data-completeness-check.js
 * Cron:  0 20 * * * cd /home/roman/openclaw/skills/pepino-google-sheets && node data-completeness-check.js
 */

import { readSheet, PEPINO_SHEETS_ID } from "./sheets.js";
import { trace } from "./langfuse-trace.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { sendStatus, sendAlert, TOPIC_STATUS } = require("./telegram-helper.cjs");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dayOfWeek() {
  return new Date().getDay(); // 0=Sun, 1=Mon...
}

function sheetToJson(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

async function checkCompleteness() {
  const t = today();
  const gaps = [];
  const suggestions = [];

  // 1. Production — was there any harvest today?
  try {
    const prod = await readSheet(PEPINO_SHEETS_ID, "🌿 Производство");
    const prodToday = prod
      .slice(1)
      .filter((r) => r[0] && r[0].startsWith(t));
    if (prodToday.length === 0) {
      gaps.push("🌿 Нет записей производства за сегодня");
      suggestions.push(
        'Напиши: "сбор огурец Xкг зона A" или "сбор вешенка Xкг зона B"',
      );
    } else {
      const totalKg = prodToday.reduce(
        (s, r) => s + (parseFloat(r[6]) || 0),
        0,
      );
      suggestions.push(`✅ Производство: ${totalKg}кг записано`);
    }
  } catch (e) {
    gaps.push("⚠️ Ошибка чтения Производство: " + e.message);
  }

  // 2. Sales — any sales today?
  try {
    const sales = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    const salesToday = sales
      .slice(1)
      .filter((r) => r[0] && r[0].startsWith(t));
    if (salesToday.length === 0) {
      gaps.push("🛒 Нет продаж за сегодня");
      suggestions.push(
        'Если были продажи, напиши: "продал 5кг огурцов клиенту 12500"',
      );
    } else {
      const totalArs = salesToday.reduce(
        (s, r) => s + (parseFloat(r[5]) || 0),
        0,
      );
      suggestions.push(`✅ Продажи: ${totalArs.toLocaleString()} ARS`);
    }
  } catch (e) {
    /* sheet might not exist yet */
  }

  // 3. Expenses — any expenses this week? (check on Fridays or if none all week)
  try {
    const exp = await readSheet(PEPINO_SHEETS_ID, "💰 Расходы");
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const expWeek = exp
      .slice(1)
      .filter((r) => r[0] && r[0] >= weekStartStr);
    if (expWeek.length === 0 && dayOfWeek() >= 4) {
      // Thursday+
      gaps.push("💰 Нет расходов за эту неделю");
      suggestions.push(
        'Напиши расходы: "расход электричество 15000" или "купил субстрат 8000"',
      );
    }
  } catch (e) {
    /* sheet might not exist */
  }

  // 4. Overdue tasks
  try {
    const tasks = await readSheet(PEPINO_SHEETS_ID, "📋 Задачи");
    const taskData = sheetToJson(tasks);
    const overdue = taskData.filter(
      (r) =>
        r["Статус"] === "открыт" && r["Срок"] && r["Срок"] < t,
    );
    if (overdue.length > 0) {
      gaps.push(
        `📋 ${overdue.length} просроченных задач:`,
      );
      overdue.forEach((r) =>
        gaps.push(`   • [${r["Приоритет (P1-P4)"] || "P3"}] ${r["Задача"]}`),
      );
    }

    const todayTasks = taskData.filter(
      (r) => r["Статус"] === "открыт" && r["Срок"] === t,
    );
    if (todayTasks.length > 0) {
      suggestions.push(`📋 Задачи на сегодня: ${todayTasks.length}`);
    }
  } catch (e) {
    /* ok */
  }

  // 5. Open alerts without response
  try {
    const alerts = await readSheet(PEPINO_SHEETS_ID, "⚠️ Алерты");
    const alertData = sheetToJson(alerts);
    const openAlerts = alertData.filter(
      (r) => r["статус"] === "открыт" && !r["реакция"],
    );
    if (openAlerts.length > 0) {
      gaps.push(
        `⚠️ ${openAlerts.length} алертов без реакции:`,
      );
      openAlerts.forEach((r) =>
        gaps.push(`   • [${r["критичность"]}/5] ${r["описание"]?.slice(0, 60)}`),
      );
    }
  } catch (e) {
    /* ok */
  }

  // 6. Inventory — check if empty (one-time reminder)
  try {
    const inv = await readSheet(PEPINO_SHEETS_ID, "📦 Склад");
    if (inv.length <= 1) {
      // Only header
      gaps.push("📦 Склад пуст — нет записей");
      suggestions.push(
        'Запиши остатки: "приход субстрат 50кг" или "получил мицелий 10кг"',
      );
    }
  } catch (e) {
    /* ok */
  }

  return { gaps, suggestions };
}

function formatMessage(gaps, suggestions) {
  const lines = [`📊 *ПРОВЕРКА ДАННЫХ* — ${today()}\n`];

  if (gaps.length === 0) {
    lines.push("✅ Все данные на месте! Отличная работа.\n");
  } else {
    lines.push(`⚠️ *Найдено ${gaps.length} пробелов:*\n`);
    gaps.forEach((g) => lines.push(g));
    lines.push("");
  }

  if (suggestions.length > 0) {
    lines.push("*Подсказки:*");
    suggestions.forEach((s) => lines.push(s));
  }

  lines.push(
    "\n_Просто напишите данные в чат — бот запишет автоматически._",
  );

  return lines.join("\n");
}

/**
 * Отправить в Telegram: тихо если всё ОК, громко если есть пробелы.
 * @param {string} text - Текст сообщения
 * @param {boolean} hasGaps - Есть ли пробелы в данных
 * @returns {Promise<boolean>}
 */
async function sendTelegram(text, hasGaps = true) {
  const result = hasGaps
    ? await sendAlert(text, TOPIC_STATUS)
    : await sendStatus(text, TOPIC_STATUS);

  if (!result.ok) {
    console.error(`Ошибка отправки в Telegram: ${result.error}`);
  }
  return result.ok;
}

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Running data completeness check...`);

  const { gaps, suggestions } = await checkCompleteness();
  const message = formatMessage(gaps, suggestions);

  console.log(message);

  // Всегда отправляем: с пробелами -- громко, без -- тихо
  await sendTelegram(message, gaps.length > 0);

  // Langfuse trace
  await trace({
    name: "data-completeness-check",
    input: { date: today() },
    output: { gaps: gaps.length, suggestions: suggestions.length },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "data-completeness" },
  }).catch(() => {});

  console.log(
    `[${new Date().toISOString()}] Done. Gaps: ${gaps.length}, Suggestions: ${suggestions.length}`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
