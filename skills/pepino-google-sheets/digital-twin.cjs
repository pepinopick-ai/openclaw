#!/usr/bin/env node
/**
 * Pepino Pick -- Digital Twin v1
 *
 * Модель состояния фермы в реальном времени. Агрегирует ВСЕ источники данных
 * (Google Sheets, погода, курс валют) в единый снимок фермы.
 *
 * 7 секций: Production Zones, Inventory, Financial Snapshot, Client Health,
 * Weather Impact, Operational Load, 2-Week Forecast.
 *
 * Источники данных (Google Sheets через sheets.js):
 *   - "Производство" -- история посадок и урожая
 *   - "Продажи"      -- история продаж
 *   - "Склад"        -- текущие остатки
 *   - "Расходы"      -- расходы
 *   - "Задачи"       -- открытые задачи
 *   - "Алерты"       -- активные алерты
 *
 * Внешние источники:
 *   - wttr.in         -- погода Кордоба, Аргентина
 *   - exchange-rates   -- курс Blue (файл ~/.openclaw/.exchange-rates.json)
 *
 * Usage:
 *   node digital-twin.cjs                -- полный JSON в stdout
 *   node digital-twin.cjs --summary      -- компактная текстовая сводка
 *   node digital-twin.cjs --html         -- HTML-дашборд → /tmp/pepino-twin.html
 *   node digital-twin.cjs --telegram     -- отправка сводки в Telegram thread 20
 *   node digital-twin.cjs --dry-run      -- без отправки в Telegram
 *
 * Cron: 15 7 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/digital-twin.cjs >> /home/roman/logs/digital-twin.log 2>&1
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { trace } = require("./langfuse-trace.cjs");
const { send } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

// Throttled sender с fallback
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// -- Флаги CLI ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const MODE_SUMMARY = process.argv.includes("--summary");
const MODE_HTML = process.argv.includes("--html");
const MODE_TELEGRAM = process.argv.includes("--telegram");

const TG_THREAD_ID = 20; // Стратегия/Директор

// -- Константы агрономии ------------------------------------------------------

/** Циклы роста культур (дни от посадки до первого урожая) */
const GROWTH_CYCLES = {
  Огурец: 60,
  Корнишон: 55,
  Томат: 75,
  Баклажан: 70,
  Укроп: 30,
  Тархун: 35,
  Базилик: 35,
  Мята: 30,
  Кинза: 30,
  Щавель: 40,
  Хрен: 60,
  Зелень: 25,
  Кабачок: 50,
  Свекла: 65,
  "Острый перец": 70,
};

/** Оптимальный диапазон температуры для теплицы (Celsius) */
const TEMP_OPTIMAL_MIN = 18;
const TEMP_OPTIMAL_MAX = 32;
const TEMP_CRITICAL_MIN = 5;
const TEMP_CRITICAL_MAX = 40;

/** Оптимальная влажность (%) */
const HUMIDITY_OPTIMAL_MIN = 50;
const HUMIDITY_OPTIMAL_MAX = 80;

/** Пороги дней запаса */
const STOCK_GREEN_DAYS = 7;
const STOCK_YELLOW_DAYS = 3;

/** Пороги для клиентов */
const CLIENT_AT_RISK_DAYS = 14;
const CLIENT_CHURNED_DAYS = 30;

// -- Хелперы ------------------------------------------------------------------

/** Безопасный парсинг числа из строки Sheets */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number") return val;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Парсит дату из строки. Поддержка DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD.
 * @param {string} raw
 * @returns {Date|null}
 */
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/** Преобразует строки Sheets (первая строка = заголовки) в массив объектов */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i]?.[j] ?? "";
    }
    result.push(obj);
  }
  return result;
}

/** Дата N дней назад */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Дата N дней вперёд */
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Разница в днях между двумя датами */
function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

