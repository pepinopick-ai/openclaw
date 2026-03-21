#!/usr/bin/env node
/**
 * task-brain.cjs -- PEPINO TASK BRAIN
 *
 * Стратегический движок планирования задач. Принимает хаотичный ввод,
 * анализирует по 8 измерениям, строит оптимальный план дня/недели.
 *
 * 8 измерений: domain, urgency, importance, effort, resources, energy,
 *              dependencies, multiplier.
 *
 * CLI:
 *   node task-brain.cjs add "купить субстрат 20 мешков"
 *   node task-brain.cjs add "позвонить El Patio насчёт заказа"
 *   node task-brain.cjs plan                    -- оптимальный план на сегодня
 *   node task-brain.cjs plan --horizon week     -- план на неделю
 *   node task-brain.cjs today                   -- что делать прямо сейчас
 *   node task-brain.cjs matrix                  -- матрица Эйзенхауэра
 *   node task-brain.cjs backlog                 -- все незапланированные задачи
 *   node task-brain.cjs done "описание задачи"  -- отметить выполненной
 *   node task-brain.cjs stats                   -- статистика
 *   node task-brain.cjs --dry-run <command>
 *
 * API:
 *   const { addTask, generatePlan, getToday, getMatrix, markDone } = require("./task-brain.cjs");
 *
 * Зависимости: farm-state.cjs, helpers.cjs, notification-throttle.cjs, langfuse-trace.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { parseNum, fmtDate, fmtNum, daysBetween } = require("./helpers.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Константы ----------------------------------------------------------------

const BACKLOG_PATH = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  "workspace",
  "memory",
  "task-brain-backlog.json",
);

/** Telegram-топик для задач (Director/Strategy) */
const TOPIC_TASKS = 20;

/** Максимум задач в день */
const MAX_TASKS_PER_DAY = 8;

/** Максимум high-energy задач в день */
const MAX_HIGH_ENERGY_PER_DAY = 3;

/** Аргентина UTC-3 */
const ARGENTINA_UTC_OFFSET = -3;

// -- Домены и ключевые слова --------------------------------------------------

/** @typedef {"production"|"sales"|"finance"|"logistics"|"marketing"|"operations"|"hr"|"strategy"} Domain */

/** Ключевые слова для определения домена задачи */
const DOMAIN_KEYWORDS = {
  production: [
    "урожай",
    "сбор",
    "посадка",
    "полив",
    "субстрат",
    "мицелий",
    "зона",
    "теплица",
    "грибы",
    "микрозелен",
    "огурц",
    "рассад",
    "семен",
    "harvest",
    "плодонош",
    "цикл",
    "компост",
    "вентиляц",
    "обогрев",
    "влажност",
  ],
  sales: [
    "клиент",
    "ресторан",
    "заказ",
    "доставка",
    "кп",
    "предложени",
    "звонок",
    "продаж",
    "покупатель",
    "контракт",
    "счёт",
    "invoice",
    "оплат",
    "переговор",
    "встреча с клиент",
  ],
  finance: [
    "расход",
    "оплата",
    "счёт",
    "цена",
    "маржа",
    "бюджет",
    "инвестиц",
    "прибыл",
    "убыт",
    "стоимост",
    "денег",
    "деньги",
    "cash",
    "p&l",
    "кредит",
    "долг",
  ],
  logistics: [
    "доставка",
    "маршрут",
    "склад",
    "тара",
    "упаковка",
    "транспорт",
    "забрать",
    "привезти",
    "отвезти",
    "перевоз",
    "груз",
    "коробк",
  ],
  marketing: [
    "пост",
    "инстаграм",
    "фото",
    "контент",
    "бренд",
    "реклама",
    "сайт",
    "видео",
    "social",
    "instagram",
    "stories",
    "reels",
    "дегустац",
    "pr",
    "продвижен",
  ],
  operations: [
    "починить",
    "настроить",
    "обслуживан",
    "ремонт",
    "замена",
    "установ",
    "подключ",
    "обновить",
    "диагностик",
    "проверить",
    "исправить",
    "fix",
  ],
  hr: [
    "сотрудник",
    "зарплата",
    "найм",
    "обучен",
    "расписание",
    "график",
    "отпуск",
    "нанять",
    "собеседован",
    "стажер",
    "кандидат",
  ],
  strategy: [
    "план",
    "развитие",
    "новый рынок",
    "масштабирован",
    "инвестиц",
    "стратег",
    "анализ рынка",
    "конкурент",
    "партнёр",
    "расширен",
  ],
};

const DOMAIN_LABELS = {
  production: "Производство",
  sales: "Продажи",
  finance: "Финансы",
  logistics: "Логистика",
  marketing: "Маркетинг",
  operations: "Операции",
  hr: "Кадры",
  strategy: "Стратегия",
};

// -- Ключевые слова для анализа -----------------------------------------------

/** Ключевые слова для определения срочности */
const URGENCY_KEYWORDS = {
  5: ["срочно", "сегодня", "сломалось", "критично", "немедленно", "asap", "экстренн"],
  4: ["завтра", "на этой неделе", "скоро", "быстро", "до конца недели"],
  3: ["нужно", "важно", "надо", "необходимо", "следует"],
  2: ["когда будет время", "неплохо бы", "по возможности", "если получится"],
  1: ["идея", "подумать", "потом", "когда-нибудь", "может быть", "на будущее"],
};

/** Ключевые слова для определения ресурсов */
const RESOURCE_KEYWORDS = {
  money: ["купить", "заказать", "оплатить", "оплата", "покупка", "закупка", "арендовать"],
  vehicle: ["доставка", "доставить", "привезти", "отвезти", "забрать", "маршрут", "поездка"],
  tools: ["починить", "установить", "настроить", "ремонт", "замена", "подключ", "монтаж"],
  people: ["помощник", "сотрудник", "бригада", "команда", "вдвоём", "нанять", "вместе"],
  phone_only: ["позвонить", "звонок", "написать", "отправить", "sms", "whatsapp", "telegram"],
  computer: ["таблица", "отчёт", "аналитик", "сайт", "пост", "контент", "скрипт", "excel"],
  greenhouse: ["теплица", "зона 1", "зона 2", "зона 3", "полив", "сбор", "посадка", "обход"],
};

