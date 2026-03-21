#!/usr/bin/env node
/**
 * multiplier-planner.cjs -- "7 задач 1 действием"
 *
 * Система скоринга мультипликаторов: определяет высокорычажные действия,
 * которые решают несколько проблем одновременно.
 *
 * Принцип: одно действие должно закрывать максимум доменов (production,
 * sales, finance, logistics, marketing, operations, knowledge).
 *
 * CLI:
 *   node multiplier-planner.cjs scan                    -- сканировать текущее состояние
 *   node multiplier-planner.cjs weekly                  -- генерировать недельный план
 *   node multiplier-planner.cjs score "описание"        -- оценить предложенное действие
 *   node multiplier-planner.cjs --dry-run scan          -- без отправки в Telegram/Sheets
 *
 * Cron: 30 6 * * 1 (пн 06:30 ART, перед утренним пайплайном)
 *
 * API:
 *   const { scanState, generateWeeklyPlan, scoreAction } = require("./multiplier-planner.cjs");
 */

"use strict";

const fs = require("fs");
const path = require("path");

// -- Константы ----------------------------------------------------------------

/** 7 проблемных доменов фермы */
const DOMAINS = /** @type {const} */ ([
  "production",
  "sales",
  "finance",
  "logistics",
  "marketing",
  "operations",
  "knowledge",
]);

/** @typedef {"production"|"sales"|"finance"|"logistics"|"marketing"|"operations"|"knowledge"} Domain */

/**
 * @typedef {Object} ActionDef
 * @property {string} id -- уникальный идентификатор действия
 * @property {string} name -- человекочитаемое название (рус)
 * @property {string} description -- описание и контекст
 * @property {Partial<Record<Domain, {score: number, reason: string}>>} impacts -- влияние по доменам
 */

/** Домены: описания для отчётов */
const DOMAIN_LABELS = {
  production: "Производство",
  sales: "Продажи",
  finance: "Финансы",
  logistics: "Логистика",
  marketing: "Маркетинг",
  operations: "Операции",
  knowledge: "Знания",
};

/** Домены: ключевые слова для автоматического маппинга */
const DOMAIN_KEYWORDS = {
  production: [
    "урожай",
    "качество",
    "болезн",
    "цикл",
    "сбор",
    "harvest",
    "grow",
    "zone",
    "зона",
    "плодонош",
    "грибы",
    "огурц",
    "микрозелен",
  ],
  sales: ["выручк", "клиент", "retention", "growth", "продаж", "заказ", "upsell", "order"],
  finance: ["марж", "расход", "cash", "pricing", "цен", "P&L", "прибыл", "убыт", "стоимост"],
  logistics: ["доставк", "маршрут", "склад", "waste", "stock", "запас", "упаков", "транспорт"],
  marketing: [
    "контент",
    "бренд",
    "reputation",
    "leads",
    "instagram",
    "фото",
    "видео",
    "chef",
    "шеф",
    "social",
  ],
  operations: ["задач", "алерт", "процесс", "время", "cron", "автоматиз", "мониторинг"],
  knowledge: ["обучен", "данны", "автоматизац", "insight", "аналитик", "отчёт", "trend", "radar"],
};

// -- Библиотека действий ------------------------------------------------------

