#!/usr/bin/env node
/**
 * sku-cockpit.cjs — Единый SKU Cockpit Pepino Pick
 *
 * Соединяет 6 бизнес-контуров в одно представление: спрос, цена,
 * производство, склад, финансы, оборачиваемость. Для каждого продукта
 * рассчитывается composite score (0-100) и принимается решение.
 *
 * Использование:
 *   node sku-cockpit.cjs weekly            -- еженедельный скоркард
 *   node sku-cockpit.cjs product "огурец"  -- глубокий анализ одного SKU
 *   node sku-cockpit.cjs decisions         -- только действия
 *   node sku-cockpit.cjs sheets            -- запись в Google Sheets
 *   node sku-cockpit.cjs --dry-run weekly
 *
 * Cron: 0 12 * * 1  (пн 12:00 UTC = 09:00 ART, после profit-maximizer)
 */

"use strict";

const { getState } = require("./farm-state.cjs");
const { parseNum, parseDate, fmtDate, fmtNum } = require("./helpers.cjs");
const { normalize } = require("./product-aliases.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Конфигурация -------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD = 20; // Director/Strategy topic

/** Анализируемый период (дни) */
const WINDOW_DAYS = 30;

/** Минимальное количество заказов для включения в скоркард */
const MIN_ORDERS = 2;

/**
 * Продолжительность производственного цикла (посадка → продажа, дни).
 * Используется для расчёта cash cycle.
 */
const CROP_CYCLES = {
  Огурец: 60,
  Томат: 75,
  Корнишон: 55,
  Баклажан: 70,
  "Сладкий перец": 80,
  "Острый перец": 80,
  Кабачок: 55,
  Укроп: 35,
  Тархун: 40,
  Базилик: 35,
  Петрушка: 35,
  Кинза: 30,
  Мята: 40,
  Щавель: 45,
  "Зеленый лук": 30,
  Микрозелень: 12,
  Шпинат: 40,
  Салат: 45,
  Пелюстка: 21,
  "Соленые огурцы": 7, // цикл засолки
  "Маринованные огурцы": 14,
  Свекла: 90,
  Картофель: 90,
  Морковь: 75,
  Чеснок: 210,
};

const DEFAULT_CROP_CYCLE = 60;

// -- Утилиты ------------------------------------------------------------------

/** Дата N дней назад (начало дня) */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/** Номер текущей недели года (ISO) */
function isoWeek(d) {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  );
}

/** Форматирование числа с пробелами как разделителями тысяч */
function fmt(n) {
  return fmtNum(Math.round(n));
}

/** Форматирование числа с одним знаком после запятой */
function fmt1(n) {
  return fmtNum(Math.round(n * 10) / 10);
}

/** Форматирование тренда со знаком и стрелкой */
function fmtTrend(pct) {
  if (pct > 5) return `↑${Math.round(pct)}%`;
  if (pct < -5) return `↓${Math.abs(Math.round(pct))}%`;
  return `→0%`;
}

// -- Основная аналитика -------------------------------------------------------

/**
 * Строки продаж за конкретный период.
 * @param {Record<string,string>[]} rows
 * @param {Date} from
 * @param {Date} to
 * @returns {Record<string,string>[]}
 */
function salesInRange(rows, from, to) {
  return rows.filter((r) => {
    const d = parseDate(r["Дата"] || r["Fecha"] || "");
    return d && d >= from && d <= to;
  });
}

/**
 * Агрегирует продажи по продуктам с детализацией по строкам.
 * @param {Record<string,string>[]} rows
 * @returns {Map<string, {kg: number, ars: number, orders: Set<string>, clients: Set<string>, rows: Record<string,string>[]}>}
 */
function aggregateSalesByProduct(rows) {
  /** @type {Map<string, any>} */
  const map = new Map();

  for (const row of rows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Producto"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);

    const kg = parseNum(row["Кол-во кг"] || row["Cantidad kg"] || row["Кг"] || 0);
    const ars = parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
    const client = (row["Клиент"] || row["клиент"] || "").trim();
    // Используем дату+клиент+продукт как суррогатный ключ заказа
    const orderKey = `${row["Дата"] || ""}_${client}_${rawProduct}`;

    if (!map.has(product)) {
      map.set(product, {
        kg: 0,
        ars: 0,
        orders: new Set(),
        clients: new Set(),
        rows: [],
      });
    }
    const entry = map.get(product);
    entry.kg += kg;
    entry.ars += ars;
    if (orderKey) entry.orders.add(orderKey);
    if (client) entry.clients.add(client);
    entry.rows.push(row);
  }

  return map;
}