/** Ключевые слова для определения энергии */
const ENERGY_HIGH_KW = [
  "починить",
  "ремонт",
  "установ",
  "монтаж",
  "физическ",
  "копать",
  "переговор",
  "презентац",
  "сложн",
  "разработ",
  "стратег",
  "планирован",
];
const ENERGY_LOW_KW = [
  "запис",
  "ввести данн",
  "обновить таблиц",
  "пост в инста",
  "чтение",
  "проверить почт",
  "заметк",
];

/** Ключевые слова для определения стоимости (грубая оценка в ARS) */
const COST_HINTS = {
  субстрат: 15000,
  мицелий: 20000,
  семен: 5000,
  тара: 3000,
  упаковка: 2000,
  удобрени: 8000,
  инструмент: 10000,
  запчаст: 5000,
  реклам: 10000,
};

// -- Временные блоки для планирования -----------------------------------------

/**
 * Стандартные блоки рабочего дня (Аргентина, ферма).
 * location: greenhouse | city | home
 * energy_level: high | medium | low
 */
const DAY_BLOCKS = [
  {
    id: "early_greenhouse",
    label: "06:00-08:00",
    start: 6,
    end: 8,
    location: "greenhouse",
    energy: "high",
  },
  {
    id: "morning_city",
    label: "08:00-12:00",
    start: 8,
    end: 12,
    location: "city",
    energy: "medium",
  },
  {
    id: "afternoon_farm",
    label: "14:00-16:00",
    start: 14,
    end: 16,
    location: "greenhouse",
    energy: "medium",
  },
  { id: "evening_desk", label: "16:00-18:00", start: 16, end: 18, location: "home", energy: "low" },
];

/** Маппинг ресурсов к локации блока */
const RESOURCE_LOCATION_MAP = {
  greenhouse: "greenhouse",
  vehicle: "city",
  phone_only: "city", // можно делать в дороге
  computer: "home",
  tools: "greenhouse",
};

// -- Хранилище ----------------------------------------------------------------

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} raw -- исходный текст задачи
 * @property {Domain} domain
 * @property {number} urgency -- 1-5
 * @property {number} importance -- 1-5
 * @property {string} effort -- XS|S|M|L|XL
 * @property {string} energy -- high|medium|low
 * @property {string[]} resources -- money|vehicle|tools|people|phone_only|computer|greenhouse
 * @property {number} cost_ars -- оценка стоимости
 * @property {number} multiplier -- сколько доменов затрагивает (1-8)
 * @property {string} eisenhower -- Q1|Q2|Q3|Q4
 * @property {string[]} dependencies
 * @property {string} status -- pending|planned|in_progress|done|cancelled
 * @property {string} created -- ISO date
 * @property {string|null} scheduled_for -- YYYY-MM-DD
 * @property {string|null} completed_at -- ISO date
 * @property {string[]} combos -- ID задач для группировки
 * @property {string} preferred_location -- greenhouse|city|home|any
 */

/**
 * Загружает бэклог из файла.
 * @returns {Task[]}
 */
function loadBacklog() {
  try {
    if (fs.existsSync(BACKLOG_PATH)) {
      const raw = fs.readFileSync(BACKLOG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Повреждённый файл -- начинаем заново
  }
  return [];
}

/**
 * Сохраняет бэклог в файл (атомарно).
 * @param {Task[]} tasks
 */
function saveBacklog(tasks) {
  const dir = path.dirname(BACKLOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = BACKLOG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(tasks, null, 2), "utf-8");
  fs.renameSync(tmpPath, BACKLOG_PATH);
}

// -- Анализ задачи (8 измерений) ----------------------------------------------

/**
 * Определяет домен задачи по ключевым словам.
 * @param {string} text
 * @returns {Domain}
 */
function detectDomain(text) {
  const lower = text.toLowerCase();
  /** @type {Record<string, number>} */
  const scores = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    scores[domain] = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        scores[domain] += 1;
      }
    }
  }

  // Лучший домен с наибольшим количеством совпадений
  let best = "operations";
  let bestScore = 0;
  for (const [domain, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }

  return /** @type {Domain} */ (best);
}

/**
 * Определяет срочность (1-5) по ключевым словам.
 * @param {string} text
 * @returns {number}
 */
function detectUrgency(text) {
  const lower = text.toLowerCase();

  // Проверяем от самого срочного к наименее
  for (const level of [5, 4, 3, 2, 1]) {
    const keywords = URGENCY_KEYWORDS[level];
    for (const kw of keywords) {
      if (lower.includes(kw)) return level;
    }
  }

  return 3; // По умолчанию: "нужно сделать"
}

/**
 * Определяет важность (1-5) на основе домена и контекста.
 * @param {string} text
 * @param {Domain} domain
 * @returns {number}
 */
function detectImportance(text, domain) {
  const lower = text.toLowerCase();

  // Всё, что влияет на выручку или клиентов -- высокая важность
  if (/клиент|ресторан|заказ|выручк|продаж/.test(lower)) return 4;
  if (/критично|срочно|сломалось|потеря/.test(lower)) return 5;
  if (/производств|урожай|полив|посадка/.test(lower)) return 4;

  // Стратегические задачи -- средне-высокая важность
  if (domain === "strategy") return 4;
  if (domain === "finance") return 3;

  // Маркетинг и HR -- средняя важность
  if (domain === "marketing" || domain === "hr") return 2;

  // Операции -- зависит от контекста
  if (/починить|ремонт|сломал/.test(lower)) return 4;
  if (/обновить|настроить/.test(lower)) return 2;

  return 3; // По умолчанию
}

/**
 * Определяет трудоёмкость (XS|S|M|L|XL).
 * @param {string} text
 * @param {string[]} resources
 * @returns {string}
 */