/** @type {ActionDef[]} */
const ACTION_LIBRARY = [
  {
    id: "morning_greenhouse_photo_walk",
    name: "Утренний обход теплицы + фото",
    description:
      "Обход всех зон с фотографированием: проверка качества, болезней, оценка урожая, контент для клиентов и соцсетей, обновление данных склада",
    impacts: {
      production: { score: 3, reason: "проверка качества, детекция болезней, оценка урожая" },
      sales: { score: 1, reason: "контент для клиентов, демонстрация свежести" },
      logistics: { score: 2, reason: "обновление остатков, планирование доставок" },
      marketing: { score: 2, reason: "контент для Instagram, визуальный бренд" },
      knowledge: { score: 1, reason: "данные роста, фенология" },
    },
  },
  {
    id: "cluster_delivery_route",
    name: "Кластерная доставка по маршруту",
    description:
      "Объединённая доставка нескольким клиентам в одном районе: экономия топлива, личный контакт, upsell-возможности",
    impacts: {
      sales: { score: 3, reason: "обслуживание 3+ клиентов, upsell при контакте" },
      logistics: { score: 3, reason: "экономия топлива, оптимизация маршрута" },
      finance: { score: 2, reason: "снижение расходов на доставку" },
      marketing: { score: 1, reason: "личные отношения, рекомендации" },
    },
  },
  {
    id: "chef_collaboration_post",
    name: "Коллаборация с шеф-поваром + пост",
    description:
      "Совместный контент с шефом: социальное доказательство, новые лиды, удержание существующих клиентов, обратная связь по продукту",
    impacts: {
      marketing: { score: 3, reason: "контент, бренд, social proof" },
      sales: { score: 3, reason: "retention, новые лиды, upsell" },
      knowledge: { score: 1, reason: "обратная связь рынка" },
    },
  },
  {
    id: "expense_entry_batch",
    name: "Пакетный ввод расходов",
    description:
      "Ввод всех накопившихся расходов за неделю: точный P&L, видимость маржи, закрытие алертов полноты данных",
    impacts: {
      finance: { score: 3, reason: "точный P&L, видимость маржи" },
      operations: { score: 2, reason: "полнота данных, закрытие алертов" },
      knowledge: { score: 1, reason: "тренды расходов, базы для прогнозов" },
    },
  },
  {
    id: "client_feedback_round",
    name: "Обзвон клиентов для фидбэка",
    description:
      "Звонки 3-5 ключевым клиентам: retention, upsell, рыночная разведка, обновление профилей",
    impacts: {
      sales: { score: 3, reason: "retention, upsell, cross-sell" },
      marketing: { score: 2, reason: "отзывы, референсы, рекомендации" },
      knowledge: { score: 2, reason: "рыночные инсайты, предпочтения" },
      operations: { score: 1, reason: "обновление CRM/профилей клиентов" },
    },
  },
  {
    id: "harvest_stock_delivery_combo",
    name: "Сбор + обновление склада + доставка",
    description:
      "Комбинированная операция: утренний сбор, взвешивание и обновление склада, сборка и отправка заказов",
    impacts: {
      production: { score: 3, reason: "сбор урожая, контроль качества" },
      logistics: { score: 3, reason: "обновление остатков, отправка заказов" },
      sales: { score: 2, reason: "выполнение заказов, клиентский сервис" },
      finance: { score: 1, reason: "реализация продукции" },
    },
  },
  {
    id: "supplier_review_pricing",
    name: "Обзор поставщиков + пересмотр цен",
    description:
      "Анализ затрат на поставщиков, сравнение альтернатив, пересмотр розничных цен, обновление прайса",
    impacts: {
      finance: { score: 3, reason: "оптимизация затрат, маржа" },
      sales: { score: 2, reason: "конкурентные цены, обновление прайса" },
      knowledge: { score: 2, reason: "рыночные цены, тренды" },
      operations: { score: 1, reason: "обновление справочников" },
    },
  },
  {
    id: "weekly_content_batch",
    name: "Пакетная подготовка контента на неделю",
    description:
      "Создание 5-7 постов/stories за один сеанс: фото с обхода, рецепты, процесс выращивания",
    impacts: {
      marketing: { score: 3, reason: "контент на неделю, бренд" },
      sales: { score: 2, reason: "лидогенерация, engagement" },
      knowledge: { score: 1, reason: "документация процессов" },
    },
  },
  {
    id: "alert_resolution_batch",
    name: "Пакетное закрытие алертов",
    description: "Разбор всех открытых алертов: диагностика, исправление, закрытие, профилактика",
    impacts: {
      operations: { score: 3, reason: "чистый список алертов, процесс-дисциплина" },
      production: { score: 2, reason: "устранение проблем производства" },
      knowledge: { score: 1, reason: "документация решений, паттерны" },
    },
  },
  {
    id: "production_cycle_planning",
    name: "Планирование циклов посадки",
    description: "Ревизия текущих циклов, планирование следующих посадок с учётом спроса и сезона",
    impacts: {
      production: { score: 3, reason: "оптимальные циклы, непрерывность" },
      sales: { score: 2, reason: "прогноз ассортимента для клиентов" },
      finance: { score: 1, reason: "планирование затрат на субстрат/семена" },
      knowledge: { score: 1, reason: "накопление данных по циклам" },
    },
  },
];

// -- Утилиты ------------------------------------------------------------------

/**
 * Рассчитывает multiplier_score для действия.
 * Формула: domains_impacted * avg_impact.
 *
 * @param {Partial<Record<Domain, {score: number, reason: string}>>} impacts
 * @returns {{domains_impacted: number, avg_impact: number, total_score: number, max_possible: number}}
 */
function calculateMultiplier(impacts) {
  const entries = Object.entries(impacts);
  const domainsImpacted = entries.length;
  if (domainsImpacted === 0) {
    return { domains_impacted: 0, avg_impact: 0, total_score: 0, max_possible: 21 };
  }
  const totalImpact = entries.reduce((sum, [, v]) => sum + (v?.score || 0), 0);
  const avgImpact = Math.round((totalImpact / domainsImpacted) * 10) / 10;
  const totalScore = Math.round(domainsImpacted * avgImpact);
  return {
    domains_impacted: domainsImpacted,
    avg_impact: avgImpact,
    total_score: totalScore,
    max_possible: 21,
  };
}