/**
 * Агрегирует производство по продуктам.
 * @param {Record<string,string>[]} rows
 * @param {Date} from
 * @param {Date} to
 * @returns {Map<string, number>}  продукт -> кг
 */
function aggregateProduction(rows, from, to) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of rows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Название"] || "").trim();
    if (!rawProduct) continue;
    const product = normalize(rawProduct);
    const d = parseDate(row["Дата"] || "");
    if (d && d >= from && d <= to) {
      const kg = parseNum(row["Кол-во кг"] || row["Кг"] || row["Количество"] || 0);
      map.set(product, (map.get(product) || 0) + kg);
    }
  }
  return map;
}

/**
 * Рассчитывает repeat rate: доля клиентов с 2+ заказами за период.
 * @param {Record<string,string>[]} rows - строки продаж за период
 * @param {string} product - нормализованное название продукта
 * @returns {number} 0-1
 */
function calcRepeatRate(rows, product) {
  /** @type {Map<string, number>} */
  const clientOrders = new Map();
  for (const row of rows) {
    const rawProduct = normalize((row["Продукт"] || row["Товар"] || "").trim());
    if (rawProduct !== product) continue;
    const client = (row["Клиент"] || row["клиент"] || "").trim();
    if (!client) continue;
    clientOrders.set(client, (clientOrders.get(client) || 0) + 1);
  }
  if (clientOrders.size === 0) return 0;
  const repeat = [...clientOrders.values()].filter((n) => n >= 2).length;
  return repeat / clientOrders.size;
}

/**
 * Рассчитывает продажи по дням недели (0=вс, 1=пн, ..., 6=сб).
 * @param {Record<string,string>[]} rows
 * @param {string} product
 * @returns {{bestDay: string, worstDay: string, byDow: number[]}}
 */
function calcDayOfWeek(rows, product) {
  const DOW_NAMES = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const totals = new Array(7).fill(0);
  const counts = new Array(7).fill(0);

  for (const row of rows) {
    const rawProduct = normalize((row["Продукт"] || row["Товар"] || "").trim());
    if (rawProduct !== product) continue;
    const d = parseDate(row["Дата"] || "");
    if (!d) continue;
    const dow = d.getDay();
    const kg = parseNum(row["Кол-во кг"] || row["Кг"] || 0);
    totals[dow] += kg;
    counts[dow]++;
  }

  const avgs = totals.map((t, i) => (counts[i] > 0 ? t / counts[i] : 0));
  let bestIdx = 0;
  let worstIdx = 0;
  for (let i = 1; i < 7; i++) {
    if (avgs[i] > avgs[bestIdx]) bestIdx = i;
    if (avgs[i] < avgs[worstIdx]) worstIdx = i;
  }

  return {
    bestDay: DOW_NAMES[bestIdx],
    worstDay: DOW_NAMES[worstIdx],
    byDow: avgs.map((v) => Math.round(v * 10) / 10),
  };
}

// -- SKU Scorecard ------------------------------------------------------------

/**
 * Строит scorecard по одному продукту.
 *
 * @param {object} params
 * @param {string} params.productName
 * @param {Record<string,string>[]} params.allSales      - все продажи
 * @param {Record<string,string>[]} params.allProduction - всё производство
 * @param {{ [product: string]: { kg: number, days: number, status: string } }} params.stock
 * @param {number} params.totalRevenue30d  - общая выручка за 30д (для revenue_share)
 * @param {number} params.totalExpenses30d - общие расходы за 30д
 * @param {number} params.totalKgProduced  - общий кг произведено за 30д (для аллокации расходов)
 * @returns {object}
 */
