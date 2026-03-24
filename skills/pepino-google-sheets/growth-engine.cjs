#!/usr/bin/env node
/**
 * growth-engine.cjs — Automated experiment designer, tracker, and evaluator.
 *
 * Completes the proactive intelligence triad:
 *   Revenue Brain  = WHO to sell to
 *   Profit Maximizer = WHAT to optimize in pricing/costs
 *   Growth Engine  = HOW to grow (this script)
 *
 * Thinks like a startup growth hacker: always testing, measuring, deciding.
 *
 * Commands:
 *   node growth-engine.cjs experiments   # List active experiments
 *   node growth-engine.cjs suggest       # AI-suggest new experiments from data
 *   node growth-engine.cjs evaluate      # Evaluate running experiments vs baselines
 *   node growth-engine.cjs weekly        # Weekly growth metrics dashboard
 *
 * Flags:
 *   --dry-run    Print to stdout, do not send to Telegram
 *
 * Storage: ~/.openclaw/workspace/memory/growth-experiments.json
 *
 * Cron:
 *   suggest:  30 11 * * 1   (Mon 08:30 ART = 11:30 UTC)
 *   evaluate: 0 20 * * 5    (Fri 17:00 ART = 20:00 UTC)
 *   weekly:   0 19 * * 0    (Sun 16:00 ART = 19:00 UTC)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getState } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { parseNum, parseDate, fmtNum } = require("./helpers.cjs");
const { normalize } = require("./product-aliases.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Config -------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD = 20; // Director/Strategy topic

const EXPERIMENTS_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "growth-experiments.json",
);

/** Auto-archive experiments older than this many days */
const ARCHIVE_AFTER_DAYS = 60;

/** Experiment types */
const EXP_TYPES = ["pricing", "product", "channel", "cost", "retention"];

/** Risk levels */
const RISK_LEVELS = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" };

// -- Utilities ----------------------------------------------------------------

/** Форматирует число как ARS */
function ars(n) {
  return `${fmtNum(Math.round(n))} ARS`;
}

/** Returns today as YYYY-MM-DD string */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Returns a date N days from now as YYYY-MM-DD */
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days between two YYYY-MM-DD strings (b - a). Positive = b is later. */
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

