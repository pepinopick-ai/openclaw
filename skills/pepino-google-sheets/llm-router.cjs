#!/usr/bin/env node
// Pepino Pick LLM Router v1.0
// Rule-based classifier + cascading fallback
// Классификатор запросов по Tier 1-4, выбор модели, учёт затрат

"use strict";

const fs = require("fs");
const path = require("path");

// --- Путь к логу затрат ---
const COST_LOG_PATH = "/home/roman/logs/llm-costs.jsonl";

// --- Конфигурация провайдеров и моделей ---
const PROVIDERS = {
  "gemini-2.0-flash": {
    provider: "google",
    inputCost: 0.075, // за 1M токенов
    outputCost: 0.3,
    maxTokens: 8192,
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  },
  "gpt-4o-mini": {
    provider: "openai",
    inputCost: 0.15,
    outputCost: 0.6,
    maxTokens: 16384,
  },
  "deepseek-chat": {
    provider: "deepseek",
    inputCost: 0.27,
    outputCost: 1.1,
    maxTokens: 8192,
  },
  "kimi-k2.5": {
    provider: "kimi",
    inputCost: 0.5,
    outputCost: 2.0,
    maxTokens: 8192,
  },
  "claude-3-5-haiku-latest": {
    provider: "anthropic",
    inputCost: 0.8,
    outputCost: 4.0,
    maxTokens: 8192,
  },
  "claude-sonnet-4-20250514": {
    provider: "anthropic",
    inputCost: 3.0,
    outputCost: 15.0,
    maxTokens: 8192,
  },
  "gpt-4o": {
    provider: "openai",
    inputCost: 2.5,
    outputCost: 10.0,
    maxTokens: 16384,
  },
  "gemini-1.5-pro": {
    provider: "google",
    inputCost: 1.25,
    outputCost: 5.0,
    maxTokens: 8192,
  },
  "llama-3.1-8b": {
    provider: "groq",
    inputCost: 0.05,
    outputCost: 0.08,
    maxTokens: 8192,
  },
};