function detectEffort(text, resources) {
  const lower = text.toLowerCase();

  // XS: быстрые действия
  if (/позвонить|звонок|написать|отправить|запис/.test(lower)) return "XS";
  if (/ввести|заполн|обновить таблиц/.test(lower)) return "XS";

  // XL: большие проекты
  if (/масштабирован|разработ|новый проект|стратегически|бизнес-план/.test(lower)) return "XL";
  if (/построить|капитальн|большой/.test(lower)) return "L";

  // L: полдня работы
  if (/ремонт|установ|монтаж/.test(lower) && resources.includes("tools")) return "M";

  // M: с транспортом
  if (resources.includes("vehicle")) return "M";

  // S: визит, настройка
  if (/визит|настроить|проверить|обход/.test(lower)) return "S";
  if (/пост|фото|контент/.test(lower)) return "S";
  if (/подготовить|составить|кп/.test(lower)) return "S";

  return "S"; // По умолчанию
}

/**
 * Определяет необходимые ресурсы.
 * @param {string} text
 * @returns {string[]}
 */
function detectResources(text) {
  const lower = text.toLowerCase();
  /** @type {string[]} */
  const result = [];

  for (const [resource, keywords] of Object.entries(RESOURCE_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        if (!result.includes(resource)) {
          result.push(resource);
        }
        break;
      }
    }
  }

  return result.length > 0 ? result : ["phone_only"];
}

/**
 * Определяет энергозатратность задачи.
 * @param {string} text
 * @param {string[]} resources
 * @returns {string}
 */
function detectEnergy(text, resources) {
  const lower = text.toLowerCase();

  for (const kw of ENERGY_HIGH_KW) {
    if (lower.includes(kw)) return "high";
  }
  for (const kw of ENERGY_LOW_KW) {
    if (lower.includes(kw)) return "low";
  }

  // Ресурсоёмкие задачи = medium/high
  if (resources.includes("tools")) return "high";
  if (resources.includes("vehicle")) return "medium";

  return "medium";
}

/**
 * Оценивает стоимость задачи в ARS.
 * @param {string} text
 * @returns {number}
 */
function detectCost(text) {
  const lower = text.toLowerCase();

  // Ищем прямые числа ("20000 ARS", "15к", "15000")
  const numMatch = text.match(/(\d[\d\s.,]*)\s*(ars|pesos?|к|k)/i);
  if (numMatch) {
    let val = parseNum(numMatch[1]);
    if (/к|k/i.test(numMatch[2])) val *= 1000;
    if (val > 0) return Math.round(val);
  }

  // Подсказки по ключевым словам
  for (const [keyword, cost] of Object.entries(COST_HINTS)) {
    if (lower.includes(keyword)) return cost;
  }

  // Если есть ресурс "money" но нет конкретной суммы
  return 0;
}

/**
 * Определяет зависимости из текста.
 * @param {string} text
 * @param {Task[]} existingTasks
 * @returns {string[]}
 */
function detectDependencies(text, existingTasks) {
  const lower = text.toLowerCase();
  /** @type {string[]} */
  const deps = [];

  // Ключевые фразы зависимостей
  const depPatterns = [
    /после\s+(.+?)(?:\s*$|,)/,
    /когда\s+(.+?)(?:\s*$|,)/,
    /сначала\s+(.+?)(?:\s*$|,)/,
    /дождаться\s+(.+?)(?:\s*$|,)/,
  ];

  for (const pattern of depPatterns) {
    const match = lower.match(pattern);
    if (match) {
      const depText = match[1].trim();
      // Ищем совпадение с существующими задачами
      for (const task of existingTasks) {
        if (task.status !== "done" && task.raw.toLowerCase().includes(depText)) {
          deps.push(task.id);
        }
      }
    }
  }

  return deps;
}

/**
 * Подсчитывает мультипликатор (сколько доменов затрагивает задача).
 * @param {string} text
 * @returns {number}
 */
function detectMultiplier(text) {
  const lower = text.toLowerCase();
  let count = 0;

  for (const keywords of Object.values(DOMAIN_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        count++;
        break; // Один домен = +1, не считаем повторно
      }
    }
  }

  return Math.max(1, count);
}

/**
 * Определяет квадрант Эйзенхауэра.
 * @param {number} urgency
 * @param {number} importance
 * @returns {string}
 */
function eisenhowerQuadrant(urgency, importance) {
  const isUrgent = urgency >= 4;
  const isImportant = importance >= 4;

  if (isUrgent && isImportant) return "Q1";
  if (!isUrgent && isImportant) return "Q2";
  if (isUrgent && !isImportant) return "Q3";
  return "Q4";
}

/**
 * Определяет предпочтительную локацию по ресурсам.
 * @param {string[]} resources
 * @returns {string}
 */
function detectPreferredLocation(resources) {
  if (resources.includes("greenhouse")) return "greenhouse";
  if (resources.includes("vehicle")) return "city";
  if (resources.includes("computer")) return "home";
  if (resources.includes("tools")) return "greenhouse";
  return "any";
}

/**
 * Полный анализ задачи по 8 измерениям.
 * @param {string} rawText -- исходный текст задачи
 * @param {Task[]} existingTasks -- существующие задачи для поиска зависимостей
 * @returns {Task}
 */
function analyzeTask(rawText, existingTasks = []) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(existingTasks.length + 1).padStart(3, "0");
  const id = `tb-${dateStr}-${seq}`;

  const resources = detectResources(rawText);
  const domain = detectDomain(rawText);
  const urgency = detectUrgency(rawText);
  const importance = detectImportance(rawText, domain);

  return {
    id,
    raw: rawText,
    domain,
    urgency,
    importance,
    effort: detectEffort(rawText, resources),
    energy: detectEnergy(rawText, resources),
    resources,
    cost_ars: detectCost(rawText),
    multiplier: detectMultiplier(rawText),
    eisenhower: eisenhowerQuadrant(urgency, importance),
    dependencies: detectDependencies(rawText, existingTasks),
    status: "pending",
    created: now.toISOString(),
    scheduled_for: null,
    completed_at: null,
    combos: [],
    preferred_location: detectPreferredLocation(resources),
  };
}

// -- Обнаружение комбо --------------------------------------------------------

/**
 * Находит задачи, которые можно объединить в одно действие.
 * @param {Task[]} tasks
 * @returns {Array<{ids: string[], reason: string}>}
 */
