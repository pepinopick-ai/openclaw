#!/usr/bin/env node
/**
 * expense-reminder.cjs — Напоминание о вводе расходов
 *
 * Проверяет: были ли введены расходы за последние N дней.
 * Если нет — отправляет напоминание в Telegram с подсказками.
 *
 * Cron: 13:00 daily (после обеда, когда есть время)
 */
"use strict";

const { sendThrottled } = (() => {
  try {
    return require("./notification-throttle.cjs");
  } catch {
    return { sendThrottled: require("./telegram-helper.cjs").send };
  }
})();

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  let state;
  try {
    state = await require("./farm-state.cjs").getState();
  } catch (e) {
    console.error(`[expense-reminder] farm-state error: ${e.message}`);
    return;
  }

  const expenses = state.expenses || [];
  const today = new Date();

  // Найти последнюю дату расхода
  const dates = expenses
    .map((r) => {
      const d = r["Дата"] || r["Date"] || "";
      if (!d) return null;
      // Parse DD/MM/YYYY or YYYY-MM-DD
      const parts = d.includes("/") ? d.split("/") : null;
      if (parts && parts.length === 3) {
        return new Date(+parts[2], +parts[1] - 1, +parts[0]);
      }
      const iso = new Date(d);
      return isNaN(iso) ? null : iso;
    })
    .filter(Boolean);

  if (!dates.length) {
    console.error("[expense-reminder] Нет данных расходов");
    return;
  }

  const lastExpenseDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const daysSince = Math.floor((today - lastExpenseDate) / 86400000);

  if (daysSince <= 1) {
    console.error(
      `[expense-reminder] Расходы актуальны (последний: ${daysSince}д назад). Пропускаю.`,
    );
    return;
  }

  // Подсчитать пропущенные дни
  const totalDays = 30;
  const daysWithExpenses = new Set();
  dates.forEach((d) => {
    const diff = Math.floor((today - d) / 86400000);
    if (diff <= totalDays) daysWithExpenses.add(d.toISOString().slice(0, 10));
  });
  const coverage = Math.round((daysWithExpenses.size / totalDays) * 100);

  // Типичные категории расходов
  const categories = [
    "🌱 Субстрат/мицелий/семена",
    "⚡ Электричество/газ/вода",
    "🚛 Бензин/транспорт",
    "📦 Упаковка/тара",
    "👷 Зарплата/помощники",
    "🔧 Ремонт/инструменты",
    "📱 Связь/интернет",
    "🏪 Прочее",
  ];

  const msg = [
    `⚠️ <b>РАСХОДЫ НЕ ВНЕСЕНЫ ${daysSince} дней!</b>`,
    ``,
    `Последняя запись: ${lastExpenseDate.toISOString().slice(0, 10)}`,
    `Покрытие за 30д: <b>${coverage}%</b> ${coverage < 50 ? "🔴" : coverage < 80 ? "🟡" : "🟢"}`,
    ``,
    `<b>Быстрый ввод голосом:</b>`,
    `🎤 "расход субстрат 15000"`,
    `🎤 "расход бензин 3500"`,
    `🎤 "расход электричество 12000"`,
    ``,
    `<b>Или CLI:</b>`,
    `<code>pepino expense "субстрат 15000"</code>`,
    ``,
    `<i>Без расходов маржа = 100% (ложная). Введи хотя бы 3 основные категории:</i>`,
    categories.slice(0, 4).join("\n"),
  ].join("\n");

  if (dryRun) {
    console.log(msg.replace(/<\/?[^>]+>/g, ""));
    return;
  }

  await sendThrottled(msg, {
    thread: 20,
    parseMode: "HTML",
    priority: daysSince > 5 ? "critical" : "normal",
  });
  console.error(
    `[expense-reminder] Отправлено (${daysSince}д без расходов, покрытие ${coverage}%)`,
  );
}

main().catch(console.error);