/**
 * Генерирует звёзды для визуализации score (1-5).
 * @param {number} score -- multiplier score (0-21)
 * @returns {string}
 */
function starsForScore(score) {
  if (score >= 12) return "\u2605\u2605\u2605\u2605\u2605";
  if (score >= 9) return "\u2605\u2605\u2605\u2605\u2606";
  if (score >= 7) return "\u2605\u2605\u2605\u2606\u2606";
  if (score >= 5) return "\u2605\u2605\u2606\u2606\u2606";
  return "\u2605\u2606\u2606\u2606\u2606";
}

/**
 * Форматирует дату как YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// -- Сканирование состояния ---------------------------------------------------

/**
 * Загружает текущее состояние фермы и определяет активные проблемы по доменам.
 * @returns {Promise<{problems: Record<Domain, string[]>, context: object}>}
 */
async function loadCurrentProblems() {
  const { getState } = require("./farm-state.cjs");
  const state = await getState();

  /** @type {Record<Domain, string[]>} */
  const problems = {
    production: [],
    sales: [],
    finance: [],
    logistics: [],
    marketing: [],
    operations: [],
    knowledge: [],
  };

  const now = new Date();
  const today = fmtDate(now);

  // -- Production: проверяем незакрытые циклы, нет записей сегодня --
  const prodToday = (state.production || []).filter((/** @type {Record<string,string>} */ r) =>
    (r["\u0414\u0430\u0442\u0430"] || "").startsWith(today),
  );
  if (prodToday.length === 0) {
    problems.production.push("Нет записей производства за сегодня");
  }

  // -- Sales: at_risk и churned клиенты --
  const clients = state.analytics?.clients || {};
  let atRiskCount = 0;
  let churnedCount = 0;
  for (const [, info] of Object.entries(clients)) {
    if (/** @type {any} */ (info).status === "at_risk") atRiskCount++;
    if (/** @type {any} */ (info).status === "churned") churnedCount++;
  }
  if (atRiskCount > 0) {
    problems.sales.push(`${atRiskCount} клиент(ов) at_risk (>14 дней без заказа)`);
  }
  if (churnedCount > 0) {
    problems.sales.push(`${churnedCount} клиент(ов) churned (>30 дней)`);
  }

  // -- Finance: пропущенные расходы, низкая маржа --
  const fin = state.analytics?.financial || {};
  const weekMargin = /** @type {any} */ (fin).week?.margin || 0;
  const weekExpenses = /** @type {any} */ (fin).week?.expenses || 0;
  if (weekExpenses === 0) {
    problems.finance.push("Расходы за неделю не внесены");
  }
  if (weekMargin > 0 && weekMargin < 0.35) {
    problems.finance.push(`Маржа за неделю ${Math.round(weekMargin * 100)}% (ниже целевых 35%)`);
  }

  // -- Logistics: критичные остатки --
  const stock = state.analytics?.stock || {};
  const criticalItems = [];
  for (const [product, info] of Object.entries(stock)) {
    if (/** @type {any} */ (info).status === "critical") {
      criticalItems.push(product);
    }
  }
  if (criticalItems.length > 0) {
    problems.logistics.push(`Критичные остатки: ${criticalItems.join(", ")}`);
  }

  // -- Operations: незакрытые задачи и алерты --
  const tasks = state.tasks || [];
  const openTasks = tasks.filter((/** @type {Record<string,string>} */ t) => {
    const status = (t["\u0421\u0442\u0430\u0442\u0443\u0441"] || t["status"] || "").toLowerCase();
    return !status.includes("done") && !status.includes("готов") && !status.includes("закрыт");
  });
  if (openTasks.length > 5) {
    problems.operations.push(`${openTasks.length} открытых задач`);
  }

  const alerts = state.alerts || [];
  const unresolvedAlerts = alerts.filter((/** @type {Record<string,string>} */ a) => {
    const status = (a["\u0421\u0442\u0430\u0442\u0443\u0441"] || a["status"] || "").toLowerCase();
    return !status.includes("resolved") && !status.includes("закрыт");
  });
  if (unresolvedAlerts.length > 0) {
    problems.operations.push(`${unresolvedAlerts.length} неразрешённых алертов`);
  }

  // -- Knowledge: пробелы в данных (production без записей >2 дней) --
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const recentProd = (state.production || []).filter((/** @type {Record<string,string>} */ r) => {
    const d = r["\u0414\u0430\u0442\u0430"] || "";
    return d >= fmtDate(twoDaysAgo);
  });
  if (recentProd.length === 0) {
    problems.knowledge.push("Нет данных производства за последние 2 дня");
  }

  // -- Marketing: нет контента (проверяем по задачам) --
  // Маркетинг-проблемы выводим только если нет маркетинговых задач
  const marketingTasks = openTasks.filter((/** @type {Record<string,string>} */ t) => {
    const desc = (
      t["\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"] ||
      t["\u0417\u0430\u0434\u0430\u0447\u0430"] ||
      ""
    ).toLowerCase();
    return (
      desc.includes("контент") ||
      desc.includes("фото") ||
      desc.includes("instagram") ||
      desc.includes("пост")
    );
  });
  if (marketingTasks.length === 0) {
    problems.marketing.push("Нет запланированных маркетинговых задач");
  }

  return {
    problems,
    context: {
      atRiskClients: atRiskCount,
      churnedClients: churnedCount,
      criticalStock: criticalItems,
      openTasksCount: openTasks.length,
      unresolvedAlertsCount: unresolvedAlerts.length,
      weekMargin: weekMargin,
      weekExpenses: weekExpenses,
      prodRecordsToday: prodToday.length,
    },
  };
}