function buildSKUScorecard({
  productName,
  allSales,
  allProduction,
  stock,
  totalRevenue30d,
  totalExpenses30d,
  totalKgProduced,
}) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const period30Start = daysAgo(WINDOW_DAYS);
  const period30End = now;
  const period30Prev = daysAgo(WINDOW_DAYS * 2);

  const sales30 = salesInRange(allSales, period30Start, period30End);
  const salesPrev = salesInRange(allSales, period30Prev, period30Start);

  // Агрегация по продукту за текущий период
  const agg30 = aggregateSalesByProduct(sales30);
  const aggPrev = aggregateSalesByProduct(salesPrev);

  const cur = agg30.get(productName) || {
    kg: 0,
    ars: 0,
    orders: new Set(),
    clients: new Set(),
    rows: [],
  };
  const prev = aggPrev.get(productName) || {
    kg: 0,
    ars: 0,
    orders: new Set(),
    clients: new Set(),
    rows: [],
  };

  // СПРОС
  const volume_30d_kg = cur.kg;
  const orders_30d = cur.orders.size;
  const unique_clients = cur.clients.size;
  const repeat_rate = calcRepeatRate(sales30, productName);

  // Тренд спроса: % изменение объёма кг
  const demand_trend =
    prev.kg > 0 ? Math.round(((cur.kg - prev.kg) / prev.kg) * 1000) / 10 : cur.kg > 0 ? 100 : 0;

  // ЦЕНА
  const prices = cur.rows
    .map((r) => {
      const kg = parseNum(r["Кол-во кг"] || r["Кг"] || 0);
      const ars = parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0);
      return kg > 0 ? ars / kg : 0;
    })
    .filter((p) => p > 0);

  const avg_price_kg = cur.kg > 0 ? Math.round(cur.ars / cur.kg) : 0;
  const min_price = prices.length > 0 ? Math.round(Math.min(...prices)) : 0;
  const max_price = prices.length > 0 ? Math.round(Math.max(...prices)) : 0;

  const prevAvgPrice = prev.kg > 0 ? Math.round(prev.ars / prev.kg) : 0;
  const price_trend =
    prevAvgPrice > 0 ? Math.round(((avg_price_kg - prevAvgPrice) / prevAvgPrice) * 1000) / 10 : 0;

  // ПРОИЗВОДСТВО
  const prod30 = aggregateProduction(allProduction, period30Start, period30End);
  const produced_30d_kg = prod30.get(productName) || 0;

  // Потери: произведено - продано - текущий запас
  const currentStock = (stock[productName] || { kg: 0 }).kg;
  const waste_kg = Math.max(0, produced_30d_kg - volume_30d_kg - currentStock);
  const waste_pct = produced_30d_kg > 0 ? Math.round((waste_kg / produced_30d_kg) * 1000) / 10 : 0;

  // Yield rate: sold / produced (если есть производство)
  const yield_rate =
    produced_30d_kg > 0 ? Math.round((volume_30d_kg / produced_30d_kg) * 1000) / 10 : 0;

  // СКЛАД
  const current_stock_kg = currentStock;
  const stockInfo = stock[productName] || { kg: 0, days: 0, status: "ok" };
  const days_of_stock = stockInfo.days;
  const stock_status = stockInfo.status;

  // ФИНАНСЫ
  const revenue_30d = cur.ars;
  const revenue_share =
    totalRevenue30d > 0 ? Math.round((revenue_30d / totalRevenue30d) * 1000) / 10 : 0;

  // Аллокация расходов пропорционально выручке
  const cost_estimate =
    totalRevenue30d > 0 ? Math.round(totalExpenses30d * (revenue_30d / totalRevenue30d)) : 0;

  const margin_pct =
    revenue_30d > 0 ? Math.round(((revenue_30d - cost_estimate) / revenue_30d) * 1000) / 10 : 0;

  // ОБОРАЧИВАЕМОСТЬ
  const crop_cycle_days = CROP_CYCLES[productName] || DEFAULT_CROP_CYCLE;

  // Cash days: цикл выращивания + среднее время продажи запаса
  const avg_daily_sales = volume_30d_kg / WINDOW_DAYS;
  const selling_days =
    avg_daily_sales > 0 && produced_30d_kg > 0 ? Math.round(produced_30d_kg / avg_daily_sales) : 0;
  const cash_days = crop_cycle_days + selling_days;

  // Turnover rate: revenue / cost за цикл
  const turnover_rate =
    cost_estimate > 0 ? Math.round((revenue_30d / cost_estimate) * 100) / 100 : 0;

  // СКОРИНГ
  const skuData = {
    product: productName,
    volume_30d_kg: Math.round(volume_30d_kg * 10) / 10,
    orders_30d,
    unique_clients,
    repeat_rate: Math.round(repeat_rate * 1000) / 10,
    demand_trend,
    avg_price_kg,
    min_price,
    max_price,
    price_trend,
    produced_30d_kg: Math.round(produced_30d_kg * 10) / 10,
    yield_rate,
    waste_kg: Math.round(waste_kg * 10) / 10,
    waste_pct,
    current_stock_kg,
    days_of_stock,
    stock_status,
    revenue_30d,
    cost_estimate,
    margin_pct,
    revenue_share,
    cash_days,
    turnover_rate,
    score: 0,
    decision: "",
    decision_icon: "",
    decision_detail: "",
  };

  skuData.score = calculateScore(skuData);
  const dec = makeDecision(skuData);
  skuData.decision = dec.action;
  skuData.decision_icon = dec.icon;
  skuData.decision_detail = dec.detail;

  return skuData;
}

