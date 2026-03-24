#!/usr/bin/env node
/**
 * Pepino Pick — Plan B Execution Engine
 *
 * Трекер выполнения Плана Б: финансовая готовность, прогресс по чеклисту,
 * поиск автомобиля, cash flow при переезде, стратегия удержания клиентов.
 *
 * Команды:
 *   node plan-b-engine.cjs dashboard          # Полный статус
 *   node plan-b-engine.cjs finances           # Финансовая готовность
 *   node plan-b-engine.cjs vehicle            # Поиск б/у авто на ML
 *   node plan-b-engine.cjs transition         # Cash flow при переезде
 *   node plan-b-engine.cjs clients            # Стратегия удержания клиентов
 *   node plan-b-engine.cjs checklist          # Чеклист статус
 *   node plan-b-engine.cjs check <id>         # Отметить пункт выполненным
 *   node plan-b-engine.cjs risk "<описание>"  # Добавить риск событие
 *   node plan-b-engine.cjs --dry-run dashboard
 *
 * Хранилище: ~/.openclaw/workspace/memory/investor/plan-b-status.json
 * Telegram: thread 20 (Директор/Стратегия)
 * Cron: воскресенье 17:00 ART (dashboard)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const { trace } = require("./langfuse-trace.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { daysBetween } = require("./helpers.cjs");

// ── Конфигурация ─────────────────────────────────────────────────────────────

const TG_THREAD = 20; // Директор/Стратегия

const STATUS_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "investor",
  "plan-b-status.json",
);

/** Дата истечения DNI (критический дедлайн) */
const DNI_EXPIRY = new Date("2026-05-22");

/** Курс ARS/USD (blue) — fallback если файл не найден */
const ARS_USD_FALLBACK = 1450;

/** Целевой бюджет Плана Б по категориям (USD) */
const BUDGET = {
  vehicle: { label: "Автомобиль (Fiorino б/у)", amount: 3500 },
  rent_deposit: { label: "Аренда 3 мес (депозит)", amount: 900 },
  move_transport: { label: "Переезд/грузовик", amount: 400 },
  connections: { label: "Подключения (газ/свет/вода)", amount: 300 },
  seeds_supplies: { label: "Семена и расходники", amount: 300 },
  certifications: { label: "Сертификаты и документы", amount: 100 },
  living_buffer: { label: "Подушка (2 мес жизни)", amount: 800 },
  emergency: { label: "Экстренный резерв", amount: 500 },
};

const TOTAL_NEEDED = Object.values(BUDGET).reduce((s, b) => s + b.amount, 0);

/** Еженедельная прибыль (оценка) в USD */
const WEEKLY_PROFIT_USD = 200;

/** Оценка текущих накоплений (USD), основана на известных выплатах */
const ESTIMATED_SAVINGS = 5500;

// ── Чеклист ──────────────────────────────────────────────────────────────────