// --- Определение уровней (Tier 1-4) ---
const TIERS = {
  tier1: {
    name: "Simple",
    models: ["gemini-2.0-flash", "gpt-4o-mini", "llama-3.1-8b"],
    // Скиллы, которые по умолчанию попадают в Tier 1
    skills: [
      "pepino-google-sheets",
      "pepino-maps-tools",
      "pepino-finance-tools",
      "pepino-team-ops",
      "pepino-knowledge",
    ],
    // Интенты, характерные для простых задач
    intents: ["data_entry", "lookup", "format", "translate", "status_check"],
    // Ключевые слова в промпте, которые маршрутизируют в Tier 1
    triggerKeywords: [
      "курс",
      "запиши",
      "покажи",
      "найди sop",
      "маршрут",
      "расстояние",
      "остатки",
      "поставь задачу",
    ],
    // Если любое из этих слов найдено, промпт НЕ может быть Tier 1
    excludeKeywords: [
      "почему",
      "проанализируй",
      "стратегия",
      "что если",
      "сценарий",
      "dcf",
      "npv",
      "оцени",
      "анализ",
      "сравни",
      "рассчитай",
      "due diligence",
      "compliance",
      "аудит",
      "haccp",
      "senasa",
      "блокируй",
      "выпуск партии",
      "заблокируй",
    ],
    maxPromptTokens: 500,
    costPerTask: 0.002,
  },
  tier2: {
    name: "Medium",
    models: ["deepseek-chat", "kimi-k2.5", "claude-3-5-haiku-latest"],
    skills: [
      "pepino-sales-crm",
      "pepino-procurement",
      "pepino-brand",
      "pepino-demand-oracle",
      "pepino-controller",
      "pepino-weekly-review",
      "pepino-climate-guard",
      "pepino-risk",
      "pepino-argentina-finance",
      "pepino-profit-engine",
      "pepino-agro-ops",
      "pepino-fermentation",
      "pepino-chef-network",
    ],
    intents: [
      "analysis",
      "report",
      "recommend",
      "content",
      "forecast",
      "monitor",
      "review",
      "compare",
      "trend",
    ],
    triggerKeywords: [
      "анализ",
      "отчёт",
      "прогноз",
      "рекомендация",
      "контент",
      "мониторинг",
      "обзор",
      "сравни",
      "тренд",
      "бюджет vs факт",
      "маржа",
      "итоги",
      "сводка",
    ],
    // Ключевые слова, повышающие до Tier 3
    escalateKeywords: [
      "стратегия",
      "что если",
      "сценарий",
      "dcf",
      "npv",
      "pitch",
      "инвестор",
      "архитектура",
    ],
    costPerTask: 0.02,
  },
  tier3: {
    name: "Complex",
    models: ["claude-sonnet-4-20250514", "gpt-4o", "gemini-1.5-pro"],
    skills: [
      "pepino-shadow-ceo",
      "pepino-financial-modeling",
      "pepino-innovation-lab",
      "pepino-capital",
      "pepino-realtor",
      "pepino-greenhouse-tech",
    ],
    intents: [
      "strategy",
      "model",
      "experiment",
      "architecture",
      "creative",
      "decision",
      "scenario",
      "pitch",
      "dcf",
      "npv",
    ],
    triggerKeywords: [
      "стратегия",
      "стратегический",
      "сценарный анализ",
      "что если",
      "dcf",
      "npv",
      "pitch",
      "инвестор",
      "эксперимент",
      "ppfd",
      "оценка участка",
      "retention",
      "архитектура",
    ],
    costPerTask: 0.1,
  },
  tier4: {
    name: "Critical",
    models: ["claude-sonnet-4-20250514"],
    verify: true,
    skills: ["pepino-qa-food-safety", "pepino-legal"],
    intents: ["approval", "release", "contract", "audit", "compliance", "haccp", "senasa"],
    // Ключевые слова, безусловно переводящие в Tier 4
    triggerKeywords: [
      "блокируй",
      "заблокируй",
      "выпуск партии",
      "haccp",
      "senasa",
      "compliance",
      "аудит",
      "due diligence",
      "контракт",
      "договор",
      "карантин",
      "food safety",
      "сертификат",
    ],
    costPerTask: 0.4,
  },
};

// --- Fallback-цепочки для каждого Tier ---
const FALLBACK_CHAINS = {
  tier1: ["gemini-2.0-flash", "gpt-4o-mini", "llama-3.1-8b", "claude-3-5-haiku-latest"],
  tier2: ["deepseek-chat", "kimi-k2.5", "claude-3-5-haiku-latest", "gpt-4o"],
  tier3: ["claude-sonnet-4-20250514", "gpt-4o", "gemini-1.5-pro", "deepseek-chat"],
  tier4: ["claude-sonnet-4-20250514", "gpt-4o", "claude-sonnet-4-20250514"],
};

// --- Утилиты ---

/**
 * Оценка количества токенов по длине текста (chars / 4)
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Нормализация текста для поиска ключевых слов
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return (text || "").toLowerCase().replace(/ё/g, "е");
}

/**
 * Проверка: содержит ли текст хотя бы одно ключевое слово из списка
 * @param {string} text
 * @param {string[]} keywords
 * @returns {string|null} — найденное слово или null
 */
function findKeyword(text, keywords) {
  const norm = normalize(text);
  for (const kw of keywords) {
    if (norm.includes(normalize(kw))) {
      return kw;
    }
  }
  return null;
}

// --- Основной классификатор ---

/**
 * Классифицирует запрос по Tier и выбирает модель
 * Приоритет проверки: Tier 4 > Tier 3 > Tier 1 > fallback Tier 2
 *
 * @param {string} skill — имя скилла (pepino-sales-crm и т.д.)
 * @param {string} intent — тип намерения (analysis, lookup и т.д.)
 * @param {string} prompt — текст запроса пользователя
 * @returns {{ tier: string, tierName: string, model: string, fallbacks: string[], reason: string, verify: boolean, estimatedCost: number, promptTokens: number }}
 */