/**
 * Composite score 0-100.
 * @param {object} sku
 * @returns {number}
 */
function calculateScore(sku) {
  let score = 0;

  // Revenue contribution (0-25): 10% доля = 25 баллов
  score += Math.min(25, sku.revenue_share * 2.5);

  // Margin (0-25): 71%+ = 25 баллов
  score += Math.min(25, sku.margin_pct * 0.35);

  // Demand trend (0-20)
  if (sku.demand_trend > 20) score += 20;
  else if (sku.demand_trend > 0) score += 10 + sku.demand_trend * 0.5;
  else score += Math.max(0, 10 + sku.demand_trend * 0.5);

  // Repeat rate (0-15): 100% = 15 баллов
  score += (sku.repeat_rate / 100) * 15;

  // Waste efficiency (0-15): 0% потерь = 15 баллов
  score += Math.max(0, 15 - sku.waste_pct * 0.5);

  return Math.round(score);
}

/**
 * Решение по SKU на основе score и тренда.
 * @param {object} sku
 * @returns {{action: string, icon: string, detail: string}}
 */
function makeDecision(sku) {
  if (sku.score >= 75 && sku.demand_trend > 0)
    return {
      action: "SCALE",
      icon: "🚀",
      detail: "Увеличить производство, можно поднять цену",
    };

  if (sku.score >= 75 && sku.demand_trend <= 0)
    return {
      action: "HOLD+PRICE",
      icon: "💰",
      detail: "Стабильный спрос, тестировать +10-20% к цене",
    };

  if (sku.score >= 50 && sku.score < 75)
    return {
      action: "HOLD",
      icon: "⏸",
      detail: "Поддерживать текущий уровень",
    };

  if (sku.score >= 30 && sku.score < 50 && sku.orders_30d < 5)
    return {
      action: "TEST",
      icon: "🧪",
      detail: "Мало данных, тестировать 4 недели",
    };

  if (sku.score >= 30 && sku.score < 50)
    return {
      action: "CUT",
      icon: "✂️",
      detail: "Сократить объём, проверить маржу",
    };

  if (sku.score < 30)
    return {
      action: "KILL",
      icon: "🗑",
      detail: "Убрать из ассортимента, заменить на star",
    };

  return { action: "REVIEW", icon: "❓", detail: "Требует ручного анализа" };
}

// -- Команды ------------------------------------------------------------------

/**
 * Загружает и рассчитывает все SKU scorecards.
 * @returns {Promise<{scorecards: object[], totalRevenue30d: number, avgMargin: number}>}
 */