function detectCombos(tasks) {
  /** @type {Array<{ids: string[], reason: string}>} */
  const combos = [];
  const active = tasks.filter((t) => t.status === "pending" || t.status === "planned");

  // Группа 1: Задачи с vehicle -- объединить в одну поездку
  const vehicleTasks = active.filter((t) => t.resources.includes("vehicle"));
  if (vehicleTasks.length >= 2) {
    combos.push({
      ids: vehicleTasks.map((t) => t.id),
      reason: "1 поездка, несколько задач",
    });
  }

  // Группа 2: Задачи greenhouse -- объединить в один обход
  const ghTasks = active.filter((t) => t.preferred_location === "greenhouse");
  if (ghTasks.length >= 2) {
    combos.push({
      ids: ghTasks.map((t) => t.id),
      reason: "1 обход теплицы, несколько задач",
    });
  }

  // Группа 3: Задачи phone_only -- батч звонков
  const phoneTasks = active.filter(
    (t) => t.resources.includes("phone_only") && !t.resources.includes("computer"),
  );
  if (phoneTasks.length >= 2) {
    combos.push({
      ids: phoneTasks.map((t) => t.id),
      reason: "сессия звонков подряд",
    });
  }

  // Группа 4: Одинаковый домен -- sales session, marketing session
  for (const domain of ["sales", "marketing"]) {
    const domTasks = active.filter((t) => t.domain === domain);
    if (domTasks.length >= 2) {
      combos.push({
        ids: domTasks.map((t) => t.id),
        reason: `${DOMAIN_LABELS[domain]}-сессия`,
      });
    }
  }

  // Записываем combo-ссылки обратно в задачи
  for (const combo of combos) {
    for (const id of combo.ids) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        const others = combo.ids.filter((cid) => cid !== id);
        for (const oid of others) {
          if (!task.combos.includes(oid)) {
            task.combos.push(oid);
          }
        }
      }
    }
  }

  return combos;
}

// -- Планирование -------------------------------------------------------------

/**
 * Время оценки для effort.
 * @param {string} effort
 * @returns {number} часы
 */
function effortHours(effort) {
  switch (effort) {
    case "XS":
      return 0.25;
    case "S":
      return 0.75;
    case "M":
      return 2.5;
    case "L":
      return 6;
    case "XL":
      return 10;
    default:
      return 1;
  }
}

/**
 * Сортирует задачи по приоритету для планирования.
 * Q1 > Q2 > Q3 > Q4, внутри -- по multiplier и urgency.
 * @param {Task[]} tasks
 * @returns {Task[]}
 */
function prioritySort(tasks) {
  const qOrder = { Q1: 0, Q2: 1, Q3: 2, Q4: 3 };
  return [...tasks].sort((a, b) => {
    // Квадрант Эйзенхауэра
    const qDiff = (qOrder[a.eisenhower] || 3) - (qOrder[b.eisenhower] || 3);
    if (qDiff !== 0) return qDiff;
    // Мультипликатор (больше = лучше)
    if (b.multiplier !== a.multiplier) return b.multiplier - a.multiplier;
    // Срочность
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    // Важность
    return b.importance - a.importance;
  });
}

/**
 * Генерирует план на день.
 * @param {Task[]} allTasks -- все задачи из бэклога
 * @param {string} dateStr -- YYYY-MM-DD
 * @returns {{ blocks: Array<{block: object, tasks: Task[]}>, summary: object }}
 */