/** ISO week number of a Date */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Generates a unique experiment ID */
function generateId(experiments) {
  const nums = experiments
    .map((e) => parseInt((e.id || "").replace("exp-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `exp-${String(next).padStart(3, "0")}`;
}

// -- Storage ------------------------------------------------------------------

/**
 * Load experiments from JSON file.
 * Returns [] if file missing or corrupt.
 * @returns {object[]}
 */
function loadExperiments() {
  try {
    if (!fs.existsSync(EXPERIMENTS_FILE)) return [];
    const raw = fs.readFileSync(EXPERIMENTS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save experiments array to JSON file, creating dirs as needed.
 * @param {object[]} experiments
 */
function saveExperiments(experiments) {
  const dir = path.dirname(EXPERIMENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EXPERIMENTS_FILE, JSON.stringify(experiments, null, 2), "utf-8");
}

/**
 * Auto-archive experiments that are completed/stopped and older than ARCHIVE_AFTER_DAYS.
 * Mutates the array in place, returns count archived.
 * @param {object[]} experiments
 * @returns {number}
 */
function archiveStale(experiments) {
  let count = 0;
  const cutoff = today();
  for (const exp of experiments) {
    if (exp.status === "archived") continue;
    if (
      exp.status !== "active" &&
      daysBetween(exp.started || cutoff, cutoff) > ARCHIVE_AFTER_DAYS
    ) {
      exp.status = "archived";
      count++;
    }
  }
  return count;
}

// -- Data helpers -------------------------------------------------------------

/**
 * Filters sales rows to last N days.
 * @param {object[]} rows
 * @param {number} days
 * @returns {object[]}
 */
function salesInPeriod(rows, days) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  return rows.filter((r) => {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    return d && d >= cutoff;
  });
}

/**
 * Aggregates sales by product: kg, ars, count.
 * @param {object[]} rows
 * @returns {Map<string, {kg: number, ars: number, count: number}>}
 */
function aggregateByProduct(rows) {
  const map = new Map();
  for (const r of rows) {
    const raw = (r["Продукт"] || r["Товар"] || r["Producto"] || "").trim();
    if (!raw) continue;
    const product = normalize(raw);
    if (!product || product.length < 2) continue;
    const kg = parseNum(r["Кол-во кг"] || r["Cantidad kg"] || r["Кг"] || 0);
    const amount = parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0);
    const existing = map.get(product) || { kg: 0, ars: 0, count: 0 };
    map.set(product, {
      kg: existing.kg + kg,
      ars: existing.ars + amount,
      count: existing.count + 1,
    });
  }
  return map;
}

/**
 * Aggregates sales by client: total ars, order count.
 * @param {object[]} rows
 * @returns {Map<string, {ars: number, count: number, products: Set<string>}>}
 */
function aggregateByClient(rows) {
  const map = new Map();
  for (const r of rows) {
    const name = (r["Клиент"] || r["клиент"] || "").trim();
    if (!name) continue;
    const amount = parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0);
    const raw = (r["Продукт"] || r["Товар"] || "").trim();
    const product = raw ? normalize(raw) : "";
    const existing = map.get(name) || { ars: 0, count: 0, products: new Set() };
    existing.ars += amount;
    existing.count += 1;
    if (product) existing.products.add(product);
    map.set(name, existing);
  }
  return map;
}

// -- COMMAND: experiments ------------------------------------------------------

/**
 * Formats a table of all non-archived experiments.
 * @param {object[]} experiments
 * @returns {string}
 */
function buildExperimentsMessage(experiments) {
  const active = experiments.filter((e) => e.status !== "archived");

  if (active.length === 0) {
    return [
      "🧪 *EXPERIMENTS — Активные эксперименты*\n",
      "Нет активных экспериментов.",
      "",
      "_Запусти: node growth-engine.cjs suggest — для генерации идей_",
    ].join("\n");
  }

  const lines = [`🧪 *EXPERIMENTS — Активные эксперименты (${active.length})*\n`];

  const byStatus = { active: [], completed: [], stopped: [] };
  for (const exp of active) {
    (byStatus[exp.status] || byStatus.active).push(exp);
  }

  for (const [statusKey, label] of [
    ["active", "ИДУТ"],
    ["completed", "ЗАВЕРШЕНЫ"],
    ["stopped", "ОСТАНОВЛЕНЫ"],
  ]) {
    const group = byStatus[statusKey];
    if (!group || group.length === 0) continue;
    lines.push(`*${label}:*`);
    for (const exp of group) {
      const daysLeft = exp.deadline ? daysBetween(today(), exp.deadline) : null;
      const daysLeftStr =
        daysLeft !== null
          ? daysLeft > 0
            ? `${daysLeft} дн. осталось`
            : `просрочен ${Math.abs(daysLeft)} дн.`
          : "без дедлайна";
      const icon = statusKey === "active" ? "⏳" : statusKey === "completed" ? "✅" : "❌";
      lines.push(`${icon} *${exp.id}*: ${exp.name}`);
      lines.push(`   Тип: ${exp.type} | Риск: ${exp.risk || "?"} | ${daysLeftStr}`);
      lines.push(`   Метрика: ${exp.metric} | Цель: ${exp.target}`);
      if (exp.result) lines.push(`   Результат: ${exp.result}`);
      if (exp.decision) lines.push(`   Решение: ${exp.decision}`);
      lines.push("");
    }
  }

  lines.push("_Подробнее: node growth-engine.cjs evaluate_");
  return lines.join("\n");
}

// -- COMMAND: suggest ----------------------------------------------------------

/**
 * Generates data-driven experiment suggestions.
 * Reads from farm-state + client-analytics to build ideas grounded in real numbers.
 * @param {object} state - farm state
 * @param {object[]} clientList - from analyzeClients()
 * @param {object[]} experiments - existing experiments (to avoid duplicates)
 * @returns {string}
 */
function buildSuggestMessage(state, clientList, experiments) {
  const { sales = [], production = [], expenses = [] } = state;
  const financials = state.analytics?.financial || { week: {}, month: {} };
  const stock = state.analytics?.stock || {};

  const recentSales = salesInPeriod(sales, 30);
  const productMap = aggregateByProduct(recentSales);
  const clientMap = aggregateByClient(recentSales);

  const weekRevenue = financials.week?.revenue || 0;
  const monthRevenue = financials.month?.revenue || 0;

  // Active experiment names set (to skip near-duplicates)
  const activeNames = new Set(
    experiments.filter((e) => e.status === "active").map((e) => e.name.toLowerCase()),
  );

  // ── Pricing experiments ────────────────────────────────────────────────────
  const pricingIdeas = [];

  // Find products with consistent high demand: candidates for price raise
  const productsByRevenue = [...productMap.entries()]
    .filter(([, v]) => v.ars > 0 && v.kg > 0)
    .sort(([, a], [, b]) => b.ars - a.ars);

  if (productsByRevenue.length > 0) {
    const [topProduct, topData] = productsByRevenue[0];
    const avgPrice = Math.round(topData.ars / topData.kg);
    const weeklyKg = Math.round((topData.kg / 30) * 7);
    const raisedPrice = Math.round(avgPrice * 1.2);
    const potentialArs = Math.round((raisedPrice - avgPrice) * weeklyKg);
    const stockInfo = stock[topProduct];
    const stockDays = stockInfo ? stockInfo.days : 7;

    if (stockDays < 10) {
      pricingIdeas.push({
        name: `Цена ${topProduct} +20% для новых клиентов`,
        hypothesis: `Новые клиенты ценят уникальность продукта и примут цену ${fmtNum(raisedPrice)} ARS/кг`,
        type: "pricing",
        metric: "Конверсия новых клиентов (%)",
        baseline: 80,
        target: 60,
        durationDays: 14,
        risk: RISK_LEVELS.LOW,
        tags: ["pricing", topProduct.toLowerCase()],
        potentialArs,
      });
    }

    // Bundle idea: top product + complementary
    if (productsByRevenue.length >= 2) {
      const [secondProduct] = productsByRevenue[1];
      pricingIdeas.push({
        name: `Бандл: ${topProduct} + ${secondProduct} со скидкой 10%`,
        hypothesis: `Связанная покупка увеличит средний чек и снизит потери у клиентов`,
        type: "pricing",
        metric: "Средний чек ARS",
        baseline: Math.round(weekRevenue / Math.max(1, clientMap.size)),
        target: Math.round((weekRevenue / Math.max(1, clientMap.size)) * 1.15),
        durationDays: 21,
        risk: RISK_LEVELS.LOW,
        tags: ["pricing", "bundle", topProduct.toLowerCase()],
        potentialArs: Math.round(weekRevenue * 0.1),
      });
    }
  }

  // ── Product experiments ────────────────────────────────────────────────────
  const productIdeas = [];

  // Find clients buying < 3 unique products in last 30d (undersaturated)
  const undersaturated = [...clientMap.entries()].filter(([, v]) => v.products.size < 3);

  if (undersaturated.length > 0) {
    // Look for a product no one is buying yet from known product list
    const knownProducts = ["Микрозелень", "Редис", "Шпинат", "Руккола", "Острый соус", "Пелюстка"];
    const boughtProducts = new Set([...productMap.keys()]);
    const untriedProducts = knownProducts.filter((p) => !boughtProducts.has(normalize(p)));

    const targetClient = undersaturated[0][0];
    const targetClientData = undersaturated[0][1];

    if (untriedProducts.length > 0) {
      const newProduct = untriedProducts[0];
      productIdeas.push({
        name: `Тест ${newProduct} с ${undersaturated.length} клиентами на 2 недели`,
        hypothesis: `Новый продукт органично дополняет текущий ассортимент покупок`,
        type: "product",
        metric: `Продажи ${newProduct} кг/нед`,
        baseline: 0,
        target: 5,
        durationDays: 14,
        risk: RISK_LEVELS.LOW,
        tags: ["product", newProduct.toLowerCase()],
        potentialArs: Math.round(5 * 1500), // estimate 1500 ARS/kg
      });
    }

    // Add product to specific undersaturated client
    const allProductsInSystem = [...boughtProducts];
    const clientProductsSet = targetClientData.products;
    const missingForClient = allProductsInSystem.filter((p) => !clientProductsSet.has(p));

    if (missingForClient.length > 0) {
      const suggestedProduct = missingForClient[0];
      productIdeas.push({
        name: `Добавить ${suggestedProduct} в ассортимент ${targetClient}`,
        hypothesis: `${targetClient} покупает только ${targetClientData.products.size} продукта — расширение логично`,
        type: "product",
        metric: `Продажи ${suggestedProduct} через ${targetClient} кг/нед`,
        baseline: 0,
        target: 3,
        durationDays: 21,
        risk: RISK_LEVELS.LOW,
        tags: ["product", "upsell", suggestedProduct.toLowerCase()],
        potentialArs: Math.round(3 * (weekRevenue / Math.max(1, clientMap.size) / 10)),
      });
    }
  }

  // ── Channel experiments ────────────────────────────────────────────────────
  const channelIdeas = [
    {
      name: "3 Reels/нед в Instagram на 1 месяц",
      hypothesis: "Визуальный контент с ферм привлекает B2C клиентов и повышает узнаваемость",
      type: "channel",
      metric: "Подписчики Instagram и DM-обращения",
      baseline: 0,
      target: 100,
      durationDays: 30,
      risk: RISK_LEVELS.LOW,
      tags: ["channel", "instagram", "content"],
      potentialArs: 0,
    },
    {
      name: "WhatsApp-рассылка 30 контактам с недельными спецпредложениями",
      hypothesis: "Персональная рассылка напоминает о ферме и генерирует повторные заказы",
      type: "channel",
      metric: "Конверсия в заказ (%)",
      baseline: 0,
      target: 15,
      durationDays: 28,
      risk: RISK_LEVELS.LOW,
      tags: ["channel", "whatsapp", "retention"],
      potentialArs: Math.round(weekRevenue * 0.05),
    },
    {
      name: "Реферальная программа: попросить 3 лучших клиента рекомендовать",
      hypothesis: "Органические рекомендации дешевле и конвертируют лучше холодного трафика",
      type: "channel",
      metric: "Новые клиенты по рекомендации",
      baseline: 0,
      target: 2,
      durationDays: 30,
      risk: RISK_LEVELS.LOW,
      tags: ["channel", "referral"],
      potentialArs: Math.round(weekRevenue * 0.1),
    },
  ];

  // ── Cost experiments ───────────────────────────────────────────────────────
  const recentExpenses = salesInPeriod(expenses, 30);
  const totalExpenses30d = recentExpenses.reduce(
    (s, r) => s + parseNum(r["Сумма"] || r["Сумма ARS"] || 0),
    0,
  );

  const costIdeas = [
    {
      name: "Закупка упаковки оптом 1000+ шт — сравнить цену за единицу",
      hypothesis: "Оптовая закупка снизит стоимость упаковки на 25-35%",
      type: "cost",
      metric: "Стоимость упаковки ARS/шт",
      baseline: Math.round((totalExpenses30d * 0.08) / 500),
      target: Math.round((totalExpenses30d * 0.08) / 1000),
      durationDays: 14,
      risk: RISK_LEVELS.MEDIUM,
      tags: ["cost", "packaging"],
      potentialArs: Math.round((totalExpenses30d * 0.03 * 12) / 12), // monthly saving
    },
    {
      name: "Тест маршрута доставки: 2 рейса вместо 3 за неделю",
      hypothesis: "Оптимизация маршрута сокращает расходы на топливо на 15%",
      type: "cost",
      metric: "Расходы на доставку ARS/нед",
      baseline: Math.round((totalExpenses30d * 0.12) / 4),
      target: Math.round((totalExpenses30d * 0.1) / 4),
      durationDays: 14,
      risk: RISK_LEVELS.LOW,
      tags: ["cost", "delivery", "logistics"],
      potentialArs: Math.round(totalExpenses30d * 0.02),
    },
  ];

  // ── Retention experiments ──────────────────────────────────────────────────
  const churnedClients = clientList.filter((c) => c.status === "churned" || c.daysSinceLast > 30);

  const retentionIdeas = [];

  if (churnedClients.length > 0) {
    retentionIdeas.push({
      name: `Позвонить ${Math.min(churnedClients.length, 5)} ушедшим клиентам со спецпредложением`,
      hypothesis: "Личный звонок с оффером возвращает 20-30% churned-клиентов",
      type: "retention",
      metric: "Повторный заказ от churned (%)",
      baseline: 0,
      target: 25,
      durationDays: 14,
      risk: RISK_LEVELS.LOW,
      tags: ["retention", "churn", "reactivation"],
      potentialArs: Math.round(
        churnedClients
          .slice(0, 5)
          .reduce((s, c) => s + c.total_ars / Math.max(1, c.orders?.length || 1), 0) * 0.25,
      ),
    });
  }

  retentionIdeas.push({
    name: "Карточка с рецептом в каждую доставку на 2 недели",
    hypothesis: "Добавленная ценность укрепляет лояльность и снижает churn",
    type: "retention",
    metric: "Repeat order rate (%)",
    baseline: Math.round(
      (clientList.filter((c) => c.status === "active").length / Math.max(1, clientList.length)) *
        100,
    ),
    target: 85,
    durationDays: 14,
    risk: RISK_LEVELS.LOW,
    tags: ["retention", "loyalty"],
    potentialArs: 0,
  });

  // ── Assemble all ideas, filter already active ──────────────────────────────
  const allIdeas = [
    ...pricingIdeas,
    ...productIdeas,
    ...channelIdeas,
    ...costIdeas,
    ...retentionIdeas,
  ].filter((idea) => !activeNames.has(idea.name.toLowerCase()));

  // Top 5 by potential ARS, then by risk (LOW first)
  const riskOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const sorted = allIdeas
    .slice()
    .sort(
      (a, b) =>
        (riskOrder[a.risk] || 0) - (riskOrder[b.risk] || 0) || b.potentialArs - a.potentialArs,
    )
    .slice(0, 5);

  const typeIcon = {
    pricing: "💰",
    product: "📦",
    channel: "📱",
    cost: "✂️",
    retention: "🔄",
  };

  const lines = [`🧪 *SUGGESTED EXPERIMENTS*\n`];

  sorted.forEach((idea, i) => {
    const icon = typeIcon[idea.type] || "🔬";
    lines.push(`${i + 1}. ${icon} *${idea.name}*`);
    lines.push(`   Гипотеза: ${idea.hypothesis}`);
    lines.push(`   Метрика: ${idea.metric}`);
    lines.push(`   Baseline: ${idea.baseline} → Цель: ${idea.target}`);
    lines.push(`   Срок: ${idea.durationDays} дней`);
    lines.push(`   Риск: ${idea.risk}`);
    if (idea.potentialArs > 0) {
      lines.push(`   Потенциал: +${ars(idea.potentialArs)}/нед`);
    }
    lines.push("");
  });

  lines.push(
    "_Запустить эксперимент: добавь в growth-experiments.json или запусти suggest без --dry-run_",
  );

  if (!DRY_RUN && sorted.length > 0) {
    // Auto-save new suggestions as proposed experiments
    const existing = loadExperiments();
    let added = 0;
    for (const idea of sorted) {
      const duplicate = existing.some(
        (e) => e.name.toLowerCase() === idea.name.toLowerCase() && e.status !== "archived",
      );
      if (duplicate) continue;
      existing.push({
        id: generateId(existing),
        name: idea.name,
        hypothesis: idea.hypothesis,
        type: idea.type,
        status: "active",
        started: today(),
        deadline: daysFromNow(idea.durationDays),
        metric: idea.metric,
        baseline: idea.baseline,
        target: idea.target,
        current: null,
        result: null,
        decision: null,
        risk: idea.risk,
        tags: idea.tags,
        potentialArs: idea.potentialArs,
      });
      added++;
    }
    if (added > 0) saveExperiments(existing);
    lines.push(`\n_Сохранено ${added} новых экспериментов в growth-experiments.json_`);
  }

  return lines.join("\n");
}

// -- COMMAND: evaluate ---------------------------------------------------------

/**
 * Evaluates running experiments against current data.
 * Updates status to completed/stopped when deadline passed or target reached.
 * @param {object[]} experiments
 * @param {object} state
 * @param {object[]} clientList
 * @returns {{ message: string, experiments: object[] }}
 */
function evaluateExperiments(experiments, state, clientList) {
  const { sales = [] } = state;
  const recentSales = salesInPeriod(sales, 30);
  const productMap = aggregateByProduct(recentSales);
  const clientMap = aggregateByClient(recentSales);

  const active = experiments.filter((e) => e.status === "active");

  if (active.length === 0) {
    return {
      message: [
        "📊 *EXPERIMENT RESULTS*\n",
        "Нет активных экспериментов для оценки.",
        "",
        "_Запусти: node growth-engine.cjs suggest — чтобы добавить эксперименты_",
      ].join("\n"),
      experiments,
    };
  }

  const lines = [`📊 *EXPERIMENT RESULTS*\n`];
  const todayStr = today();

  for (const exp of active) {
    const deadlinePassed = exp.deadline && daysBetween(todayStr, exp.deadline) < 0;
    const daysRunning = exp.started ? daysBetween(exp.started, todayStr) : 0;
    const totalDays = exp.deadline && exp.started ? daysBetween(exp.started, exp.deadline) : 14;

    // Estimate current metric from data
    let currentValue = null;
    let successMessage = "";
    let failMessage = "";

    if (exp.type === "pricing") {
      // For pricing: approximate from revenue change
      const weekRev = state.analytics?.financial?.week?.revenue || 0;
      const prevWeekRev = weekRev * 0.95; // rough estimate without historical
      currentValue = weekRev > 0 ? Math.round((weekRev / Math.max(1, prevWeekRev)) * 100) : null;
    } else if (exp.type === "product") {
      // Look for specific product in metric tag
      const productTag = (exp.tags || []).find(
        (t) => t !== "product" && t !== "upsell" && t.length > 2,
      );
      if (productTag) {
        const canonName = normalize(productTag);
        const productData = productMap.get(canonName);
        if (productData) {
          currentValue = Math.round(productData.kg / 4); // weekly kg
        }
      }
    } else if (exp.type === "retention") {
      const activeClients = clientList.filter((c) => c.status === "active").length;
      const totalClients = clientList.length;
      currentValue = totalClients > 0 ? Math.round((activeClients / totalClients) * 100) : null;
    } else if (exp.type === "channel") {
      // Cannot measure channels without external API; note as manual check needed
      currentValue = null;
    } else if (exp.type === "cost") {
      const monthExpenses = state.analytics?.financial?.month?.expenses || 0;
      currentValue = monthExpenses > 0 ? Math.round(monthExpenses / 4) : null;
    }

    // Update current in place
    exp.current = currentValue;

    // Determine outcome
    let statusIcon = "⏳";
    let decision = null;
    let outcomeText = "";

    const targetNum = parseNum(exp.target);
    const baselineNum = parseNum(exp.baseline);
    const targetIsHigherGood = targetNum >= baselineNum;

    if (currentValue !== null) {
      const targetMet = targetIsHigherGood ? currentValue >= targetNum : currentValue <= targetNum;

      if (targetMet && deadlinePassed) {
        statusIcon = "✅";
        exp.status = "completed";
        exp.result = `${exp.metric}: ${currentValue} (цель: ${targetNum}) — УСПЕХ`;
        decision = "МАСШТАБИРОВАТЬ — применить на всех подходящих клиентах";
        exp.decision = decision;
        successMessage = `Доп. выручка: ~${ars(exp.potentialArs || 0)}/нед`;
      } else if (!targetMet && deadlinePassed) {
        statusIcon = "❌";
        exp.status = "stopped";
        exp.result = `${exp.metric}: ${currentValue} (цель: ${targetNum}) — НЕ ДОСТИГНУТО`;
        decision = "ОСТАНОВИТЬ — вернуться к прежнему подходу";
        exp.decision = decision;
        failMessage = "Убытков нет — просто не работает. Ищем другую гипотезу.";
      } else if (deadlinePassed) {
        // Deadline passed, no clear signal
        statusIcon = "❓";
        exp.status = "stopped";
        exp.result = `${exp.metric}: не измерено — дедлайн прошёл`;
        decision = "ЗАКРЫТЬ — добавить ручное измерение перед следующим тестом";
        exp.decision = decision;
      }
    }

    const progressPct =
      totalDays > 0 ? Math.min(100, Math.round((daysRunning / totalDays) * 100)) : 0;
    const barFilled = Math.round(progressPct / 10);
    const bar = "█".repeat(barFilled) + "░".repeat(10 - barFilled);

    lines.push(`${statusIcon} *${exp.id}*: ${exp.name}`);
    if (exp.status === "completed" || exp.status === "stopped") {
      lines.push(`   Результат: ${exp.result}`);
      if (decision) lines.push(`   Решение: ${decision}`);
      if (successMessage) lines.push(`   ${successMessage}`);
      if (failMessage) lines.push(`   ${failMessage}`);
    } else {
      lines.push(`   Прогресс: ${bar} ${progressPct}% (день ${daysRunning}/${totalDays})`);
      if (currentValue !== null) {
        lines.push(`   Текущий показатель: ${currentValue} (цель: ${targetNum})`);
      } else {
        lines.push(`   Требует ручного измерения`);
      }
      if (exp.deadline) {
        const dLeft = daysBetween(todayStr, exp.deadline);
        lines.push(`   Осталось: ${dLeft > 0 ? dLeft + " дн." : "дедлайн сегодня"}`);
      }
    }
    lines.push("");
  }

  // Archive stale closed experiments
  const archivedCount = archiveStale(experiments);
  if (archivedCount > 0) {
    lines.push(
      `_Архивировано ${archivedCount} старых экспериментов (>${ARCHIVE_AFTER_DAYS} дн.)_\n`,
    );
  }

  return { message: lines.join("\n"), experiments };
}

// -- COMMAND: weekly -----------------------------------------------------------

/**
 * Builds the weekly growth dashboard.
 * @param {object} state
 * @param {object[]} clientList
 * @param {object[]} experiments
 * @returns {string}
 */
function buildWeeklyMessage(state, clientList, experiments) {
  const { sales = [] } = state;
  const financials = state.analytics?.financial || { week: {}, month: {} };

  const weekRevenue = financials.week?.revenue || 0;
  const prevWeekRevenue = weekRevenue * 0.92; // approximate without rolling history
  const weekRevGrowth =
    prevWeekRevenue > 0 ? ((weekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100 : 0;

  const activeClients = clientList.filter((c) => c.status === "active");
  const newClients = clientList.filter(
    (c) =>
      c.first_order && daysBetween(c.first_order.toISOString?.()?.slice(0, 10) || "", today()) <= 7,
  );
  const churnedClients = clientList.filter((c) => c.status === "churned");

  // Product count from recent sales
  const recentSales = salesInPeriod(sales, 7);
  const productMap = aggregateByProduct(recentSales);
  const activeProductCount = productMap.size;

  // Average order value this week
  const clientMap = aggregateByClient(recentSales);
  const totalOrders = [...clientMap.values()].reduce((s, v) => s + v.count, 0);
  const avgOrderArs = totalOrders > 0 ? Math.round(weekRevenue / totalOrders) : 0;

  // Repeat rate: clients with >1 order in 30 days
  const recentSales30 = salesInPeriod(sales, 30);
  const clientMap30 = aggregateByClient(recentSales30);
  const repeatClients = [...clientMap30.values()].filter((v) => v.count > 1).length;
  const repeatRate =
    clientMap30.size > 0 ? Math.round((repeatClients / clientMap30.size) * 100) : 0;

  // Experiments stats
  const activeExps = experiments.filter((e) => e.status === "active");
  const completedThisWeek = experiments.filter(
    (e) =>
      (e.status === "completed" || e.status === "stopped") &&
      e.deadline &&
      daysBetween(e.deadline, today()) >= 0 &&
      daysBetween(e.deadline, today()) <= 7,
  );
  const successfulTotal = experiments.filter((e) => e.status === "completed").length;
  const stoppedTotal = experiments.filter((e) => e.status === "stopped").length;
  const winRate =
    successfulTotal + stoppedTotal > 0
      ? Math.round((successfulTotal / (successfulTotal + stoppedTotal)) * 100)
      : 0;

  // Growth opportunities
  const undersaturated = [...clientMap30.entries()]
    .map(([name, v]) => ({ name, productCount: v.products.size }))
    .filter((c) => c.productCount < 3);

  const weekNum = getWeekNumber(new Date());

  const trendArrow = (val, positive = true) => {
    if (val > 2) return "↑";
    if (val < -2) return "↓";
    return "→";
  };

  const lines = [
    `📈 *GROWTH REPORT — неделя ${weekNum}*\n`,
    "*КЛЮЧЕВЫЕ МЕТРИКИ:*",
    `  Клиенты: ${activeClients.length} (${newClients.length > 0 ? `+${newClients.length} новых` : "нет новых"}, -${churnedClients.filter((c) => daysBetween(c.last_order?.toISOString?.()?.slice(0, 10) || today(), today()) <= 14).length} ушедших) ${trendArrow(newClients.length - churnedClients.length)}`,
    `  Выручка/нед: ${ars(weekRevenue)} (${weekRevGrowth >= 0 ? "+" : ""}${Math.round(weekRevGrowth)}%) ${trendArrow(weekRevGrowth)}`,
    `  Средний чек: ${ars(avgOrderArs)} ${trendArrow(0)}`,
    `  Продуктов активных: ${activeProductCount} ${trendArrow(0)}`,
    `  Повторные заказы: ${repeatRate}% ${trendArrow(repeatRate - 70)}`,
    "",
    "*ЭКСПЕРИМЕНТЫ:*",
    `  Активных: ${activeExps.length}`,
    `  Завершённых за неделю: ${completedThisWeek.length}`,
    `  Win rate: ${winRate}% (за всё время, ${successfulTotal} успехов / ${stoppedTotal} остановлено)`,
    "",
  ];

  // Growth opportunities
  lines.push("*GROWTH OPPORTUNITIES:*");

  if (undersaturated.length > 0) {
    lines.push(
      `  1. Ненасыщенные клиенты: ${undersaturated.length} покупают <3 продуктов (${undersaturated
        .slice(0, 3)
        .map((c) => c.name)
        .join(", ")})`,
    );
  }

  // Products not sold in last 7 days but present in 30-day history
  const productMap30 = aggregateByProduct(recentSales30);
  const dormantProducts = [...productMap30.keys()].filter((p) => !productMap.has(p));
  if (dormantProducts.length > 0) {
    lines.push(
      `  2. Спящие продукты (не продавались 7 дней): ${dormantProducts.slice(0, 3).join(", ")}`,
    );
  }

  // Churned clients with recent history
  const recoverableChurn = churnedClients.filter(
    (c) =>
      c.last_order && daysBetween(c.last_order.toISOString?.()?.slice(0, 10) || "", today()) <= 45,
  );
  if (recoverableChurn.length > 0) {
    lines.push(
      `  3. Восстановимые уходы (последний заказ <45 дн.): ${recoverableChurn.length} клиентов`,
    );
  }

  // Weekly recommendation
  lines.push("");
  lines.push("*РЕКОМЕНДАЦИЯ НЕДЕЛИ:*");

  if (activeExps.length === 0) {
    lines.push("  Нет активных экспериментов — запусти: node growth-engine.cjs suggest");
  } else {
    const topExp = activeExps.sort((a, b) => (b.potentialArs || 0) - (a.potentialArs || 0))[0];
    lines.push(`  Фокус на: *${topExp.name}*`);
    if (topExp.potentialArs) lines.push(`  Ожидаемый эффект: +${ars(topExp.potentialArs)}/нед`);
    lines.push(`  Дедлайн: ${topExp.deadline || "не задан"}`);
  }

  if (undersaturated.length > 0) {
    lines.push("");
    lines.push(
      `  Быстрая победа: предложить доп. продукт ${undersaturated[0].name} → +15% к заказу`,
    );
  }

  lines.push("");
  lines.push(`_Подробно: node growth-engine.cjs experiments | evaluate | suggest_`);

  return lines.join("\n");
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const command = args[0];

  const validCommands = ["experiments", "suggest", "evaluate", "weekly"];

  if (!command || !validCommands.includes(command)) {
    console.error(
      "Usage: node growth-engine.cjs <experiments|suggest|evaluate|weekly> [--dry-run]",
    );
    console.error("\nCommands:");
    console.error("  experiments  List active experiments");
    console.error("  suggest      AI-suggest new experiments from real data");
    console.error("  evaluate     Evaluate running experiments vs baselines");
    console.error("  weekly       Weekly growth metrics dashboard");
    process.exit(1);
  }

  const startMs = Date.now();
  console.error(`[growth-engine] command=${command} dry-run=${DRY_RUN}`);

  // Load state and client analytics
  let state;
  try {
    state = await getState();
  } catch (err) {
    console.error(`[growth-engine] Ошибка загрузки farm-state: ${err.message}`);
    process.exit(1);
  }

  let clientList = [];
  try {
    const analysis = await analyzeClients(state.sales);
    clientList = analysis.clients || [];
  } catch (err) {
    console.error(`[growth-engine] Предупреждение: client-analytics недоступен: ${err.message}`);
  }

  // Load experiments from disk
  let experiments = loadExperiments();

  let message = "";

  if (command === "experiments") {
    message = buildExperimentsMessage(experiments);
  } else if (command === "suggest") {
    message = buildSuggestMessage(state, clientList, experiments);
  } else if (command === "evaluate") {
    const result = evaluateExperiments(experiments, state, clientList);
    message = result.message;
    experiments = result.experiments;
    if (!DRY_RUN) {
      saveExperiments(experiments);
      console.error("[growth-engine] Эксперименты обновлены в", EXPERIMENTS_FILE);
    }
  } else if (command === "weekly") {
    // Auto-run evaluate before weekly to get fresh statuses
    const evalResult = evaluateExperiments(experiments, state, clientList);
    experiments = evalResult.experiments;
    if (!DRY_RUN) saveExperiments(experiments);

    message = buildWeeklyMessage(state, clientList, experiments);
  }

  const durationMs = Date.now() - startMs;

  if (DRY_RUN) {
    console.log("--- DRY RUN ---");
    console.log(message);
    console.log("--- END DRY RUN ---");
    console.log(
      `[growth-engine] command=${command} clients=${clientList.length} experiments=${experiments.length} duration=${durationMs}ms`,
    );
  } else {
    try {
      const result = await sendThrottled(message, {
        thread: TG_THREAD,
        priority: command === "weekly" ? "high" : "normal",
        parseMode: "Markdown",
      });
      console.log(
        `[growth-engine] command=${command} clients=${clientList.length} experiments=${experiments.length} telegram=${result.action} duration=${durationMs}ms`,
      );
    } catch (err) {
      console.error(`[growth-engine] Ошибка отправки Telegram: ${err.message}`);
      console.log(message);
    }
  }

  // Langfuse trace
  await trace({
    name: "growth-engine",
    input: { command, dryRun: DRY_RUN, clientCount: clientList.length },
    output: {
      chars: message.length,
      experimentsActive: experiments.filter((e) => e.status === "active").length,
      action: DRY_RUN ? "dry_run" : "sent",
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "growth-engine",
      command,
    },
  });
}

main().catch((err) => {
  console.error(`[growth-engine] FATAL: ${err.message}`);
  process.exit(1);
});
