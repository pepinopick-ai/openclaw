#!/usr/bin/env node
/**
 * cross-topic-router.cjs — Пересылка задач между топиками Telegram
 *
 * Usage:
 *   node cross-topic-router.cjs send 176 "Закупить субстрат 20 мешков для грибов"
 *   node cross-topic-router.cjs send 14 "Проверить EC/pH в зоне 2"
 */
"use strict";

const { send } = require("./telegram-helper.cjs");

const TOPIC_MAP = {
  13: "Общий",
  14: "Агрономия",
  15: "Финансы",
  16: "Маркетинг",
  17: "Логистика",
  18: "DEV",
  19: "HR",
  20: "Стратегия",
  58: "Крипто",
  111: "Бриф",
  112: "Итоги",
  113: "Алерты",
  114: "Общий",
  115: "Задачи",
  176: "Закупки",
};

async function main() {
  const [, , cmd, topicId, ...msgParts] = process.argv;

  if (cmd !== "send" || !topicId || !msgParts.length) {
    console.error('Usage: node cross-topic-router.cjs send <topic_id> "message"');
    console.error("\nTopics:");
    for (const [id, name] of Object.entries(TOPIC_MAP)) {
      console.error(`  #${id} → ${name}`);
    }
    process.exit(1);
  }

  const message = msgParts.join(" ");
  const topicName = TOPIC_MAP[topicId] || `Topic #${topicId}`;

  const html = `📨 <b>Задача от Стратегии → ${topicName}</b>\n\n${message}\n\n<i>Автоматически переслано через Task Router</i>`;

  try {
    const result = await send(html, {
      threadId: parseInt(topicId),
      parseMode: "HTML",
      silent: false,
    });

    if (result.ok) {
      console.log(`✅ Отправлено в #${topicId} (${topicName})`);
    } else {
      console.error(`❌ Ошибка: ${result.error}`);
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
  }
}

main().catch(console.error);
