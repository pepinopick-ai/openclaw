#!/usr/bin/env node
/**
 * llm-cost-report.cjs — Генератор отчётов по расходам LLM Router
 *
 * Читает /home/roman/logs/llm-costs.jsonl и формирует JSON-отчёт
 * для Grafana-дашборда pepino-ai-costs.
 *
 * CLI: node llm-cost-report.cjs [today|week|month]
 * Cron: every 5 min — see install instructions at end of file
 */

const fs = require("fs");
const path = require("path");

const LOG_FILE = "/home/roman/logs/llm-costs.jsonl";
const MONTHLY_BUDGET_USD = 80;

/**
 * Парсим JSONL-файл, возвращаем массив записей
 * @returns {Array<Object>}
 */
function readCostLog() {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`[ERROR] Лог-файл не найден: ${LOG_FILE}`);
    return [];
  }

  const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
  /** @type {Array<Object>} */
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      console.error(`[WARN] Строка ${i + 1} не парсится: ${err.message}`);
    }
  }

  return entries;
}

/**
 * Фильтрация записей по периоду
 * @param {Array<Object>} entries
 * @param {"today"|"week"|"month"} period
 * @returns {Array<Object>}
 */
function filterByPeriod(entries, period) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (period === "today") {
    return entries.filter((e) => (e.timestamp || "").startsWith(todayStr));
  }

  if (period === "week") {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return entries.filter((e) => new Date(e.timestamp) >= weekAgo);
  }

  if (period === "month") {
    const monthStr = now.toISOString().slice(0, 7);
    return entries.filter((e) => (e.timestamp || "").startsWith(monthStr));
  }

  return entries;
}

/**
 * Генерация полного отчёта
 * @param {Array<Object>} filtered — записи за выбранный период
 * @param {Array<Object>} allMonth — все записи за текущий месяц (для бюджета)
 * @param {string} period
 */
