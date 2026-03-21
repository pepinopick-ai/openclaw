#!/usr/bin/env node
/**
 * cross-topic-router.cjs — Маршрутизация задач между топиками/агентами
 *
 * Проблема: бот не реагирует на свои сообщения в другом топике.
 * Решение: записать задачу в Sheets + отправить уведомление в топик +
 *          подсказать пользователю ткнуть в топик для активации агента.
 *
 * Usage:
 *   node cross-topic-router.cjs send 176 "Закупить субстрат 20 мешков"
 *   node cross-topic-router.cjs send 14 "Проверить EC/pH в зоне 2" --from 20
 */
"use strict";

const { send } = require("./telegram-helper.cjs");
const { parseDate, fmtDate } = require("./helpers.cjs");

const TOPIC_MAP = {
  13: { name: "Общий", dept: "Общее" },
  14: { name: "Агрономия", dept: "Агрономия" },
  15: { name: "Финансы", dept: "Финансы" },
  16: { name: "Маркетинг", dept: "Маркетинг" },
  17: { name: "Логистика", dept: "Логистика" },
  18: { name: "DEV", dept: "DEV" },
  19: { name: "HR", dept: "HR" },
  20: { name: "Стратегия", dept: "Стратегия" },
  58: { name: "Крипто", dept: "Крипто" },
  111: { name: "Бриф", dept: "Планирование" },
  112: { name: "Итоги", dept: "Отчётность" },
  113: { name: "Алерты", dept: "Безопасность" },
  115: { name: "Задачи", dept: "Управление" },
  176: { name: "Закупки", dept: "Закупки" },
};

async function writeTaskToSheets(task, dept, fromTopic) {
  try {
    const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const today = new Date().toISOString().slice(0, 10);
    const row = [
      today, // Дата
      task, // Задача
      dept, // Отдел
      "", // Исполнитель
      "2", // Приоритет
      "", // Дедлайн
      "planned", // Статус
      "", // Качество
      `Делегировано из #${fromTopic}`, // Заметки
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "📋 Задачи");
    return true;
  } catch (e) {
    console.error(`[router] Sheets write failed: ${e.message}`);
    // Fallback to API
    try {
      const http = require("http");
      const { apiHeaders } = require("./api-auth.cjs");
      const body = JSON.stringify({
        task,
        dept,
        priority: 2,
        notes: `Делегировано из #${fromTopic}`,
      });
      await new Promise((resolve, reject) => {
        const req = http.request(
          "http://127.0.0.1:4000/log/task",
          {
            method: "POST",
            headers: { ...apiHeaders(), "Content-Type": "application/json" },
          },
          (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve(d));
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      return true;
    } catch (e2) {
      console.error(`[router] API fallback failed: ${e2.message}`);
      return false;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd !== "send" || args.length < 3) {
    console.error('Usage: node cross-topic-router.cjs send <topic_id> "message" [--from N]');
    console.error("\nTopics:");
    for (const [id, { name }] of Object.entries(TOPIC_MAP)) {
      console.error(`  #${id} → ${name}`);
    }
    process.exit(1);
  }

  const topicId = args[1];
  const fromIdx = args.indexOf("--from");
  const fromTopic = fromIdx > -1 ? args[fromIdx + 1] : "20";
  const msgParts = args.slice(2).filter((_, i) => {
    const absI = i + 2;
    return absI !== fromIdx && absI !== fromIdx + 1;
  });
  const message = msgParts.join(" ");
  const target = TOPIC_MAP[topicId] || { name: `Topic #${topicId}`, dept: "Общее" };
  const source = TOPIC_MAP[fromTopic] || { name: `#${fromTopic}` };

  // 1. Записать задачу в Google Sheets
  const saved = await writeTaskToSheets(message, target.dept, fromTopic);
  console.log(
    saved
      ? `✅ Задача записана в Sheets (отдел: ${target.dept})`
      : `⚠️ Не удалось записать в Sheets`,
  );

  // 2. Отправить уведомление в целевой топик
  const notification = [
    `📨 <b>Новая задача → ${target.name}</b>`,
    ``,
    message,
    ``,
    `<i>От: ${source.name} | Статус: planned</i>`,
    `<i>💬 Ответьте на это сообщение чтобы начать работу</i>`,
  ].join("\n");

  try {
    const r1 = await send(notification, {
      threadId: parseInt(topicId),
      parseMode: "HTML",
      silent: false,
    });
    if (r1.ok) {
      console.log(`✅ Уведомление отправлено в #${topicId} (${target.name})`);
    } else {
      console.error(`⚠️ Telegram: ${r1.error}`);
    }
  } catch (e) {
    console.error(`⚠️ Telegram error: ${e.message}`);
  }

  // 3. Ответ для вызывающего агента (stdout)
  console.log(`\n📋 Задача делегирована:`);
  console.log(`   Куда: #${topicId} ${target.name}`);
  console.log(`   Что: ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}`);
  console.log(`   Sheets: ${saved ? "✅" : "⚠️"}`);
  console.log(
    `\n💡 Пользователь может ответить на сообщение в #${topicId} чтобы активировать агента ${target.name}.`,
  );
}

main().catch(console.error);