function classifyTier(skill, intent, prompt) {
  const promptTokens = estimateTokens(prompt);
  const normalizedIntent = normalize(intent);
  const normalizedSkill = normalize(skill);

  // --- Шаг 1: Tier 4 (Critical) — проверяем первым ---
  // Скилл в списке Tier 4
  if (TIERS.tier4.skills.includes(normalizedSkill)) {
    return buildResult("tier4", "skill", `Скилл ${skill} -- критический`, promptTokens);
  }
  // Intent в списке Tier 4
  if (TIERS.tier4.intents.includes(normalizedIntent)) {
    return buildResult("tier4", "intent", `Intent "${intent}" требует верификации`, promptTokens);
  }
  // Ключевое слово Tier 4 в промпте
  const t4kw = findKeyword(prompt, TIERS.tier4.triggerKeywords);
  if (t4kw) {
    return buildResult(
      "tier4",
      "keyword",
      `Ключевое слово "${t4kw}" -- критический уровень`,
      promptTokens,
    );
  }

  // --- Шаг 2: Tier 3 (Complex) ---
  // Скилл в списке Tier 3
  if (TIERS.tier3.skills.includes(normalizedSkill)) {
    return buildResult("tier3", "skill", `Скилл ${skill} -- сложная задача`, promptTokens);
  }
  // Intent в списке Tier 3
  if (TIERS.tier3.intents.includes(normalizedIntent)) {
    return buildResult(
      "tier3",
      "intent",
      `Intent "${intent}" -- стратегический/сложный`,
      promptTokens,
    );
  }
  // Ключевое слово Tier 3 в промпте
  const t3kw = findKeyword(prompt, TIERS.tier3.triggerKeywords);
  if (t3kw) {
    return buildResult(
      "tier3",
      "keyword",
      `Ключевое слово "${t3kw}" -- сложный анализ`,
      promptTokens,
    );
  }
  // Длинный промпт (> 3000 токенов) -- предполагаем сложную задачу
  if (promptTokens > 3000) {
    return buildResult(
      "tier3",
      "length",
      `Длинный промпт (${promptTokens} токенов) -- сложная задача`,
      promptTokens,
    );
  }

  // --- Шаг 3: Tier 1 (Simple) ---
  // Проверяем, нет ли ключевых слов, исключающих Tier 1
  const excludeKw = findKeyword(prompt, TIERS.tier1.excludeKeywords);
  if (!excludeKw) {
    // Скилл в списке Tier 1
    if (TIERS.tier1.skills.includes(normalizedSkill)) {
      return buildResult("tier1", "skill", `Скилл ${skill} -- простая операция`, promptTokens);
    }
    // Intent в списке Tier 1
    if (TIERS.tier1.intents.includes(normalizedIntent)) {
      return buildResult("tier1", "intent", `Intent "${intent}" -- простая задача`, promptTokens);
    }
    // Ключевое слово Tier 1 в промпте и промпт короткий
    const t1kw = findKeyword(prompt, TIERS.tier1.triggerKeywords);
    if (t1kw && promptTokens <= TIERS.tier1.maxPromptTokens) {
      return buildResult(
        "tier1",
        "keyword",
        `Ключевое слово "${t1kw}" + короткий промпт`,
        promptTokens,
      );
    }
  }

  // --- Шаг 4: Tier 2 (Medium) — проверяем escalation ---
  // Если есть ключевое слово эскалации из Tier 2, повышаем до Tier 3
  const escKw = findKeyword(prompt, TIERS.tier2.escalateKeywords || []);
  if (escKw) {
    return buildResult(
      "tier3",
      "escalation",
      `Ключевое слово "${escKw}" в среднем скилле -- повышение до Complex`,
      promptTokens,
    );
  }

  // --- Шаг 5: Default -- Tier 2 ---
  let reason = "По умолчанию -- средняя сложность";
  if (TIERS.tier2.skills.includes(normalizedSkill)) {
    reason = `Скилл ${skill} -- средняя сложность`;
  } else if (TIERS.tier2.intents.includes(normalizedIntent)) {
    reason = `Intent "${intent}" -- средняя аналитика`;
  } else {
    const t2kw = findKeyword(prompt, TIERS.tier2.triggerKeywords);
    if (t2kw) {
      reason = `Ключевое слово "${t2kw}" -- средняя задача`;
    }
  }
  return buildResult("tier2", "default", reason, promptTokens);
}