/** @type {Array<{id: number, category: string, task: string, status: string, critical: boolean}>} */
const DEFAULT_CHECKLIST = [
  // Финансы
  {
    id: 1,
    category: "Финансы",
    task: "Подсчитать точную сумму накоплений",
    status: "pending",
    critical: true,
  },
  {
    id: 2,
    category: "Финансы",
    task: "Заморозить ненужные расходы",
    status: "pending",
    critical: true,
  },
  {
    id: 3,
    category: "Финансы",
    task: "Следующий раздел кассы — 100% в накопления",
    status: "pending",
    critical: true,
  },

  // Документы
  {
    id: 4,
    category: "Документы",
    task: "Продлить DNI (до 22.05!)",
    status: "pending",
    critical: true,
  },
  {
    id: 5,
    category: "Документы",
    task: "RENSPA онлайн (72 часа, бесплатно)",
    status: "pending",
    critical: false,
  },
  {
    id: 6,
    category: "Документы",
    task: "Carnet manipulador (онлайн, бесплатно)",
    status: "pending",
    critical: false,
  },

  // Активы
  {
    id: 7,
    category: "Активы",
    task: "Все клиенты в НАШЕМ телефоне",
    status: "done",
    critical: true,
  },
  {
    id: 8,
    category: "Активы",
    task: "Соцсети (FB/IG/YT/TG) на нашем email",
    status: "done",
    critical: true,
  },
  { id: 9, category: "Активы", task: "Бэкап переписок с Игорем", status: "done", critical: true },
  {
    id: 10,
    category: "Активы",
    task: "Бэкап Google Sheets данных",
    status: "pending",
    critical: true,
  },

  // Транспорт
  {
    id: 11,
    category: "Транспорт",
    task: "Найти и купить автомобиль",
    status: "pending",
    critical: true,
  },

  // Земля
  {
    id: 12,
    category: "Земля",
    task: "Посетить 2-3 участка лично",
    status: "pending",
    critical: true,
  },
  {
    id: 13,
    category: "Земля",
    task: "Подписать договор аренды",
    status: "pending",
    critical: true,
  },

  // Переезд
  {
    id: 14,
    category: "Переезд",
    task: "Спланировать разборку теплицы",
    status: "pending",
    critical: false,
  },
  {
    id: 15,
    category: "Переезд",
    task: "Список что забрать (инструменты, семена)",
    status: "pending",
    critical: false,
  },
  {
    id: 16,
    category: "Переезд",
    task: "Найти грузовой транспорт для переезда",
    status: "pending",
    critical: false,
  },

  // Клиенты
  {
    id: 17,
    category: "Клиенты",
    task: "Подготовить тексты уведомлений для клиентов",
    status: "pending",
    critical: false,
  },
  {
    id: 18,
    category: "Клиенты",
    task: "Закупить капусту+огурцы для ферментации в переходный период",
    status: "pending",
    critical: false,
  },

  // Миграция
  {
    id: 19,
    category: "Миграция",
    task: "Справки из РФ получены и переведены",
    status: "in_progress",
    critical: true,
  },
  {
    id: 20,
    category: "Миграция",
    task: "Turno в Migraciones Berazategui",
    status: "pending",
    critical: true,
  },
];

// ── Хранилище ─────────────────────────────────────────────────────────────────

/**
 * Загружает состояние из файла. Если файла нет — создаёт дефолт.
 * @returns {{checklist: typeof DEFAULT_CHECKLIST, risks: Array, vehicle_results: Array, last_updated: string}}
 */
function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = fs.readFileSync(STATUS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // файл повреждён — пересоздаём
  }
  return {
    checklist: DEFAULT_CHECKLIST.map((item) => ({ ...item })),
    risks: [],
    vehicle_results: [],
    last_updated: new Date().toISOString(),
  };
}

/**
 * Сохраняет состояние в файл.
 * @param {object} status
 * @param {boolean} dryRun
 */