async function loadAllScorecards() {
  const state = await getState();
  const allSales = state.sales || [];
  const allProduction = state.production || [];
  const stock = state.analytics?.stock || {};

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const period30Start = daysAgo(WINDOW_DAYS);

  // Считаем общую выручку за 30д и общие расходы
  const sales30 = salesInRange(allSales, period30Start, now);
  const expenses30 = (state.expenses || []).filter((r) => {
    const d = parseDate(r["Дата"] || "");
    return d && d >= period30Start;
  });

  const totalRevenue30d = sales30.reduce(
    (sum, r) => sum + parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0),
    0,
  );
  const totalExpenses30d = expenses30.reduce(
    (sum, r) => sum + parseNum(r["Сумма"] || r["Сумма ARS"] || r["Monto"] || 0),
    0,
  );

  // Общий кг произведено за 30д (для аллокации)
  const prod30 = aggregateProduction(allProduction, period30Start, now);
  const totalKgProduced = [...prod30.values()].reduce((s, v) => s + v, 0);

  // Собираем уникальные продукты из продаж за 30д
  const agg30 = aggregateSalesByProduct(sales30);
  const products = [...agg30.keys()].filter((p) => (agg30.get(p)?.orders.size || 0) >= MIN_ORDERS);

  const scorecards = products.map((productName) =>
    buildSKUScorecard({
      productName,
      allSales,
      allProduction,
      stock,
      totalRevenue30d,
      totalExpenses30d,
      totalKgProduced,
    }),
  );

  // Сортируем по score убыванием
  scorecards.sort((a, b) => b.score - a.score);

  const avgMargin =
    scorecards.length > 0
      ? Math.round(scorecards.reduce((s, sc) => s + sc.margin_pct, 0) / scorecards.length)
      : 0;

  // Средний тренд спроса
  const avgTrend =
    scorecards.length > 0
      ? Math.round(scorecards.reduce((s, sc) => s + sc.demand_trend, 0) / scorecards.length)
      : 0;

  return { scorecards, totalRevenue30d, avgMargin, avgTrend };
}

/**
 * Команда weekly — еженедельный скоркард всех SKU.
 * @returns {Promise<string>} HTML-текст для Telegram
 */
async function cmdWeekly() {
  const startTime = Date.now();
  const { scorecards, totalRevenue30d, avgMargin, avgTrend } = await loadAllScorecards();

  const weekNum = isoWeek(new Date());

  // Группируем по решению
  /** @type {Record<string, object[]>} */
  const byDecision = {};
  for (const sc of scorecards) {
    if (!byDecision[sc.decision]) byDecision[sc.decision] = [];
    byDecision[sc.decision].push(sc);
  }

  const ORDER = ["SCALE", "HOLD+PRICE", "HOLD", "TEST", "CUT", "KILL", "REVIEW"];

  let msg = `<b>📊 SKU COCKPIT — неделя ${weekNum}</b>\n\n`;

  if (scorecards.length === 0) {
    msg += "Нет данных о продажах за последние 30 дней.\n";
  }

  for (const decision of ORDER) {
    const list = byDecision[decision];
    if (!list || list.length === 0) continue;

    // Заголовок группы
    const icon = list[0].decision_icon;
    msg += `<b>${icon} ${decision}:</b>\n`;

    for (const sc of list) {
      const priceStr = sc.avg_price_kg > 0 ? `${fmt(sc.avg_price_kg)}/кг` : "—";
      const volStr = sc.volume_30d_kg > 0 ? `${fmt1(sc.volume_30d_kg)}кг` : "—";
      const marginStr = sc.margin_pct > 0 ? `маржа ${Math.round(sc.margin_pct)}%` : "маржа ?";
      const trendStr = fmtTrend(sc.demand_trend);

      msg += `  <b>${sc.product}</b>  ${sc.score}pts  ${priceStr}  ${volStr}  ${marginStr}  ${trendStr}\n`;
      msg += `  → ${sc.decision_detail}\n`;
    }
    msg += "\n";
  }

  // Сводка
  const stars = scorecards.filter((sc) => sc.score >= 75);
  const starNames = stars.map((sc) => sc.product).join(", ") || "—";

  msg += `<b>📈 СВОДКА:</b>\n`;
  msg += `  SKU в ассортименте: ${scorecards.length}\n`;
  msg += `  Stars (&gt;75): ${stars.length} (${starNames})\n`;
  msg += `  Средняя маржа: ${avgMargin}%\n`;
  msg += `  Общий тренд спроса: ${fmtTrend(avgTrend)}\n`;
  msg += `  Выручка 30д: ${fmt(totalRevenue30d)} ARS\n`;

  if (DRY_RUN) {
    console.log("[dry-run] weekly:");
    console.log(msg.replace(/<[^>]+>/g, ""));
  }

  await trace({
    name: "sku-cockpit/weekly",
    input: { scorecards_count: scorecards.length, dry_run: DRY_RUN },
    output: { avg_margin: avgMargin, avg_trend: avgTrend, stars: stars.length },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "pepino-google-sheets", week: weekNum },
  });

  return msg;
}