/**
 * Собирает результат классификации
 * @param {string} tier
 * @param {string} matchType
 * @param {string} reason
 * @param {number} promptTokens
 * @returns {object}
 */
function buildResult(tier, matchType, reason, promptTokens) {
  const tierConfig = TIERS[tier];
  const fallbacks = FALLBACK_CHAINS[tier];
  const model = fallbacks[0];
  // Оценка стоимости: input = promptTokens, output ~= promptTokens (грубая оценка)
  const estimatedOutputTokens = Math.min(promptTokens * 2, PROVIDERS[model]?.maxTokens || 4096);
  const cost = estimateCost(model, promptTokens, estimatedOutputTokens);

  return {
    tier,
    tierName: tierConfig.name,
    model,
    fallbacks: fallbacks.slice(1),
    matchType,
    reason,
    verify: tierConfig.verify || false,
    estimatedCost: Math.round(cost * 1000000) / 1000000,
    promptTokens,
    estimatedOutputTokens,
  };
}

// --- Оценка стоимости ---

/**
 * Рассчитывает стоимость запроса в USD
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
function estimateCost(model, inputTokens, outputTokens) {
  const p = PROVIDERS[model];
  if (!p) return 0;
  return (inputTokens * p.inputCost + outputTokens * p.outputCost) / 1_000_000;
}

// --- Проверка качества ответа (для cascading) ---

/**
 * Проверяет качество ответа LLM для принятия решения об эскалации
 * @param {string} response — текст ответа модели
 * @param {string} tier — текущий tier
 * @returns {{ passed: boolean, reason: string }}
 */
function checkQuality(response, tier) {
  if (!response || response.trim().length < 10) {
    return { passed: false, reason: "Ответ слишком короткий или пустой" };
  }

  // Паттерны отказа
  const refusalPatterns = [
    /не могу/i,
    /cannot/i,
    /sorry/i,
    /извини/i,
    /я не в состоянии/i,
    /не имею возможности/i,
    /i can't/i,
    /i cannot/i,
    /unable to/i,
  ];
  for (const pattern of refusalPatterns) {
    if (pattern.test(response)) {
      return { passed: false, reason: `Обнаружен отказ модели: ${pattern}` };
    }
  }

  // Проверка JSON валидности, если ответ похож на JSON
  if (response.trim().startsWith("{") || response.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(response);
      // Проверка на нереальные числа (>10M для финансов Pepino)
      const numericValues = extractNumbers(parsed);
      for (const val of numericValues) {
        if (Math.abs(val) > 10_000_000 && tier !== "tier3" && tier !== "tier4") {
          return { passed: false, reason: `Подозрительное число: ${val} (> 10M для ${tier})` };
        }
      }
    } catch {
      return { passed: false, reason: "Невалидный JSON в ответе" };
    }
  }

  // Для Tier 3/4 проверяем минимальную длину ответа (ожидаем развёрнутый ответ)
  if ((tier === "tier3" || tier === "tier4") && response.trim().length < 100) {
    return {
      passed: false,
      reason: `Слишком короткий ответ для ${tier} (${response.trim().length} символов)`,
    };
  }

  return { passed: true, reason: "OK" };
}

/**
 * Извлекает числовые значения из объекта рекурсивно
 * @param {any} obj
 * @returns {number[]}
 */
function extractNumbers(obj) {
  const nums = [];
  if (typeof obj === "number") {
    nums.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      nums.push(...extractNumbers(item));
    }
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj)) {
      nums.push(...extractNumbers(val));
    }
  }
  return nums;
}

// --- Логирование затрат ---

/**
 * Записывает запись о вызове LLM в JSONL лог
 * @param {object} entry
 */
