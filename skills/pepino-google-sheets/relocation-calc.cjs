#!/usr/bin/env node
/**
 * relocation-calc.cjs — Финансовая модель переезда Pepino Pick
 *
 * Сравнивает текущую ситуацию (Суипача, с Игорем) с вариантами переезда.
 * Считает полную себестоимость, логистику, прибыль и находит «золотую середину».
 *
 * Команды:
 *   node relocation-calc.cjs compare          # Полная таблица сравнения
 *   node relocation-calc.cjs zone "Cañuelas"  # Детальный разбор одной зоны
 *   node relocation-calc.cjs breakeven        # Анализ окупаемости переезда
 *   node relocation-calc.cjs golden           # Найти золотую середину
 *   node relocation-calc.cjs --dry-run compare
 *
 * Cron: 0 9 1 * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/relocation-calc.cjs compare
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { getState, getFinancials, getProducts } = require("./farm-state.cjs");
const { fmtNum } = require("./helpers.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Флаги --------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD = 20; // Director/Strategy topic

// -- Курс валют ---------------------------------------------------------------

const EXCHANGE_RATES_FILE = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  ".exchange-rates.json",
);

/**
 * Загружает курс USD/ARS (blue sell). Если файл недоступен — возвращает 1425.
 * @returns {number}
 */
function loadBlueRate() {
  try {
    const raw = fs.readFileSync(EXCHANGE_RATES_FILE, "utf8");
    const data = JSON.parse(raw);
    return data.blue_sell || 1425;
  } catch {
    return 1425;
  }
}

// -- Данные: текущая ситуация -------------------------------------------------

/** @type {object} */
const CURRENT = {
  key: "current",
  label: "Суипача (Игорь)",
  distance_km: 133,
  fuel_cost_per_km: 21.5, // ARS (дизель 2150/л, 10л/100км)
  toll_cost_round: 0, // нет toll на RN-5
  deliveries_per_month: 8,
  rent_usd: 0, // Игорь не берёт аренду (но забирает 50%!)
  profit_share: 0.5, // Игорь забирает 50%
  electricity_usd: 0, // Игорь оплачивает
  water_usd: 0, // скважина Игоря
  housing_usd: 0, // живём бесплатно
  setup_cost_usd: 0,
  investor_share: 0,
  safety: 8,
  independence: 0, // 0-10, полная зависимость
  risk_eviction: 9, // 1-10, высокий риск
  note: null,
};

// -- Данные: сценарии переезда ------------------------------------------------

