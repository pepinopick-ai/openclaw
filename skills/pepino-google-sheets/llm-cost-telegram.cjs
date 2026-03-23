/**
 * Ежедневный отчёт AI-расходов в Telegram.
 *
 * Читает /tmp/llm-cost-report.json (генерируется llm-cost-report.cjs),
 * форматирует краткую сводку и отправляет через telegram-helper.cjs
 * в топик TOPIC_STATUS (тихое уведомление).
 *
 * Cron: 0 22 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/llm-cost-telegram.cjs >> /home/roman/logs/llm-cost-telegram.log 2>&1
 *
 * @module llm-cost-telegram
 */

const fs = require("fs");
const path = require("path");
const { sendStatus, TOPIC_STATUS } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const REPORT_PATH =
  process.env.LLM_COST_REPORT_PATH || "/tmp/llm-cost-report.json";

const MONTHLY_BUDGET_USD = Number(process.env.LLM_MONTHLY_BUDGET) || 80;

// ── Вспомогательные функции ─────────────────────────────────────────────────

/**
 * Форматирует дату в русском стиле: "20 марта"
 * @param {Date} date
 * @returns {string}
 */
function formatDateRu(date) {
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

/**
 * Определяет статус-индикатор по порогу
 * @param {number} value
 * @param {number} goodThreshold
 * @param {boolean} higherIsBetter
 * @returns {string}
 */
function statusIcon(value, goodThreshold, higherIsBetter = true) {
  if (higherIsBetter) {
    return value >= goodThreshold ? "OK" : "LOW";
  }
  return value <= goodThreshold ? "OK" : "HIGH";
}

/**
 * Форматирует сообщение для Telegram из данных отчёта.
 * @param {object} report - Данные из llm-cost-report.json
 * @returns {string}
 */
function formatMessage(report) {
  const today = formatDateRu(new Date());

  // Извлечение данных с безопасными значениями по умолчанию
  const totalTasks = report.total_tasks || 0;
  const tierBreakdown = report.tier_breakdown || {};
  const t1 = tierBreakdown.T1 || 0;
  const t2 = tierBreakdown.T2 || 0;
  const t3 = tierBreakdown.T3 || 0;
  const t4 = tierBreakdown.T4 || 0;

  const totalCost = report.total_cost_usd || 0;
  const avgCost = totalTasks > 0 ? totalCost / totalTasks : 0;

  // Cheap rate = доля T1 задач, решённых без эскалации
  const cheapRate = report.cheap_pass_rate || (totalTasks > 0 ? (t1 / totalTasks) * 100 : 0);
  const cheapStatus = statusIcon(cheapRate, 85, true);

  // Бюджет: % использования MTD
  const mtdCost = report.mtd_cost_usd || totalCost;
  const budgetPct = MONTHLY_BUDGET_USD > 0 ? (mtdCost / MONTHLY_BUDGET_USD) * 100 : 0;

  // Топ расход по скиллу
  const topSkill = report.top_cost_skill || null;
  const topSkillName = topSkill ? topSkill.skill : "n/a";
  const topSkillCost = topSkill ? topSkill.cost_usd : 0;

  const lines = [
    `AI Costs -- ${today}`,
    "",
    `Tasks: ${totalTasks} (T1:${t1} T2:${t2} T3:${t3} T4:${t4})`,
    `Cost: $${totalCost.toFixed(2)} (avg $${avgCost.toFixed(3)}/task)`,
    `Cheap rate: ${cheapRate.toFixed(0)}% ${cheapStatus}`,
    `Budget: ${budgetPct.toFixed(0)}% used ($${mtdCost.toFixed(2)}/$${MONTHLY_BUDGET_USD})`,
  ];

  if (topSkillName !== "n/a") {
    lines.push("");
    lines.push(`Top cost: ${topSkillName} $${topSkillCost.toFixed(2)}`);
  }

  // Алерты при превышении порогов
  const alerts = [];
  if (cheapRate < 85) {
    alerts.push(`Cheap rate ${cheapRate.toFixed(0)}% < 85% target`);
  }
  if (budgetPct > 80) {
    alerts.push(`Budget usage ${budgetPct.toFixed(0)}% -- approaching limit`);
  }
  if (avgCost > 0.025) {
    alerts.push(`Avg cost $${avgCost.toFixed(3)} > $0.025 target`);
  }

  if (alerts.length > 0) {
    lines.push("");
    lines.push("Alerts:");
    for (const alert of alerts) {
      lines.push(`  - ${alert}`);
    }
  }

  return lines.join("\n");
}

// ── Основная логика ─────────────────────────────────────────────────────────

async function main() {
  // Проверяем наличие файла отчёта
  if (!fs.existsSync(REPORT_PATH)) {
    const errMsg = `[llm-cost-telegram] Файл отчёта не найден: ${REPORT_PATH}`;
    console.error(errMsg);
    // Отправляем алерт о проблеме
    const result = await sendStatus(
      `AI Cost Report -- ERROR\n\nФайл отчёта не найден: ${REPORT_PATH}\nЗапустите llm-cost-report.cjs для генерации.`,
      TOPIC_STATUS,
    );
    if (!result.ok) {
      console.error(`[llm-cost-telegram] Telegram send failed: ${result.error}`);
    }
    process.exit(1);
  }

  // Читаем и парсим отчёт
  /** @type {object} */
  let report;
  try {
    const raw = fs.readFileSync(REPORT_PATH, "utf-8");
    report = JSON.parse(raw);
  } catch (err) {
    const errMsg = `[llm-cost-telegram] Ошибка чтения/парсинга ${REPORT_PATH}: ${err.message}`;
    console.error(errMsg);
    await sendStatus(
      `AI Cost Report -- ERROR\n\nОшибка парсинга отчёта: ${err.message}`,
      TOPIC_STATUS,
    );
    process.exit(1);
  }

  // Форматируем и отправляем
  const message = formatMessage(report);
  console.log(`[llm-cost-telegram] Отправка отчёта в Telegram...`);
  console.log(message);

  const result = await sendStatus(message, TOPIC_STATUS);

  if (result.ok) {
    console.log(
      `[llm-cost-telegram] Отправлено успешно, message_id: ${result.messageId}`,
    );
  } else {
    console.error(
      `[llm-cost-telegram] Ошибка отправки: ${result.error}`,
    );
    process.exit(1);
  }

  // Langfuse trace
  await trace({
    name: "llm-cost-telegram",
    input: { report_path: REPORT_PATH },
    output: { total_usd: report.total_cost_usd, models: Object.keys(report.by_model || {}).length },
    metadata: { skill: "pepino-google-sheets", cron: "llm-cost-telegram" },
  }).catch(() => {});
}

main().catch((err) => {
  console.error(`[llm-cost-telegram] Необработанная ошибка: ${err.message}`);
  process.exit(1);
});