function logCost(entry) {
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    }) + "\n";
  const dir = path.dirname(COST_LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(COST_LOG_PATH, line);
}

/**
 * Читает все записи из лога
 * @returns {object[]}
 */
function readCostLog() {
  if (!fs.existsSync(COST_LOG_PATH)) return [];
  const content = fs.readFileSync(COST_LOG_PATH, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// --- CLI команды ---

/**
 * classify -- классифицировать запрос
 */
function cmdClassify(args) {
  const skill = getArg(args, "--skill") || "unknown";
  const intent = getArg(args, "--intent") || "";
  const prompt = getArg(args, "--prompt") || "";

  if (!prompt && !intent && skill === "unknown") {
    console.error(
      'Использование: node llm-router.cjs classify --skill <skill> --intent <intent> --prompt "<text>"',
    );
    process.exit(1);
  }

  const result = classifyTier(skill, intent, prompt);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * test -- быстрая классификация одного промпта
 */
function cmdTest(args) {
  const prompt = getArg(args, "--prompt") || "";
  const skill = getArg(args, "--skill") || "unknown";

  if (!prompt) {
    console.error('Использование: node llm-router.cjs test --prompt "<text>" [--skill <skill>]');
    process.exit(1);
  }

  const result = classifyTier(skill, "", prompt);
  console.log(`Prompt:  "${prompt}"`);
  console.log(`Skill:   ${skill}`);
  console.log(`Tier:    ${result.tier} (${result.tierName})`);
  console.log(`Model:   ${result.model}`);
  console.log(`Reason:  ${result.reason}`);
  console.log(`Verify:  ${result.verify}`);
  console.log(`Cost:    $${result.estimatedCost.toFixed(6)}`);
  console.log(`Tokens:  ~${result.promptTokens} input, ~${result.estimatedOutputTokens} output`);
}

/**
 * report -- отчёт за период (today/week/month)
 */
function cmdReport(args) {
  const period = getArg(args, "--period") || "today";
  const entries = readCostLog();

  if (entries.length === 0) {
    console.log("Лог пуст. Нет данных для отчёта.");
    console.log(`Путь к логу: ${COST_LOG_PATH}`);
    return;
  }

  const now = new Date();
  let cutoff;
  switch (period) {
    case "today":
      cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week":
      cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "month":
      cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default:
      cutoff = new Date(0);
  }

  const filtered = entries.filter((e) => new Date(e.timestamp) >= cutoff);
  if (filtered.length === 0) {
    console.log(`Нет данных за период: ${period}`);
    return;
  }

  const totalCost = filtered.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  const skillCosts = {};
  let escalated = 0;

  for (const e of filtered) {
    const t = e.tier || "tier2";
    tierCounts[t] = (tierCounts[t] || 0) + 1;
    if (e.escalated) escalated++;
    const sk = e.skill || "unknown";
    skillCosts[sk] = (skillCosts[sk] || 0) + (e.cost_usd || 0);
  }

  // Топ-3 по затратам
  const topSkills = Object.entries(skillCosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  console.log(`AI Costs -- ${period}`);
  console.log("");
  console.log(
    `Задач:     ${filtered.length} (T1: ${tierCounts.tier1}, T2: ${tierCounts.tier2}, T3: ${tierCounts.tier3}, T4: ${tierCounts.tier4})`,
  );
  console.log(`Расход:    $${totalCost.toFixed(2)}`);
  console.log(`Avg/task:  $${(totalCost / filtered.length).toFixed(4)}`);
  console.log(`Escalated: ${escalated} (${((escalated / filtered.length) * 100).toFixed(1)}%)`);
  console.log("");
  console.log("Топ-3 по затратам:");
  topSkills.forEach(([sk, cost], i) => {
    const count = filtered.filter((e) => e.skill === sk).length;
    console.log(`  ${i + 1}. ${sk}: $${cost.toFixed(2)} (${count} задач)`);
  });
  console.log("");
  console.log(
    `Budget: $66.60/мес -> использовано $${totalCost.toFixed(2)} (${((totalCost / 66.6) * 100).toFixed(1)}%)`,
  );
}

/**
 * stats -- общая статистика
 */
function cmdStats() {
  const entries = readCostLog();

  if (entries.length === 0) {
    console.log("Статистика LLM Router");
    console.log("=====================");
    console.log("");
    console.log(`Лог:     ${COST_LOG_PATH}`);
    console.log("Записей: 0");
    console.log("");
    console.log("Лог пуст. Запустите classify с --log для записи данных.");
    console.log("");
    console.log("Доступные Tier:");
    for (const [key, tier] of Object.entries(TIERS)) {
      console.log(
        `  ${key} (${tier.name}): ${tier.models.join(", ")} | $${tier.costPerTask}/задача`,
      );
    }
    console.log("");
    console.log("Провайдеры:");
    for (const [model, info] of Object.entries(PROVIDERS)) {
      console.log(
        `  ${model} [${info.provider}]: input $${info.inputCost}/1M, output $${info.outputCost}/1M`,
      );
    }
    return;
  }

  const totalCost = entries.reduce((s, e) => s + (e.cost_usd || 0), 0);
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  const modelCounts = {};
  let escalated = 0;

  for (const e of entries) {
    const t = e.tier || "tier2";
    tierCounts[t] = (tierCounts[t] || 0) + 1;
    const m = e.model || "unknown";
    modelCounts[m] = (modelCounts[m] || 0) + 1;
    if (e.escalated) escalated++;
  }

  // Стоимость если бы всё шло через Sonnet
  const sonnetBaseline = entries.reduce((s, e) => {
    const input = e.input_tokens || 0;
    const output = e.output_tokens || 0;
    return s + estimateCost("claude-sonnet-4-20250514", input, output);
  }, 0);

  console.log("Статистика LLM Router");
  console.log("=====================");
  console.log("");
  console.log(`Всего задач:   ${entries.length}`);
  console.log(`Общий расход:  $${totalCost.toFixed(2)}`);
  console.log(`Avg/task:      $${(totalCost / entries.length).toFixed(4)}`);
  console.log(`Escalated:     ${escalated} (${((escalated / entries.length) * 100).toFixed(1)}%)`);
  console.log("");
  console.log("По Tier:");
  for (const [t, count] of Object.entries(tierCounts)) {
    const pct = ((count / entries.length) * 100).toFixed(1);
    console.log(`  ${t}: ${count} (${pct}%)`);
  }
  console.log("");
  console.log("По моделям:");
  for (const [m, count] of Object.entries(modelCounts)) {
    console.log(`  ${m}: ${count}`);
  }
  console.log("");
  console.log(`All-Sonnet baseline: $${sonnetBaseline.toFixed(2)}`);
  if (sonnetBaseline > 0) {
    const savings = sonnetBaseline - totalCost;
    const pct = ((savings / sonnetBaseline) * 100).toFixed(1);
    console.log(`Экономия:          $${savings.toFixed(2)} (${pct}%)`);
  }
}

/**
 * simulate -- массовое тестирование классификатора
 */
function cmdSimulate() {
  const TEST_PROMPTS = [
    // Tier 1 -- простые задачи
    {
      prompt: "Запиши: зона A, EC 2.1, pH 6.2, урожай 15 кг",
      skill: "pepino-agro-ops",
      expected: "tier1",
    },
    { prompt: "Курс Blue", skill: "pepino-finance-tools", expected: "tier1" },
    { prompt: "Покажи остатки на складе", skill: "pepino-google-sheets", expected: "tier1" },
    { prompt: "Маршрут до клиента У Беларуса", skill: "pepino-maps-tools", expected: "tier1" },
    { prompt: "Найди SOP по упаковке", skill: "pepino-knowledge", expected: "tier1" },
    {
      prompt: "Поставь задачу Хуану: проверить зону C",
      skill: "pepino-team-ops",
      expected: "tier1",
    },
    { prompt: "Покажи KPI за сегодня", skill: "pepino-google-sheets", expected: "tier1" },
    { prompt: "Запиши расход: мицелий 5 кг", skill: "pepino-google-sheets", expected: "tier1" },
    { prompt: "Курс доллара Oficial", skill: "pepino-finance-tools", expected: "tier1" },
    { prompt: "Найди SOP по инокуляции", skill: "pepino-knowledge", expected: "tier1" },

    // Tier 2 -- средние задачи
    { prompt: "Подготовь КП для ресторана Тележка", skill: "pepino-sales-crm", expected: "tier2" },
    {
      prompt: "Анализ маржи по продуктам за март",
      skill: "pepino-profit-engine",
      expected: "tier2",
    },
    { prompt: "Контент-план Instagram на неделю", skill: "pepino-brand", expected: "tier2" },
    {
      prompt: "Прогноз спроса на следующую неделю",
      skill: "pepino-demand-oracle",
      expected: "tier2",
    },
    {
      prompt: "Итоги недели по всем направлениям",
      skill: "pepino-weekly-review",
      expected: "tier2",
    },
    {
      prompt: "Оцени надёжность поставщика субстрата",
      skill: "pepino-procurement",
      expected: "tier2",
    },
    { prompt: "Бюджет vs факт за февраль", skill: "pepino-controller", expected: "tier2" },
    { prompt: "Температура и влажность в зонах", skill: "pepino-climate-guard", expected: "tier2" },
    {
      prompt: "Арбитраж Blue/MEP -- пора ли менять?",
      skill: "pepino-argentina-finance",
      expected: "tier2",
    },
    { prompt: "Какие риски сейчас критические?", skill: "pepino-risk", expected: "tier2" },

    // Tier 3 -- сложные задачи
    {
      prompt: "Что если поднять цены на 15%? Сценарный анализ P&L",
      skill: "pepino-financial-modeling",
      expected: "tier3",
    },
    {
      prompt: "DCF проекта второй теплицы, горизонт 5 лет",
      skill: "pepino-financial-modeling",
      expected: "tier3",
    },
    {
      prompt: "Стратегия retention для топ-клиентов",
      skill: "pepino-shadow-ceo",
      expected: "tier3",
    },
    {
      prompt: "Запусти эксперимент: новый субстрат для вешенки",
      skill: "pepino-innovation-lab",
      expected: "tier3",
    },
    {
      prompt: "Подготовь pitch для инвестора, серия A",
      skill: "pepino-capital",
      expected: "tier3",
    },
    {
      prompt: "Рассчитай PPFD для зоны C, площадь 40м2",
      skill: "pepino-greenhouse-tech",
      expected: "tier3",
    },
    {
      prompt: "Оценка участка 5 Га в Пилар по 40 критериям",
      skill: "pepino-realtor",
      expected: "tier3",
    },
    {
      prompt: "Стоит ли открывать вторую теплицу? Стратегический анализ",
      skill: "pepino-shadow-ceo",
      expected: "tier3",
    },

    // Tier 4 -- критические задачи
    {
      prompt: "Заблокируй партию #45 - подозрение на загрязнение",
      skill: "pepino-qa-food-safety",
      expected: "tier4",
    },
    {
      prompt: "Проверь договор поставки на соответствие SENASA",
      skill: "pepino-legal",
      expected: "tier4",
    },
    { prompt: "Аудит HACCP для зоны B", skill: "pepino-qa-food-safety", expected: "tier4" },
    { prompt: "Compliance check для экспорта в Уругвай", skill: "pepino-legal", expected: "tier4" },
    {
      prompt: "Due Diligence поставщика: полная проверка",
      skill: "pepino-procurement",
      expected: "tier4",
    },
    {
      prompt: "Выпуск партии #78 после карантина",
      skill: "pepino-qa-food-safety",
      expected: "tier4",
    },
  ];

  let correct = 0;
  let total = TEST_PROMPTS.length;
  const results = [];

  // Стоимость при роутинге vs all-Sonnet
  let routedCostTotal = 0;
  let sonnetCostTotal = 0;

  console.log("LLM Router -- Simulation");
  console.log("========================");
  console.log("");
  console.log(
    padRight("Prompt", 55) +
      padRight("Skill", 30) +
      padRight("Expected", 8) +
      padRight("Got", 8) +
      padRight("Model", 28) +
      "OK",
  );
  console.log("-".repeat(135));

  for (const test of TEST_PROMPTS) {
    const result = classifyTier(test.skill, "", test.prompt);
    const ok = result.tier === test.expected;
    if (ok) correct++;

    routedCostTotal += result.estimatedCost;
    const sonnetCost = estimateCost(
      "claude-sonnet-4-20250514",
      result.promptTokens,
      result.estimatedOutputTokens,
    );
    sonnetCostTotal += sonnetCost;

    const promptShort = test.prompt.length > 52 ? test.prompt.slice(0, 49) + "..." : test.prompt;
    const status = ok ? "OK" : "MISS";
    console.log(
      padRight(promptShort, 55) +
        padRight(test.skill, 30) +
        padRight(test.expected, 8) +
        padRight(result.tier, 8) +
        padRight(result.model, 28) +
        status,
    );

    results.push({ ...test, got: result.tier, model: result.model, ok });
  }

  console.log("-".repeat(135));
  console.log("");

  const accuracy = ((correct / total) * 100).toFixed(1);
  const missed = results.filter((r) => !r.ok);

  console.log(`Accuracy:  ${correct}/${total} (${accuracy}%)`);
  console.log("");
  console.log(`Routed cost (estimated):     $${routedCostTotal.toFixed(4)}`);
  console.log(`All-Sonnet cost (estimated): $${sonnetCostTotal.toFixed(4)}`);
  if (sonnetCostTotal > 0) {
    const savings = ((1 - routedCostTotal / sonnetCostTotal) * 100).toFixed(1);
    console.log(`Savings:                     ${savings}%`);
  }

  if (missed.length > 0) {
    console.log("");
    console.log("Mismatches:");
    for (const m of missed) {
      console.log(`  "${m.prompt}" [${m.skill}] -- expected ${m.expected}, got ${m.got}`);
    }
  }

  // Распределение по Tier
  console.log("");
  console.log("Distribution:");
  const dist = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  for (const r of results) {
    dist[r.got] = (dist[r.got] || 0) + 1;
  }
  for (const [t, count] of Object.entries(dist)) {
    const pct = ((count / total) * 100).toFixed(0);
    const bar = "#".repeat(Math.round((count / total) * 40));
    console.log(`  ${t}: ${padRight(String(count), 4)} (${padRight(pct + "%", 5)}) ${bar}`);
  }
}

// --- Утилиты CLI ---

function padRight(str, len) {
  str = String(str);
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// --- Экспорт для программного использования ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    classifyTier,
    estimateCost,
    checkQuality,
    logCost,
    readCostLog,
    TIERS,
    PROVIDERS,
    FALLBACK_CHAINS,
  };
}

// --- Точка входа CLI ---
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "classify":
      cmdClassify(args.slice(1));
      break;
    case "test":
      cmdTest(args.slice(1));
      break;
    case "report":
      cmdReport(args.slice(1));
      break;
    case "stats":
      cmdStats();
      break;
    case "simulate":
      cmdSimulate();
      break;
    default:
      console.log("Pepino Pick LLM Router v1.0");
      console.log("");
      console.log("Использование:");
      console.log(
        '  node llm-router.cjs classify --skill <skill> --intent <intent> --prompt "<text>"',
      );
      console.log('  node llm-router.cjs test --prompt "<text>" [--skill <skill>]');
      console.log("  node llm-router.cjs report --period today|week|month");
      console.log("  node llm-router.cjs stats");
      console.log("  node llm-router.cjs simulate");
      console.log("");
      console.log("Примеры:");
      console.log(
        '  node llm-router.cjs classify --skill pepino-sales-crm --intent analysis --prompt "Маржа по продуктам"',
      );
      console.log('  node llm-router.cjs test --prompt "Запиши урожай 15 кг вешенки"');
      console.log("  node llm-router.cjs simulate");
      break;
  }
}

main();