function planDay(allTasks, dateStr) {
  // Фильтруем доступные задачи: pending/planned, без невыполненных зависимостей
  const doneIds = new Set(allTasks.filter((t) => t.status === "done").map((t) => t.id));
  const available = allTasks.filter((t) => {
    if (t.status !== "pending" && t.status !== "planned") return false;
    // Проверяем зависимости
    if (t.dependencies.length > 0) {
      const allDepsDone = t.dependencies.every((depId) => doneIds.has(depId));
      if (!allDepsDone) return false;
    }
    return true;
  });

  // Сортируем по приоритету
  const sorted = prioritySort(available);

  // Распределяем по блокам дня
  /** @type {Array<{block: typeof DAY_BLOCKS[0], tasks: Task[]}>} */
  const schedule = DAY_BLOCKS.map((block) => ({ block, tasks: [] }));
  let totalTasks = 0;
  let highEnergyCount = 0;
  let totalHours = 0;
  let totalCost = 0;

  /** @type {Set<string>} */
  const assigned = new Set();

  for (const task of sorted) {
    if (totalTasks >= MAX_TASKS_PER_DAY) break;
    if (task.energy === "high" && highEnergyCount >= MAX_HIGH_ENERGY_PER_DAY) continue;
    if (assigned.has(task.id)) continue;

    // Найти лучший блок по локации и энергии
    let bestBlock = null;
    let bestScore = -1;

    for (const slot of schedule) {
      const blockHoursUsed = slot.tasks.reduce((s, t) => s + effortHours(t.effort), 0);
      const blockCapacity = slot.block.end - slot.block.start;
      const remainingCapacity = blockCapacity - blockHoursUsed;

      if (remainingCapacity < effortHours(task.effort)) continue;

      let score = 0;
      // Совпадение локации (+10)
      if (task.preferred_location === "any") {
        score += 5;
      } else if (
        (task.preferred_location === "greenhouse" && slot.block.location === "greenhouse") ||
        (task.preferred_location === "city" && slot.block.location === "city") ||
        (task.preferred_location === "home" && slot.block.location === "home")
      ) {
        score += 10;
      }

      // Совпадение энергии (+5)
      if (task.energy === slot.block.energy) {
        score += 5;
      } else if (task.energy === "high" && slot.block.energy === "medium") {
        score += 2; // high-energy задачу можно в medium блок, но не идеально
      }

      // Combo-бонус: если в блоке уже есть combo-партнёр (+8)
      for (const existing of slot.tasks) {
        if (task.combos.includes(existing.id)) {
          score += 8;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestBlock = slot;
      }
    }

    if (bestBlock) {
      bestBlock.tasks.push(task);
      task.status = "planned";
      task.scheduled_for = dateStr;
      assigned.add(task.id);
      totalTasks++;
      totalHours += effortHours(task.effort);
      totalCost += task.cost_ars;
      if (task.energy === "high") highEnergyCount++;
    }
  }

  // Обнаруживаем комбо в расписании
  const combos = detectCombos(allTasks);
  const activeCombos = combos.filter((c) => c.ids.some((id) => assigned.has(id)));

  return {
    blocks: schedule.filter((s) => s.tasks.length > 0),
    summary: {
      date: dateStr,
      total_tasks: totalTasks,
      total_hours: Math.round(totalHours * 10) / 10,
      total_cost: totalCost,
      high_energy: highEnergyCount,
      combos: activeCombos,
      q1: sorted.filter((t) => t.eisenhower === "Q1" && assigned.has(t.id)).length,
      q2: sorted.filter((t) => t.eisenhower === "Q2" && assigned.has(t.id)).length,
      q3: sorted.filter((t) => t.eisenhower === "Q3" && assigned.has(t.id)).length,
      q4: sorted.filter((t) => t.eisenhower === "Q4" && assigned.has(t.id)).length,
      unplanned: available.length - totalTasks,
    },
  };
}

// -- Форматирование Telegram --------------------------------------------------

/** Символы приоритета */
function urgencyIcon(urgency) {
  if (urgency >= 5) return "\u{1F534}"; // red circle
  if (urgency >= 4) return "\u{1F7E0}"; // orange circle
  if (urgency >= 3) return "\u{1F7E1}"; // yellow circle
  return "\u{1F7E2}"; // green circle
}

/** Иконка ресурса */
function resourceIcon(res) {
  const map = {
    money: "\u{1F4B0}",
    vehicle: "\u{1F69B}",
    tools: "\u{1F527}",
    people: "\u{1F465}",
    phone_only: "\u{1F4F1}",
    computer: "\u{1F4BB}",
    greenhouse: "\u{1F3E0}",
  };
  return map[res] || res;
}

/** Иконка локации блока */
function locationLabel(loc) {
  const map = {
    greenhouse: "ТЕПЛИЦА",
    city: "ДОРОГА+ГОРОД",
    home: "ТЕЛЕФОН/КОМП",
  };
  return map[loc] || loc;
}

/**
 * Форматирует задачу для Telegram.
 * @param {Task} task
 * @param {number} num
 * @returns {string}
 */
function formatTaskLine(task, num) {
  const icon = urgencyIcon(task.urgency);
  const resIcons = task.resources.map(resourceIcon).join("+");
  const costStr = task.cost_ars > 0 ? ` ${fmtNum(task.cost_ars)} ARS` : "";
  const multiStr = task.multiplier > 1 ? ` x${task.multiplier} домена` : "";
  return `  ${num}. ${icon} ${task.raw} (${task.effort}, ${resIcons}${costStr})${multiStr}`;
}

/**
 * Форматирует план дня для Telegram.
 * @param {{ blocks: Array<{block: object, tasks: Task[]}>, summary: object }} plan
 * @returns {string}
 */
function formatTodayTelegram(plan) {
  const lines = [];
  const date = plan.summary.date.slice(5).replace("-", ".");
  lines.push(`\u{1F9E0} TASK BRAIN -- \u0421\u0435\u0433\u043E\u0434\u043D\u044F (${date})`);
  lines.push("");

  let taskNum = 1;
  for (const slot of plan.blocks) {
    const locLabel = locationLabel(slot.block.location);
    lines.push(`\u23F0 ${slot.block.label} [${locLabel}] energy: ${slot.block.energy}`);
    for (const task of slot.tasks) {
      lines.push(formatTaskLine(task, taskNum));
      taskNum++;
    }
    lines.push("");
  }

  // Итого
  const s = plan.summary;
  const qCounts = [s.q1, s.q2, s.q3, s.q4]
    .map((v, i) => (v > 0 ? `${v}${["\u{1F534}", "\u{1F7E1}", "\u{1F7E0}", "\u{1F7E2}"][i]}` : ""))
    .filter(Boolean)
    .join(" ");
  lines.push(
    `\u{1F4CA} \u0418\u0442\u043E\u0433\u043E: ${s.total_tasks} \u0437\u0430\u0434\u0430\u0447 | ${qCounts} | ~${s.total_hours} \u0447\u0430\u0441\u043E\u0432`,
  );

  if (s.total_cost > 0) {
    lines.push(`\u{1F4B0} \u0411\u044E\u0434\u0436\u0435\u0442: ${fmtNum(s.total_cost)} ARS`);
  }

  if (s.combos && s.combos.length > 0) {
    for (const combo of s.combos) {
      lines.push(
        `\u{1F3AF} \u041C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440: ${combo.reason} (${combo.ids.length} \u0437\u0430\u0434\u0430\u0447)`,
      );
    }
  }

  if (s.unplanned > 0) {
    lines.push(
      `\u{1F4CB} \u0412 \u0431\u044D\u043A\u043B\u043E\u0433\u0435: ${s.unplanned} \u0437\u0430\u0434\u0430\u0447`,
    );
  }

  return lines.join("\n");
}

/**
 * Форматирует матрицу Эйзенхауэра для Telegram.
 * @param {Task[]} tasks
 * @returns {string}
 */
function formatMatrixTelegram(tasks) {
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const q1 = active.filter((t) => t.eisenhower === "Q1");
  const q2 = active.filter((t) => t.eisenhower === "Q2");
  const q3 = active.filter((t) => t.eisenhower === "Q3");
  const q4 = active.filter((t) => t.eisenhower === "Q4");

  const lines = [];
  lines.push(
    "\u{1F9E0} \u041C\u0410\u0422\u0420\u0418\u0426\u0410 \u042D\u0419\u0417\u0415\u041D\u0425\u0410\u0423\u042D\u0420\u0410",
  );
  lines.push("");

  if (q1.length > 0) {
    lines.push(
      "Q1 \u0414\u0415\u041B\u0410\u0419 \u0421\u0415\u0419\u0427\u0410\u0421 (urgent+important):",
    );
    for (const t of q1) lines.push(`  \u2022 ${t.raw}`);
    lines.push("");
  }

  if (q2.length > 0) {
    lines.push("Q2 \u041F\u041B\u0410\u041D\u0418\u0420\u0423\u0419 (important):");
    for (const t of q2) lines.push(`  \u2022 ${t.raw}`);
    lines.push("");
  }

  if (q3.length > 0) {
    lines.push(
      "Q3 \u0414\u0415\u041B\u0415\u0413\u0418\u0420\u0423\u0419/\u0411\u0410\u0422\u0427\u0418 (urgent):",
    );
    for (const t of q3) lines.push(`  \u2022 ${t.raw}`);
    lines.push("");
  }

  if (q4.length > 0) {
    lines.push("Q4 \u0411\u042D\u041A\u041B\u041E\u0413:");
    for (const t of q4) lines.push(`  \u2022 ${t.raw}`);
    lines.push("");
  }

  lines.push(
    `\u{1F4CA} \u0412\u0441\u0435\u0433\u043E: ${active.length} | Q1:${q1.length} Q2:${q2.length} Q3:${q3.length} Q4:${q4.length}`,
  );

  return lines.join("\n");
}

/**
 * Форматирует бэклог для Telegram.
 * @param {Task[]} tasks
 * @returns {string}
 */
function formatBacklogTelegram(tasks) {
  const pending = tasks.filter((t) => t.status === "pending");

  if (pending.length === 0) {
    return "\u{1F9E0} \u0411\u044D\u043A\u043B\u043E\u0433 \u043F\u0443\u0441\u0442. \u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 \u0447\u0435\u0440\u0435\u0437 `add`.";
  }

  const sorted = prioritySort(pending);
  const lines = [];
  lines.push(
    `\u{1F9E0} \u0411\u042D\u041A\u041B\u041E\u0413 (${pending.length} \u0437\u0430\u0434\u0430\u0447)`,
  );
  lines.push("");

  for (const task of sorted) {
    const icon = urgencyIcon(task.urgency);
    const domainLabel = DOMAIN_LABELS[task.domain] || task.domain;
    lines.push(
      `${icon} [${domainLabel}] ${task.raw} (${task.effort}, U:${task.urgency} I:${task.importance})`,
    );
  }

  return lines.join("\n");
}

/**
 * Форматирует результат добавления задачи для Telegram.
 * @param {Task} task
 * @returns {string}
 */
function formatAddedTaskTelegram(task) {
  const lines = [];
  const domainLabel = DOMAIN_LABELS[task.domain] || task.domain;
  lines.push(
    `\u{1F9E0} \u0417\u0430\u0434\u0430\u0447\u0430 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430: ${task.raw}`,
  );
  lines.push("");
  lines.push(`\u{1F3F7} \u0414\u043E\u043C\u0435\u043D: ${domainLabel}`);
  lines.push(
    `\u26A1 \u0421\u0440\u043E\u0447\u043D\u043E\u0441\u0442\u044C: ${task.urgency}/5 | \u0412\u0430\u0436\u043D\u043E\u0441\u0442\u044C: ${task.importance}/5`,
  );
  lines.push(
    `\u{1F4CB} \u042D\u0439\u0437\u0435\u043D\u0445\u0430\u0443\u044D\u0440: ${task.eisenhower}`,
  );
  lines.push(
    `\u23F1 \u0422\u0440\u0443\u0434\u043E\u0451\u043C\u043A\u043E\u0441\u0442\u044C: ${task.effort} | \u042D\u043D\u0435\u0440\u0433\u0438\u044F: ${task.energy}`,
  );
  lines.push(
    `\u{1F4E6} \u0420\u0435\u0441\u0443\u0440\u0441\u044B: ${task.resources.map(resourceIcon).join(" ")}`,
  );
  if (task.cost_ars > 0) {
    lines.push(
      `\u{1F4B0} \u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C: ${fmtNum(task.cost_ars)} ARS`,
    );
  }
  if (task.multiplier > 1) {
    lines.push(
      `\u{1F3AF} \u041C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440: x${task.multiplier}`,
    );
  }
  lines.push(`\u{1F194} ${task.id}`);

  return lines.join("\n");
}

// -- Публичные API-функции ----------------------------------------------------

/**
 * Добавляет новую задачу.
 * @param {string} rawText
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<Task>}
 */
async function addTask(rawText, options = {}) {
  const { dryRun = false } = options;
  const startTime = Date.now();

  const backlog = loadBacklog();
  const task = analyzeTask(rawText, backlog);
  backlog.push(task);

  if (!dryRun) {
    saveBacklog(backlog);
    const msg = formatAddedTaskTelegram(task);
    await sendThrottled(msg, { thread: TOPIC_TASKS, silent: true, priority: "normal" });
  }

  await trace({
    name: "task-brain/add",
    input: { raw: rawText },
    output: task,
    duration_ms: Date.now() - startTime,
    metadata: { skill: "task-brain", dry_run: dryRun },
  });

  return task;
}

/**
 * Генерирует оптимальный план.
 * @param {{ horizon?: string, dryRun?: boolean }} [options]
 * @returns {Promise<{ plan: object, message: string }>}
 */
async function generatePlan(options = {}) {
  const { horizon = "today", dryRun = false } = options;
  const startTime = Date.now();

  const backlog = loadBacklog();

  // Загружаем задачи из Sheets через farm-state (если есть)
  try {
    const { getState } = require("./farm-state.cjs");
    const state = await getState();
    if (state && state.tasks && state.tasks.length > 0) {
      for (const sheetTask of state.tasks) {
        const desc = (
          sheetTask["\u0417\u0430\u0434\u0430\u0447\u0430"] ||
          sheetTask["\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"] ||
          ""
        ).trim();
        const status = (sheetTask["\u0421\u0442\u0430\u0442\u0443\u0441"] || "")
          .trim()
          .toLowerCase();
        if (
          !desc ||
          status === "\u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E" ||
          status === "done"
        )
          continue;
        // Избегаем дубликатов
        const alreadyExists = backlog.some((t) => t.raw.toLowerCase() === desc.toLowerCase());
        if (!alreadyExists) {
          const task = analyzeTask(desc, backlog);
          task.id = `sheets-${crypto.createHash("md5").update(desc).digest("hex").slice(0, 8)}`;
          backlog.push(task);
        }
      }
    }
  } catch {
    // farm-state недоступен -- работаем только с локальным бэклогом
  }

  // Обнаруживаем комбо перед планированием
  detectCombos(backlog);

  const today = argentinaToday();
  let message = "";

  if (horizon === "week") {
    // Планируем на 7 дней вперёд
    const weekPlans = [];
    const backlogCopy = JSON.parse(JSON.stringify(backlog));
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = fmtDate(d);
      const dayPlan = planDay(backlogCopy, dateStr);
      weekPlans.push(dayPlan);
      // Помечаем запланированные как planned для следующих дней
      for (const slot of dayPlan.blocks) {
        for (const task of slot.tasks) {
          const original = backlogCopy.find((t) => t.id === task.id);
          if (original) original.status = "planned";
        }
      }
    }

    const lines = [];
    lines.push(
      `\u{1F9E0} TASK BRAIN -- \u041F\u043B\u0430\u043D \u043D\u0430 \u043D\u0435\u0434\u0435\u043B\u044E`,
    );
    lines.push("");
    const dayNames = [
      "\u041F\u043D",
      "\u0412\u0442",
      "\u0421\u0440",
      "\u0427\u0442",
      "\u041F\u0442",
      "\u0421\u0431",
      "\u0412\u0441",
    ];
    for (let i = 0; i < weekPlans.length; i++) {
      const wp = weekPlans[i];
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dayName = dayNames[d.getDay() === 0 ? 6 : d.getDay() - 1];
      if (wp.summary.total_tasks > 0) {
        lines.push(
          `${dayName} ${wp.summary.date.slice(5).replace("-", ".")}: ${wp.summary.total_tasks} \u0437\u0430\u0434\u0430\u0447 (~${wp.summary.total_hours}\u0447)`,
        );
        for (const slot of wp.blocks) {
          for (const task of slot.tasks) {
            lines.push(`  ${urgencyIcon(task.urgency)} ${task.raw}`);
          }
        }
      } else {
        lines.push(`${dayName} ${wp.summary.date.slice(5).replace("-", ".")}: --`);
      }
    }
    message = lines.join("\n");
  } else {
    // План на сегодня
    const plan = planDay(backlog, today);
    message = formatTodayTelegram(plan);

    // Сохраняем обновлённые статусы
    if (!dryRun) {
      saveBacklog(backlog);
    }
  }

  if (!dryRun) {
    await sendThrottled(message, { thread: TOPIC_TASKS, silent: false, priority: "normal" });
  }

  await trace({
    name: "task-brain/plan",
    input: { horizon, task_count: backlog.length },
    output: { message_length: message.length },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "task-brain", dry_run: dryRun },
  });

  return { plan: backlog, message };
}