function saveStatus(status, dryRun) {
  if (dryRun) return;
  const dir = path.dirname(STATUS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  status.last_updated = new Date().toISOString();
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8");
}

// ── Курс ARS/USD ──────────────────────────────────────────────────────────────

/**
 * Читает текущий курс blue доллара из кеша.
 * @returns {number}
 */
function getUsdRate() {
  try {
    const ratesFile = path.join(os.homedir(), ".openclaw", ".exchange-rates.json");
    if (fs.existsSync(ratesFile)) {
      const data = JSON.parse(fs.readFileSync(ratesFile, "utf-8"));
      const rate = data?.usd_blue || data?.USD_blue || data?.usd?.blue;
      if (rate && rate > 0) return rate;
    }
  } catch {
    // fallback
  }
  return ARS_USD_FALLBACK;
}

// ── HTTP утилита ──────────────────────────────────────────────────────────────

/**
 * GET-запрос с таймаутом.
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<string>}
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PepinoBot/1.0)",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// ── FINANCES ──────────────────────────────────────────────────────────────────

/**
 * Рассчитывает финансовую готовность к Плану Б.
 * @returns {{estimated: number, needed: number, gap: number, weeks: number, pct: number, items: typeof BUDGET}}
 */
function calcFinances() {
  const gap = Math.max(0, TOTAL_NEEDED - ESTIMATED_SAVINGS);
  const weeks = gap > 0 ? Math.ceil(gap / WEEKLY_PROFIT_USD) : 0;
  const pct = Math.min(100, Math.round((ESTIMATED_SAVINGS / TOTAL_NEEDED) * 100));
  return {
    estimated: ESTIMATED_SAVINGS,
    needed: TOTAL_NEEDED,
    gap,
    weeks,
    pct,
    items: BUDGET,
  };
}

/**
 * Форматирует финансовый отчёт.
 * @param {ReturnType<typeof calcFinances>} f
 * @returns {string}
 */
function formatFinances(f) {
  const bar = buildProgressBar(f.pct, 20);
  const lines = [
    `<b>ФИНАНСОВАЯ ГОТОВНОСТЬ К ПЛАНУ Б</b>`,
    ``,
    `${bar} ${f.pct}%`,
    ``,
    `Накопления (оценка):  ~$${f.estimated.toLocaleString()}`,
    `Нужно минимум:        $${f.needed.toLocaleString()}`,
    f.gap > 0
      ? `Дефицит:              ~$${f.gap.toLocaleString()}`
      : `Профицит:             ~$${(f.estimated - f.needed).toLocaleString()} (ГОТОВО!)`,
    f.weeks > 0
      ? `До цели:              ${f.weeks}-${f.weeks + 2} нед (при $${WEEKLY_PROFIT_USD}/нед)`
      : `Статус:               МОЖНО НАЧИНАТЬ`,
    ``,
    `РАЗБИВКА НУЖД:`,
  ];

  const statuses = loadStatus();
  const vehicleDone = statuses.checklist.find((c) => c.id === 11)?.status === "done";
  const landDone = statuses.checklist.find((c) => c.id === 13)?.status === "done";

  for (const [key, item] of Object.entries(f.items)) {
    let flag = "[ ]";
    if (key === "vehicle" && vehicleDone) flag = "[x]";
    if (key === "rent_deposit" && landDone) flag = "[x]";
    lines.push(`  ${flag} ${item.label.padEnd(30)} $${item.amount}`);
  }

  lines.push(``, `РЕКОМЕНДАЦИИ:`);
  if (f.gap > 0) {
    lines.push(
      `  * НЕ тратить на несущественное — каждый $100 = ${Math.ceil(100 / WEEKLY_PROFIT_USD)} нед`,
      `  * Следующий раздел кассы — 100% в накопления`,
      `  * Заморозить: кафе, одежда, подписки`,
    );
  } else {
    lines.push(`  * Финансово ГОТОВЫ. Фокус на поиск участка и авто.`);
  }

  return lines.join("\n");
}

// ── VEHICLE ───────────────────────────────────────────────────────────────────

/**
 * Ищет б/у автомобили через Mercado Libre API.
 * @param {boolean} dryRun
 * @returns {Promise<Array<{title: string, price_usd: number, price_ars: number, url: string, year: string, km: number}>>}
 */
async function searchVehicles(dryRun) {
  const usdRate = getUsdRate();

  // Запросы к ML API
  const queries = [
    { q: "fiat fiorino furgon", label: "Fiat Fiorino" },
    { q: "renault kangoo furgon", label: "Renault Kangoo" },
    { q: "volkswagen saveiro", label: "VW Saveiro" },
    { q: "fiat strada", label: "Fiat Strada" },
    { q: "peugeot partner", label: "Peugeot Partner" },
  ];

  if (dryRun) {
    // Возвращаем фиктивные данные в dry-run
    return [
      {
        title: "Fiat Fiorino 2018 GNC (DRY-RUN)",
        price_usd: 3200,
        price_ars: Math.round(3200 * usdRate),
        url: "https://www.mercadolibre.com.ar/dry-run",
        year: "2018",
        km: 85000,
        score: 90,
      },
      {
        title: "Renault Kangoo 2017 Diesel (DRY-RUN)",
        price_usd: 3800,
        price_ars: Math.round(3800 * usdRate),
        url: "https://www.mercadolibre.com.ar/dry-run-2",
        year: "2017",
        km: 120000,
        score: 75,
      },
    ];
  }

  const results = [];

  for (const { q, label } of queries) {
    try {
      const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q + " usada")}&category=MLA1743&limit=5&sort=price_asc`;
      const raw = await httpGet(url);
      const data = JSON.parse(raw);

      for (const item of data.results || []) {
        const priceArs = item.price || 0;
        const priceUsd = Math.round(priceArs / usdRate);

        // Фильтр по цене: $2,500 - $7,000
        if (priceUsd < 2500 || priceUsd > 7000) continue;

        // Извлекаем год и км из атрибутов
        let year = "н/д";
        let km = 0;
        for (const attr of item.attributes || []) {
          if (attr.id === "VEHICLE_YEAR") year = attr.value_name || "н/д";
          if (attr.id === "KILOMETERS") km = parseInt(attr.value_name || "0", 10) || 0;
        }

        // Скоринг: новее + меньше км + дешевле = лучше
        const yearNum = parseInt(year, 10) || 2010;
        const score = Math.round(
          ((yearNum - 2010) / 10) * 40 +
            (1 - Math.min(km, 200000) / 200000) * 35 +
            (1 - (priceUsd - 2500) / 4500) * 25,
        );

        results.push({
          title: item.title || label,
          price_usd: priceUsd,
          price_ars: priceArs,
          url: item.permalink || "",
          year,
          km,
          score: Math.max(0, Math.min(100, score)),
        });
      }
    } catch {
      // Пропускаем ошибки по отдельным запросам
    }
  }

  // Сортируем по скорингу
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

/**
 * Форматирует результаты поиска авто.
 * @param {Array} vehicles
 * @param {boolean} dryRun
 * @returns {string}
 */
function formatVehicles(vehicles, dryRun) {
  const lines = [`<b>ПОИСК АВТО — ТОП ${vehicles.length}${dryRun ? " (DRY-RUN)" : ""}</b>`, ``];

  if (vehicles.length === 0) {
    lines.push(`Ничего не найдено в диапазоне $2,500-7,000.`);
    lines.push(`Попробуйте позже или измените критерии.`);
    return lines.join("\n");
  }

  lines.push(`Бюджет: $3,000-5,000 | Цели: Fiorino / Kangoo / Saveiro`);
  lines.push(``);

  vehicles.forEach((v, i) => {
    const kmStr = v.km > 0 ? `${(v.km / 1000).toFixed(0)}к км` : "км н/д";
    lines.push(`${i + 1}. ${v.title}`);
    lines.push(
      `   $${v.price_usd.toLocaleString()} USD | ${v.year} | ${kmStr} | Скор: ${v.score}/100`,
    );
    lines.push(`   ${v.url}`);
    lines.push(``);
  });

  lines.push(`Обновить: node plan-b-engine.cjs vehicle`);
  return lines.join("\n");
}

// ── TRANSITION ────────────────────────────────────────────────────────────────

/**
 * Рассчитывает cash flow в переходный период (45-60 дней).
 * @returns {string}
 */
function formatTransition() {
  const lines = [
    `<b>CASH FLOW В ПЕРЕХОДНЫЙ ПЕРИОД</b>`,
    ``,
    `КРИТИЧЕСКИЙ ПЕРИОД: 45-60 дней (от переезда до первого урожая)`,
    ``,
    `ФЕРМЕНТАЦИЯ (не требует теплицы — НАЧИНАЕМ В ДЕНЬ 1):`,
    `  Кислая капуста:`,
    `    Купить 50кг = ~25,000 ARS`,
    `    Через 21 день = 45кг готово = ~360,000 ARS`,
    `    Маржа: ~335,000 ARS (+$230 USD)`,
    ``,
    `  Соленые огурцы:`,
    `    Купить 30кг на Mercado Central = ~75,000 ARS`,
    `    Через 7 дней = готово = ~240,000 ARS`,
    `    Маржа: ~165,000 ARS (+$114 USD)`,
    ``,
    `  Острый соус, пелюстка, маринады:`,
    `    Дополнительно ~80,000 ARS/мес`,
    ``,
    `  ИТОГО доход: ~420,000 ARS/мес ($295 USD)`,
    ``,
    `ПРОИЗВОДСТВО (теплица, с нуля):`,
    `  Неделя 1-4:   Подготовка почвы, посадка`,
    `  Неделя 5-8:   Первые огурцы и зелень`,
    `  Неделя 9+:    Полное производство`,
    ``,
    `РАСХОДЫ В ПЕРЕХОДНЫЙ ПЕРИОД:`,
    `  Аренда участка:    $300/мес`,
    `  Еда (семья):       $200/мес`,
    `  Транспорт/бензин:  $100/мес`,
    `  Расходники фермы:  $50/мес`,
    `  ИТОГО:             $650/мес`,
    ``,
    `БАЛАНС:`,
    `  Доход (ферментация): $295/мес`,
    `  Расходы:             $650/мес`,
    `  Дефицит:             -$355/мес x 2 мес = -$710`,
    ``,
    `  Подушка в бюджете:   $800 (покрывает дефицит) OK`,
    ``,
    `КЛЮЧЕВОЕ ДЕЙСТВИЕ ДО ПЕРЕЕЗДА:`,
    `  Закупить 50кг капусты + 30кг огурцов`,
    `  Стоимость: ~100,000 ARS ($69)`,
    `  Выход: ~600,000 ARS ($414) — через 3 недели`,
  ];
  return lines.join("\n");
}

// ── CLIENTS ───────────────────────────────────────────────────────────────────

/**
 * Стратегия удержания клиентов при переезде.
 * @returns {string}
 */
function formatClients() {
  const lines = [
    `<b>СТРАТЕГИЯ УДЕРЖАНИЯ КЛИЕНТОВ</b>`,
    ``,
    `16 клиентов — ВСЕ привязаны к НАШЕМУ телефону`,
    ``,
    `ПРИ ПЕРЕЕЗДЕ (за 2 недели):`,
    ``,
    `РЕСТОРАНЫ (Musgo, Чайхана, Гастроном):`,
    `  Уведомить за 2 недели:`,
    `  "Мы переезжаем ближе к BA! Доставки станут`,
    `  чаще и свежее. Пауза: 3-4 недели."`,
    `  Предложить сейчас: соленья и квашения.`,
    ``,
    `ОПТОВИКИ (Тележка, Беларус):`,
    `  Уведомить за 1 неделю.`,
    `  Предложить ферментированные продукты`,
    `  (паузы в поставках НЕТ!).`,
    ``,
    `ФИЗИЧЕСКИЕ ЛИЦА:`,
    `  Уведомить в день переезда:`,
    `  "Мы переехали! Новый адрес ближе к вам.`,
    `  Скоро возобновим. А пока — соленья и капуста!"`,
    ``,
    `ПРОДУКТЫ КОТОРЫЕ МОЖНО ПРОДАВАТЬ С ДНЯ 1:`,
    `  Соленые огурцы:      7 дней`,
    `  Квашеная капуста:    21 день`,
    `  Пелюстка свекла:     14 дней`,
    `  Острый соус:         3 дня`,
    ``,
    `ИТОГ: ни один клиент не теряет поставщика.`,
    `Ферментация покрывает переходный период полностью.`,
  ];
  return lines.join("\n");
}