/** @type {Record<string, object>} */
const SCENARIOS = {
  "Cañuelas (аренда 1Га)": {
    key: "can_rent",
    label: "Каньюэлас (аренда)",
    distance_km: 65,
    fuel_cost_per_km: 21.5,
    toll_cost_round: 3000, // Autopista Ezeiza-Cañuelas
    deliveries_per_month: 8,
    rent_usd: 300,
    electricity_usd: 30,
    water_usd: 20,
    housing_usd: 0,
    profit_share: 1.0,
    setup_cost_usd: 3000,
    investor_share: 0,
    safety: 7,
    independence: 10,
    risk_eviction: 2,
    note: null,
  },
  "Lobos (покупка 5.85Га)": {
    key: "lobos_buy",
    label: "Лобос (покупка)",
    distance_km: 100,
    fuel_cost_per_km: 21.5,
    toll_cost_round: 2000,
    deliveries_per_month: 8,
    rent_usd: 0,
    electricity_usd: 30,
    water_usd: 15,
    housing_usd: 0,
    profit_share: 1.0,
    setup_cost_usd: 70000, // покупка (для инвестора)
    investor_share: 0.3, // если инвестор купит = 30% ему
    safety: 8,
    independence: 10,
    risk_eviction: 0,
    note: "* С инвестором 30/70",
  },
  "San Vicente (покупка 14Га)": {
    key: "sanvic_buy",
    label: "Сан Висенте (покупка)",
    distance_km: 65,
    fuel_cost_per_km: 21.5,
    toll_cost_round: 2500,
    deliveries_per_month: 8,
    rent_usd: 0,
    electricity_usd: 35,
    water_usd: 15,
    housing_usd: 50, // ремонт дома, амортизация
    profit_share: 1.0,
    setup_cost_usd: 90000, // покупка + ремонт $15K
    investor_share: 0.3,
    safety: 6,
    independence: 10,
    risk_eviction: 0,
    note: "* С инвестором 30/70",
  },
  "Cañuelas (покупка 5Га)": {
    key: "can_buy",
    label: "Каньюэлас (покупка)",
    distance_km: 65,
    fuel_cost_per_km: 21.5,
    toll_cost_round: 3000,
    deliveries_per_month: 8,
    rent_usd: 0,
    electricity_usd: 30,
    water_usd: 20,
    housing_usd: 0,
    profit_share: 1.0,
    setup_cost_usd: 50000,
    investor_share: 0.3,
    safety: 7,
    independence: 10,
    risk_eviction: 0,
    note: "* С инвестором 30/70",
  },
  "Suipacha (своя аренда)": {
    key: "sui_own",
    label: "Суипача (своя аренда)",
    distance_km: 133,
    fuel_cost_per_km: 21.5,
    toll_cost_round: 0,
    deliveries_per_month: 8,
    rent_usd: 150,
    electricity_usd: 25,
    water_usd: 15,
    housing_usd: 200, // аренда жилья отдельно
    profit_share: 1.0,
    setup_cost_usd: 1500,
    investor_share: 0,
    safety: 8,
    independence: 10,
    risk_eviction: 2,
    note: null,
  },
};

// -- Константы производства ---------------------------------------------------

const PRODUCTION_KG_MONTH = 600; // ~150кг/нед × 4
const AVG_PRICE_KG = 5000; // ARS средняя
const SEEDS_SUPPLIES_ARS = 150000; // фиксированные расходы
const PACKAGING_ARS = 50000; // упаковка

// -- Расчёт -------------------------------------------------------------------

/**
 * Считает OPEX, выручку и прибыль для одного сценария.
 *
 * @param {object} sc — сценарий (CURRENT или элемент SCENARIOS)
 * @param {number} blueRate — курс USD→ARS
 * @param {{ grossRevenue?: number }} [overrides] — переопределить выручку из реальных данных
 * @returns {object}
 */
function calcScenario(sc, blueRate, overrides = {}) {
  const { deliveries_per_month, distance_km, fuel_cost_per_km, toll_cost_round } = sc;

  // --- OPEX ---
  const fuel = distance_km * 2 * fuel_cost_per_km * deliveries_per_month;
  const toll = toll_cost_round * deliveries_per_month;
  const rent = sc.rent_usd * blueRate;
  const electricity = sc.electricity_usd * blueRate;
  const water = sc.water_usd * blueRate;
  const housing = sc.housing_usd * blueRate;
  const seeds = SEEDS_SUPPLIES_ARS;
  const packaging = PACKAGING_ARS;

  const totalOpex = fuel + toll + rent + electricity + water + housing + seeds + packaging;

  // --- Выручка ---
  const grossRevenue = overrides.grossRevenue || PRODUCTION_KG_MONTH * AVG_PRICE_KG;

  // Эффективная доля: если есть инвестор — берём (1 - investor_share), иначе profit_share
  const effectiveShare =
    sc.investor_share > 0
      ? 1.0 - sc.investor_share // с инвестором
      : sc.profit_share; // без инвестора / с Игорем

  const netRevenue = grossRevenue * effectiveShare;

  // --- Прибыль ---
  const profit = netRevenue - totalOpex;
  const margin = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;
  const profitUsd = profit / blueRate;
  const costPerKg = totalOpex / PRODUCTION_KG_MONTH;

  // --- Время на доставку ---
  const avgSpeedKmh = 80;
  const deliveryHoursPerMonth = (distance_km / avgSpeedKmh) * 2 * deliveries_per_month;
  const freshnessHoursLost = (distance_km / avgSpeedKmh) * 0.5; // одна поездка

  // --- Месяц для окупаемости (только для сценариев с setup_cost > 0) ---
  let breakEvenMonths = null;
  if (sc.setup_cost_usd > 0 && profit > 0) {
    // Сравниваем с текущей прибылью (CURRENT)
    const currentGross = PRODUCTION_KG_MONTH * AVG_PRICE_KG;
    const currentOpex = calcCurrentOpex(blueRate);
    const currentProfit = currentGross * 0.5 - currentOpex;
    const monthlySurplus = profit - currentProfit;
    if (monthlySurplus > 0) {
      const setupArs = sc.setup_cost_usd * blueRate;
      breakEvenMonths = Math.ceil(setupArs / monthlySurplus);
    }
  }

  return {
    label: sc.label,
    key: sc.key,
    note: sc.note,
    // Входные данные
    distance_km,
    safety: sc.safety,
    independence: sc.independence,
    risk_eviction: sc.risk_eviction,
    profit_share: sc.profit_share,
    investor_share: sc.investor_share,
    setup_cost_usd: sc.setup_cost_usd,
    // OPEX строки
    opex: { fuel, toll, rent, electricity, water, housing, seeds, packaging },
    totalOpex,
    // Выручка
    grossRevenue,
    effectiveShare,
    netRevenue,
    // Прибыль
    profit,
    margin,
    profitUsd,
    costPerKg,
    // Время
    deliveryHoursPerMonth,
    freshnessHoursLost,
    // Окупаемость
    breakEvenMonths,
  };
}