// -- Динамические предложения -------------------------------------------------

/**
 * Генерирует контекстные действия на основе текущих проблем.
 * @param {Record<Domain, string[]>} problems
 * @param {object} context
 * @returns {ActionDef[]}
 */
function generateDynamicActions(problems, context) {
  /** @type {ActionDef[]} */
  const dynamic = [];
  const ctx = /** @type {any} */ (context);

  // Критичные остатки -> комбо "сбор + склад + доставка"
  if (ctx.criticalStock && ctx.criticalStock.length > 0) {
    dynamic.push({
      id: "dynamic_critical_stock_combo",
      name: `Срочный сбор ${ctx.criticalStock.join(", ")} + обновление склада + доставка`,
      description: `Критичные остатки: ${ctx.criticalStock.join(", ")}. Нужно: собрать, взвесить, обновить склад, отправить клиентам`,
      impacts: {
        production: { score: 3, reason: "срочный сбор дефицитных позиций" },
        logistics: { score: 3, reason: "обновление критичных остатков" },
        sales: { score: 2, reason: "выполнение заказов, клиентский сервис" },
        finance: { score: 1, reason: "реализация продукции" },
      },
    });
  }

  // at_risk клиенты -> "доставка + визит + фидбэк"
  if (ctx.atRiskClients > 0) {
    dynamic.push({
      id: "dynamic_at_risk_recovery",
      name: `Восстановление ${ctx.atRiskClients} at_risk клиентов`,
      description: `${ctx.atRiskClients} клиентов не покупали >14 дней. Нужно: связаться, предложить доставку, собрать фидбэк`,
      impacts: {
        sales: { score: 3, reason: "спасение at_risk клиентов, retention" },
        marketing: { score: 2, reason: "личный контакт, рекомендации" },
        knowledge: { score: 2, reason: "причины паузы, предпочтения" },
        logistics: { score: 1, reason: "планирование доставки под визит" },
      },
    });
  }

  // Пропущенные расходы -> "ввод + ревизия поставщиков + обновление цен"
  if (ctx.weekExpenses === 0) {
    dynamic.push({
      id: "dynamic_expense_recovery",
      name: "Пакетный ввод расходов + ревизия поставщиков + обновление цен",
      description:
        "Расходы за неделю не внесены. Комбо: ввести все расходы, сравнить поставщиков, скорректировать цены",
      impacts: {
        finance: { score: 3, reason: "восстановление точного P&L" },
        operations: { score: 2, reason: "закрытие алертов полноты данных" },
        sales: { score: 1, reason: "актуализация прайса" },
        knowledge: { score: 1, reason: "тренды расходов" },
      },
    });
  }

  // Неразрешённые алерты -> "утренний обход + фото + ремонт"
  if (ctx.unresolvedAlertsCount > 2) {
    dynamic.push({
      id: "dynamic_alert_walkaround",
      name: `Обход + фото-диагностика + закрытие ${ctx.unresolvedAlertsCount} алертов`,
      description: `${ctx.unresolvedAlertsCount} алертов без ответа. Комбо: обход теплицы, фото проблем, диагностика, закрытие`,
      impacts: {
        operations: { score: 3, reason: "массовое закрытие алертов" },
        production: { score: 2, reason: "диагностика и устранение проблем" },
        marketing: { score: 1, reason: "контент о решении проблем (прозрачность)" },
        knowledge: { score: 1, reason: "документация решений" },
      },
    });
  }

  // Низкая маржа -> "анализ цен + оптимизация затрат + upsell"
  if (ctx.weekMargin > 0 && ctx.weekMargin < 0.35) {
    dynamic.push({
      id: "dynamic_margin_recovery",
      name: "Восстановление маржи: цены + затраты + upsell",
      description: `Маржа ${Math.round(ctx.weekMargin * 100)}% ниже целевых 35%. Комбо: пересмотр цен, оптимизация затрат, upsell клиентам`,
      impacts: {
        finance: { score: 3, reason: "восстановление целевой маржи" },
        sales: { score: 2, reason: "upsell, пересмотр прайса" },
        knowledge: { score: 1, reason: "анализ структуры затрат" },
      },
    });
  }

  return dynamic;
}