/** Форматирует дату как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Форматирует число с разделителями тысяч */
function fmtNum(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

// -- Загрузка внешних данных --------------------------------------------------

/**
 * Загружает погоду из wttr.in (JSON формат).
 * @returns {Promise<{temp_c: number, humidity: number, feels_like_c: number, description: string, wind_kmph: number}|null>}
 */
function fetchWeather() {
  return new Promise((resolve) => {
    const url = "https://wttr.in/Cordoba,Argentina?format=j1";
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const cur = data.current_condition?.[0];
          if (!cur) {
            resolve(null);
            return;
          }
          resolve({
            temp_c: parseFloat(cur.temp_C) || 0,
            feels_like_c: parseFloat(cur.FeelsLikeC) || 0,
            humidity: parseFloat(cur.humidity) || 0,
            wind_kmph: parseFloat(cur.windspeedKmph) || 0,
            description: (cur.lang_es?.[0]?.value || cur.weatherDesc?.[0]?.value || "").trim(),
            pressure_mb: parseFloat(cur.pressure) || 0,
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Загружает курс Blue из файла ~/.openclaw/.exchange-rates.json.
 * @returns {{blue_buy: number, blue_sell: number, updated_at: string}|null}
 */
function loadExchangeRate() {
  try {
    const filePath = path.join(process.env.HOME || "/root", ".openclaw", ".exchange-rates.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      blue_buy: data.blue_buy || 0,
      blue_sell: data.blue_sell || 0,
      official_buy: data.official_buy || 0,
      official_sell: data.official_sell || 0,
      updated_at: data.updated_at || "",
      source: data.source || "",
    };
  } catch {
    return null;
  }
}

// -- Секция 1: Production Zones -----------------------------------------------

/**
 * Определяет стадию роста и строит карту производственных зон.
 * @param {Record<string, string>[]} productionRows
 * @returns {Array<{product: string, zone: string, plantDate: string, daysSincePlanting: number, growthCycleDays: number, expectedHarvestDate: string, stage: string, progressPct: number}>}
 */
function buildProductionZones(productionRows) {
  const now = new Date();
  /** @type {Map<string, {product: string, zone: string, plantDate: Date, latestDate: Date}>} */
  const zones = new Map();

  for (const row of productionRows) {
    const product = normalize(row["Продукт"] || row["Культура"] || row["Товар"] || "");
    if (!product) continue;

    const zone = row["Зона"] || row["Блок"] || row["Теплица"] || "General";
    const dateStr = row["Дата посадки"] || row["Дата"] || row["Fecha"] || "";
    const date = parseDate(dateStr);
    if (!date) continue;

    const key = `${product}::${zone}`;
    const existing = zones.get(key);
    // Берём самую позднюю посадку как актуальную
    if (!existing || date > existing.latestDate) {
      zones.set(key, { product, zone, plantDate: date, latestDate: date });
    }
  }

  const result = [];
  for (const [, info] of zones) {
    const cycleDays = GROWTH_CYCLES[info.product] || 45;
    const daysSincePlanting = daysBetween(info.plantDate, now);
    const progressPct = Math.min(100, Math.round((daysSincePlanting / cycleDays) * 100));

    const expectedHarvest = new Date(info.plantDate);
    expectedHarvest.setDate(expectedHarvest.getDate() + cycleDays);

    // Определяем стадию
    let stage;
    if (daysSincePlanting < 0) {
      stage = "planned";
    } else if (daysSincePlanting < cycleDays * 0.15) {
      stage = "seeded";
    } else if (daysSincePlanting < cycleDays * 0.5) {
      stage = "growing";
    } else if (daysSincePlanting < cycleDays * 0.75) {
      stage = "flowering";
    } else if (daysSincePlanting < cycleDays * 1.3) {
      stage = "harvesting";
    } else {
      stage = "resting";
    }

    result.push({
      product: info.product,
      zone: info.zone,
      plantDate: fmtDate(info.plantDate),
      daysSincePlanting,
      growthCycleDays: cycleDays,
      expectedHarvestDate: fmtDate(expectedHarvest),
      stage,
      progressPct,
    });
  }

  // Сортируем по стадии (harvesting первым) затем по продукту
  const stageOrder = { harvesting: 0, flowering: 1, growing: 2, seeded: 3, planned: 4, resting: 5 };
  result.sort((a, b) => (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9));

  return result;
}

// -- Секция 2: Inventory State ------------------------------------------------

/**
 * Строит состояние запасов с traffic light.
 * @param {Record<string, string>[]} inventoryRows
 * @param {Record<string, string>[]} salesRows
 * @returns {Array<{product: string, stock_kg: number, avgDailySales: number, daysOfStock: number|null, reorderPoint: number, trafficLight: string}>}
 */
function buildInventoryState(inventoryRows, salesRows) {
  // Текущий остаток
  /** @type {Map<string, number>} */
  const stock = new Map();
  for (const row of inventoryRows) {
    const product = normalize((row["Продукт"] || row["Товар"] || row["Название"] || "").trim());
    const qty = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );
    if (!product) continue;
    stock.set(product, (stock.get(product) || 0) + qty);
  }

  // Средние дневные продажи за 7 дней
  const cutoff = daysAgo(7);
  /** @type {Map<string, number>} */
  const totalSold = new Map();
  for (const row of salesRows) {
    const d = parseDate(row["Дата"]);
    if (!d || d < cutoff) continue;
    const product = normalize(row["Продукт"] || row["Товар"] || "");
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);
    if (product && qty > 0) {
      totalSold.set(product, (totalSold.get(product) || 0) + qty);
    }
  }

  const allProducts = new Set([...stock.keys(), ...totalSold.keys()]);
  const result = [];

  for (const product of allProducts) {
    const currentStock = stock.get(product) || 0;
    const avgDaily = (totalSold.get(product) || 0) / 7;
    const daysOfStock = avgDaily > 0 ? currentStock / avgDaily : null;
    const reorderPoint = avgDaily * 3; // 3-дневный буфер

    let trafficLight;
    if (daysOfStock === null) {
      trafficLight = currentStock > 0 ? "green" : "gray";
    } else if (daysOfStock > STOCK_GREEN_DAYS) {
      trafficLight = "green";
    } else if (daysOfStock > STOCK_YELLOW_DAYS) {
      trafficLight = "yellow";
    } else {
      trafficLight = "red";
    }

    result.push({
      product,
      stock_kg: Math.round(currentStock * 10) / 10,
      avgDailySales: Math.round(avgDaily * 10) / 10,
      daysOfStock: daysOfStock !== null ? Math.round(daysOfStock * 10) / 10 : null,
      reorderPoint: Math.round(reorderPoint * 10) / 10,
      trafficLight,
    });
  }

  // Сортируем: красные первыми
  const lightOrder = { red: 0, yellow: 1, gray: 2, green: 3 };
  result.sort((a, b) => (lightOrder[a.trafficLight] ?? 9) - (lightOrder[b.trafficLight] ?? 9));

  return result;
}

// -- Секция 3: Financial Snapshot ---------------------------------------------

/**
 * Строит финансовый снимок: неделя, месяц, маржа, тренд.
 * @param {Record<string, string>[]} salesRows
 * @param {Record<string, string>[]} expenseRows
 * @param {object|null} exchangeRate
 * @returns {object}
 */
function buildFinancialSnapshot(salesRows, expenseRows, exchangeRate) {
  const now = new Date();
  const weekAgo = daysAgo(7);
  const week2Ago = daysAgo(14);
  const monthAgo = daysAgo(30);

  let revenueWeek = 0,
    revenueMonth = 0,
    revenuePrevWeek = 0;
  let expensesWeek = 0,
    expensesMonth = 0;

  for (const row of salesRows) {
    const d = parseDate(row["Дата"]);
    if (!d) continue;
    const total = parseNum(
      row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["Total"] || 0,
    );
    if (d >= weekAgo) revenueWeek += total;
    if (d >= week2Ago && d < weekAgo) revenuePrevWeek += total;
    if (d >= monthAgo) revenueMonth += total;
  }

  for (const row of expenseRows) {
    const d = parseDate(row["Дата"]);
    if (!d) continue;
    const total = parseNum(
      row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["Amount"] || 0,
    );
    if (d >= weekAgo) expensesWeek += total;
    if (d >= monthAgo) expensesMonth += total;
  }

  const marginWeek = revenueWeek > 0 ? Math.round((1 - expensesWeek / revenueWeek) * 100) : 0;
  const marginMonth = revenueMonth > 0 ? Math.round((1 - expensesMonth / revenueMonth) * 100) : 0;
  const weekTrend =
    revenuePrevWeek > 0 ? Math.round((revenueWeek / revenuePrevWeek - 1) * 100) : null;

  let cashFlowDirection;
  if (weekTrend === null) cashFlowDirection = "unknown";
  else if (weekTrend > 5) cashFlowDirection = "improving";
  else if (weekTrend < -5) cashFlowDirection = "declining";
  else cashFlowDirection = "stable";

  const expensesWarning = expensesWeek <= 0 && revenueWeek > 0;

  return {
    revenue_week: Math.round(revenueWeek),
    revenue_month: Math.round(revenueMonth),
    expenses_week: Math.round(expensesWeek),
    expenses_month: Math.round(expensesMonth),
    margin_week_pct: marginWeek,
    margin_month_pct: marginMonth,
    week_trend_pct: weekTrend,
    cash_flow_direction: cashFlowDirection,
    expenses_warning: expensesWarning,
    exchange_rate: exchangeRate
      ? {
          blue_buy: exchangeRate.blue_buy,
          blue_sell: exchangeRate.blue_sell,
          official_buy: exchangeRate.official_buy,
          official_sell: exchangeRate.official_sell,
          updated_at: exchangeRate.updated_at,
        }
      : null,
  };
}

// -- Секция 4: Client Health --------------------------------------------------

/**
 * Анализирует здоровье клиентской базы.
 * @param {Record<string, string>[]} salesRows
 * @returns {object}
 */
function buildClientHealth(salesRows) {
  const now = new Date();
  /** @type {Map<string, {name: string, orders: Array<{date: Date, total: number}>, totalRevenue: number}>} */
  const clients = new Map();

  for (const row of salesRows) {
    const client = (row["Клиент"] || row["клиент"] || "").trim();
    if (!client || client === "Тест" || client === "test") continue;
    const d = parseDate(row["Дата"]);
    if (!d) continue;
    const total = parseNum(
      row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["Total"] || 0,
    );

    if (!clients.has(client)) {
      clients.set(client, { name: client, orders: [], totalRevenue: 0 });
    }
    const c = clients.get(client);
    c.orders.push({ date: d, total });
    c.totalRevenue += total;
  }

  let active = 0,
    atRisk = 0,
    churned = 0;
  let totalRevenue = 0;
  const topClients = [];

  for (const [, c] of clients) {
    c.orders.sort((a, b) => a.date - b.date);
    const lastOrder = c.orders[c.orders.length - 1];
    const daysSince = daysBetween(lastOrder.date, now);
    totalRevenue += c.totalRevenue;

    if (daysSince > CLIENT_CHURNED_DAYS) {
      churned++;
    } else if (daysSince > CLIENT_AT_RISK_DAYS) {
      atRisk++;
    } else {
      active++;
    }

    topClients.push({ name: c.name, revenue: c.totalRevenue, daysSinceLast: daysSince });
  }

  // Сортируем по выручке для концентрации
  topClients.sort((a, b) => b.revenue - a.revenue);
  const top3Revenue = topClients.slice(0, 3).reduce((s, c) => s + c.revenue, 0);
  const concentrationPct = totalRevenue > 0 ? Math.round((top3Revenue / totalRevenue) * 100) : 0;

  // Ожидаемые заказы на этой неделе (на основе средней частоты активных клиентов)
  let expectedOrdersThisWeek = 0;
  for (const [, c] of clients) {
    if (c.orders.length < 2) continue;
    const lastOrder = c.orders[c.orders.length - 1];
    const daysSince = daysBetween(lastOrder.date, now);
    if (daysSince > CLIENT_CHURNED_DAYS) continue;

    // Средний интервал между заказами
    const gaps = [];
    for (let i = 1; i < c.orders.length; i++) {
      gaps.push(daysBetween(c.orders[i - 1].date, c.orders[i].date));
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap > 0 && daysSince >= avgGap * 0.8) {
      expectedOrdersThisWeek++;
    }
  }

  return {
    total_clients: clients.size,
    active,
    at_risk: atRisk,
    churned,
    expected_orders_this_week: expectedOrdersThisWeek,
    revenue_concentration: {
      top_3_pct: concentrationPct,
      top_3: topClients.slice(0, 3).map((c) => ({
        name: c.name,
        revenue: Math.round(c.revenue),
      })),
    },
  };
}

// -- Секция 5: Weather Impact -------------------------------------------------

/**
 * Анализирует влияние погоды на теплицу.
 * @param {object|null} weather
 * @returns {object}
 */
function buildWeatherImpact(weather) {
  if (!weather) {
    return {
      available: false,
      temp_c: null,
      humidity: null,
      alerts: ["Weather data unavailable"],
      growth_impact: "unknown",
    };
  }

  const alerts = [];
  let growthModifier = 1.0; // коэффициент влияния на скорость роста

  // Температурные алерты
  if (weather.temp_c >= TEMP_CRITICAL_MAX) {
    alerts.push(`CRITICAL: Temperature ${weather.temp_c}C exceeds ${TEMP_CRITICAL_MAX}C`);
    growthModifier *= 0.5;
  } else if (weather.temp_c >= TEMP_OPTIMAL_MAX) {
    alerts.push(`WARNING: Temperature ${weather.temp_c}C above optimal ${TEMP_OPTIMAL_MAX}C`);
    growthModifier *= 0.85;
  } else if (weather.temp_c <= TEMP_CRITICAL_MIN) {
    alerts.push(
      `CRITICAL: Temperature ${weather.temp_c}C below ${TEMP_CRITICAL_MIN}C — frost risk`,
    );
    growthModifier *= 0.3;
  } else if (weather.temp_c <= TEMP_OPTIMAL_MIN) {
    alerts.push(`WARNING: Temperature ${weather.temp_c}C below optimal ${TEMP_OPTIMAL_MIN}C`);
    growthModifier *= 0.8;
  }

  // Влажность
  if (weather.humidity > HUMIDITY_OPTIMAL_MAX) {
    alerts.push(`WARNING: Humidity ${weather.humidity}% — disease risk`);
    growthModifier *= 0.9;
  } else if (weather.humidity < HUMIDITY_OPTIMAL_MIN) {
    alerts.push(`WARNING: Humidity ${weather.humidity}% — low, increase irrigation`);
    growthModifier *= 0.95;
  }

  let growthImpact;
  if (growthModifier >= 0.95) growthImpact = "optimal";
  else if (growthModifier >= 0.8) growthImpact = "slightly_reduced";
  else if (growthModifier >= 0.6) growthImpact = "reduced";
  else growthImpact = "severely_reduced";

  return {
    available: true,
    temp_c: weather.temp_c,
    feels_like_c: weather.feels_like_c,
    humidity: weather.humidity,
    wind_kmph: weather.wind_kmph,
    description: weather.description,
    alerts,
    growth_impact: growthImpact,
    growth_modifier: Math.round(growthModifier * 100) / 100,
  };
}

// -- Секция 6: Operational Load -----------------------------------------------

/**
 * Анализирует операционную нагрузку.
 * @param {Record<string, string>[]} taskRows
 * @param {Record<string, string>[]} alertRows
 * @returns {object}
 */
function buildOperationalLoad(taskRows, alertRows) {
  const now = new Date();
  let openTasks = 0,
    overdueTasks = 0,
    highPriorityTasks = 0;

  for (const row of taskRows) {
    const status = (row["Статус"] || row["Status"] || "").toLowerCase().trim();
    if (status === "done" || status === "выполнено" || status === "закрыто" || status === "closed")
      continue;

    openTasks++;

    const priority = (row["Приоритет"] || row["Priority"] || "").toLowerCase();
    if (
      priority === "high" ||
      priority === "высокий" ||
      priority === "critical" ||
      priority === "критичный"
    ) {
      highPriorityTasks++;
    }

    const dueDate = parseDate(row["Дедлайн"] || row["Срок"] || row["Due"] || "");
    if (dueDate && dueDate < now) {
      overdueTasks++;
    }
  }

  let unresolvedAlerts = 0,
    criticalAlerts = 0;
  for (const row of alertRows) {
    const status = (row["Статус"] || row["Status"] || "").toLowerCase().trim();
    if (status === "resolved" || status === "решено" || status === "закрыто") continue;

    unresolvedAlerts++;
    const severity = parseNum(row["Severity"] || row["Критичность"] || row["Приоритет"] || 0);
    if (severity >= 4) criticalAlerts++;
  }

  let loadLevel;
  if (overdueTasks >= 3 || criticalAlerts >= 2) loadLevel = "overloaded";
  else if (overdueTasks >= 1 || openTasks >= 10) loadLevel = "busy";
  else if (openTasks >= 5) loadLevel = "normal";
  else loadLevel = "light";

  return {
    open_tasks: openTasks,
    overdue_tasks: overdueTasks,
    high_priority_tasks: highPriorityTasks,
    unresolved_alerts: unresolvedAlerts,
    critical_alerts: criticalAlerts,
    load_level: loadLevel,
  };
}

// -- Секция 7: 2-Week Forecast ------------------------------------------------

/**
 * Прогноз на 2 недели: урожай, выручка, расходы, маржа.
 * @param {Array} productionZones
 * @param {object} financial
 * @param {object} clientHealth
 * @param {object} weatherImpact
 * @returns {object}
 */
function build2WeekForecast(productionZones, financial, clientHealth, weatherImpact) {
  const forecastDays = 14;
  const now = new Date();

  // Ожидаемый урожай: зоны в стадии flowering/harvesting с ожидаемой датой в пределах 14 дней
  const expectedHarvests = [];
  for (const zone of productionZones) {
    const harvestDate = new Date(zone.expectedHarvestDate);
    const daysToHarvest = daysBetween(now, harvestDate);
    if (daysToHarvest >= -7 && daysToHarvest <= forecastDays) {
      expectedHarvests.push({
        product: zone.product,
        zone: zone.zone,
        expectedDate: zone.expectedHarvestDate,
        daysToHarvest: Math.max(0, daysToHarvest),
        stage: zone.stage,
      });
    }
  }

  // Прогноз выручки: avg daily revenue * 14 * weather modifier
  const avgDailyRevenue = financial.revenue_week / 7;
  const growthMod = weatherImpact.growth_modifier || 1.0;
  const expectedRevenue = Math.round(avgDailyRevenue * forecastDays * growthMod);

  // Прогноз расходов: avg daily * 14
  const avgDailyExpense =
    financial.expenses_month > 0 ? financial.expenses_month / 30 : financial.expenses_week / 7;
  const expectedExpenses = Math.round(avgDailyExpense * forecastDays);

  // Прогнозируемая маржа
  const forecastMargin =
    expectedRevenue > 0 ? Math.round((1 - expectedExpenses / expectedRevenue) * 100) : 0;

  // Прогноз заказов
  const expectedOrders = clientHealth.expected_orders_this_week * 2; // две недели

  return {
    period_days: forecastDays,
    expected_harvests: expectedHarvests,
    expected_revenue_ars: expectedRevenue,
    expected_expenses_ars: expectedExpenses,
    predicted_margin_pct: forecastMargin,
    expected_orders: expectedOrders,
    confidence: financial.expenses_warning ? "low" : "medium",
    assumptions: [
      "Revenue based on 7-day average",
      "Expenses based on 30-day average",
      `Weather growth modifier: ${growthMod}`,
    ],
  };
}

// -- Форматирование: Summary --------------------------------------------------

/**
 * Компактная текстовая сводка для stdout или Telegram.
 * @param {object} state
 * @returns {string}
 */
function formatSummary(state) {
  const lines = [];
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });
  lines.push(`PEPINO PICK DIGITAL TWIN`);
  lines.push(`${ts}\n`);

  // Production
  lines.push(`--- PRODUCTION ---`);
  const stageCount = {};
  for (const z of state.production_zones) {
    stageCount[z.stage] = (stageCount[z.stage] || 0) + 1;
  }
  const stageStr = Object.entries(stageCount)
    .map(([s, c]) => `${s}: ${c}`)
    .join(", ");
  lines.push(`Zones: ${state.production_zones.length} (${stageStr})`);

  // Inventory
  lines.push(`\n--- INVENTORY ---`);
  const invCount = { red: 0, yellow: 0, green: 0, gray: 0 };
  for (const i of state.inventory) {
    invCount[i.trafficLight] = (invCount[i.trafficLight] || 0) + 1;
  }
  lines.push(
    `Products: ${state.inventory.length} | RED:${invCount.red} YEL:${invCount.yellow} GRN:${invCount.green}`,
  );
  const redItems = state.inventory.filter((i) => i.trafficLight === "red");
  for (const r of redItems) {
    lines.push(`  !!! ${r.product}: ${r.stock_kg}kg (${r.daysOfStock ?? 0}d left)`);
  }

  // Financial
  lines.push(`\n--- FINANCIAL ---`);
  const f = state.financial;
  lines.push(
    `Week: ${fmtNum(f.revenue_week)} ARS rev / ${fmtNum(f.expenses_week)} ARS exp | Margin ${f.margin_week_pct}%`,
  );
  lines.push(
    `Month: ${fmtNum(f.revenue_month)} ARS rev / ${fmtNum(f.expenses_month)} ARS exp | Margin ${f.margin_month_pct}%`,
  );
  lines.push(
    `Trend: ${f.cash_flow_direction}${f.week_trend_pct !== null ? ` (${f.week_trend_pct > 0 ? "+" : ""}${f.week_trend_pct}%)` : ""}`,
  );
  if (f.expenses_warning) lines.push(`  WARNING: Expenses not entered — margin may be inflated`);
  if (f.exchange_rate) {
    lines.push(`Blue: ${f.exchange_rate.blue_buy}/${f.exchange_rate.blue_sell}`);
  }

  // Client Health
  lines.push(`\n--- CLIENTS ---`);
  const c = state.client_health;
  lines.push(
    `Active:${c.active} AtRisk:${c.at_risk} Churned:${c.churned} | Total:${c.total_clients}`,
  );
  lines.push(`Top3 concentration: ${c.revenue_concentration.top_3_pct}%`);
  lines.push(`Expected orders this week: ${c.expected_orders_this_week}`);

  // Weather
  lines.push(`\n--- WEATHER ---`);
  const w = state.weather;
  if (w.available) {
    lines.push(
      `${w.temp_c}C (feels ${w.feels_like_c}C) | Humidity ${w.humidity}% | ${w.description}`,
    );
    lines.push(`Growth impact: ${w.growth_impact} (${w.growth_modifier}x)`);
    for (const a of w.alerts) lines.push(`  ${a}`);
  } else {
    lines.push(`Weather data unavailable`);
  }

  // Operations
  lines.push(`\n--- OPERATIONS ---`);
  const o = state.operations;
  lines.push(
    `Tasks: ${o.open_tasks} open, ${o.overdue_tasks} overdue, ${o.high_priority_tasks} high-priority`,
  );
  lines.push(`Alerts: ${o.unresolved_alerts} unresolved (${o.critical_alerts} critical)`);
  lines.push(`Load: ${o.load_level}`);

  // Forecast
  lines.push(`\n--- 2-WEEK FORECAST ---`);
  const fc = state.forecast;
  lines.push(
    `Revenue: ~${fmtNum(fc.expected_revenue_ars)} ARS | Expenses: ~${fmtNum(fc.expected_expenses_ars)} ARS`,
  );
  lines.push(`Margin: ~${fc.predicted_margin_pct}% | Orders: ~${fc.expected_orders}`);
  lines.push(`Harvests expected: ${fc.expected_harvests.length}`);
  for (const h of fc.expected_harvests.slice(0, 5)) {
    lines.push(`  ${h.product} (${h.zone}) — ${h.daysToHarvest}d [${h.stage}]`);
  }
  lines.push(`Confidence: ${fc.confidence}`);

  return lines.join("\n");
}

// -- Форматирование: Telegram -------------------------------------------------

/**
 * HTML-сводка для Telegram.
 * @param {object} state
 * @returns {string}
 */
function formatTelegram(state) {
  const lines = [];
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });
  lines.push(`<b>Digital Twin Pepino Pick</b>`);
  lines.push(`${ts}\n`);

  // Inventory highlights
  const redItems = state.inventory.filter((i) => i.trafficLight === "red");
  const yellowItems = state.inventory.filter((i) => i.trafficLight === "yellow");
  if (redItems.length > 0) {
    lines.push(`<b>!!! Запасы (критично):</b>`);
    for (const r of redItems) {
      lines.push(`  ${r.product}: ${r.stock_kg}кг (${r.daysOfStock ?? 0} дн.)`);
    }
  }
  if (yellowItems.length > 0) {
    lines.push(`<b>! Запасы (внимание):</b>`);
    for (const y of yellowItems.slice(0, 3)) {
      lines.push(`  ${y.product}: ${y.stock_kg}кг (${y.daysOfStock ?? 0} дн.)`);
    }
  }

  // Financial
  const f = state.financial;
  lines.push(`\n<b>Финансы (неделя):</b>`);
  lines.push(`  Выручка: ${fmtNum(f.revenue_week)} ARS`);
  lines.push(`  Расходы: ${fmtNum(f.expenses_week)} ARS`);
  lines.push(`  Маржа: ${f.margin_week_pct}%`);
  if (f.expenses_warning) lines.push(`  Внимание: расходы не внесены`);
  const trendIcon =
    f.cash_flow_direction === "improving"
      ? "UP"
      : f.cash_flow_direction === "declining"
        ? "DOWN"
        : "==";
  lines.push(
    `  Тренд: ${trendIcon}${f.week_trend_pct !== null ? ` ${f.week_trend_pct > 0 ? "+" : ""}${f.week_trend_pct}%` : ""}`,
  );

  // Clients
  const ch = state.client_health;
  lines.push(`\n<b>Клиенты:</b> ${ch.active} актив. / ${ch.at_risk} риск / ${ch.churned} ушли`);

  // Weather
  const w = state.weather;
  if (w.available) {
    lines.push(`\n<b>Погода:</b> ${w.temp_c}C | Влажн. ${w.humidity}% | ${w.growth_impact}`);
    if (w.alerts.length > 0) {
      for (const a of w.alerts) lines.push(`  ${a}`);
    }
  }

  // Operations
  const o = state.operations;
  if (o.overdue_tasks > 0 || o.critical_alerts > 0) {
    lines.push(
      `\n<b>Операции:</b> ${o.overdue_tasks} просрочено, ${o.critical_alerts} крит. алертов`,
    );
  }

  // Forecast
  const fc = state.forecast;
  lines.push(
    `\n<b>Прогноз 14д:</b> ~${fmtNum(fc.expected_revenue_ars)} ARS, маржа ~${fc.predicted_margin_pct}%`,
  );

  return lines.join("\n");
}