/**
 * Считает OPEX текущей ситуации (Суипача с Игорем) без выручки.
 * Вынесено, чтобы использовать в расчёте breakeven внутри calcScenario.
 * @param {number} blueRate
 * @returns {number}
 */
function calcCurrentOpex(blueRate) {
  const { distance_km, fuel_cost_per_km, toll_cost_round, deliveries_per_month } = CURRENT;
  return (
    distance_km * 2 * fuel_cost_per_km * deliveries_per_month +
    toll_cost_round * deliveries_per_month +
    CURRENT.rent_usd * blueRate +
    CURRENT.electricity_usd * blueRate +
    CURRENT.water_usd * blueRate +
    CURRENT.housing_usd * blueRate +
    SEEDS_SUPPLIES_ARS +
    PACKAGING_ARS
  );
}

/**
 * Рассчитывает все сценарии и возвращает массив результатов.
 * @param {number} blueRate
 * @param {object} [realData] — реальные данные из farm-state
 * @returns {object[]}
 */
function calcAll(blueRate, realData = {}) {
  const overrides = {};
  if (realData.monthRevenue && realData.monthRevenue > 0) {
    overrides.grossRevenue = realData.monthRevenue;
  }

  const results = [];
  results.push(calcScenario(CURRENT, blueRate, overrides));
  for (const sc of Object.values(SCENARIOS)) {
    results.push(calcScenario(sc, blueRate, overrides));
  }
  return results;
}

// -- Форматирование -----------------------------------------------------------

/**
 * Падит строку пробелами вправо до нужной длины (ASCII).
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function padR(s, n) {
  return String(s).padEnd(n, " ");
}

/**
 * Падит строку пробелами влево до нужной длины (ASCII).
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function padL(s, n) {
  return String(s).padStart(n, " ");
}

/** Форматирует ARS с разрядами. */
function fArs(n) {
  return fmtNum(Math.round(n));
}

/** Форматирует USD. */
function fUsd(n) {
  return `$${fmtNum(Math.round(n))}`;
}

/**
 * Строит текстовую таблицу сравнения всех сценариев.
 * @param {object[]} results
 * @param {number} blueRate
 * @returns {string}
 */
