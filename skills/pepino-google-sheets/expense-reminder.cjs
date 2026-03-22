#!/usr/bin/env node
/**
 * expense-reminder.cjs — Напоминание о вводе расходов
 *
 * Проверяет были ли внесены расходы за сегодня.
 * Если нет — отправляет напоминание в Telegram.
 *
 * Cron: 0 19 * * * (ежедневно 19:00, перед вечерним планированием)
 */
"use strict";

const { sendReport } = require("./telegram-helper.cjs");
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

const DRY = process.argv.includes("--dry-run");

async function main() {
  const { getState } = require("./farm-state.cjs");
  const state = await getState();

  const today = new Date().toISOString().slice(0, 10);
  const expenses = (state.expenses || []).filter((row) => {
    const date = row["Дата"] || row["Date"] || "";
    return date.includes(today) || date.includes(today.split("-").reverse().join("/"));
  });

  const sales = (state.sales || []).filter((row) => {
    const date = row["Дата"] || row["Date"] || "";
    return date.includes(today) || date.includes(today.split("-").reverse().join("/"));
  });

  // Count days without expenses in last 7 days
  const last7 = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dsAr = ds.split("-").reverse().join("/");
    const hasExpense = (state.expenses || []).some((row) => {
      const date = row["Дата"] || row["Date"] || "";
      return date.includes(ds) || date.includes(dsAr);
    });
    last7.push({ date: ds, hasExpense });
  }
  const missingDays = last7.filter((d) => !d.hasExpense).length;

  if (expenses.length > 0) {
    if (!DRY)
      console.log(
        `[expense-reminder] Расходы за ${today} уже внесены (${expenses.length} записей). Пропуск.`,
      );
    return;
  }

  // Build reminder message
  let msg = `<b>💰 Напоминание: расходы за сегодня</b>\n\n`;
  msg += `За ${today} расходы ещё не внесены.\n\n`;

  if (sales.length > 0) {
    msg += `📊 При этом продажи есть: ${sales.length} записей\n`;
    msg += `⚠️ Без расходов маржа показывает 100% (нереально)\n\n`;
  }

  if (missingDays >= 3) {
    msg += `🔴 За последние 7 дней расходы не внесены ${missingDays} дней!\n`;
    msg += `Это снижает точность всей аналитики.\n\n`;
  }

  msg += `<b>Быстрый ввод (голосом или текстом):</b>\n`;
  msg += `<code>pepino expense "субстрат 5000"</code>\n`;
  msg += `<code>pepino expense "доставка 3500"</code>\n`;
  msg += `<code>pepino expense "электричество 12000"</code>\n\n`;
  msg += `Или ответь на это сообщение списком расходов 📝`;

  if (DRY) {
    console.log("[DRY-RUN]", msg.replace(/<[^>]+>/g, ""));
    return;
  }

  const sender = sendThrottled || sendReport;
  await sender(msg, { thread: 20, priority: "normal", parseMode: "HTML" });
  console.log(`[expense-reminder] Отправлено напоминание (missing: ${missingDays}/7 days)`);
}

main().catch((e) => console.error("[expense-reminder]", e.message));