/**
 * Показывает план на сегодня.
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function getToday(options = {}) {
  const result = await generatePlan({ horizon: "today", dryRun: options.dryRun });
  return result.message;
}

/**
 * Показывает матрицу Эйзенхауэра.
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function getMatrix(options = {}) {
  const { dryRun = false } = options;
  const backlog = loadBacklog();
  const message = formatMatrixTelegram(backlog);

  if (!dryRun) {
    await sendThrottled(message, { thread: TOPIC_TASKS, silent: true, priority: "normal" });
  }

  return message;
}

/**
 * Показывает бэклог.
 * @param {{ dryRun?: boolean }} [options]
 * @returns {string}
 */
function getBacklog(options = {}) {
  const backlog = loadBacklog();
  return formatBacklogTelegram(backlog);
}

/**
 * Отмечает задачу выполненной.
 * @param {string} query -- описание или ID задачи
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<Task|null>}
 */
async function markDone(query, options = {}) {
  const { dryRun = false } = options;
  const backlog = loadBacklog();
  const lower = query.toLowerCase();

  // Ищем задачу по ID или по частичному совпадению текста
  const task = backlog.find((t) => t.id === query || t.raw.toLowerCase().includes(lower));

  if (!task) {
    return null;
  }

  task.status = "done";
  task.completed_at = new Date().toISOString();

  if (!dryRun) {
    saveBacklog(backlog);
    const msg = `\u2705 \u0417\u0430\u0434\u0430\u0447\u0430 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0430: ${task.raw}`;
    await sendThrottled(msg, { thread: TOPIC_TASKS, silent: true, priority: "normal" });
  }

  await trace({
    name: "task-brain/done",
    input: { query },
    output: { task_id: task.id, raw: task.raw },
    metadata: { skill: "task-brain", dry_run: dryRun },
  });

  return task;
}