// ── CHECKLIST ────────────────────────────────────────────────────────────────

/**
 * Форматирует чеклист.
 * @param {typeof DEFAULT_CHECKLIST} checklist
 * @returns {string}
 */
function formatChecklist(checklist) {
  const done = checklist.filter((c) => c.status === "done").length;
  const total = checklist.length;
  const pct = Math.round((done / total) * 100);
  const bar = buildProgressBar(pct, 20);

  const lines = [`<b>ЧЕКЛИСТ ПЛАН Б</b>`, ``, `${bar} ${done}/${total} (${pct}%)`, ``];

  // Группируем по категориям
  const byCategory = {};
  for (const item of checklist) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`${cat}:`);
    for (const item of items) {
      const mark = item.status === "done" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
      const flag = item.critical ? " !" : "";
      lines.push(`  ${mark} ${item.id}. ${item.task}${flag}`);
    }
    lines.push(``);
  }

  lines.push(`Отметить выполненным: node plan-b-engine.cjs check <id>`);
  lines.push(`Обозначения: [x]=готово [~]=в процессе [ ]=ожидает !=критично`);
  return lines.join("\n");
}

// ── RISKS ─────────────────────────────────────────────────────────────────────

/**
 * Возвращает активные риски (системные + пользовательские).
 * @param {Array} userRisks
 * @returns {Array<{level: string, text: string}>}
 */