/**
 * Команда product — детальный анализ одного SKU.
 * @param {string} rawName
 * @returns {Promise<string>}
 */
async function cmdProduct(rawName) {
  const startTime = Date.now();
  const productName = normalize(rawName);

  const state = await getState();
  const allSales = state.sales || [];
  const allProduction = state.production || [];
  const stock = state.analytics?.stock || {};

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const period30Start = daysAgo(WINDOW_DAYS);

  const sales30 = salesInRange(allSales, period30Start, now);
  const expenses30 = (state.expenses || []).filter((r) => {
    const d = parseDate(r["Дата"] || "");
    return d && d >= period30Start;
  });

  const totalRevenue30d = sales30.reduce(
    (sum, r) => sum + parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0),
    0,
  );
  const totalExpenses30d = expenses30.reduce(
    (sum, r) => sum + parseNum(r["Сумма"] || r["Сумма ARS"] || r["Monto"] || 0),
    0,
  );

  const prod30 = aggregateProduction(allProduction, period30Start, now);
  const totalKgProduced = [...prod30.values()].reduce((s, v) => s + v, 0);

  const sc = buildSKUScorecard({
    productName,
    allSales,
    allProduction,
    stock,
    totalRevenue30d,
    totalExpenses30d,
    totalKgProduced,
  });

  // Минимальная и максимальная цена с клиентами
  const sales30prod = salesInRange(allSales, period30Start, now).filter(
    (r) => normalize((r["Продукт"] || r["Товар"] || "").trim()) === productName,
  );

  let minRow = null;
  let maxRow = null;
  let minP = Infinity;
  let maxP = 0;
  for (const r of sales30prod) {
    const kg = parseNum(r["Кол-во кг"] || r["Кг"] || 0);
    const ars = parseNum(r["Итого ARS"] || r["Сумма ARS"] || r["Сумма"] || 0);
    if (kg <= 0) continue;
    const p = ars / kg;
    if (p < minP) {
      minP = p;
      minRow = r;
    }
    if (p > maxP) {
      maxP = p;
      maxRow = r;
    }
  }

  const minClientStr = minRow ? ` (${minRow["Клиент"] || minRow["клиент"] || "—"})` : "";
  const maxClientStr = maxRow ? ` (${maxRow["Клиент"] || maxRow["клиент"] || "—"})` : "";

  const dow = calcDayOfWeek(sales30, productName);

  const stockStatus =
    sc.stock_status === "critical"
      ? " (КРИТИЧНО)"
      : sc.stock_status === "warning"
        ? " (ВНИМАНИЕ)"
        : "";

  const cashDaysStr =
    sc.cash_days > 0
      ? `${sc.cash_days} дней (цикл ${CROP_CYCLES[productName] || DEFAULT_CROP_CYCLE}д + продажа ${sc.cash_days - (CROP_CYCLES[productName] || DEFAULT_CROP_CYCLE)}д)`
      : "—";

  let msg = `<b>🔍 DEEP DIVE: ${productName}</b>\n\n`;

  msg += `<b>СПРОС:</b>\n`;
  msg += `  Объём 30д: ${fmt1(sc.volume_30d_kg)} кг (${sc.orders_30d} заказов)\n`;
  msg += `  Клиенты: ${sc.unique_clients}\n`;
  msg += `  Повторные: ${Math.round(sc.repeat_rate)}%\n`;
  msg += `  Тренд: ${fmtTrend(sc.demand_trend)}\n`;
  msg += `  Лучший день: ${dow.bestDay}\n`;
  msg += `  Худший день: ${dow.worstDay}\n\n`;

  msg += `<b>ЦЕНА:</b>\n`;
  msg += `  Средняя: ${fmt(sc.avg_price_kg)} ARS/кг\n`;
  msg += `  Мин: ${sc.min_price > 0 ? fmt(sc.min_price) : "—"}${minClientStr}\n`;
  msg += `  Макс: ${sc.max_price > 0 ? fmt(sc.max_price) : "—"}${maxClientStr}\n`;
  msg += `  Тренд: ${fmtTrend(sc.price_trend)}\n\n`;

  msg += `<b>ПРОИЗВОДСТВО:</b>\n`;
  msg += `  Произведено: ${fmt1(sc.produced_30d_kg)} кг\n`;
  msg += `  Потери: ${fmt1(sc.waste_kg)} кг (${sc.waste_pct}%)\n`;
  msg += `  Запас: ${fmt1(sc.current_stock_kg)} кг${stockStatus}\n\n`;

  msg += `<b>ФИНАНСЫ:</b>\n`;
  msg += `  Выручка: ${fmt(sc.revenue_30d)} ARS\n`;
  msg += `  Доля: ${sc.revenue_share}% от общей выручки\n`;
  msg += `  Маржа: ~${Math.round(sc.margin_pct)}%\n`;
  msg += `  Cash cycle: ${cashDaysStr}\n\n`;

  msg += `<b>РЕШЕНИЕ: ${sc.decision_icon} ${sc.decision}</b>  (score ${sc.score}/100)\n`;

  // Конкретные шаги в зависимости от решения
  if (sc.decision === "SCALE") {
    msg += `  1. Увеличить посадку на 25% (следующий цикл)\n`;
    msg += `  2. Тестировать цену ${fmt(Math.round(sc.avg_price_kg * 1.15))} для новых клиентов\n`;
    msg += `  3. Следить за запасом, избегать дефицита\n`;
  } else if (sc.decision === "HOLD+PRICE") {
    msg += `  1. Поднять цену +10% для новых клиентов → ${fmt(Math.round(sc.avg_price_kg * 1.1))}/кг\n`;
    msg += `  2. Поддерживать объём производства\n`;
    msg += `  3. Мониторить реакцию через 2 недели\n`;
  } else if (sc.decision === "HOLD") {
    msg += `  1. Поддерживать текущий объём\n`;
    msg += `  2. Следить за трендом спроса\n`;
  } else if (sc.decision === "TEST") {
    msg += `  1. Тестировать с 3-5 клиентами, 4 недели\n`;
    msg += `  2. Целевой объём: не менее 20 кг/мес\n`;
  } else if (sc.decision === "CUT") {
    msg += `  1. Сократить объём производства на 30%\n`;
    msg += `  2. Проверить структуру расходов\n`;
    msg += `  3. Пересмотреть ценообразование\n`;
  } else if (sc.decision === "KILL") {
    msg += `  1. Остановить производство после распродажи запасов\n`;
    msg += `  2. Перенаправить ресурсы на star-продукты\n`;
  }

  if (DRY_RUN) {
    console.log("[dry-run] product:");
    console.log(msg.replace(/<[^>]+>/g, ""));
  }

  await trace({
    name: "sku-cockpit/product",
    input: { product: productName, dry_run: DRY_RUN },
    output: { score: sc.score, decision: sc.decision, margin: sc.margin_pct },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "pepino-google-sheets" },
  });

  return msg;
}

