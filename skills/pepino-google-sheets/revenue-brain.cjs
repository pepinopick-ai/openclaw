#!/usr/bin/env node
/**
 * revenue-brain.cjs — Revenue generation engine for Pepino Pick.
 *
 * Not analytics. Not reports. MONEY ACTIONS.
 * Tells the operator WHO to call, WHAT to sell, and HOW MUCH they'll earn.
 *
 * Commands:
 *   node revenue-brain.cjs morning     # Morning revenue opportunities (top 3)
 *   node revenue-brain.cjs call-list   # Full prioritized call list with scripts
 *   node revenue-brain.cjs upsell      # Upsell opportunities for existing clients
 *   node revenue-brain.cjs newbiz      # New client acquisition targets
 *
 * Flags:
 *   --dry-run    Print to stdout, do not send to Telegram
 *
 * Cron: 0 11 * * 1-6  (11:00 UTC = 07:00 ART, Mon-Sat)
 */

"use strict";

const { getState } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { normalize } = require("./product-aliases.cjs");
const { fmtNum } = require("./helpers.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// ── Constants ────────────────────────────────────────────────────────────────

const TELEGRAM_THREAD_DIRECTOR = 20;

/**
 * Cross-sell matrix: if a client buys key product → suggest these additions.
 * Values are canonical names from product-aliases.cjs.
 */
const CROSS_SELL = {
  Огурец: ["Соленые огурцы", "Корнишон", "Укроп"],
  Томат: ["Квашеные томаты", "Пелюстка", "Базилик"],
  Корнишон: ["Соленые огурцы", "Укроп"],
  Баклажан: ["Острый перец", "Острый соус"],
  "Острый перец": ["Острый соус", "Базилик"],
  Кабачок: ["Укроп", "Базилик"],
  Зелень: ["Острый соус", "Укроп", "Базилик"],
  Укроп: ["Щавель", "Зеленый лук", "Мята"],
};

/**
 * New business targets — potential clients not yet in sales data.
 * Managed here until a dedicated Sheets tab is created.
 */
const NEW_BIZ_TARGETS = [
  {
    name: "Don Julio (Palermo)",
    type: "ресторан",
    advantage: "25+ сортов томатов, прямые поставки с фермы",
    firstStep: "Отправить каталог в Instagram DM @donjuliorestaurant",
    estimatedArs: 80000,
  },
  {
    name: "Авоська",
    type: "производство",
    advantage: "Прямые поставки огурца для консервации, стабильный объём",
    firstStep: "Предложить тестовую партию 20кг по спеццене",
    estimatedArs: 60000,
  },
  {
    name: "La Mar (Palermo)",
    type: "ресторан",
    advantage: "Микрозелень и съедобные цветы — уникально для их кухни",
    firstStep: "Занести пробный набор лично",
    estimatedArs: 45000,
  },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Urgency indicator: red/yellow/green based on overdue days.
 * @param {number} overdueDays - days past expected order date (negative = not yet due)
 * @returns {string}
 */
function urgencyDot(overdueDays) {
  if (overdueDays >= 7) return "🔴";
  if (overdueDays >= 0) return "🟡";
  return "🟢";
}

/**
 * Suggested call action based on urgency.
 * @param {number} overdueDays
 * @returns {string}
 */
function callAction(overdueDays) {
  if (overdueDays >= 14) return "Позвонить СЕГОДНЯ";
  if (overdueDays >= 0) return "Написать в WhatsApp";
  return "Подтвердить заказ";
}

/**
 * Short opening phrase tailored to the client's situation.
 * @param {object} client - enriched client object
 * @returns {string}
 */
function openingPhrase(client) {
  const firstName = client.name.split(/\s/)[0];

  if (client.status === "churned" || client.overdueDays >= 21) {
    return `Здравствуйте! Давно не виделись, хотим предложить кое-что интересное`;
  }
  if (client.status === "at_risk" || client.overdueDays >= 7) {
    return `${firstName}, привет! Давно не заказывали — как дела, всё хорошо?`;
  }
  // Active, specific product hook
  const topProduct = client.topProducts[0];
  if (topProduct) {
    return `${firstName}, привет! Свежий ${topProduct.toLowerCase()} готов, есть запас`;
  }
  return `${firstName}, подтверждаем заказ на завтра?`;
}

/**
 * Build a formatted product list string for suggested order.
 * @param {Array<{product: string, avgKg: number}>} items
 * @returns {string}
 */
function formatProductList(items) {
  return items
    .slice(0, 4)
    .map((i) => `${Math.round(i.avgKg)}кг ${i.product.toLowerCase()}`)
    .join(" + ");
}

/**
 * Progress bar: 10-char block string.
 * @param {number} current
 * @param {number} target
 * @returns {string}
 */
function progressBar(current, target) {
  const pct = Math.min(1, current / Math.max(1, target));
  const filled = Math.round(pct * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// ── Core data model ──────────────────────────────────────────────────────────

/**
 * Build an enriched client list from raw sales data.
 * For each client:
 *   - avgFrequencyDays from client-analytics
 *   - overdueDays = daysSinceLast - avgFrequencyDays
 *   - topProducts with per-client average kg
 *   - expectedOrderArs = avgOrderArs
 *   - urgencyScore = overdueDays * avgOrderArs (for sorting)
 *
 * @param {object[]} clientList - output of analyzeClients().clients
 * @param {object[]} salesRows  - raw sales rows from farm-state
 * @returns {object[]} sorted by urgencyScore desc
 */
function buildEnrichedClients(clientList, salesRows) {
  const DAY_MS = 86400000;
  const now = Date.now();

  // Build per-client per-product aggregates from raw sales
  /** @type {Map<string, Map<string, {kg: number, ars: number, count: number}>>} */
  const clientProducts = new Map();

  for (const row of salesRows) {
    const name = (row["Клиент"] || row["клиент"] || "").trim();
    if (!name) continue;

    const rawProduct = (row["Продукт"] || row["Товар"] || row["product"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);

    const kg =
      parseFloat(
        String(row["Кол-во кг"] || row["кг"] || "0")
          .replace(",", ".")
          .replace(/[^\d.]/g, ""),
      ) || 0;
    const ars =
      parseFloat(
        String(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || "0")
          .replace(",", ".")
          .replace(/[^\d.]/g, ""),
      ) || 0;

    if (!clientProducts.has(name)) clientProducts.set(name, new Map());
    const pm = clientProducts.get(name);
    if (!pm.has(product)) pm.set(product, { kg: 0, ars: 0, count: 0 });
    const entry = pm.get(product);
    entry.kg += kg;
    entry.ars += ars;
    entry.count += 1;
  }

  const enriched = clientList.map((c) => {
    const overdueDays =
      c.avgFrequencyDays > 0 ? c.daysSinceLast - c.avgFrequencyDays : c.daysSinceLast - 7; // default cadence assumption

    // Top products by total kg for this client
    const pm = clientProducts.get(c.name) || new Map();
    const topProducts = [...pm.entries()]
      .filter(([, v]) => v.kg > 0)
      .sort(([, a], [, b]) => b.kg - a.kg)
      .slice(0, 5)
      .map(([product, v]) => ({
        product,
        totalKg: v.kg,
        totalArs: v.ars,
        count: v.count,
        avgKg: v.count > 0 ? v.kg / v.count : 0,
        avgPrice: v.kg > 0 ? v.ars / v.kg : 0,
      }));

    const urgencyScore = Math.max(0, overdueDays) * c.avgOrderArs;

    return {
      ...c,
      overdueDays,
      topProducts,
      urgencyScore,
    };
  });

  // Sort: most urgent + valuable first
  return enriched.sort((a, b) => b.urgencyScore - a.urgencyScore);
}

// ── Weekly target helper ─────────────────────────────────────────────────────

/**
 * Estimate weekly target from financials.
 * Uses last month revenue / 4 weeks, with a +10% growth target.
 * @param {object} financials - from farm-state analytics.financial
 * @returns {{ target: number, achieved: number, daysLeft: number }}
 */
function weeklyTarget(financials) {
  const weekRevenue = financials?.week?.revenue || 0;
  const monthRevenue = financials?.month?.revenue || 0;

  // Target: monthly average per week + 10%
  const avgWeek = monthRevenue > 0 ? monthRevenue / 4 : weekRevenue;
  const target = Math.round(avgWeek * 1.1);

  const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat
  const workDayOfWeek = dayOfWeek === 0 ? 6 : dayOfWeek; // Mon=1..Sat=6
  const daysLeft = Math.max(1, 6 - workDayOfWeek);

  return { target, achieved: weekRevenue, daysLeft };
}

// ── Command: morning ─────────────────────────────────────────────────────────

/**
 * Build the morning revenue message.
 * @param {object[]} enriched   - enriched client list
 * @param {object}   stock      - farm-state analytics.stock
 * @param {object}   financials - farm-state analytics.financial
 * @returns {string}
 */
function buildMorningMessage(enriched, stock, financials) {
  const lines = [];

  // ── Section 1: Revenue Actions ──────────────────────────────────────────
  lines.push("💰 *REVENUE ACTIONS*\n");

  const actionable = enriched.filter((c) => c.avgOrderArs > 0 && c.orderCount >= 1).slice(0, 3);

  if (actionable.length === 0) {
    lines.push("Нет данных о клиентах. Проверь кеш: `node farm-state.cjs refresh`\n");
  } else {
    actionable.forEach((c, i) => {
      const dot = urgencyDot(c.overdueDays);
      const action = callAction(c.overdueDays);
      const freq =
        c.avgFrequencyDays > 0 ? `обычно каждые ${c.avgFrequencyDays}д` : "частота неизвестна";

      const productStr =
        c.topProducts.length > 0 ? formatProductList(c.topProducts) : "уточнить при звонке";

      lines.push(`${i + 1}. ${dot} *${c.name}* — ${c.daysSinceLast} дней без заказа (${freq})`);
      lines.push(`   📞 ${action}`);
      lines.push(`   🛒 Предложить: ${productStr}`);
      lines.push(`   💵 Ожидаемо: ${fmtNum(c.avgOrderArs)} ARS`);
      lines.push(``);
    });
  }

  // ── Section 2: Stock × Demand ────────────────────────────────────────────
  lines.push("📦 *ЧТО ПРОДАВАТЬ СЕГОДНЯ*\n");

  const availableStock = Object.entries(stock)
    .filter(([, v]) => v.kg > 0)
    .sort(([, a], [, b]) => b.kg - a.kg)
    .slice(0, 5);

  if (availableStock.length === 0) {
    lines.push("Данные склада недоступны. Обнови кеш.\n");
  } else {
    lines.push("В наличии → кому подходит:");
    for (const [product, stockInfo] of availableStock) {
      // Find which actionable clients buy this product
      const buyers = enriched
        .filter((c) => c.topProducts.some((p) => p.product === product))
        .slice(0, 3)
        .map((c) => c.name);

      const buyersStr = buyers.length > 0 ? `приоритет: ${buyers.join(", ")}` : "все клиенты";
      const kgStr = stockInfo.kg >= 1 ? `${Math.round(stockInfo.kg)}кг` : `${stockInfo.kg}кг`;
      lines.push(`• *${product}* (запас ${kgStr}) → ${buyersStr}`);
    }
    lines.push("");
  }

  // ── Section 3: Weekly Target ─────────────────────────────────────────────
  const wt = weeklyTarget(financials);
  const pct = wt.target > 0 ? Math.round((wt.achieved / wt.target) * 100) : 0;
  const remaining = Math.max(0, wt.target - wt.achieved);
  const dailyNeeded = wt.daysLeft > 0 ? Math.round(remaining / wt.daysLeft) : remaining;
  const bar = progressBar(wt.achieved, wt.target);

  lines.push("🎯 *ЦЕЛЬ НЕДЕЛИ*\n");
  lines.push(`Цель: *${fmtNum(wt.target)} ARS*`);
  lines.push(`Прогресс: ${bar} ${pct}% (${fmtNum(wt.achieved)} / ${fmtNum(wt.target)})`);
  lines.push(`Осталось: *${fmtNum(remaining)} ARS* за ${wt.daysLeft} дн.`);
  lines.push(`Нужно в день: ${fmtNum(dailyNeeded)} ARS`);

  // Potential from top 2 calls
  if (actionable.length >= 2) {
    const potential = actionable[0].avgOrderArs + actionable[1].avgOrderArs;
    const potPct = wt.target > 0 ? Math.round((potential / wt.target) * 100) : 0;
    lines.push(
      `\nЕсли позвонишь *${actionable[0].name}* + *${actionable[1].name}* сегодня = +${fmtNum(potential)} ARS (${potPct}%)`,
    );
  }

  return lines.join("\n");
}

// ── Command: call-list ────────────────────────────────────────────────────────

/**
 * Build full prioritized call list.
 * @param {object[]} enriched
 * @returns {string}
 */
function buildCallListMessage(enriched) {
  const lines = [];
  lines.push("📞 *CALL LIST* (отсортировано по деньгам)\n");

  const callable = enriched.filter((c) => c.avgOrderArs > 0 && c.orderCount >= 1).slice(0, 10);

  if (callable.length === 0) {
    lines.push("Нет данных. Запусти `node farm-state.cjs refresh`");
    return lines.join("\n");
  }

  callable.forEach((c, i) => {
    const dot = urgencyDot(c.overdueDays);
    const phrase = openingPhrase(c);
    const arsStr = fmtNum(c.avgOrderArs);

    // Pad columns for readability
    const nameCol = c.name.padEnd(16).slice(0, 16);
    const daysCol = String(c.daysSinceLast + "д").padEnd(4);
    const arsCol = arsStr.padEnd(8);

    lines.push(`${i + 1}. ${nameCol} ${daysCol} ${dot} ${arsCol}`);
    lines.push(`   _"${phrase}"_`);
    lines.push(``);
  });

  return lines.join("\n");
}

// ── Command: upsell ───────────────────────────────────────────────────────────

/**
 * Find upsell opportunities per client.
 * Logic: client buys product A but NOT product B, and A→B exists in CROSS_SELL.
 * @param {object[]} enriched
 * @returns {string}
 */
function buildUpsellMessage(enriched) {
  const lines = [];
  lines.push("📈 *UPSELL OPPORTUNITIES*\n");

  const opportunities = [];

  for (const client of enriched) {
    if (client.orderCount < 2) continue; // Need established relationship

    const clientProductSet = new Set(client.topProducts.map((p) => p.product));

    for (const [sourceProduct, suggestions] of Object.entries(CROSS_SELL)) {
      if (!clientProductSet.has(sourceProduct)) continue;

      for (const target of suggestions) {
        if (clientProductSet.has(target)) continue; // Already buys it

        // Estimate value: assume 3kg of new product at avg market price
        const estimatedArs = client.avgOrderArs * 0.15; // ~15% add-on

        opportunities.push({
          client: client.name,
          sourceProduct,
          targetProduct: target,
          estimatedArs: Math.round(estimatedArs),
          clientScore: client.rfmScore,
        });
        break; // One upsell per source product per client
      }
    }
  }

  if (opportunities.length === 0) {
    lines.push("Нет явных возможностей для апселла. Данных о покупках может быть недостаточно.");
    return lines.join("\n");
  }

  // Sort by estimated value
  opportunities.sort((a, b) => b.estimatedArs - a.estimatedArs);

  opportunities.slice(0, 6).forEach((op, i) => {
    const script = buildUpsellScript(op);
    lines.push(
      `${i + 1}. *${op.client}* покупает ${op.sourceProduct.toLowerCase()} → предложи *${op.targetProduct.toLowerCase()}*`,
    );
    lines.push(`   +~${fmtNum(op.estimatedArs)} ARS к заказу`);
    lines.push(`   Скрипт: _"${script}"_`);
    lines.push(``);
  });

  return lines.join("\n");
}

/**
 * Generate a specific upsell script line.
 * @param {{ client: string, sourceProduct: string, targetProduct: string }} op
 * @returns {string}
 */
function buildUpsellScript(op) {
  const firstName = op.client.split(/\s/)[0];
  const target = op.targetProduct.toLowerCase();
  const source = op.sourceProduct.toLowerCase();

  const scripts = {
    "Соленые огурцы": `${firstName}, попробуй наши соленые огурцы — берёшь ${source} всё равно, можем положить в заказ`,
    "Квашеная капуста": `${firstName}, есть новинка — квашеная капуста домашняя, клиенты в восторге`,
    Пелюстка: `${firstName}, есть эксклюзив — капуста пелюстка, рецепт из Украины, уникально для меню`,
    "Квашеные томаты": `${firstName}, квашеные томаты — новый продукт, очень хорошо идут к ${source}`,
    "Острый соус": `${firstName}, попробуй наш соус — 3 уровня остроты, идёт к ${source}`,
  };

  return (
    scripts[op.targetProduct] || `${firstName}, добавь в заказ ${target} — свежий, с нашей фермы`
  );
}

// ── Command: newbiz ───────────────────────────────────────────────────────────

/**
 * Build new business targets message.
 * @param {object[]} enriched - existing enriched clients (to avoid duplicates)
 * @returns {string}
 */
function buildNewBizMessage(enriched) {
  const lines = [];
  lines.push("🆕 *NEW BUSINESS TARGETS*\n");

  const existingNames = new Set(enriched.map((c) => c.name.toLowerCase()));

  // Filter out targets already in our client base
  const targets = NEW_BIZ_TARGETS.filter((t) => !existingNames.has(t.name.toLowerCase()));

  if (targets.length === 0) {
    lines.push(
      "Все известные цели уже в базе клиентов. Добавь новые в revenue-brain.cjs → NEW_BIZ_TARGETS.",
    );
    return lines.join("\n");
  }

  targets.forEach((t, i) => {
    lines.push(`${i + 1}. *${t.name}* (${t.type})`);
    lines.push(`   Наше преимущество: ${t.advantage}`);
    lines.push(`   Первый шаг: ${t.firstStep}`);
    lines.push(`   Потенциал: ~${fmtNum(t.estimatedArs)} ARS/нед.`);
    lines.push(``);
  });

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // process.argv = ['node', 'revenue-brain.cjs', 'command', ...flags]
  const command = process.argv[2];

  const validCommands = ["morning", "call-list", "upsell", "newbiz"];

  if (!command || !validCommands.includes(command)) {
    console.error("Usage: node revenue-brain.cjs <morning|call-list|upsell|newbiz> [--dry-run]");
    console.error("\nCommands:");
    console.error("  morning    Morning revenue opportunities (top 3 + stock + target)");
    console.error("  call-list  Full prioritized call list with opening scripts");
    console.error("  upsell     Upsell opportunities for existing clients");
    console.error("  newbiz     New client acquisition targets");
    process.exit(1);
  }

  const startMs = Date.now();

  // Load data
  const state = await getState();
  const { clients: clientList } = await analyzeClients(state.sales);
  const stock = state.analytics?.stock || {};
  const financials = state.analytics?.financial || {};

  // Enrich clients
  const enriched = buildEnrichedClients(clientList, state.sales);

  let message = "";

  switch (command) {
    case "morning":
      message = buildMorningMessage(enriched, stock, financials);
      break;
    case "call-list":
      message = buildCallListMessage(enriched);
      break;
    case "upsell":
      message = buildUpsellMessage(enriched);
      break;
    case "newbiz":
      message = buildNewBizMessage(enriched);
      break;
  }

  const durationMs = Date.now() - startMs;

  if (DRY_RUN) {
    console.log("--- DRY RUN ---");
    console.log(message);
    console.log("--- END DRY RUN ---");
    console.log(
      `[revenue-brain] command=${command} clients=${enriched.length} duration=${durationMs}ms`,
    );
  } else {
    const result = await sendThrottled(message, {
      thread: TELEGRAM_THREAD_DIRECTOR,
      priority: "high",
    });
    console.log(
      `[revenue-brain] command=${command} clients=${enriched.length} telegram=${result.action} duration=${durationMs}ms`,
    );
  }

  // Langfuse trace
  await trace({
    name: "revenue-brain",
    input: { command, dryRun: DRY_RUN, clientCount: enriched.length },
    output: { chars: message.length, action: DRY_RUN ? "dry_run" : "sent" },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "revenue-brain",
      command,
    },
  });
}

main().catch((err) => {
  console.error(`[revenue-brain] FATAL: ${err.message}`);
  process.exit(1);
});