/**
 * Статистика по задачам.
 * @returns {object}
 */
function getStats() {
  const backlog = loadBacklog();
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const done = backlog.filter((t) => t.status === "done");
  const pending = backlog.filter((t) => t.status === "pending");
  const planned = backlog.filter((t) => t.status === "planned");
  const doneThisWeek = done.filter((t) => {
    if (!t.completed_at) return false;
    return new Date(t.completed_at) >= weekAgo;
  });

  /** @type {Record<string, number>} */
  const byDomain = {};
  for (const t of backlog) {
    byDomain[t.domain] = (byDomain[t.domain] || 0) + 1;
  }

  /** @type {Record<string, number>} */
  const byQuadrant = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  for (const t of pending.concat(planned)) {
    byQuadrant[t.eisenhower] = (byQuadrant[t.eisenhower] || 0) + 1;
  }

  return {
    total: backlog.length,
    pending: pending.length,
    planned: planned.length,
    done: done.length,
    done_this_week: doneThisWeek.length,
    by_domain: byDomain,
    by_quadrant: byQuadrant,
    avg_multiplier:
      backlog.length > 0
        ? Math.round((backlog.reduce((s, t) => s + t.multiplier, 0) / backlog.length) * 10) / 10
        : 0,
  };
}

// -- Утилиты ------------------------------------------------------------------

/**
 * Текущая дата в Аргентине (YYYY-MM-DD).
 * @returns {string}
 */
function argentinaToday() {
  const now = new Date();
  // Смещение UTC-3
  const argNow = new Date(now.getTime() + ARGENTINA_UTC_OFFSET * 60 * 60 * 1000);
  return argNow.toISOString().slice(0, 10);
}