function buildCompareTable(results, blueRate) {
  const COL = 14; // ширина колонки данных
  const LBL = 28; // ширина метки строки

  // Заголовки колонок (укороченные для таблицы)
  const headers = results.map((r) => r.label);

  const divider = "─".repeat(LBL + COL * results.length + results.length);

  /**
   * Строит одну строку таблицы.
   * @param {string} label
   * @param {(r: object) => string} fn
   * @returns {string}
   */
  function row(label, fn) {
    const cells = results.map((r) => padL(fn(r), COL)).join("");
    return `${padR(label, LBL)}${cells}`;
  }

  const lines = [];
  lines.push("💰 МОДЕЛЬ ПЕРЕЕЗДА PEPINO PICK");
  lines.push(`Курс USD: ${blueRate} ARS/$ (Blue)`);
  lines.push(`Производство: ${PRODUCTION_KG_MONTH} кг/мес × ${fArs(AVG_PRICE_KG)} ARS/кг`);
  lines.push("");

  // Заголовок таблицы
  lines.push(`${padR("", LBL)}${headers.map((h) => padL(h, COL)).join("")}`);
  lines.push(divider);

  lines.push("📍 ПАРАМЕТРЫ:");
  lines.push(row("  Расстояние до BA:", (r) => `${r.distance_km} км`));
  lines.push(row("  Безопасность:", (r) => `${r.safety}/10`));
  lines.push(row("  Независимость:", (r) => `${r.independence}/10`));
  lines.push(row("  Риск выселения:", (r) => `${r.risk_eviction}/10`));

  lines.push("");
  lines.push("💸 РАСХОДЫ/МЕС (ARS):");
  lines.push(row("  Топливо:", (r) => fArs(r.opex.fuel)));
  lines.push(row("  Пьяхе (toll):", (r) => fArs(r.opex.toll)));
  lines.push(row("  Аренда:", (r) => fArs(r.opex.rent)));
  lines.push(row("  Электричество:", (r) => fArs(r.opex.electricity)));
  lines.push(row("  Вода:", (r) => fArs(r.opex.water)));
  lines.push(row("  Жильё:", (r) => fArs(r.opex.housing)));
  lines.push(row("  Семена/расходники:", (r) => fArs(r.opex.seeds)));
  lines.push(row("  Упаковка:", (r) => fArs(r.opex.packaging)));
  lines.push(row("  ── ИТОГО OPEX:", (r) => fArs(r.totalOpex)));

  lines.push("");
  lines.push("💰 ДОХОД/МЕС:");
  lines.push(row("  Выручка брутто:", (r) => fArs(r.grossRevenue)));
  lines.push(row("  Доля Романа:", (r) => `${Math.round(r.effectiveShare * 100)}%`));
  lines.push(row("  Выручка нетто:", (r) => fArs(r.netRevenue)));

  lines.push("");
  lines.push("📊 ПРИБЫЛЬ/МЕС:");
  lines.push(row("  Прибыль ARS:", (r) => fArs(r.profit)));
  lines.push(row("  Маржа:", (r) => `${Math.round(r.margin)}%`));
  lines.push(row("  Прибыль USD:", (r) => fUsd(r.profitUsd)));

  lines.push("");
  lines.push("📦 СЕБЕСТОИМОСТЬ:");
  lines.push(row("  Cost/кг ARS:", (r) => fArs(r.costPerKg)));

  lines.push("");
  lines.push("⏱ ЛОГИСТИКА:");
  lines.push(row("  Часов на доставки/мес:", (r) => `${r.deliveryHoursPerMonth.toFixed(1)}ч`));
  lines.push(row("  Потеря свежести (1 рейс):", (r) => `-${r.freshnessHoursLost.toFixed(1)}ч`));

  lines.push("");
  lines.push("🚀 СТАРТ:");
  lines.push(
    row("  Стартовый капитал:", (r) => (r.setup_cost_usd > 0 ? fUsd(r.setup_cost_usd) : "0")),
  );
  lines.push(
    row("  Окупаемость переезда:", (r) =>
      r.breakEvenMonths != null ? `${r.breakEvenMonths} мес` : "—",
    ),
  );

  // Примечания
  const notes = results.filter((r) => r.note).map((r) => r.note);
  const uniqueNotes = [...new Set(notes)];
  if (uniqueNotes.length > 0) {
    lines.push("");
    for (const n of uniqueNotes) lines.push(n);
  }

  if (DRY_RUN) lines.push("\n[DRY RUN — Telegram не отправлен]");

  return lines.join("\n");
}

