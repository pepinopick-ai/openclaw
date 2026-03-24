#!/usr/bin/env node
/**
 * profit-maximizer.cjs -- Жадный CFO: ищет возможности роста выручки и снижения затрат
 *
 * Анализирует реальные данные продаж, расходов, производства и склада.
 * Выдаёт конкретные рекомендации с числами.
 *
 * Команды:
 *   node profit-maximizer.cjs pricing     -- когда поднять/снизить цену
 *   node profit-maximizer.cjs volume      -- оптимизация объёмов производства
 *   node profit-maximizer.cjs products    -- keep/kill/test по продуктам
 *   node profit-maximizer.cjs costs       -- возможности снижения расходов
 *   node profit-maximizer.cjs suppliers   -- оптимизация поставщиков
 *   node profit-maximizer.cjs full        -- полный отчёт (все секции)
 *   node profit-maximizer.cjs --dry-run full
 *
 * Cron:
 *   pricing + volume + products:  0 8 * * 1   (пн 08:00 ART)
 *   costs + suppliers:            0 8 1,15 * * (1-е и 15-е числа)
 *   full:                         30 17 * * 0  (вс 17:30 ART)
 */

"use strict";

const { getState, getProducts, getFinancials, getStock } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { parseNum, parseDate, fmtDate, fmtNum } = require("./helpers.cjs");
const { normalize } = require("./product-aliases.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Конфигурация -------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD = 20; // Director/Strategy topic

/** Период анализа цен (дни) */
const PRICING_WINDOW_DAYS = 30;
/** Период анализа объёмов (дни) */
const VOLUME_WINDOW_DAYS = 30;
/** Период скоринга продуктов (дни) */
const SCORING_WINDOW_DAYS = 90;
/** Допустимое отклонение объёма от спроса (%) */
const VOLUME_TOLERANCE_PCT = 10;
/** Порог роста спроса для повышения цены */
const DEMAND_RISE_THRESHOLD = 0.2;
/** Порог падения спроса для снижения цены */
const DEMAND_FALL_THRESHOLD = 0.2;
/** Критический запас (дней) — риск потерь */
const STOCK_SURPLUS_DAYS = 14;

// -- Утилиты ------------------------------------------------------------------

/** Форматирует число как ARS */
function ars(n) {
  return `${fmtNum(Math.round(n))} ARS`;
}

/** Вычисляет дату N дней назад */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Фильтрует строки продаж за последние N дней.
 * @param {Record<string,string>[]} rows
 * @param {number} days
 * @returns {Record<string,string>[]}
 */
function salesInPeriod(rows, days) {
  const cutoff = daysAgo(days);
  return rows.filter((r) => {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    return d && d >= cutoff;
  });
}

/** Проверяет, что строка — это реальное имя продукта, а не число/вес */
function isValidProductName(name) {
  if (!name || name.length < 2) return false;
  // Пропускаем строки вида "20 кг", "0.5 кг", "36.5", "2 кг" — только числа с единицами
  if (/^\d+([.,]\d+)?\s*(кг|kg|г|g|шт|uds?)?$/i.test(name)) return false;
  return true;
}

/**
 * Суммирует кг и ARS по продукту из строк продаж.
 * @param {Record<string,string>[]} rows
 * @returns {Map<string, {kg: number, ars: number, count: number}>}
 */
function aggregateByProduct(rows) {
  /** @type {Map<string, {kg: number, ars: number, count: number}>} */
  const map = new Map();
  for (const r of rows) {
    const raw = (r["Продукт"] || r["Товар"] || r["Producto"] || "").trim();
    if (!raw) continue;
    const product = normalize(raw);
    if (!isValidProductName(product)) continue;
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
 * Суммирует кг производства по продукту.
 * @param {Record<string,string>[]} rows
 * @param {number} days
 * @returns {Map<string, number>}
 */
function productionByProduct(rows, days) {
  const cutoff = daysAgo(days);
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    if (!d || d < cutoff) continue;
    const raw = (r["Продукт"] || r["Товар"] || r["Producto"] || "").trim();
    if (!raw) continue;
    const product = normalize(raw);
    const kg = parseNum(r["Вес кг"] || r["Кол-во кг"] || r["Кг"] || r["Объём кг"] || 0);
    map.set(product, (map.get(product) || 0) + kg);
  }
  return map;
}

/**
 * Группирует расходы по категории.
 * @param {Record<string,string>[]} rows
 * @param {number} days
 * @returns {Map<string, number>}
 */
function expensesByCategory(rows, days) {
  const cutoff = daysAgo(days);
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    if (!d || d < cutoff) continue;
    const category = (r["Категория"] || r["Tipo"] || r["Тип"] || "Прочее").trim() || "Прочее";
    const amount = parseNum(r["Сумма"] || r["Сумма ARS"] || r["Monto"] || 0);
    map.set(category, (map.get(category) || 0) + amount);
  }
  return map;
}

// -- 1. PRICING ---------------------------------------------------------------

/**
 * Анализирует ценовые возможности.
 * @param {Record<string,string>[]} allSales
 * @param {Record<string, {kg: number, days: number, status: string}>} stock
 * @returns {string}
 */
function analyzePricing(allSales, stock) {
  const current = salesInPeriod(allSales, PRICING_WINDOW_DAYS);
  const previous = salesInPeriod(allSales, PRICING_WINDOW_DAYS * 2).filter((r) => {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    const cutoff = daysAgo(PRICING_WINDOW_DAYS);
    return d && d < cutoff;
  });

  const curMap = aggregateByProduct(current);
  const prevMap = aggregateByProduct(previous);

  /** @type {Array<{product: string, action: string, reason: string, currentPrice: number, suggestedPrice: number, potentialArs: number}>} */
  const raise = [];
  /** @type {Array<{product: string, action: string, reason: string, currentPrice: number, suggestedPrice: number, potentialArs: number}>} */
  const lower = [];
  /** @type {string[]} */
  const hold = [];

  for (const [product, cur] of curMap) {
    if (cur.kg === 0) continue;
    const currentAvgPrice = cur.ars / cur.kg;

    const prev = prevMap.get(product);
    const prevKg = prev ? prev.kg : 0;
    const demandChange = prevKg > 0 ? (cur.kg - prevKg) / prevKg : 0;

    const stockInfo = stock[product];
    const stockDays = stockInfo ? stockInfo.days : 7;

    // Повышать цену:
    // - спрос растёт >20% И запас не критический
    // - запасов нет (дефицит)
    const raiseReasons = [];
    if (demandChange > DEMAND_RISE_THRESHOLD && stockDays >= 5) {
      raiseReasons.push(`спрос +${Math.round(demandChange * 100)}% за месяц`);
    }
    if (stockDays < 3 && cur.kg > 0) {
      raiseReasons.push(`дефицит: запас ${stockDays} дн.`);
    }

    // Снижать цену:
    // - избыток запаса (>14 дней для скоропортящихся)
    // - спрос падает >20%
    const lowerReasons = [];
    if (stockDays > STOCK_SURPLUS_DAYS) {
      lowerReasons.push(`избыток запаса: ${Math.round(stockDays)} дн.`);
    }
    if (demandChange < -DEMAND_FALL_THRESHOLD) {
      lowerReasons.push(`спрос -${Math.round(Math.abs(demandChange) * 100)}%`);
    }

    if (raiseReasons.length > 0) {
      const suggestedPrice = Math.round(currentAvgPrice * 1.2);
      const weeklyKg = cur.kg / (PRICING_WINDOW_DAYS / 7);
      const potentialArs = (suggestedPrice - currentAvgPrice) * weeklyKg;
      raise.push({
        product,
        action: "raise",
        reason: raiseReasons.join(", "),
        currentPrice: Math.round(currentAvgPrice),
        suggestedPrice,
        potentialArs: Math.round(potentialArs),
      });
    } else if (lowerReasons.length > 0) {
      const suggestedPrice = Math.round(currentAvgPrice * 0.8);
      const extraVolume = Math.round((cur.kg / PRICING_WINDOW_DAYS) * 7 * 0.3);
      const potentialArs = suggestedPrice * extraVolume;
      lower.push({
        product,
        action: "lower",
        reason: lowerReasons.join(", "),
        currentPrice: Math.round(currentAvgPrice),
        suggestedPrice,
        potentialArs: Math.round(potentialArs),
      });
    } else {
      hold.push(`${product}: ${ars(Math.round(currentAvgPrice))}/кг — стабильный спрос`);
    }
  }

  const lines = ["*PRICING — Ценовые рекомендации*\n"];

  if (raise.length > 0) {
    lines.push("*ПОДНЯТЬ ЦЕНУ:*");
    for (const r of raise) {
      lines.push(
        `  ${r.product}: ${ars(r.currentPrice)} → ${ars(r.suggestedPrice)}/кг (+20%)\n` +
          `  Причина: ${r.reason}\n` +
          `  Тест: поднять для новых клиентов, сохранить для постоянных\n` +
          `  Потенциал: +${ars(r.potentialArs)}/нед`,
      );
    }
    lines.push("");
  }

  if (lower.length > 0) {
    lines.push("*СНИЗИТЬ ЦЕНУ (промо):*");
    for (const r of lower) {
      lines.push(
        `  ${r.product}: ${ars(r.currentPrice)} → ${ars(r.suggestedPrice)}/кг (-20%)\n` +
          `  Причина: ${r.reason}\n` +
          `  Потенциал нового объёма: +${ars(r.potentialArs)}/нед`,
      );
    }
    lines.push("");
  }

  if (hold.length > 0) {
    lines.push("*ДЕРЖАТЬ:*");
    for (const h of hold) {
      lines.push(`  ${h}`);
    }
    lines.push("");
  }

  if (raise.length === 0 && lower.length === 0 && hold.length === 0) {
    lines.push("_Данных по продажам за последние 30 дней недостаточно для анализа._");
  }

  const totalRaisePotential = raise.reduce((s, r) => s + r.potentialArs, 0);
  if (totalRaisePotential > 0) {
    lines.push(`*Итого потенциал от ценовых изменений: +${ars(totalRaisePotential)}/нед*`);
  }

  return lines.join("\n");
}

// -- 2. VOLUME ----------------------------------------------------------------

/**
 * Анализирует соответствие производства спросу.
 * @param {Record<string,string>[]} allSales
 * @param {Record<string,string>[]} allProduction
 * @returns {string}
 */
function analyzeVolume(allSales, allProduction) {
  const salesPeriod = salesInPeriod(allSales, VOLUME_WINDOW_DAYS);
  const salesMap = aggregateByProduct(salesPeriod);
  const prodMap = productionByProduct(allProduction, VOLUME_WINDOW_DAYS);

  // Все продукты (из продаж ИЛИ производства)
  const allProducts = new Set([...salesMap.keys(), ...prodMap.keys()]);

  /** @type {Array<{product: string, soldKg: number, producedKg: number, gap: number, type: string}>} */
  const overproduced = [];
  /** @type {Array<{product: string, soldKg: number, producedKg: number, gap: number, type: string}>} */
  const underproduced = [];
  /** @type {string[]} */
  const optimal = [];

  for (const product of allProducts) {
    const sold = salesMap.get(product);
    const soldKg = sold ? sold.kg : 0;
    const producedKg = prodMap.get(product) || 0;

    // Если нет данных о производстве, пропускаем (только продаём остатки)
    if (producedKg === 0 && soldKg === 0) continue;
    if (producedKg === 0) continue; // не производим сами

    const avgSoldPrice = sold && sold.kg > 0 ? sold.ars / sold.kg : 0;
    const gap = producedKg - soldKg;
    const gapPct = producedKg > 0 ? Math.abs(gap) / producedKg : 0;

    if (gap > 0 && gapPct > VOLUME_TOLERANCE_PCT / 100) {
      // Перепроизводство
      const costPerKg = avgSoldPrice * 0.4; // ~40% себестоимость
      overproduced.push({
        product,
        soldKg: Math.round(soldKg * 10) / 10,
        producedKg: Math.round(producedKg * 10) / 10,
        gap: Math.round(gap * 10) / 10,
        weeklyWasteCost: Math.round((gap / (VOLUME_WINDOW_DAYS / 7)) * costPerKg),
        reductionPct: Math.round(gapPct * 100),
      });
    } else if (gap < 0 && gapPct > VOLUME_TOLERANCE_PCT / 100) {
      // Дефицит
      const unmetKg = Math.abs(gap);
      overproduced; // not used here
      underproduced.push({
        product,
        soldKg: Math.round(soldKg * 10) / 10,
        producedKg: Math.round(producedKg * 10) / 10,
        gap: Math.round(unmetKg * 10) / 10,
        weeklyRevenueLost: Math.round((unmetKg / (VOLUME_WINDOW_DAYS / 7)) * avgSoldPrice),
        increasePct: Math.round(gapPct * 100),
      });
    } else {
      optimal.push(
        `  ${product}: производим ${Math.round(producedKg)}кг, продаём ${Math.round(soldKg)}кг`,
      );
    }
  }

  const lines = ["*VOLUME — Оптимизация производства*\n"];

  if (overproduced.length > 0) {
    lines.push("*Перепроизводство (риск потерь):*");
    for (const p of overproduced) {
      lines.push(
        `  ${p.product}: производим ${p.producedKg}кг, продаём ${p.soldKg}кг → -${p.gap}кг лишних за ${VOLUME_WINDOW_DAYS}дн\n` +
          `  → Сократить посадку на ${p.reductionPct}% в следующем цикле\n` +
          `  → Экономия: ~${ars(p.weeklyWasteCost)}/нед`,
      );
    }
    lines.push("");
  }

  if (underproduced.length > 0) {
    lines.push("*Дефицит (упущенная выручка):*");
    for (const p of underproduced) {
      lines.push(
        `  ${p.product}: спрос ${p.soldKg}кг, производим ${p.producedKg}кг → -${p.gap}кг нехватка за ${VOLUME_WINDOW_DAYS}дн\n` +
          `  → Увеличить посадку на ${p.increasePct}%\n` +
          `  → Доп. выручка: +${ars(p.weeklyRevenueLost)}/нед`,
      );
    }
    lines.push("");
  }

  if (optimal.length > 0) {
    lines.push("*Оптимально:*");
    lines.push(...optimal);
    lines.push("");
  }

  if (overproduced.length === 0 && underproduced.length === 0 && optimal.length === 0) {
    lines.push("_Недостаточно данных производства для анализа объёмов._");
    lines.push("_Внесите данные в лист Производство._");
  }

  const totalWeeklySavings = overproduced.reduce((s, p) => s + (p.weeklyWasteCost || 0), 0);
  const totalWeeklyRevenue = underproduced.reduce((s, p) => s + (p.weeklyRevenueLost || 0), 0);
  if (totalWeeklySavings > 0 || totalWeeklyRevenue > 0) {
    lines.push(
      `*Итого потенциал: +${ars(totalWeeklyRevenue)}/нед выручки, -${ars(totalWeeklySavings)}/нед потерь*`,
    );
  }

  return lines.join("\n");
}

// -- 3. PRODUCTS --------------------------------------------------------------

/**
 * Скорит продукты по портфельной матрице.
 * @param {Record<string,string>[]} allSales
 * @param {Record<string, {kg: number, ars: number, avg_price: number}>} productAnalytics
 * @returns {string}
 */
function analyzeProducts(allSales, productAnalytics) {
  const recent = salesInPeriod(allSales, SCORING_WINDOW_DAYS);
  const recentMap = aggregateByProduct(recent);

  // Данные за предыдущий период для тренда
  const prev = salesInPeriod(allSales, SCORING_WINDOW_DAYS * 2).filter((r) => {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    const cutoff = daysAgo(SCORING_WINDOW_DAYS);
    return d && d < cutoff;
  });
  const prevMap = aggregateByProduct(prev);

  const totalRevenue = [...recentMap.values()].reduce((s, v) => s + v.ars, 0);

  /** @type {Array<{product: string, score: number, revenue: number, revenueShare: number, margin: number, trend: number, label: string}>} */
  const scored = [];

  for (const [product, cur] of recentMap) {
    if (cur.ars === 0) continue;

    const revenueShare = totalRevenue > 0 ? cur.ars / totalRevenue : 0;
    const avgPrice = cur.kg > 0 ? cur.ars / cur.kg : 0;

    // Маржа: грубая оценка (цена - 40% себестоимость)
    // Чем выше цена/кг, тем выше маржа
    const estimatedCostShare = 0.4;
    const marginPct = 1 - estimatedCostShare;

    // Тренд: сравниваем объём с предыдущим периодом
    const prevData = prevMap.get(product);
    const prevKg = prevData ? prevData.kg : 0;
    const trendRaw = prevKg > 0 ? (cur.kg - prevKg) / prevKg : 0;
    const trendScore = Math.max(0, Math.min(1, (trendRaw + 0.5) / 1.0)); // нормализуем в 0-1

    // Уникальность: оцениваем по наличию в productAnalytics и среднему чеку
    // Высокий средний чек = скорее всего уникальный продукт
    const avgPriceScore = avgPrice > 3000 ? 1.0 : avgPrice > 1500 ? 0.6 : 0.3;

    // Скоринг (0-100)
    const score = Math.round(
      revenueShare * 30 + // доля выручки (0-30)
        marginPct * 30 + // маржа (0-30)
        trendScore * 20 + // тренд (0-20)
        avgPriceScore * 20, // уникальность по цене (0-20)
    );

    scored.push({
      product,
      score,
      revenue: Math.round(cur.ars),
      revenueShare: Math.round(revenueShare * 100),
      margin: Math.round(marginPct * 100),
      trend: Math.round(trendRaw * 100),
      label: score >= 70 ? "star" : score >= 50 ? "workhorse" : score >= 30 ? "question" : "dog",
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const stars = scored.filter((p) => p.label === "star");
  const workhorses = scored.filter((p) => p.label === "workhorse");
  const questions = scored.filter((p) => p.label === "question");
  const dogs = scored.filter((p) => p.label === "dog");

  const lines = ["*PRODUCTS — Портфель продуктов*\n"];

  if (stars.length > 0) {
    lines.push("*STARS (score >70 — масштабировать):*");
    for (const p of stars) {
      const trendStr = p.trend > 0 ? `+${p.trend}%` : `${p.trend}%`;
      lines.push(
        `  ${p.product}: ${p.score}/100 — выручка ${ars(p.revenue)} (${p.revenueShare}%), тренд ${trendStr}\n` +
          `  → Действие: увеличить производство, расширить клиентскую базу`,
      );
    }
    lines.push("");
  }

  if (workhorses.length > 0) {
    lines.push("*WORKHORSES (50-70 — поддерживать):*");
    for (const p of workhorses) {
      lines.push(
        `  ${p.product}: ${p.score}/100 — выручка ${ars(p.revenue)} (${p.revenueShare}%)\n` +
          `  → Действие: поддерживать текущий уровень`,
      );
    }
    lines.push("");
  }

  if (questions.length > 0) {
    lines.push("*QUESTION MARKS (30-50 — тестировать):*");
    for (const p of questions) {
      lines.push(
        `  ${p.product}: ${p.score}/100 — выручка ${ars(p.revenue)}, данных мало\n` +
          `  → Действие: тест 4 недели, цель 10 новых клиентов`,
      );
    }
    lines.push("");
  }

  if (dogs.length > 0) {
    lines.push("*DOGS (<30 — рассмотреть отказ):*");
    for (const p of dogs) {
      lines.push(
        `  ${p.product}: ${p.score}/100 — низкий потенциал\n` +
          `  → Действие: прекратить через 1 цикл, ресурсы → на Stars`,
      );
    }
    lines.push("");
  }

  if (scored.length === 0) {
    lines.push("_Нет данных по продажам за последние 90 дней._");
  }

  return lines.join("\n");
}

// -- 4. COSTS -----------------------------------------------------------------

/**
 * Анализирует расходы и находит возможности экономии.
 * @param {Record<string,string>[]} allExpenses
 * @param {number} monthRevenue
 * @returns {string}
 */
function analyzeCosts(allExpenses, monthRevenue) {
  const catMap = expensesByCategory(allExpenses, 30);
  const totalExpenses = [...catMap.values()].reduce((s, v) => s + v, 0);

  const lines = ["*COSTS — Возможности снижения расходов*\n"];

  if (catMap.size === 0) {
    lines.push("_Нет данных по расходам за последние 30 дней._");
    lines.push("_Внесите расходы через expense-quick-entry.cjs._");
    return lines.join("\n");
  }

  // Сортируем категории по сумме
  const sorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  const revenueRef = monthRevenue > 0 ? monthRevenue : totalExpenses / 0.6;

  lines.push(
    `Расходы за 30 дней: ${ars(totalExpenses)} (${Math.round((totalExpenses / revenueRef) * 100)}% от выручки)\n`,
  );

  /** Накопленный потенциал экономии */
  let savingsPotential = 0;

  lines.push("*Анализ по категориям:*");
  for (const [cat, amount] of sorted) {
    const shareOfExpenses = totalExpenses > 0 ? amount / totalExpenses : 0;
    const shareOfRevenue = revenueRef > 0 ? amount / revenueRef : 0;
    const icon = shareOfRevenue >= 0.15 ? "RED" : shareOfRevenue >= 0.08 ? "YEL" : "GRN";
    const iconStr = icon === "RED" ? "[!]" : icon === "YEL" ? "[~]" : "[ ]";

    lines.push(
      `${iconStr} ${cat}: ${ars(amount)} (${Math.round(shareOfExpenses * 100)}% расходов)`,
    );

    // Рекомендации по крупным категориям
    if (icon === "RED" && amount > 50000) {
      const saving = Math.round(amount * 0.15);
      savingsPotential += saving;
      if (
        cat.toLowerCase().includes("топлив") ||
        cat.toLowerCase().includes("доставк") ||
        cat.toLowerCase().includes("transport")
      ) {
        lines.push(`    → Оптимизировать маршруты (trip-optimizer экономит 15%)`);
        lines.push(`    → Объединять доставки, сокращать число поездок`);
        lines.push(`    → Экономия: ~${ars(saving)}/мес`);
      } else if (
        cat.toLowerCase().includes("упаков") ||
        cat.toLowerCase().includes("packag") ||
        cat.toLowerCase().includes("матери")
      ) {
        lines.push(`    → Перейти на оптовые закупки (1000+ шт = скидка 25-35%)`);
        lines.push(`    → Экономия: ~${ars(Math.round(amount * 0.3))}/мес`);
        savingsPotential += Math.round(amount * 0.15); // учли выше
      } else {
        lines.push(`    → Пересмотреть поставщика или объём закупок`);
        lines.push(`    → Потенциал экономии: ~${ars(saving)}/мес`);
      }
    } else if (icon === "YEL" && amount > 20000) {
      const saving = Math.round(amount * 0.1);
      savingsPotential += saving;
      lines.push(`    → Оптовая закупка или альтернативный поставщик: ~${ars(saving)}/мес`);
    }
  }

  lines.push("");
  lines.push("*Бесплатные/дешёвые ресурсы (используем?):*");
  lines.push("  Пекановая шелуха → субстрат для грибов (бесплатно от соседей)");
  lines.push("  Отходы теплицы → компост (экономия на удобрениях)");
  lines.push("  Сыворотка → корм для кур (договориться с молочной)");
  lines.push("");

  if (savingsPotential > 0) {
    lines.push(`*Общий потенциал экономии: ~${ars(savingsPotential)}/мес*`);
  }

  return lines.join("\n");
}

// -- 5. SUPPLIERS -------------------------------------------------------------

/**
 * Рекомендации по оптимизации поставщиков.
 * (На основе известных данных + анализа расходных категорий.)
 * @param {Record<string,string>[]} allExpenses
 * @returns {string}
 */
function analyzeSuppliers(allExpenses) {
  const catMap = expensesByCategory(allExpenses, 30);

  const lines = ["*SUPPLIERS — Оптимизация поставщиков*\n"];

  lines.push("*Текущая ситуация и возможности:*\n");

  lines.push("1. Субстрат для грибов");
  lines.push("   Текущее: мелкие партии у местных поставщиков");
  lines.push("   Альтернатива: ARG-AGRO оптом или сделать самостоятельно из шелухи");
  lines.push("   Потенциал: -20-30% на себестоимость субстрата");
  lines.push("");

  lines.push("2. Семена и рассада");
  lines.push("   Текущее: розничные закупки по необходимости");
  lines.push("   Альтернатива: сезонная закупка у ARG-AGRO или Украинских поставщиков");
  lines.push("   Потенциал: -15-25% при заказе на сезон вперёд");
  lines.push("");

  lines.push("3. Упаковочные материалы");
  lines.push("   Текущее: мелкие партии (розница)");
  lines.push("   Альтернатива: опт 1000+ шт у производителя напрямую");
  lines.push("   Потенциал: -30-40% на единицу упаковки");
  lines.push("");

  lines.push("4. Удобрения и субстраты");
  lines.push("   Текущее: COINCER или аналогичный");
  lines.push("   Альтернатива: оптовый заказ с квартальным запасом");
  lines.push("   Потенциал: скидка 10-15% при объёме");
  lines.push("");

  lines.push("*Приоритетные действия:*");
  lines.push("  1. Запросить оптовые цены на упаковку у 3 поставщиков");
  lines.push("  2. Оценить стоимость самостоятельного субстрата из шелухи");
  lines.push("  3. Договориться о сезонном контракте с поставщиком семян");

  // Если есть данные расходов, упоминаем конкретные цифры
  const totalExpenses = [...catMap.values()].reduce((s, v) => s + v, 0);
  if (totalExpenses > 0) {
    const packagingEstimate = totalExpenses * 0.08;
    lines.push("");
    lines.push(
      `*Оценка экономии при переходе на опт: ~${ars(Math.round(packagingEstimate * 0.3))}/мес*`,
    );
  }

  return lines.join("\n");
}

// -- 6. FULL REPORT -----------------------------------------------------------

/**
 * Формирует полный отчёт из всех секций.
 * @param {object} state
 * @returns {string}
 */
function buildFullReport(state) {
  const { sales, production, expenses } = state;
  const financials = state.analytics?.financial || { week: {}, month: {} };
  const stock = state.analytics?.stock || {};
  const productAnalytics = state.analytics?.products || {};

  const monthRevenue = financials.month?.revenue || 0;
  const monthExpenses = financials.month?.expenses || 0;
  const monthProfit = monthRevenue - monthExpenses;
  const monthMarginPct = monthRevenue > 0 ? Math.round((monthProfit / monthRevenue) * 100) : 0;

  // Считаем потенциалы
  const pricingSection = analyzePricing(sales, stock);
  const volumeSection = analyzeVolume(sales, production);
  const productsSection = analyzeProducts(sales, productAnalytics);
  const costsSection = analyzeCosts(expenses, monthRevenue);
  const suppliersSection = analyzeSuppliers(expenses);

  // Извлекаем потенциалы из секций (простой парсинг итоговых строк)
  const pricingPotential = extractPotential(pricingSection);
  const volumePotential = extractPotential(volumeSection);
  const costsPotential = extractCostSaving(costsSection);
  const suppliersPotential = extractCostSaving(suppliersSection);

  const totalRevenuePotential = pricingPotential + volumePotential;
  const totalCostSavings = costsPotential + suppliersPotential;

  const weekNum = getWeekNumber(new Date());

  const lines = [
    `*PROFIT MAXIMIZER — неделя ${weekNum}*`,
    "",
    `*Текущие показатели (месяц):*`,
    `  Выручка: ${ars(monthRevenue)}`,
    `  Расходы: ${ars(monthExpenses)}`,
    `  Прибыль: ${ars(monthProfit)} (маржа ${monthMarginPct}%)`,
    "",
  ];

  if (totalRevenuePotential > 0) {
    lines.push(`*Потенциал роста выручки: +${ars(totalRevenuePotential)}/нед*`);
    if (pricingPotential > 0) lines.push(`  • Ценовые изменения: +${ars(pricingPotential)}`);
    if (volumePotential > 0) lines.push(`  • Оптимизация объёмов: +${ars(volumePotential)}`);
    lines.push("");
  }

  if (totalCostSavings > 0) {
    lines.push(`*Потенциал экономии: -${ars(totalCostSavings)}/мес*`);
    if (costsPotential > 0) lines.push(`  • Оптимизация расходов: -${ars(costsPotential)}`);
    if (suppliersPotential > 0) lines.push(`  • Смена поставщиков: -${ars(suppliersPotential)}`);
    lines.push("");
  }

  // ТОП-3 действия
  lines.push("*ТОП-3 ДЕЙСТВИЯ ЭТОЙ НЕДЕЛИ:*");

  const actions = [];

  // Из pricing: первое raise-рекомендация
  const raiseMatch = pricingSection.match(/ПОДНЯТЬ.*?\n  (\S[^\n]+)/s);
  if (raiseMatch) {
    actions.push(`Поднять цену: ${raiseMatch[1].trim()}`);
  }

  // Из costs: первое крупное
  const costsMatch = costsSection.match(/\[!\]([^\n]+)/);
  if (costsMatch) {
    actions.push(`Оптимизировать расходы: ${costsMatch[1].trim()}`);
  }

  // Из suppliers
  actions.push("Запросить оптовые цены на упаковку у 3 поставщиков");

  // Из clients: звонки at_risk
  actions.push("Проверить и позвонить клиентам со статусом at_risk");

  for (let i = 0; i < Math.min(3, actions.length); i++) {
    lines.push(`  ${i + 1}. ${actions[i]}`);
  }

  lines.push("");
  lines.push("_Детали: node profit-maximizer.cjs pricing/volume/products/costs/suppliers_");

  return lines.join("\n");
}

/** Извлекает потенциал выручки из секции (последняя строка "Итого...") */
function extractPotential(section) {
  const match = section.match(/Итого потенциал[^:]*:\s*\+?([\d\s]+)\s*ARS/);
  if (!match) return 0;
  return parseInt(match[1].replace(/\s/g, ""), 10) || 0;
}

/** Извлекает потенциал экономии из секции */
function extractCostSaving(section) {
  const match = section.match(/потенциал\s+экономии[^:]*:\s*~?([\d\s]+)\s*ARS/i);
  if (!match) return 0;
  return parseInt(match[1].replace(/\s/g, ""), 10) || 0;
}

/** ISO week number */
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// -- Основная логика ----------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const command = args[0] || "full";

  const validCommands = ["pricing", "volume", "products", "costs", "suppliers", "full"];
  if (!validCommands.includes(command)) {
    console.error(`Неизвестная команда: ${command}`);
    console.error(`Допустимые команды: ${validCommands.join(", ")}`);
    process.exit(1);
  }

  const startMs = Date.now();
  console.log(`[profit-maximizer] Команда: ${command}${DRY_RUN ? " (dry-run)" : ""}`);

  let state;
  try {
    state = await getState();
  } catch (err) {
    console.error(`[profit-maximizer] Ошибка загрузки state: ${err.message}`);
    process.exit(1);
  }

  const { sales = [], production = [], expenses = [] } = state;
  const stock = state.analytics?.stock || {};
  const productAnalytics = state.analytics?.products || {};
  const financials = state.analytics?.financial || { week: {}, month: {} };
  const monthRevenue = financials.month?.revenue || 0;

  let report = "";
  let sectionName = command;

  if (command === "pricing") {
    report = analyzePricing(sales, stock);
    sectionName = "PRICING";
  } else if (command === "volume") {
    report = analyzeVolume(sales, production);
    sectionName = "VOLUME";
  } else if (command === "products") {
    report = analyzeProducts(sales, productAnalytics);
    sectionName = "PRODUCTS";
  } else if (command === "costs") {
    report = analyzeCosts(expenses, monthRevenue);
    sectionName = "COSTS";
  } else if (command === "suppliers") {
    report = analyzeSuppliers(expenses);
    sectionName = "SUPPLIERS";
  } else {
    report = buildFullReport(state);
    sectionName = "FULL";
  }

  const elapsed = Date.now() - startMs;

  console.log("\n" + report + "\n");

  if (!DRY_RUN) {
    try {
      const result = await sendThrottled(report, {
        thread: TG_THREAD,
        priority: "normal",
        parseMode: "Markdown",
      });
      console.log(`[profit-maximizer] Telegram: ${result.action}`);
    } catch (err) {
      console.error(`[profit-maximizer] Ошибка отправки Telegram: ${err.message}`);
    }
  } else {
    console.log("[profit-maximizer] --dry-run: Telegram не отправлен");
  }

  // Langfuse tracing
  await trace({
    name: `profit-maximizer/${command}`,
    input: { command, dry_run: DRY_RUN, sales_rows: sales.length, expense_rows: expenses.length },
    output: {
      section: sectionName,
      report_length: report.length,
      month_revenue: monthRevenue,
    },
    duration_ms: elapsed,
    metadata: { skill: "pepino-google-sheets", script: "profit-maximizer" },
  });

  console.log(`[profit-maximizer] Готово за ${elapsed}ms`);
}

// -- CLI / module export ------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error(`[profit-maximizer] ОШИБКА: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  analyzePricing,
  analyzeVolume,
  analyzeProducts,
  analyzeCosts,
  analyzeSuppliers,
  buildFullReport,
};