/**
 * Команда decisions — только действия по всем SKU.
 * @returns {Promise<string>}
 */
async function cmdDecisions() {
  const startTime = Date.now();
  const { scorecards } = await loadAllScorecards();

  let msg = `<b>🎯 РЕШЕНИЯ ПО SKU (только действия)</b>\n\n`;

  if (scorecards.length === 0) {
    msg += "Нет данных о продажах за последние 30 дней.\n";
  } else {
    for (const sc of scorecards) {
      msg += `${sc.decision_icon} <b>${sc.product}</b> → ${sc.decision_detail}\n`;
    }
  }

  if (DRY_RUN) {
    console.log("[dry-run] decisions:");
    console.log(msg.replace(/<[^>]+>/g, ""));
  }

  await trace({
    name: "sku-cockpit/decisions",
    input: { dry_run: DRY_RUN },
    output: { actions_count: scorecards.length },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "pepino-google-sheets" },
  });

  return msg;
}

/**
 * Команда sheets — записывает скоркард в Google Sheets.
 * @returns {Promise<void>}
 */
async function cmdSheets() {
  const startTime = Date.now();
  const { scorecards } = await loadAllScorecards();

  if (scorecards.length === 0) {
    console.log("[sku-cockpit] Нет данных для записи в Sheets.");
    return;
  }

  const today = fmtDate(new Date());
  const rows = scorecards.map((sc) => [
    today,
    sc.product,
    sc.score,
    `${sc.decision_icon} ${sc.decision}`,
    sc.avg_price_kg,
    sc.volume_30d_kg,
    sc.margin_pct,
    sc.demand_trend,
    sc.unique_clients,
    sc.repeat_rate,
    sc.waste_pct,
    sc.days_of_stock,
  ]);

  if (DRY_RUN) {
    console.log(`[dry-run] sheets: would write ${rows.length} rows to "📊 SKU Cockpit"`);
    console.log(
      "Columns: Дата, Продукт, Score, Решение, Цена/кг, Объём/мес, Маржа%, Тренд%, Клиенты, Повторные%, Потери%, Запас дн",
    );
    for (const r of rows) console.log(" ", r.join(" | "));
    return;
  }

  const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
  await appendToSheet(PEPINO_SHEETS_ID, rows, "📊 SKU Cockpit");

  console.log(`[sku-cockpit] Записано ${rows.length} строк в "📊 SKU Cockpit".`);

  await trace({
    name: "sku-cockpit/sheets",
    input: { rows_count: rows.length, dry_run: DRY_RUN },
    output: { written: rows.length },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "pepino-google-sheets" },
  });
}