// -- Команда: zone ------------------------------------------------------------

/**
 * Детальный разбор одной зоны.
 * @param {string} zoneName
 * @param {number} blueRate
 * @param {object} [realData]
 * @returns {string}
 */
function buildZoneDetail(zoneName, blueRate, realData = {}) {
  // Ищем зону по подстроке (case-insensitive)
  const key = Object.keys(SCENARIOS).find((k) => k.toLowerCase().includes(zoneName.toLowerCase()));

  if (!key) {
    return `Зона "${zoneName}" не найдена.\n` + `Доступные: ${Object.keys(SCENARIOS).join(", ")}`;
  }

  const sc = SCENARIOS[key];
  const overrides = {};
  if (realData.monthRevenue && realData.monthRevenue > 0) {
    overrides.grossRevenue = realData.monthRevenue;
  }

  const r = calcScenario(sc, blueRate, overrides);
  const base = calcScenario(CURRENT, blueRate, overrides);

  const profitDiff = r.profit - base.profit;
  const profitDiffUsd = profitDiff / blueRate;
  const profitGrowthPct = base.profit > 0 ? (profitDiff / base.profit) * 100 : 0;

  const lines = [];
  lines.push(`🔍 ДЕТАЛЬНЫЙ РАЗБОР: ${key}`);
  lines.push(`Курс: ${blueRate} ARS/$`);
  lines.push("─".repeat(50));

  lines.push("\n📍 Параметры:");
  lines.push(`  Расстояние: ${r.distance_km} км (vs ${base.distance_km} км у Игоря)`);
  lines.push(`  Toll за поездку: ${fArs(sc.toll_cost_round)} ARS`);
  lines.push(`  Доставок/мес: ${sc.deliveries_per_month}`);
  lines.push(`  Безопасность: ${r.safety}/10`);
  lines.push(`  Независимость: ${r.independence}/10`);
  lines.push(`  Риск выселения: ${r.risk_eviction}/10`);

  lines.push("\n💸 OPEX детально (ARS/мес):");
  lines.push(`  Топливо:        ${fArs(r.opex.fuel).padStart(12)}`);
  lines.push(`  Toll:           ${fArs(r.opex.toll).padStart(12)}`);
  lines.push(`  Аренда:         ${fArs(r.opex.rent).padStart(12)}`);
  lines.push(`  Электричество:  ${fArs(r.opex.electricity).padStart(12)}`);
  lines.push(`  Вода:           ${fArs(r.opex.water).padStart(12)}`);
  lines.push(`  Жильё:          ${fArs(r.opex.housing).padStart(12)}`);
  lines.push(`  Семена/расх.:   ${fArs(r.opex.seeds).padStart(12)}`);
  lines.push(`  Упаковка:       ${fArs(r.opex.packaging).padStart(12)}`);
  lines.push(`  ─────────────────────────────`);
  lines.push(`  ИТОГО OPEX:     ${fArs(r.totalOpex).padStart(12)}`);

  lines.push("\n💰 Финансы:");
  lines.push(`  Выручка брутто: ${fArs(r.grossRevenue)} ARS`);
  lines.push(`  Доля Романа:    ${Math.round(r.effectiveShare * 100)}%`);
  lines.push(`  Выручка нетто:  ${fArs(r.netRevenue)} ARS`);
  lines.push(`  Прибыль:        ${fArs(r.profit)} ARS / ${fUsd(r.profitUsd)}`);
  lines.push(`  Маржа:          ${Math.round(r.margin)}%`);
  lines.push(`  Cost/кг:        ${fArs(r.costPerKg)} ARS`);

  lines.push("\n📈 Vs текущая ситуация (Игорь):");
  lines.push(
    `  Прибыль: ${fUsd(base.profitUsd)} → ${fUsd(r.profitUsd)} (${profitDiff >= 0 ? "+" : ""}${fUsd(profitDiffUsd)}, ${profitGrowthPct >= 0 ? "+" : ""}${Math.round(profitGrowthPct)}%)`,
  );
  lines.push(
    `  Логистика: ${base.deliveryHoursPerMonth.toFixed(1)}ч → ${r.deliveryHoursPerMonth.toFixed(1)}ч/мес`,
  );

  lines.push("\n🚀 Старт:");
  lines.push(`  Стартовый капитал: ${fUsd(r.setup_cost_usd)}`);
  if (r.breakEvenMonths != null) {
    lines.push(`  Окупаемость переезда: ${r.breakEvenMonths} мес`);
  }
  if (sc.investor_share > 0) {
    lines.push(
      `  С инвестором: ${Math.round(sc.investor_share * 100)}% ему / ${Math.round((1 - sc.investor_share) * 100)}% нам`,
    );
  }

  if (r.note) lines.push(`\n${r.note}`);
  if (DRY_RUN) lines.push("\n[DRY RUN — Telegram не отправлен]");

  return lines.join("\n");
}