function buildRisks(userRisks) {
  const risks = [];

  // Системный риск: до истечения DNI
  const today = new Date();
  const dniDays = Math.ceil((DNI_EXPIRY - today) / (1000 * 60 * 60 * 24));
  if (dniDays < 0) {
    risks.push({ level: "RED", text: `DNI ПРОСРОЧЕН на ${Math.abs(dniDays)} дней — СРОЧНО!` });
  } else if (dniDays <= 30) {
    risks.push({
      level: "RED",
      text: `DNI истекает через ${dniDays} дней (22.05) — ПРОДЛИТЬ СЕЙЧАС!`,
    });
  } else if (dniDays <= 60) {
    risks.push({
      level: "YELLOW",
      text: `DNI истекает через ${dniDays} дней (22.05) — запланировать`,
    });
  } else {
    risks.push({ level: "GREEN", text: `DNI действителен ещё ${dniDays} дней` });
  }

  // Системный риск: нет договора с Игорем
  risks.push({ level: "RED", text: "Нет договора с Игорем — может выгнать в любой момент" });

  // Финансовый риск
  const f = calcFinances();
  if (f.gap > 500) {
    risks.push({
      level: "YELLOW",
      text: `Финансовый дефицит $${f.gap} — ещё ${f.weeks} нед экономии`,
    });
  } else if (f.gap > 0) {
    risks.push({ level: "GREEN", text: `Финансовый дефицит небольшой $${f.gap} — почти готово` });
  } else {
    risks.push({ level: "GREEN", text: "Финансово готовы к переезду" });
  }

  // Пользовательские риски
  for (const r of (userRisks || []).slice(-5)) {
    risks.push({ level: "YELLOW", text: `[${r.date || "?"}] ${r.text}` });
  }

  return risks;
}