function generateReport(filtered, allMonth, period) {
  const totalTasks = filtered.length;
  const totalCost = filtered.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const avgCostPerTask = totalTasks > 0 ? totalCost / totalTasks : 0;
  const totalLatency = filtered.reduce((s, e) => s + (e.latency_ms || 0), 0);
  const avgLatency = totalTasks > 0 ? totalLatency / totalTasks : 0;

  // Дневная сводка (Daily Summary)
  const daily_summary = {
    period,
    total_tasks: totalTasks,
    total_cost_usd: round(totalCost, 4),
    avg_cost_per_task_usd: round(avgCostPerTask, 4),
    avg_latency_ms: Math.round(avgLatency),
  };

  // Разбивка по тирам (Tier Distribution)
  /** @type {Record<string, {count: number, cost: number}>} */
  const tierMap = {};
  for (const e of filtered) {
    const tier = e.tier || "unknown";
    if (!tierMap[tier]) tierMap[tier] = { count: 0, cost: 0 };
    tierMap[tier].count++;
    tierMap[tier].cost += e.cost_usd || 0;
  }
  const tier_distribution = Object.entries(tierMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tier, data]) => ({
      tier,
      count: data.count,
      pct: totalTasks > 0 ? round((data.count / totalTasks) * 100, 1) : 0,
      cost_usd: round(data.cost, 4),
    }));

  // Топ скиллов по стоимости (Top Skills by Cost)
  /** @type {Record<string, {count: number, cost: number}>} */
  const skillMap = {};
  for (const e of filtered) {
    const skill = e.skill || "unknown";
    if (!skillMap[skill]) skillMap[skill] = { count: 0, cost: 0 };
    skillMap[skill].count++;
    skillMap[skill].cost += e.cost_usd || 0;
  }
  const top_skills = Object.entries(skillMap)
    .map(([skill, data]) => ({
      skill: skill.replace("pepino-", ""),
      count: data.count,
      cost_usd: round(data.cost, 4),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, 10);

  // Использование моделей (Model Usage)
  /** @type {Record<string, {count: number, cost: number, input_tokens: number, output_tokens: number}>} */
  const modelMap = {};
  for (const e of filtered) {
    const model = e.model || "unknown";
    if (!modelMap[model]) modelMap[model] = { count: 0, cost: 0, input_tokens: 0, output_tokens: 0 };
    modelMap[model].count++;
    modelMap[model].cost += e.cost_usd || 0;
    modelMap[model].input_tokens += e.input_tokens || 0;
    modelMap[model].output_tokens += e.output_tokens || 0;
  }
  const model_usage = Object.entries(modelMap)
    .map(([model, data]) => ({
      model,
      count: data.count,
      cost_usd: round(data.cost, 4),
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  // Процент эскалаций (Escalation Rate)
  const escalated = filtered.filter((e) => e.escalated === true).length;
  const escalation_rate = totalTasks > 0 ? round((escalated / totalTasks) * 100, 1) : 0;

  // Cheap Pass Rate — процент задач T1, прошедших без эскалации
  const t1Tasks = filtered.filter((e) => e.tier === "T1");
  const t1Passed = t1Tasks.filter((e) => e.quality_passed === true && !e.escalated).length;
  const cheap_pass_rate = t1Tasks.length > 0 ? round((t1Passed / t1Tasks.length) * 100, 1) : 0;

  // Бюджет (Budget Tracking) — считаем по всему месяцу
  const monthCost = allMonth.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const projected = dayOfMonth > 0 ? (monthCost / dayOfMonth) * daysInMonth : 0;

  const budget = {
    monthly_budget_usd: MONTHLY_BUDGET_USD,
    spent_usd: round(monthCost, 4),
    spent_pct: round((monthCost / MONTHLY_BUDGET_USD) * 100, 1),
    remaining_usd: round(MONTHLY_BUDGET_USD - monthCost, 4),
    projected_usd: round(projected, 2),
    day_of_month: dayOfMonth,
    days_in_month: daysInMonth,
  };

  // Последние 20 задач (Recent Tasks)
  const recent_tasks = filtered
    .slice(-20)
    .reverse()
    .map((e) => ({
      timestamp: (e.timestamp || "").replace("T", " ").replace("Z", ""),
      skill: (e.skill || "").replace("pepino-", ""),
      intent: e.intent || "",
      tier: e.tier || "",
      model: e.model || "",
      cost_usd: round(e.cost_usd || 0, 4),
      latency_ms: e.latency_ms || 0,
      quality: e.quality_passed ? "OK" : "FAIL",
      escalated: e.escalated ? "YES" : "",
    }));

  return {
    generated_at: new Date().toISOString(),
    period,
    daily_summary,
    tier_distribution,
    top_skills,
    model_usage,
    escalation_rate,
    cheap_pass_rate,
    budget,
    recent_tasks,
  };
}

/**
 * Округление с заданной точностью
 * @param {number} num
 * @param {number} decimals
 * @returns {number}
 */
function round(num, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}

// ── Точка входа ──────────────────────────────────────────────────────────────

function main() {
  const period = process.argv[2] || "today";
  if (!["today", "week", "month"].includes(period)) {
    console.error(`Использование: node llm-cost-report.cjs [today|week|month]`);
    process.exit(1);
  }

  const allEntries = readCostLog();
  if (allEntries.length === 0) {
    console.error("[WARN] Нет записей в лог-файле");
    const emptyReport = generateReport([], [], period);
    console.log(JSON.stringify(emptyReport, null, 2));
    return;
  }

  const now = new Date();
  const monthStr = now.toISOString().slice(0, 7);
  const allMonth = allEntries.filter((e) => (e.timestamp || "").startsWith(monthStr));
  const filtered = filterByPeriod(allEntries, period);

  const report = generateReport(filtered, allMonth, period);
  console.log(JSON.stringify(report, null, 2));
}

main();