// -- Команда: breakeven -------------------------------------------------------

/**
 * Анализ окупаемости для сценариев с setup_cost > 0.
 * @param {number} blueRate
 * @param {object} [realData]
 * @returns {string}
 */
function buildBreakeven(blueRate, realData = {}) {
  const overrides = {};
  if (realData.monthRevenue && realData.monthRevenue > 0) {
    overrides.grossRevenue = realData.monthRevenue;
  }

  const base = calcScenario(CURRENT, blueRate, overrides);
  const lines = [];

  lines.push("📊 АНАЛИЗ ОКУПАЕМОСТИ ПЕРЕЕЗДА");
  lines.push(`Курс: ${blueRate} ARS/$`);
  lines.push(`Текущая прибыль (Игорь): ${fArs(base.profit)} ARS / ${fUsd(base.profitUsd)}/мес`);
  lines.push("─".repeat(60));

  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (sc.setup_cost_usd <= 0) continue;

    const r = calcScenario(sc, blueRate, overrides);
    const profitDiff = r.profit - base.profit;
    const profitDiffUsd = profitDiff / blueRate;

    lines.push(`\n🏡 ${name}`);
    lines.push(`  Стартовый капитал: ${fUsd(sc.setup_cost_usd)}`);
    lines.push(
      `  Прибыль/мес: ${fArs(r.profit)} (${profitDiff >= 0 ? "+" : ""}${fArs(profitDiff)} vs Игорь)`,
    );
    lines.push(
      `  В USD: ${fUsd(r.profitUsd)} (${profitDiffUsd >= 0 ? "+" : ""}${fUsd(profitDiffUsd)}/мес)`,
    );

    if (profitDiff > 0) {
      const setupArs = sc.setup_cost_usd * blueRate;
      const months = Math.ceil(setupArs / profitDiff);
      const years = (months / 12).toFixed(1);
      lines.push(`  Окупаемость переезда: ${months} мес (${years} лет)`);
    } else {
      lines.push(`  Окупаемость: УБЫТОЧНО — переезд не окупится при текущей выручке`);
    }

    if (sc.investor_share > 0) {
      // Альтернативный расчёт: если инвестор даёт деньги под долю
      const shareForInvestor = sc.investor_share;
      const monthlyInvestorShare = r.profit * shareForInvestor; // это часть прибыли инвестора
      // Период возврата инвестиций инвестору через его долю прибыли
      const setupArs = sc.setup_cost_usd * blueRate;
      const investorMonths = Math.ceil(setupArs / monthlyInvestorShare);
      lines.push(
        `  Возврат инвестиций инвестору: ${investorMonths} мес (${(investorMonths / 12).toFixed(1)} лет через ${Math.round(shareForInvestor * 100)}% прибыли)`,
      );
    }
  }

  if (DRY_RUN) lines.push("\n[DRY RUN — Telegram не отправлен]");
  return lines.join("\n");
}

// -- Команда: golden ----------------------------------------------------------

/**
 * Находит и описывает «золотую середину».
 * @param {object[]} results — все рассчитанные сценарии
 * @param {number} blueRate
 * @returns {string}
 */