// -- Основные функции ---------------------------------------------------------

/**
 * Сканирует текущее состояние и возвращает ранжированные мультипликаторные действия.
 * @returns {Promise<{actions: Array<{action: ActionDef, multiplier: ReturnType<typeof calculateMultiplier>, relevance: string}>, problems: Record<Domain, string[]>, context: object}>}
 */
async function scanState() {
  const { problems, context } = await loadCurrentProblems();

  // Объединяем библиотеку + динамические предложения
  const allActions = [...ACTION_LIBRARY, ...generateDynamicActions(problems, context)];

  // Определяем релевантность каждого действия к текущим проблемам
  const scored = allActions.map((action) => {
    const multiplier = calculateMultiplier(action.impacts);

    // Бонус релевантности: действие решает текущие проблемы?
    let relevance = "standard";
    const actionDomains = Object.keys(action.impacts);
    const problemDomains = Object.entries(problems)
      .filter(([, items]) => items.length > 0)
      .map(([d]) => d);

    const overlap = actionDomains.filter((d) => problemDomains.includes(d));
    if (overlap.length >= 3) relevance = "high";
    else if (overlap.length >= 2) relevance = "medium";

    // Бустим score для высоко-релевантных действий
    if (relevance === "high") multiplier.total_score += 3;
    else if (relevance === "medium") multiplier.total_score += 1;

    return { action, multiplier, relevance };
  });

  // Сортируем по total_score (desc), при равенстве -- по domains_impacted
  scored.sort((a, b) => {
    if (b.multiplier.total_score !== a.multiplier.total_score) {
      return b.multiplier.total_score - a.multiplier.total_score;
    }
    return b.multiplier.domains_impacted - a.multiplier.domains_impacted;
  });

  return { actions: scored, problems, context };
}

/**
 * Генерирует недельный план: топ-5 мультипликаторных действий + расписание.
 * @returns {Promise<{plan: Array<{day: string, action: ActionDef, multiplier: ReturnType<typeof calculateMultiplier>, relevance: string}>, totalScore: number, domainsReached: Set<string>}>}
 */
async function generateWeeklyPlan() {
  const { actions, problems } = await scanState();

  // Берём топ-7 (по одному в день), но дедуплицируем по покрытию доменов
  const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  /** @type {Array<{day: string, action: ActionDef, multiplier: ReturnType<typeof calculateMultiplier>, relevance: string}>} */
  const plan = [];
  /** @type {Set<string>} */
  const usedIds = new Set();
  /** @type {Set<string>} */
  const domainsReached = new Set();

  let totalScore = 0;

  for (const day of days) {
    // Выбираем лучшее неиспользованное действие
    const best = actions.find((a) => !usedIds.has(a.action.id));
    if (!best) break;

    usedIds.add(best.action.id);
    Object.keys(best.action.impacts).forEach((d) => domainsReached.add(d));
    totalScore += best.multiplier.total_score;

    plan.push({
      day,
      action: best.action,
      multiplier: best.multiplier,
      relevance: best.relevance,
    });
  }

  return { plan, totalScore, domainsReached };
}

/**
 * Скорит произвольное действие по ключевым словам.
 * @param {string} description -- описание действия на русском/английском
 * @returns {{description: string, impacts: Partial<Record<Domain, {score: number, reason: string}>>, multiplier: ReturnType<typeof calculateMultiplier>}}
 */
function scoreAction(description) {
  const lower = description.toLowerCase();

  /** @type {Partial<Record<Domain, {score: number, reason: string}>>} */
  const impacts = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches = keywords.filter((kw) => lower.includes(kw));
    if (matches.length > 0) {
      const score = Math.min(3, matches.length); // 1 совпадение = 1, 2 = 2, 3+ = 3
      impacts[/** @type {Domain} */ (domain)] = {
        score,
        reason: `совпадения: ${matches.join(", ")}`,
      };
    }
  }

  const multiplier = calculateMultiplier(impacts);

  return { description, impacts, multiplier };
}