/**
 * Форматирует блок рисков.
 * @param {Array<{level: string, text: string}>} risks
 * @returns {string}
 */
function formatRisks(risks) {
  const icons = { RED: "RED", YELLOW: "YEL", GREEN: "GRN" };
  return risks.map((r) => `  [${icons[r.level] || "?"}] ${r.text}`).join("\n");
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

/**
 * Генерирует полный дашборд.
 * @param {object} status — текущее состояние
 * @returns {string}
 */
function formatDashboard(status) {
  const f = calcFinances();
  const checklist = status.checklist || DEFAULT_CHECKLIST;
  const risks = buildRisks(status.risks);
  const vehicles = status.vehicle_results || [];

  const done = checklist.filter((c) => c.status === "done").length;
  const total = checklist.length;

  // DNI countdown
  const today = new Date();
  const dniDays = Math.ceil((DNI_EXPIRY - today) / (1000 * 60 * 60 * 24));
  const dniStr = dniDays > 0 ? `${dniDays} дней (22.05)` : `ПРОСРОЧЕН!`;

  const lines = [
    `<b>ПЛАН Б — DASHBOARD</b>`,
    `Обновлено: ${new Date().toLocaleDateString("ru-RU")}`,
    ``,
    `<b>ФИНАНСОВАЯ ГОТОВНОСТЬ: ${f.pct}%</b>`,
    `  ${buildProgressBar(f.pct, 16)}`,
    `  Накопления:    ~$${f.estimated.toLocaleString()} (оценка)`,
    `  Нужно минимум: $${f.needed.toLocaleString()}`,
    f.gap > 0
      ? `  Дефицит:       ~$${f.gap} | до цели: ${f.weeks}-${f.weeks + 2} нед`
      : `  Статус:        ФИНАНСОВО ГОТОВЫ`,
    ``,
    `  Разбивка нужд:`,
  ];

  for (const [, item] of Object.entries(f.items)) {
    lines.push(`    ${item.label.padEnd(28)} $${item.amount}`);
  }

  lines.push(``);
  lines.push(
    `<b>АВТОМОБИЛЬ:</b> ${vehicles.length > 0 ? `найдено ${vehicles.length} вариантов` : "нет данных (запустить vehicle)"}`,
  );
  if (vehicles.length > 0) {
    const best = vehicles[0];
    lines.push(
      `  Лучший: ${best.title} — $${best.price_usd} (${best.year}, ${(best.km / 1000).toFixed(0)}к км)`,
    );
  }
  lines.push(`  Бюджет: $3,000-5,000 | Цели: Fiorino / Kangoo / Saveiro`);

  lines.push(``);
  lines.push(`<b>ЧЕКЛИСТ: ${done}/${total} (${Math.round((done / total) * 100)}%)</b>`);
  lines.push(`  ${buildProgressBar(Math.round((done / total) * 100), 16)}`);

  // Критические невыполненные
  const critPending = checklist.filter((c) => c.critical && c.status !== "done");
  if (critPending.length > 0) {
    lines.push(`  Критические ожидают:`);
    critPending.slice(0, 5).forEach((c) => {
      lines.push(`    [ ] ${c.id}. ${c.task}`);
    });
  }

  lines.push(``);
  lines.push(`<b>DNI:</b> ${dniStr}`);

  lines.push(``);
  lines.push(`<b>РИСКИ:</b>`);
  lines.push(formatRisks(risks));

  lines.push(``);
  lines.push(`Детали: node plan-b-engine.cjs <finances|vehicle|checklist|transition|clients>`);

  return lines.join("\n");
}

// ── Вспомогательные ───────────────────────────────────────────────────────────

/**
 * Строит ASCII-прогресс бар.
 * @param {number} pct — 0-100
 * @param {number} width — ширина
 * @returns {string}
 */
function buildProgressBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes("--dry-run");

  // Убираем флаги из позиционных аргументов
  const positional = args.filter((a) => !a.startsWith("--"));
  const COMMAND = positional[0] || "dashboard";
  const EXTRA = positional.slice(1).join(" ");

  const startMs = Date.now();

  // Загружаем состояние
  const status = loadStatus();

  let output = "";
  let sendToTg = true;

  if (COMMAND === "check") {
    // Отметить пункт выполненным
    const id = parseInt(EXTRA, 10);
    const item = (status.checklist || []).find((c) => c.id === id);
    if (!item) {
      process.stdout.write(`Пункт ${id} не найден. Доступно: 1-${DEFAULT_CHECKLIST.length}\n`);
      process.exit(1);
    }
    item.status = "done";
    saveStatus(status, DRY_RUN);
    output = `OK: Пункт ${id} отмечен как выполненный: "${item.task}"`;
    sendToTg = false;
    process.stdout.write(output + "\n");

    await trace({
      name: "plan-b-engine/check",
      input: { id },
      output: { task: item.task },
      metadata: { skill: "pepino-google-sheets", dry_run: DRY_RUN },
      duration_ms: Date.now() - startMs,
    });
    return;
  }

  if (COMMAND === "risk") {
    // Записать событие риска
    if (!EXTRA) {
      process.stdout.write('Укажите описание риска: node plan-b-engine.cjs risk "текст"\n');
      process.exit(1);
    }
    if (!status.risks) status.risks = [];
    status.risks.push({
      date: new Date().toLocaleDateString("ru-RU"),
      text: EXTRA,
    });
    saveStatus(status, DRY_RUN);
    output = `OK: Риск записан: "${EXTRA}"`;
    sendToTg = false;
    process.stdout.write(output + "\n");

    await trace({
      name: "plan-b-engine/risk",
      input: { text: EXTRA },
      metadata: { skill: "pepino-google-sheets", dry_run: DRY_RUN },
      duration_ms: Date.now() - startMs,
    });
    return;
  }

  if (COMMAND === "finances") {
    const f = calcFinances();
    output = formatFinances(f);
    sendToTg = false;
  } else if (COMMAND === "vehicle") {
    process.stdout.write("Ищу автомобили на Mercado Libre...\n");
    const vehicles = await searchVehicles(DRY_RUN);
    // Сохраняем результаты для дашборда
    if (!DRY_RUN) {
      status.vehicle_results = vehicles;
      saveStatus(status, false);
    }
    output = formatVehicles(vehicles, DRY_RUN);
    sendToTg = vehicles.length > 0;
  } else if (COMMAND === "transition") {
    output = formatTransition();
    sendToTg = false;
  } else if (COMMAND === "clients") {
    output = formatClients();
    sendToTg = false;
  } else if (COMMAND === "checklist") {
    output = formatChecklist(status.checklist || DEFAULT_CHECKLIST);
    sendToTg = false;
  } else if (COMMAND === "dashboard") {
    output = formatDashboard(status);
    sendToTg = true;
  } else {
    process.stdout.write(`Неизвестная команда: ${COMMAND}\n`);
    process.stdout.write(
      `Доступно: dashboard finances vehicle transition clients checklist check risk\n`,
    );
    process.exit(1);
  }

  // Вывод в консоль (убираем HTML теги)
  const plain = output.replace(/<[^>]+>/g, "");
  process.stdout.write(plain + "\n");

  // Отправка в Telegram
  if (sendToTg) {
    if (DRY_RUN) {
      process.stdout.write(`[DRY-RUN] Telegram thread ${TG_THREAD} — отправка пропущена\n`);
    } else {
      await sendThrottled(output, { thread: TG_THREAD, priority: "normal" });
      process.stdout.write(`Отправлено в Telegram thread ${TG_THREAD}\n`);
    }
  }

  await trace({
    name: `plan-b-engine/${COMMAND}`,
    input: { command: COMMAND, dry_run: DRY_RUN },
    output: { chars: output.length, send_tg: sendToTg },
    metadata: { skill: "pepino-google-sheets", dry_run: DRY_RUN },
    duration_ms: Date.now() - startMs,
  });
}

main().catch((err) => {
  process.stderr.write(`[plan-b-engine] FATAL: ${err.message}\n`);
  process.exit(1);
});