function buildGolden(results, blueRate) {
  const base = results[0]; // CURRENT всегда первый

  // Ищем лучшие по каждому критерию (кроме baseline)
  const others = results.slice(1);

  const bestProfit = others.reduce((a, b) => (b.profitUsd > a.profitUsd ? b : a));
  const bestCost = others.reduce((a, b) => (b.costPerKg < a.costPerKg ? b : a));
  const bestSafety = others.reduce((a, b) => (b.safety > a.safety ? b : a));
  const bestLogistics = others.reduce((a, b) =>
    b.deliveryHoursPerMonth < a.deliveryHoursPerMonth ? b : a,
  );

  // «Золотая середина» — взвешенный скор
  // Нормируем каждый критерий (0..1), берём среднее
  const maxProfit = Math.max(...others.map((r) => r.profitUsd));
  const minProfit = Math.min(...others.map((r) => r.profitUsd));
  const minCost = Math.min(...others.map((r) => r.costPerKg));
  const maxCost = Math.max(...others.map((r) => r.costPerKg));
  const minTime = Math.min(...others.map((r) => r.deliveryHoursPerMonth));
  const maxTime = Math.max(...others.map((r) => r.deliveryHoursPerMonth));

  /** @param {object} r */
  function score(r) {
    const profitScore =
      maxProfit > minProfit ? (r.profitUsd - minProfit) / (maxProfit - minProfit) : 1;
    const costScore = maxCost > minCost ? (maxCost - r.costPerKg) / (maxCost - minCost) : 1;
    const safetyScore = r.safety / 10;
    const logisticsScore =
      maxTime > minTime ? (maxTime - r.deliveryHoursPerMonth) / (maxTime - minTime) : 1;
    const independenceScore = r.independence / 10;
    const riskScore = 1 - r.risk_eviction / 10;
    // Веса: прибыль 30%, независимость 20%, безопасность 15%, логистика 15%, cost 10%, риск 10%
    return (
      profitScore * 0.3 +
      independenceScore * 0.2 +
      safetyScore * 0.15 +
      logisticsScore * 0.15 +
      costScore * 0.1 +
      riskScore * 0.1
    );
  }

  const golden = others.reduce((a, b) => (score(b) > score(a) ? b : a));
  const profitGrowthPct =
    base.profitUsd > 0 ? ((golden.profitUsd - base.profitUsd) / base.profitUsd) * 100 : 0;

  // Найдём имя сценария по key
  const goldenName =
    Object.keys(SCENARIOS).find((k) => SCENARIOS[k].key === golden.key) || golden.label;

  const lines = [];
  lines.push("🏆 ЗОЛОТАЯ СЕРЕДИНА — PEPINO PICK");
  lines.push(`Курс: ${blueRate} ARS/$`);
  lines.push("─".repeat(50));

  lines.push(`\nПо ПРИБЫЛИ:        ${bestProfit.label} — ${fUsd(bestProfit.profitUsd)}/мес`);
  if (base.profitUsd > 0) {
    const pct = ((bestProfit.profitUsd - base.profitUsd) / base.profitUsd) * 100;
    lines[lines.length - 1] += ` (+${Math.round(pct)}% vs Суипача)`;
  }
  lines.push(`По СЕБЕСТОИМОСТИ:  ${bestCost.label} — ${fArs(bestCost.costPerKg)} ARS/кг`);
  lines.push(`По БЕЗОПАСНОСТИ:   ${bestSafety.label} — ${bestSafety.safety}/10`);
  lines.push(
    `По ЛОГИСТИКЕ:      ${bestLogistics.label} — ${bestLogistics.distance_km} км, ${bestLogistics.deliveryHoursPerMonth.toFixed(1)}ч/мес`,
  );

  lines.push(`\n⭐ РЕКОМЕНДАЦИЯ: ${goldenName}`);
  lines.push(`  Скор: ${(score(golden) * 100).toFixed(0)}/100 (взвешенный)`);
  lines.push(
    `  Прибыль: ${fUsd(golden.profitUsd)}/мес (+${Math.round(profitGrowthPct)}% vs текущая)`,
  );
  lines.push(`  Себестоимость: ${fArs(golden.costPerKg)} ARS/кг`);
  lines.push(`  Безопасность: ${golden.safety}/10`);
  lines.push(
    `  Логистика: ${golden.distance_km} км, ${golden.deliveryHoursPerMonth.toFixed(1)}ч/мес`,
  );
  lines.push(`  Независимость: ${golden.independence}/10`);
  lines.push(
    `  Стартовый капитал: ${golden.setup_cost_usd > 0 ? fUsd(golden.setup_cost_usd) : "0 (аренда)"}`,
  );
  if (golden.breakEvenMonths != null) {
    lines.push(`  Окупаемость переезда: ${golden.breakEvenMonths} мес`);
  }
  if (golden.investor_share > 0) {
    lines.push(`  Инвестор: ${Math.round(golden.investor_share * 100)}% (если нужен капитал)`);
  }

  lines.push("\n📋 СКОРЫ ВСЕХ ВАРИАНТОВ:");
  const ranked = [...others].sort((a, b) => score(b) - score(a));
  for (const r of ranked) {
    const name = Object.keys(SCENARIOS).find((k) => SCENARIOS[k].key === r.key) || r.label;
    lines.push(
      `  ${(score(r) * 100).toFixed(0).padStart(3)}/100  ${name.padEnd(30)}  ${fUsd(r.profitUsd)}/мес`,
    );
  }

  if (DRY_RUN) lines.push("\n[DRY RUN — Telegram не отправлен]");
  return lines.join("\n");
}