// -- Форматирование -----------------------------------------------------------

/**
 * Форматирует результат scan в HTML для Telegram.
 * @param {Awaited<ReturnType<typeof scanState>>} scanResult
 * @returns {string}
 */
function formatScanHTML(scanResult) {
  const { actions, problems } = scanResult;
  const top = actions.slice(0, 7);
  const lines = [];

  lines.push(
    "<b>\uD83C\uDFAF \u041C\u0423\u041B\u042C\u0422\u0418\u041F\u041B\u0418\u041A\u0410\u0422\u041E\u0420 \u0421\u041A\u0410\u041D</b>",
  );
  lines.push("");

  // Текущие проблемы
  const problemDomains = Object.entries(problems).filter(([, items]) => items.length > 0);
  if (problemDomains.length > 0) {
    lines.push("<b>Текущие проблемы:</b>");
    for (const [domain, items] of problemDomains) {
      for (const item of items) {
        lines.push(`  \u2022 <i>${DOMAIN_LABELS[/** @type {Domain} */ (domain)]}</i>: ${item}`);
      }
    }
    lines.push("");
  }

  // Топ действий
  lines.push("<b>Топ мультипликаторов:</b>");
  lines.push("");
  for (let i = 0; i < top.length; i++) {
    const { action, multiplier, relevance } = top[i];
    const stars = starsForScore(multiplier.total_score);
    const relTag = relevance === "high" ? " \uD83D\uDD25" : relevance === "medium" ? " \u26A1" : "";
    const domains = Object.keys(action.impacts)
      .map((d) => DOMAIN_LABELS[/** @type {Domain} */ (d)])
      .join(" \u2713 ");

    lines.push(
      `${i + 1}. [${stars}] <b>${action.name}</b> (score: ${multiplier.total_score})${relTag}`,
    );
    lines.push(`   \u0420\u0435\u0448\u0430\u0435\u0442: ${domains}`);
    if (i < 3) {
      // Подробности для топ-3
      lines.push(`   <i>${action.description}</i>`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Форматирует недельный план в HTML для Telegram.
 * @param {Awaited<ReturnType<typeof generateWeeklyPlan>>} weeklyResult
 * @returns {string}
 */
function formatWeeklyHTML(weeklyResult) {
  const { plan, totalScore, domainsReached } = weeklyResult;
  const lines = [];

  lines.push(
    "<b>\uD83C\uDFAF \u041C\u0423\u041B\u042C\u0422\u0418\u041F\u041B\u0418\u041A\u0410\u0422\u041E\u0420 \u041D\u0415\u0414\u0415\u041B\u0418</b>",
  );
  lines.push("");

  for (const entry of plan) {
    const stars = starsForScore(entry.multiplier.total_score);
    const domains = Object.keys(entry.action.impacts)
      .map((d) => DOMAIN_LABELS[/** @type {Domain} */ (d)])
      .join(" \u2713 ");

    lines.push(
      `<b>${entry.day}:</b> [${stars}] ${entry.action.name} (${entry.multiplier.total_score})`,
    );
    lines.push(`   \u2192 ${domains}`);
  }

  lines.push("");
  lines.push(
    `<b>\u0418\u0442\u043E\u0433\u043E:</b> score ${totalScore} | ${domainsReached.size}/7 \u0434\u043E\u043C\u0435\u043D\u043E\u0432 \u043F\u043E\u043A\u0440\u044B\u0442\u043E`,
  );
  const missing = DOMAINS.filter((d) => !domainsReached.has(d));
  if (missing.length > 0) {
    lines.push(
      `\u041D\u0435 \u043F\u043E\u043A\u0440\u044B\u0442\u043E: ${missing.map((d) => DOMAIN_LABELS[/** @type {Domain} */ (d)]).join(", ")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Форматирует результат score в HTML для Telegram.
 * @param {ReturnType<typeof scoreAction>} result
 * @returns {string}
 */
function formatScoreHTML(result) {
  const { description, impacts, multiplier } = result;
  const lines = [];
  const stars = starsForScore(multiplier.total_score);

  lines.push(
    `<b>\uD83C\uDFAF \u041E\u0426\u0415\u041D\u041A\u0410 \u0414\u0415\u0419\u0421\u0422\u0412\u0418\u042F</b>`,
  );
  lines.push(`<i>${description}</i>`);
  lines.push("");
  lines.push(
    `[${stars}] Score: <b>${multiplier.total_score}</b> (${multiplier.domains_impacted}/7 \u0434\u043E\u043C\u0435\u043D\u043E\u0432, avg ${multiplier.avg_impact})`,
  );
  lines.push("");

  if (Object.keys(impacts).length > 0) {
    for (const [domain, info] of Object.entries(impacts)) {
      const bar = "\u2588".repeat(info?.score || 0) + "\u2591".repeat(3 - (info?.score || 0));
      lines.push(
        `  ${bar} <b>${DOMAIN_LABELS[/** @type {Domain} */ (domain)]}</b>: ${info?.reason}`,
      );
    }
  } else {
    lines.push(
      "  <i>\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0434\u043E\u043C\u0435\u043D\u044B. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430 \u0434\u043E\u043C\u0435\u043D\u043E\u0432.</i>",
    );
  }

  // Рекомендация
  lines.push("");
  if (multiplier.total_score >= 9) {
    lines.push(
      "\u2705 <b>\u0412\u044B\u0441\u043E\u043A\u0438\u0439 \u043C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440!</b> \u041F\u0440\u0438\u043E\u0440\u0438\u0442\u0435\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435.",
    );
  } else if (multiplier.total_score >= 6) {
    lines.push(
      "\u26A0\uFE0F \u0421\u0440\u0435\u0434\u043D\u0438\u0439 \u043C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440. \u041C\u043E\u0436\u043D\u043E \u0443\u0441\u0438\u043B\u0438\u0442\u044C, \u043A\u043E\u043C\u0431\u0438\u043D\u0438\u0440\u0443\u044F \u0441 \u0434\u0440\u0443\u0433\u0438\u043C\u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F\u043C\u0438.",
    );
  } else {
    lines.push(
      "\u274C \u041D\u0438\u0437\u043A\u0438\u0439 \u043C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440. \u041F\u043E\u0434\u0443\u043C\u0430\u0439\u0442\u0435, \u043A\u0430\u043A \u0440\u0430\u0441\u0448\u0438\u0440\u0438\u0442\u044C \u043E\u0445\u0432\u0430\u0442 \u0434\u043E\u043C\u0435\u043D\u043E\u0432.",
    );
  }

  return lines.join("\n");
}

// -- Запись в Sheets ----------------------------------------------------------

/**
 * Сохраняет топ рекомендаций в лист "Задачи" с multiplier_score.
 * @param {Awaited<ReturnType<typeof scanState>>["actions"]} actions
 * @param {boolean} dryRun
 * @returns {Promise<number>} -- количество записанных строк
 */
async function saveToTasks(actions, dryRun) {
  if (dryRun) return 0;

  const top = actions.slice(0, 5);
  if (top.length === 0) return 0;

  try {
    const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const today = fmtDate(new Date());

    const rows = top.map((a) => [
      today, // Дата
      a.action.name, // Задача
      "multiplier-planner", // Источник
      "open", // Статус
      `multiplier_score=${a.multiplier.total_score}, domains=${a.multiplier.domains_impacted}, relevance=${a.relevance}`, // Примечания
    ]);

    await appendToSheet(
      PEPINO_SHEETS_ID,
      rows,
      "\uD83D\uDCCB \u0417\u0430\u0434\u0430\u0447\u0438",
    );
    return rows.length;
  } catch (err) {
    console.error(
      `[multiplier-planner] \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u043F\u0438\u0441\u0438 \u0432 \u0417\u0430\u0434\u0430\u0447\u0438: ${/** @type {Error} */ (err).message}`,
    );
    return 0;
  }
}

// -- CLI ----------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filteredArgs = args.filter((a) => a !== "--dry-run");
  const command = filteredArgs[0];

  if (!command || !["scan", "weekly", "score"].includes(command)) {
    console.error("Usage: node multiplier-planner.cjs <command> [options]");
    console.error("");
    console.error("Commands:");
    console.error(
      "  scan                     \u0421\u043A\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0435\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435, \u043D\u0430\u0439\u0442\u0438 \u043C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440\u044B",
    );
    console.error(
      "  weekly                   \u0413\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043D\u0435\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u043F\u043B\u0430\u043D",
    );
    console.error(
      '  score "\u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"          \u041E\u0446\u0435\u043D\u0438\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435',
    );
    console.error("");
    console.error("Options:");
    console.error(
      "  --dry-run                \u0411\u0435\u0437 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438 \u0432 Telegram/Sheets",
    );
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    if (command === "scan") {
      const result = await scanState();
      const html = formatScanHTML(result);

      if (dryRun) {
        console.log(
          "[DRY RUN] \u0421\u043A\u0430\u043D \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D. \u0422\u043E\u043F-5:",
        );
        for (let i = 0; i < Math.min(5, result.actions.length); i++) {
          const a = result.actions[i];
          console.log(
            `  ${i + 1}. [${a.multiplier.total_score}] ${a.action.name} (${a.relevance})`,
          );
        }
        console.log("");
        console.log("[DRY RUN] HTML:");
        console.log(html);
      } else {
        // Отправляем в Telegram (тред директора/стратегии = 20)
        const { sendThrottled } = require("./notification-throttle.cjs");
        await sendThrottled(html, { thread: 20, parseMode: "HTML", priority: "normal" });

        // Записываем в задачи
        const saved = await saveToTasks(result.actions, false);
        console.error(
          `[multiplier-planner] Scan: ${result.actions.length} \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439, ${saved} \u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043E \u0432 \u0417\u0430\u0434\u0430\u0447\u0438`,
        );
      }
    } else if (command === "weekly") {
      const result = await generateWeeklyPlan();
      const html = formatWeeklyHTML(result);

      if (dryRun) {
        console.log(
          "[DRY RUN] \u041D\u0435\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u043F\u043B\u0430\u043D:",
        );
        for (const entry of result.plan) {
          console.log(`  ${entry.day}: [${entry.multiplier.total_score}] ${entry.action.name}`);
        }
        console.log(
          `  \u0418\u0442\u043E\u0433\u043E: score=${result.totalScore}, \u0434\u043E\u043C\u0435\u043D\u043E\u0432=${result.domainsReached.size}/7`,
        );
        console.log("");
        console.log("[DRY RUN] HTML:");
        console.log(html);
      } else {
        const { sendThrottled } = require("./notification-throttle.cjs");
        await sendThrottled(html, { thread: 20, parseMode: "HTML", priority: "normal" });
        console.error(
          `[multiplier-planner] Weekly: score=${result.totalScore}, \u0434\u043E\u043C\u0435\u043D\u043E\u0432=${result.domainsReached.size}/7`,
        );
      }
    } else if (command === "score") {
      const description = filteredArgs.slice(1).join(" ");
      if (!description) {
        console.error(
          '\u041E\u0448\u0438\u0431\u043A\u0430: \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F. \u041F\u0440\u0438\u043C\u0435\u0440: node multiplier-planner.cjs score "\u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0430\u043C \u0441 \u0444\u043E\u0442\u043E"',
        );
        process.exit(1);
      }

      const result = scoreAction(description);
      const html = formatScoreHTML(result);

      if (dryRun) {
        console.log(`[DRY RUN] Score \u0434\u043B\u044F: "${description}"`);
        console.log(
          `  \u0414\u043E\u043C\u0435\u043D\u043E\u0432: ${result.multiplier.domains_impacted}/7`,
        );
        console.log(`  Score: ${result.multiplier.total_score}`);
        console.log("");
        console.log("[DRY RUN] HTML:");
        console.log(html);
      } else {
        const { sendThrottled } = require("./notification-throttle.cjs");
        await sendThrottled(html, { thread: 20, parseMode: "HTML", priority: "normal" });
        console.error(
          `[multiplier-planner] Score: ${result.multiplier.total_score} (${result.multiplier.domains_impacted} \u0434\u043E\u043C\u0435\u043D\u043E\u0432)`,
        );
      }
    }

    // Langfuse трейс
    const elapsed = Date.now() - startTime;
    try {
      const { trace } = require("./langfuse-trace.cjs");
      await trace({
        name: "multiplier-planner",
        input: { command, dryRun },
        output: { elapsed_ms: elapsed },
        duration_ms: elapsed,
        metadata: { skill: "pepino-google-sheets", script: "multiplier-planner.cjs" },
      });
    } catch {
      // Langfuse не критичен
    }
  } catch (err) {
    console.error(
      `[multiplier-planner] \u041E\u0428\u0418\u0411\u041A\u0410: ${/** @type {Error} */ (err).message}`,
    );
    process.exit(1);
  }
}

// -- CLI entry point ----------------------------------------------------------

if (require.main === module) {
  main();
}

// -- Экспорт ------------------------------------------------------------------

module.exports = {
  scanState,
  generateWeeklyPlan,
  scoreAction,
  calculateMultiplier,
  // Для тестирования
  ACTION_LIBRARY,
  DOMAINS,
  DOMAIN_LABELS,
  DOMAIN_KEYWORDS,
  formatScanHTML,
  formatWeeklyHTML,
  formatScoreHTML,
  generateDynamicActions,
  loadCurrentProblems,
};