// -- CLI ----------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filteredArgs = args.filter((a) => a !== "--dry-run");

  const command = filteredArgs[0];
  const arg = filteredArgs.slice(1).join(" ");

  if (dryRun) {
    process.stderr.write(
      "[task-brain] DRY-RUN \u0440\u0435\u0436\u0438\u043C -- \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u0438 \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F\n",
    );
  }

  (async () => {
    try {
      switch (command) {
        case "add": {
          if (!arg) {
            console.error(
              "\u041E\u0448\u0438\u0431\u043A\u0430: \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438",
            );
            console.error(
              '  node task-brain.cjs add "\u043A\u0443\u043F\u0438\u0442\u044C \u0441\u0443\u0431\u0441\u0442\u0440\u0430\u0442 20 \u043C\u0435\u0448\u043A\u043E\u0432"',
            );
            process.exit(1);
          }
          const task = await addTask(arg, { dryRun });
          const output = formatAddedTaskTelegram(task);
          process.stdout.write(output + "\n");
          break;
        }

        case "plan": {
          const horizonIdx = filteredArgs.indexOf("--horizon");
          const horizon = horizonIdx >= 0 ? filteredArgs[horizonIdx + 1] : "today";
          const result = await generatePlan({ horizon, dryRun });
          process.stdout.write(result.message + "\n");
          break;
        }

        case "today": {
          const message = await getToday({ dryRun });
          process.stdout.write(message + "\n");
          break;
        }

        case "matrix": {
          const message = await getMatrix({ dryRun });
          process.stdout.write(message + "\n");
          break;
        }

        case "backlog": {
          const message = getBacklog({ dryRun });
          process.stdout.write(message + "\n");
          break;
        }

        case "done": {
          if (!arg) {
            console.error(
              "\u041E\u0448\u0438\u0431\u043A\u0430: \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0438\u043B\u0438 ID \u0437\u0430\u0434\u0430\u0447\u0438",
            );
            process.exit(1);
          }
          const done = await markDone(arg, { dryRun });
          if (done) {
            process.stdout.write(
              `\u2705 \u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${done.raw}\n`,
            );
          } else {
            console.error(
              `\u0417\u0430\u0434\u0430\u0447\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: "${arg}"`,
            );
            process.exit(1);
          }
          break;
        }

        case "stats": {
          const stats = getStats();
          process.stdout.write(
            "\u{1F9E0} TASK BRAIN -- \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430\n",
          );
          process.stdout.write(
            `\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0434\u0430\u0447: ${stats.total}\n`,
          );
          process.stdout.write(
            `\u041E\u0436\u0438\u0434\u0430\u044E\u0442: ${stats.pending} | \u0417\u0430\u043F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u043E: ${stats.planned} | \u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${stats.done}\n`,
          );
          process.stdout.write(
            `\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E \u0437\u0430 \u043D\u0435\u0434\u0435\u043B\u044E: ${stats.done_this_week}\n`,
          );
          process.stdout.write(
            `\u041C\u0430\u0442\u0440\u0438\u0446\u0430: Q1:${stats.by_quadrant.Q1} Q2:${stats.by_quadrant.Q2} Q3:${stats.by_quadrant.Q3} Q4:${stats.by_quadrant.Q4}\n`,
          );
          process.stdout.write(
            `\u0421\u0440. \u043C\u0443\u043B\u044C\u0442\u0438\u043F\u043B\u0438\u043A\u0430\u0442\u043E\u0440: ${stats.avg_multiplier}\n`,
          );
          if (Object.keys(stats.by_domain).length > 0) {
            const domStr = Object.entries(stats.by_domain)
              .map(([d, c]) => `${DOMAIN_LABELS[d] || d}:${c}`)
              .join(" ");
            process.stdout.write(`\u0414\u043E\u043C\u0435\u043D\u044B: ${domStr}\n`);
          }
          break;
        }

        default: {
          process.stdout.write(
            "PEPINO TASK BRAIN -- \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u043F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u0437\u0430\u0434\u0430\u0447\n\n",
          );
          process.stdout.write(
            "\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u0438\u0435:\n",
          );
          process.stdout.write(
            '  node task-brain.cjs add "\u043A\u0443\u043F\u0438\u0442\u044C \u0441\u0443\u0431\u0441\u0442\u0440\u0430\u0442"      -- \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0437\u0430\u0434\u0430\u0447\u0443\n',
          );
          process.stdout.write(
            "  node task-brain.cjs plan                  -- \u043E\u043F\u0442\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u043F\u043B\u0430\u043D \u043D\u0430 \u0441\u0435\u0433\u043E\u0434\u043D\u044F\n",
          );
          process.stdout.write(
            "  node task-brain.cjs plan --horizon week   -- \u043F\u043B\u0430\u043D \u043D\u0430 \u043D\u0435\u0434\u0435\u043B\u044E\n",
          );
          process.stdout.write(
            "  node task-brain.cjs today                 -- \u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C \u0441\u0435\u0439\u0447\u0430\u0441\n",
          );
          process.stdout.write(
            "  node task-brain.cjs matrix                -- \u043C\u0430\u0442\u0440\u0438\u0446\u0430 \u042D\u0439\u0437\u0435\u043D\u0445\u0430\u0443\u044D\u0440\u0430\n",
          );
          process.stdout.write(
            "  node task-brain.cjs backlog               -- \u0431\u044D\u043A\u043B\u043E\u0433\n",
          );
          process.stdout.write(
            '  node task-brain.cjs done "\u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"     -- \u043E\u0442\u043C\u0435\u0442\u0438\u0442\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u043E\u0439\n',
          );
          process.stdout.write(
            "  node task-brain.cjs stats                 -- \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430\n",
          );
          process.stdout.write(
            "  node task-brain.cjs --dry-run <command>   -- \u0442\u0435\u0441\u0442\u043E\u0432\u044B\u0439 \u0440\u0435\u0436\u0438\u043C\n",
          );
          break;
        }
      }
    } catch (err) {
      console.error(`[task-brain] \u041E\u0428\u0418\u0411\u041A\u0410: ${err.message}`);
      process.exit(1);
    }
  })();
}

// -- Экспорт ------------------------------------------------------------------

module.exports = {
  addTask,
  generatePlan,
  getToday,
  getMatrix,
  getBacklog,
  markDone,
  getStats,
  // Для тестирования
  _internal: {
    analyzeTask,
    detectDomain,
    detectUrgency,
    detectImportance,
    detectEffort,
    detectResources,
    detectEnergy,
    detectCost,
    detectMultiplier,
    eisenhowerQuadrant,
    detectCombos,
    planDay,
    prioritySort,
    loadBacklog,
    saveBacklog,
    BACKLOG_PATH,
  },
};