// -- Основной запуск ----------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const cmd = args[0] || "compare";
  const zoneArg = args[1] || "";

  const startMs = Date.now();

  // Загружаем реальные данные из farm-state (не блокируем, если кеш пустой)
  let realData = {};
  try {
    const state = await getState();
    const fin = getFinancials(state);
    // Берём месячную выручку если данные выглядят реально (> 100k ARS)
    if (fin && fin.month && fin.month.revenue > 100000) {
      realData.monthRevenue = fin.month.revenue;
    }
  } catch (err) {
    // farm-state может быть недоступен — используем модельные данные
    if (!DRY_RUN) {
      process.stderr.write(`[relocation-calc] farm-state недоступен: ${err.message}\n`);
    }
  }

  const blueRate = loadBlueRate();

  let message = "";

  if (cmd === "compare") {
    const results = calcAll(blueRate, realData);
    message = buildCompareTable(results, blueRate);
  } else if (cmd === "zone") {
    message = buildZoneDetail(zoneArg, blueRate, realData);
  } else if (cmd === "breakeven") {
    message = buildBreakeven(blueRate, realData);
  } else if (cmd === "golden") {
    const results = calcAll(blueRate, realData);
    message = buildGolden(results, blueRate);
  } else {
    message =
      "Использование:\n" +
      "  node relocation-calc.cjs compare\n" +
      '  node relocation-calc.cjs zone "Cañuelas"\n' +
      "  node relocation-calc.cjs breakeven\n" +
      "  node relocation-calc.cjs golden\n" +
      "  node relocation-calc.cjs --dry-run compare";
  }

  // Вывод в консоль всегда
  process.stdout.write(message + "\n");

  // Отправка в Telegram (если не dry-run)
  if (!DRY_RUN && message) {
    // Telegram ограничен 4096 символами — режем если нужно
    const MAX_TG = 4000;
    const tgText = message.length > MAX_TG ? message.slice(0, MAX_TG) + "\n...(обрезано)" : message;
    await sendThrottled(tgText, { thread: TG_THREAD, priority: "normal" });
  }

  // Langfuse трейс
  const durationMs = Date.now() - startMs;
  await trace({
    name: "relocation-calc",
    input: { cmd, zone: zoneArg, dry_run: DRY_RUN, realData: !!realData.monthRevenue },
    output: { length: message.length, blueRate },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", thread: TG_THREAD },
  });
}

main().catch((err) => {
  process.stderr.write(`[relocation-calc] Ошибка: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