// -- Форматирование: HTML Dashboard -------------------------------------------

/**
 * Генерирует HTML-дашборд с тёмной темой.
 * @param {object} state
 * @returns {string}
 */
function generateHtmlDashboard(state) {
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });
  const f = state.financial;
  const ch = state.client_health;
  const w = state.weather;
  const o = state.operations;
  const fc = state.forecast;

  // Traffic light для CSS
  const tlColor = { red: "#e74c3c", yellow: "#f39c12", green: "#2ecc71", gray: "#95a5a6" };

  // Карточка запасов
  const invRows = state.inventory
    .map((i) => {
      const color = tlColor[i.trafficLight] || "#95a5a6";
      const days = i.daysOfStock !== null ? `${i.daysOfStock}д` : "---";
      return `<tr><td style="color:${color};font-weight:bold">${i.product}</td><td>${i.stock_kg}кг</td><td>${days}</td><td>${i.avgDailySales}кг/д</td></tr>`;
    })
    .join("\n");

  // Карточка зон
  const zoneRows = state.production_zones
    .map((z) => {
      const stageColors = {
        harvesting: "#2ecc71",
        flowering: "#f39c12",
        growing: "#3498db",
        seeded: "#9b59b6",
        resting: "#95a5a6",
        planned: "#bdc3c7",
      };
      const color = stageColors[z.stage] || "#ecf0f1";
      return `<tr><td>${z.product}</td><td>${z.zone}</td><td style="color:${color}">${z.stage}</td><td>${z.progressPct}%</td><td>${z.expectedHarvestDate}</td></tr>`;
    })
    .join("\n");

  // Forecast harvests
  const harvestRows = fc.expected_harvests
    .map(
      (h) =>
        `<tr><td>${h.product}</td><td>${h.zone}</td><td>${h.daysToHarvest}д</td><td>${h.stage}</td></tr>`,
    )
    .join("\n");

  // Top clients
  const clientRows = ch.revenue_concentration.top_3
    .map((c) => `<tr><td>${c.name}</td><td>${fmtNum(c.revenue)} ARS</td></tr>`)
    .join("\n");

  // Weather alerts
  const weatherAlerts = w.available
    ? w.alerts.length > 0
      ? w.alerts.map((a) => `<div class="alert">${a}</div>`).join("")
      : `<div class="ok">No weather alerts</div>`
    : `<div class="alert">Weather data unavailable</div>`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pepino Pick Digital Twin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #ecf0f1; font-family: 'Segoe UI', system-ui, sans-serif; padding: 20px; }
  h1 { text-align: center; color: #2ecc71; margin-bottom: 5px; font-size: 1.8em; }
  .timestamp { text-align: center; color: #7f8c8d; margin-bottom: 20px; font-size: 0.9em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; max-width: 1400px; margin: 0 auto; }
  .card { background: #16213e; border-radius: 12px; padding: 18px; border: 1px solid #0f3460; }
  .card h2 { color: #e94560; font-size: 1.1em; margin-bottom: 12px; border-bottom: 1px solid #0f3460; padding-bottom: 8px; }
  .card.wide { grid-column: span 2; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; color: #7f8c8d; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid #0f3460; }
  td { padding: 4px 8px; border-bottom: 1px solid rgba(15,52,96,0.5); }
  .metric { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(15,52,96,0.3); }
  .metric .label { color: #7f8c8d; }
  .metric .value { font-weight: bold; }
  .metric .value.green { color: #2ecc71; }
  .metric .value.yellow { color: #f39c12; }
  .metric .value.red { color: #e74c3c; }
  .alert { background: rgba(231,76,60,0.15); border-left: 3px solid #e74c3c; padding: 6px 10px; margin: 4px 0; font-size: 0.85em; border-radius: 0 4px 4px 0; }
  .ok { background: rgba(46,204,113,0.1); border-left: 3px solid #2ecc71; padding: 6px 10px; font-size: 0.85em; border-radius: 0 4px 4px 0; }
  .tl { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .tl-red { background: #e74c3c; }
  .tl-yellow { background: #f39c12; }
  .tl-green { background: #2ecc71; }
  .tl-gray { background: #95a5a6; }
  .bar { background: #0f3460; border-radius: 4px; height: 8px; margin-top: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .confidence { text-align: right; color: #7f8c8d; font-size: 0.8em; margin-top: 8px; font-style: italic; }
  @media (max-width: 800px) { .card.wide { grid-column: span 1; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>Pepino Pick Digital Twin</h1>
<p class="timestamp">${ts}</p>
<div class="grid">

  <!-- 1. Production Zones -->
  <div class="card wide">
    <h2>Production Zones (${state.production_zones.length})</h2>
    <table>
      <tr><th>Product</th><th>Zone</th><th>Stage</th><th>Progress</th><th>Harvest</th></tr>
      ${zoneRows || '<tr><td colspan="5" style="color:#7f8c8d">No production data</td></tr>'}
    </table>
  </div>

  <!-- 2. Inventory -->
  <div class="card">
    <h2>Inventory (<span class="tl tl-red"></span>${state.inventory.filter((i) => i.trafficLight === "red").length} <span class="tl tl-yellow"></span>${state.inventory.filter((i) => i.trafficLight === "yellow").length} <span class="tl tl-green"></span>${state.inventory.filter((i) => i.trafficLight === "green").length})</h2>
    <table>
      <tr><th>Product</th><th>Stock</th><th>Days</th><th>Avg Sales</th></tr>
      ${invRows || '<tr><td colspan="4" style="color:#7f8c8d">No inventory data</td></tr>'}
    </table>
  </div>

  <!-- 3. Financial Snapshot -->
  <div class="card">
    <h2>Financial Snapshot</h2>
    <div class="metric"><span class="label">Revenue (week)</span><span class="value">${fmtNum(f.revenue_week)} ARS</span></div>
    <div class="metric"><span class="label">Expenses (week)</span><span class="value">${fmtNum(f.expenses_week)} ARS</span></div>
    <div class="metric"><span class="label">Margin (week)</span><span class="value ${f.margin_week_pct >= 50 ? "green" : f.margin_week_pct >= 35 ? "yellow" : "red"}">${f.margin_week_pct}%</span></div>
    <div class="metric"><span class="label">Revenue (month)</span><span class="value">${fmtNum(f.revenue_month)} ARS</span></div>
    <div class="metric"><span class="label">Margin (month)</span><span class="value ${f.margin_month_pct >= 50 ? "green" : f.margin_month_pct >= 35 ? "yellow" : "red"}">${f.margin_month_pct}%</span></div>
    <div class="metric"><span class="label">Trend (WoW)</span><span class="value ${f.cash_flow_direction === "improving" ? "green" : f.cash_flow_direction === "declining" ? "red" : "yellow"}">${f.week_trend_pct !== null ? (f.week_trend_pct > 0 ? "+" : "") + f.week_trend_pct + "%" : "---"} ${f.cash_flow_direction}</span></div>
    ${f.exchange_rate ? `<div class="metric"><span class="label">Blue Rate</span><span class="value">${f.exchange_rate.blue_buy} / ${f.exchange_rate.blue_sell}</span></div>` : ""}
    ${f.expenses_warning ? '<div class="alert">Expenses not entered — margin may be inflated</div>' : ""}
  </div>

  <!-- 4. Client Health -->
  <div class="card">
    <h2>Client Health (${ch.total_clients})</h2>
    <div class="metric"><span class="label">Active</span><span class="value green">${ch.active}</span></div>
    <div class="metric"><span class="label">At Risk</span><span class="value yellow">${ch.at_risk}</span></div>
    <div class="metric"><span class="label">Churned</span><span class="value red">${ch.churned}</span></div>
    <div class="metric"><span class="label">Expected orders this week</span><span class="value">${ch.expected_orders_this_week}</span></div>
    <div class="metric"><span class="label">Top 3 concentration</span><span class="value ${ch.revenue_concentration.top_3_pct > 70 ? "red" : ch.revenue_concentration.top_3_pct > 50 ? "yellow" : "green"}">${ch.revenue_concentration.top_3_pct}%</span></div>
    <table style="margin-top:8px">
      <tr><th>Top Clients</th><th>Revenue</th></tr>
      ${clientRows}
    </table>
  </div>

  <!-- 5. Weather Impact -->
  <div class="card">
    <h2>Weather Impact</h2>
    ${
      w.available
        ? `
    <div class="metric"><span class="label">Temperature</span><span class="value">${w.temp_c}C (feels ${w.feels_like_c}C)</span></div>
    <div class="metric"><span class="label">Humidity</span><span class="value ${w.humidity > 80 ? "yellow" : w.humidity < 50 ? "yellow" : "green"}">${w.humidity}%</span></div>
    <div class="metric"><span class="label">Wind</span><span class="value">${w.wind_kmph} km/h</span></div>
    <div class="metric"><span class="label">Conditions</span><span class="value">${w.description}</span></div>
    <div class="metric"><span class="label">Growth Impact</span><span class="value ${w.growth_impact === "optimal" ? "green" : w.growth_impact === "slightly_reduced" ? "yellow" : "red"}">${w.growth_impact} (${w.growth_modifier}x)</span></div>
    ${weatherAlerts}
    `
        : '<div class="alert">Weather data unavailable</div>'
    }
  </div>

  <!-- 6. Operational Load -->
  <div class="card">
    <h2>Operational Load</h2>
    <div class="metric"><span class="label">Open Tasks</span><span class="value">${o.open_tasks}</span></div>
    <div class="metric"><span class="label">Overdue</span><span class="value ${o.overdue_tasks > 0 ? "red" : "green"}">${o.overdue_tasks}</span></div>
    <div class="metric"><span class="label">High Priority</span><span class="value ${o.high_priority_tasks > 0 ? "yellow" : "green"}">${o.high_priority_tasks}</span></div>
    <div class="metric"><span class="label">Unresolved Alerts</span><span class="value ${o.unresolved_alerts > 0 ? "yellow" : "green"}">${o.unresolved_alerts}</span></div>
    <div class="metric"><span class="label">Critical Alerts</span><span class="value ${o.critical_alerts > 0 ? "red" : "green"}">${o.critical_alerts}</span></div>
    <div class="metric"><span class="label">Load Level</span><span class="value ${o.load_level === "overloaded" ? "red" : o.load_level === "busy" ? "yellow" : "green"}">${o.load_level.toUpperCase()}</span></div>
  </div>

  <!-- 7. 2-Week Forecast -->
  <div class="card wide">
    <h2>2-Week Forecast</h2>
    <div style="display:flex;gap:30px;flex-wrap:wrap">
      <div>
        <div class="metric"><span class="label">Expected Revenue</span><span class="value">~${fmtNum(fc.expected_revenue_ars)} ARS</span></div>
        <div class="metric"><span class="label">Expected Expenses</span><span class="value">~${fmtNum(fc.expected_expenses_ars)} ARS</span></div>
        <div class="metric"><span class="label">Predicted Margin</span><span class="value ${fc.predicted_margin_pct >= 50 ? "green" : fc.predicted_margin_pct >= 35 ? "yellow" : "red"}">~${fc.predicted_margin_pct}%</span></div>
        <div class="metric"><span class="label">Expected Orders</span><span class="value">~${fc.expected_orders}</span></div>
      </div>
      <div style="flex:1;min-width:200px">
        <h3 style="color:#7f8c8d;font-size:0.9em;margin-bottom:6px">Expected Harvests (${fc.expected_harvests.length})</h3>
        ${fc.expected_harvests.length > 0 ? `<table><tr><th>Product</th><th>Zone</th><th>In</th><th>Stage</th></tr>${harvestRows}</table>` : '<span style="color:#7f8c8d">No harvests expected in next 14 days</span>'}
      </div>
    </div>
    <p class="confidence">Confidence: ${fc.confidence}</p>
  </div>

</div>
</body>
</html>`;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Digital Twin starting...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // 1. Импорт sheets.js (ESM из CJS)
  let readSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[digital-twin] Failed to import sheets.js: ${err.message}`);
    process.exit(1);
  }

  // 2. Параллельное чтение всех листов + погоды + курса
  let productionRaw, salesRaw, inventoryRaw, expensesRaw, tasksRaw, alertsRaw;
  let weather;
  const exchangeRate = loadExchangeRate();

  try {
    [productionRaw, salesRaw, inventoryRaw, expensesRaw, tasksRaw, alertsRaw, weather] =
      await Promise.all([
        readSheet(
          PEPINO_SHEETS_ID,
          "\u{1F33F} \u041F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0441\u0442\u0432\u043E",
        ),
        readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} \u041F\u0440\u043E\u0434\u0430\u0436\u0438"),
        readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} \u0421\u043A\u043B\u0430\u0434"),
        readSheet(PEPINO_SHEETS_ID, "\u{1F4B0} \u0420\u0430\u0441\u0445\u043E\u0434\u044B"),
        readSheet(PEPINO_SHEETS_ID, "\u{1F4CB} \u0417\u0430\u0434\u0430\u0447\u0438"),
        readSheet(PEPINO_SHEETS_ID, "\u26A0\uFE0F \u0410\u043B\u0435\u0440\u0442\u044B"),
        fetchWeather(),
      ]);
  } catch (err) {
    console.error(`[digital-twin] Failed to read data sources: ${err.message}`);
    process.exit(1);
  }

  // 3. Парсинг в объекты
  const productionRows = rowsToObjects(productionRaw);
  const salesRows = rowsToObjects(salesRaw);
  const inventoryRows = rowsToObjects(inventoryRaw);
  const expenseRows = rowsToObjects(expensesRaw);
  const taskRows = rowsToObjects(tasksRaw);
  const alertRows = rowsToObjects(alertsRaw);

  console.error(
    `[digital-twin] Data loaded: production=${productionRows.length}, ` +
      `sales=${salesRows.length}, inventory=${inventoryRows.length}, ` +
      `expenses=${expenseRows.length}, tasks=${taskRows.length}, alerts=${alertRows.length}, ` +
      `weather=${weather ? "OK" : "FAIL"}, exchange=${exchangeRate ? "OK" : "FAIL"}`,
  );

  // 4. Построение модели
  const productionZones = buildProductionZones(productionRows);
  const inventory = buildInventoryState(inventoryRows, salesRows);
  const financial = buildFinancialSnapshot(salesRows, expenseRows, exchangeRate);
  const clientHealth = buildClientHealth(salesRows);
  const weatherImpact = buildWeatherImpact(weather);
  const operations = buildOperationalLoad(taskRows, alertRows);
  const forecast = build2WeekForecast(productionZones, financial, clientHealth, weatherImpact);

  const durationMs = Date.now() - startTime;

  // 5. Собираем полную модель
  const state = {
    timestamp,
    version: "1.0.0",
    duration_ms: durationMs,
    dry_run: DRY_RUN,
    production_zones: productionZones,
    inventory,
    financial,
    client_health: clientHealth,
    weather: weatherImpact,
    operations,
    forecast,
    data_sources: {
      production_rows: productionRows.length,
      sales_rows: salesRows.length,
      inventory_rows: inventoryRows.length,
      expense_rows: expenseRows.length,
      task_rows: taskRows.length,
      alert_rows: alertRows.length,
      weather_available: weather !== null,
      exchange_rate_available: exchangeRate !== null,
    },
  };

  // 6. Вывод в зависимости от режима

  if (MODE_HTML) {
    const html = generateHtmlDashboard(state);
    const htmlPath = "/tmp/pepino-twin.html";
    fs.writeFileSync(htmlPath, html, "utf8");
    console.error(`[digital-twin] HTML dashboard saved to ${htmlPath}`);
    // Также выводим JSON
    console.log(JSON.stringify(state, null, 2));
  } else if (MODE_SUMMARY) {
    console.log(formatSummary(state));
  } else if (MODE_TELEGRAM) {
    // Показываем сводку в stdout, отправляем в Telegram
    const summary = formatTelegram(state);
    console.log(summary.replace(/<[^>]+>/g, ""));

    if (!DRY_RUN) {
      try {
        if (sendThrottled) {
          await sendThrottled(summary, {
            thread: TG_THREAD_ID,
            silent: true,
            priority: "normal",
            parseMode: "HTML",
          });
        } else {
          await send(summary, {
            silent: true,
            threadId: TG_THREAD_ID,
            parseMode: "HTML",
          });
        }
        console.error("[digital-twin] Telegram message sent");
      } catch (err) {
        console.error(`[digital-twin] Telegram error: ${err.message}`);
      }
    } else {
      console.error("[digital-twin] DRY RUN: skipping Telegram send");
    }
  } else {
    // Полный JSON в stdout
    console.log(JSON.stringify(state, null, 2));
  }

  // 7. Langfuse trace
  await trace({
    name: "digital-twin",
    input: {
      sheets: ["Производство", "Продажи", "Склад", "Расходы", "Задачи", "Алерты"],
      mode: MODE_HTML ? "html" : MODE_SUMMARY ? "summary" : MODE_TELEGRAM ? "telegram" : "json",
      dry_run: DRY_RUN,
    },
    output: {
      production_zones: productionZones.length,
      inventory_items: inventory.length,
      revenue_week: financial.revenue_week,
      margin_week: financial.margin_week_pct,
      active_clients: clientHealth.active,
      weather_impact: weatherImpact.growth_impact,
      open_tasks: operations.open_tasks,
      forecast_revenue: forecast.expected_revenue_ars,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "digital-twin",
    },
  }).catch(() => {});

  console.error(
    `[digital-twin] Completed in ${durationMs}ms. ` +
      `Zones: ${productionZones.length}, Products: ${inventory.length}, ` +
      `Revenue/wk: ${fmtNum(financial.revenue_week)} ARS`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[digital-twin] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