// -- CLI ----------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const command = args[0] || "weekly";

  if (DRY_RUN) {
    console.log("[sku-cockpit] DRY-RUN режим — Telegram и Sheets не затронуты");
  }

  /** @type {Promise<void>} */
  let task;

  if (command === "weekly") {
    task = cmdWeekly().then(async (msg) => {
      if (!DRY_RUN) {
        const res = await sendThrottled(msg, {
          thread: TG_THREAD,
          parseMode: "HTML",
          priority: "normal",
        });
        console.log(`[sku-cockpit] Telegram: ${res.action}`);
      }
    });
  } else if (command === "product") {
    const productArg = args[1] || "";
    if (!productArg) {
      console.error("Использование: node sku-cockpit.cjs product <название>");
      process.exit(1);
    }
    task = cmdProduct(productArg).then(async (msg) => {
      if (!DRY_RUN) {
        const res = await sendThrottled(msg, {
          thread: TG_THREAD,
          parseMode: "HTML",
          priority: "normal",
        });
        console.log(`[sku-cockpit] Telegram: ${res.action}`);
      }
    });
  } else if (command === "decisions") {
    task = cmdDecisions().then(async (msg) => {
      if (!DRY_RUN) {
        const res = await sendThrottled(msg, {
          thread: TG_THREAD,
          parseMode: "HTML",
          priority: "normal",
        });
        console.log(`[sku-cockpit] Telegram: ${res.action}`);
      }
    });
  } else if (command === "sheets") {
    task = cmdSheets();
  } else {
    console.error(`Неизвестная команда: ${command}`);
    console.error("Команды: weekly | product <name> | decisions | sheets");
    process.exit(1);
  }

  task.catch((err) => {
    console.error("[sku-cockpit] ОШИБКА:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

// -- Экспорт ------------------------------------------------------------------

module.exports = {
  buildSKUScorecard,
  calculateScore,
  makeDecision,
  cmdWeekly,
  cmdProduct,
  cmdDecisions,
  cmdSheets,
  CROP_CYCLES,
};
