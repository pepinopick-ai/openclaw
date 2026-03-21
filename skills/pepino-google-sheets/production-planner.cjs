#!/usr/bin/env node
/**
 * Pepino Pick -- Недельный планировщик производства
 *
 * Анализирует продажи, производство и склад, строит план на следующую неделю:
 *   1. Средние продажи за 4 недели + паттерн по дням недели
 *   2. Остатки и days-of-stock
 *   3. Рекомендуемый объём производства
 *   4. Учёт циклов роста (грибы 21д, микрозелень 7-14д, овощи по типу)
 *   5. Проверка погоды (wttr.in) — корректировки при экстремальных условиях
 *
 * Результат:
 *   - Задачи записываются в "📋 Задачи"
 *   - Отчёт отправляется в Telegram thread 20
 *
 * Usage:
 *   node production-planner.cjs              -- полный запуск
 *   node production-planner.cjs --dry-run    -- без записи в Sheets и Telegram
 *
 * Cron: 0 17 * * 0 (воскресенье 17:00, перед еженедельным агро-планированием)
 */

"use strict";

const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_PRODUCTION = 20;

/** Период для расчёта средних продаж (дней) */
const SALES_WINDOW_DAYS = 28;

/** Целевой запас (дней продаж вперёд) */
const TARGET_STOCK_DAYS = 10;

/** Порог критичного запаса (дней) */
const CRITICAL_STOCK_DAYS = 7;

/** Буфер перепроизводства (множитель к прогнозу, 1.15 = +15%) */
const SAFETY_BUFFER = 1.15;

// -- Циклы роста культур ------------------------------------------------------

/**
 * Знания о циклах роста.
 * cycle_days — от посадки/инокуляции до сбора урожая.
 * plan_ahead_days — за сколько дней планировать (cycle_days + буфер).
 * category — тип культуры для группировки.
 *
 * @type {Record<string, {cycle_days: number, plan_ahead_days: number, category: string}>}
 */
const GROWING_CYCLES = {
  // Грибы
  Вешенка: { cycle_days: 21, plan_ahead_days: 25, category: "mushroom" },
  Шиитаке: { cycle_days: 28, plan_ahead_days: 32, category: "mushroom" },
  // Микрозелень
  Микрозелень: { cycle_days: 10, plan_ahead_days: 14, category: "microgreen" },
  "Руккола микро": { cycle_days: 7, plan_ahead_days: 10, category: "microgreen" },
  "Горчица микро": { cycle_days: 7, plan_ahead_days: 10, category: "microgreen" },
  "Подсолнух микро": { cycle_days: 12, plan_ahead_days: 14, category: "microgreen" },
  // Овощи
  Огурец: { cycle_days: 60, plan_ahead_days: 65, category: "vegetable" },
  Томат: { cycle_days: 75, plan_ahead_days: 80, category: "vegetable" },
  Баклажан: { cycle_days: 70, plan_ahead_days: 75, category: "vegetable" },
  Кабачок: { cycle_days: 50, plan_ahead_days: 55, category: "vegetable" },
  "Острый перец": { cycle_days: 90, plan_ahead_days: 95, category: "vegetable" },
  // Зелень
  Укроп: { cycle_days: 30, plan_ahead_days: 35, category: "herb" },
  Базилик: { cycle_days: 25, plan_ahead_days: 30, category: "herb" },
  Мята: { cycle_days: 30, plan_ahead_days: 35, category: "herb" },
  Кинза: { cycle_days: 25, plan_ahead_days: 30, category: "herb" },
  Тархун: { cycle_days: 35, plan_ahead_days: 40, category: "herb" },
  Щавель: { cycle_days: 40, plan_ahead_days: 45, category: "herb" },
  Зелень: { cycle_days: 25, plan_ahead_days: 30, category: "herb" },
  Хрен: { cycle_days: 90, plan_ahead_days: 95, category: "vegetable" },
  // Корнеплоды
  Свекла: { cycle_days: 60, plan_ahead_days: 65, category: "vegetable" },
  Корнишон: { cycle_days: 55, plan_ahead_days: 60, category: "vegetable" },
  // Консервация (без цикла роста, производство = переработка)
  "Соленые огурцы": { cycle_days: 3, plan_ahead_days: 7, category: "processed" },
};

/** Цикл по умолчанию для неизвестных продуктов */
const DEFAULT_CYCLE = { cycle_days: 30, plan_ahead_days: 35, category: "unknown" };

// -- Хелперы ------------------------------------------------------------------

/** Безопасное извлечение числа */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Парсит дату из строки (DD/MM/YYYY, DD.MM.YYYY, YYYY-MM-DD).
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

/** Дата N дней назад */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Форматирует дату как YYYY-MM-DD */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Название дня недели на русском */
function dayOfWeekName(dayIndex) {
  return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][dayIndex] || "?";
}

/** Первая буква заглавная */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Преобразует массив строк из Sheets в массив объектов.
 * Первая строка — заголовки.
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
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

// -- Погода (wttr.in) ---------------------------------------------------------

/**
 * Запрашивает прогноз погоды через wttr.in.
 * Возвращает null при ошибке (не блокирует основной процесс).
 * @param {string} location — город или координаты
 * @returns {Promise<{temp_max: number, temp_min: number, humidity_max: number, description: string}|null>}
 */
function fetchWeather(location = "Cordoba,Argentina") {
  return new Promise((resolve) => {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          // Берём прогноз на завтра (первый день — сегодня, второй — завтра)
          const forecast = data.weather?.[1] || data.weather?.[0];
          if (!forecast) {
            resolve(null);
            return;
          }
          resolve({
            temp_max: parseFloat(forecast.maxtempC) || 0,
            temp_min: parseFloat(forecast.mintempC) || 0,
            humidity_max: Math.max(...forecast.hourly.map((h) => parseFloat(h.humidity) || 0)),
            description: forecast.hourly?.[4]?.weatherDesc?.[0]?.value || "",
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

// -- Аналитика продаж ---------------------------------------------------------

/**
 * Рассчитывает средние недельные продажи за последние N дней.
 * Также определяет паттерн продаж по дням недели.
 *
 * @param {Record<string, string>[]} salesRows
 * @param {number} windowDays
 * @returns {{
 *   weeklyAvg: Map<string, number>,
 *   dailyPattern: Map<string, number[]>,
 *   dailyAvg: Map<string, number>
 * }}
 */
function analyzeSales(salesRows, windowDays) {
  const cutoff = daysAgo(windowDays);
  const weeksInWindow = windowDays / 7;

  /** @type {Map<string, number>} продукт → суммарные продажи за период */
  const totalSold = new Map();

  /**
   * Паттерн по дням недели: продукт → [вс, пн, вт, ср, чт, пт, сб]
   * @type {Map<string, number[]>}
   */
  const dayPattern = new Map();

  for (const row of salesRows) {
    const saleDate = parseDate(row["Дата"]);
    if (!saleDate || saleDate < cutoff) continue;

    const product = normalize(row["Продукт"] || row["Товар"] || "").toLowerCase();
    const qty = parseNum(row["Кол-во кг"] || row["Количество"] || 0);

    if (!product || qty <= 0) continue;

    totalSold.set(product, (totalSold.get(product) || 0) + qty);

    if (!dayPattern.has(product)) {
      dayPattern.set(product, [0, 0, 0, 0, 0, 0, 0]);
    }
    const pattern = dayPattern.get(product);
    pattern[saleDate.getDay()] += qty;
  }

  // Среднее за неделю
  /** @type {Map<string, number>} */
  const weeklyAvg = new Map();
  for (const [product, total] of totalSold) {
    weeklyAvg.set(product, total / weeksInWindow);
  }

  // Среднее за день
  /** @type {Map<string, number>} */
  const dailyAvg = new Map();
  for (const [product, total] of totalSold) {
    dailyAvg.set(product, total / windowDays);
  }

  return { weeklyAvg, dailyPattern: dayPattern, dailyAvg };
}

// -- Расчёт запасов -----------------------------------------------------------

/**
 * Парсит данные склада.
 * @param {Record<string, string>[]} inventoryRows
 * @returns {Map<string, number>} продукт → остаток (кг)
 */
function parseInventory(inventoryRows) {
  /** @type {Map<string, number>} */
  const stock = new Map();

  for (const row of inventoryRows) {
    const rawProduct = (row["Продукт"] || row["Товар"] || row["Название"] || "").trim();
    const qty = parseNum(
      row["Остаток кг"] || row["Кол-во кг"] || row["Количество"] || row["Остаток"] || 0,
    );

    if (!rawProduct) continue;

    const key = normalize(rawProduct).toLowerCase();
    stock.set(key, (stock.get(key) || 0) + qty);
  }

  return stock;
}

// -- Построение плана ---------------------------------------------------------

/**
 * @typedef {Object} ProductionPlan
 * @property {string} product — название продукта
 * @property {number} weeklyAvgSales — средние недельные продажи (кг)
 * @property {number} dailyAvgSales — средние дневные продажи (кг)
 * @property {number} currentStock — текущий остаток (кг)
 * @property {number|null} daysOfStock — дней запаса
 * @property {number} recommendedProduction — рекомендуемый объём производства (кг)
 * @property {string} priority — "critical" | "high" | "normal" | "low"
 * @property {string} action — что делать: "plant", "harvest", "process", "monitor"
 * @property {number} cycleDays — цикл роста (дней)
 * @property {string} category — категория продукта
 * @property {number[]} dayPattern — паттерн продаж по дням недели
 * @property {string[]} warnings — предупреждения (погода, и т.д.)
 */

/**
 * Строит план производства на следующую неделю.
 *
 * @param {Map<string, number>} weeklyAvg — средние недельные продажи
 * @param {Map<string, number>} dailyAvg — средние дневные продажи
 * @param {Map<string, number[]>} dailyPattern — паттерн по дням недели
 * @param {Map<string, number>} stock — текущие остатки
 * @param {{temp_max: number, temp_min: number, humidity_max: number, description: string}|null} weather
 * @returns {ProductionPlan[]}
 */
function buildPlan(weeklyAvg, dailyAvg, dailyPattern, stock, weather) {
  // Объединяем все известные продукты
  const allProducts = new Set([...weeklyAvg.keys(), ...stock.keys()]);

  /** @type {ProductionPlan[]} */
  const plans = [];

  for (const product of allProducts) {
    const weekly = weeklyAvg.get(product) || 0;
    const daily = dailyAvg.get(product) || 0;
    const currentStock = stock.get(product) || 0;
    const pattern = dailyPattern.get(product) || [0, 0, 0, 0, 0, 0, 0];

    // Цикл роста
    const canonical = capitalize(product);
    const cycle = GROWING_CYCLES[canonical] || DEFAULT_CYCLE;

    // Days of stock
    let daysOfStock = null;
    if (daily > 0) {
      daysOfStock = currentStock / daily;
    }

    // Рекомендуемый объём: покрыть целевой запас минус текущий
    const targetStock = daily * TARGET_STOCK_DAYS;
    let recommended = Math.max(0, (targetStock - currentStock) * SAFETY_BUFFER);

    // Округляем до 0.5 кг
    recommended = Math.round(recommended * 2) / 2;

    // Приоритет
    let priority = "normal";
    if (daysOfStock !== null && daysOfStock < 3) {
      priority = "critical";
    } else if (daysOfStock !== null && daysOfStock < CRITICAL_STOCK_DAYS) {
      priority = "high";
    } else if (recommended <= 0) {
      priority = "low";
    }

    // Действие зависит от цикла и текущей ситуации
    let action = "monitor";
    if (cycle.category === "processed") {
      action = recommended > 0 ? "process" : "monitor";
    } else if (cycle.cycle_days <= 14) {
      // Микрозелень и быстрорастущие — можно посадить и успеть собрать
      action = recommended > 0 ? "plant" : "monitor";
    } else {
      // Длинный цикл — если уже растёт, ожидаем сбор; если нет, планируем посадку
      action = recommended > 0 ? "plant" : "monitor";
    }

    // Предупреждения по погоде
    /** @type {string[]} */
    const warnings = [];
    if (weather) {
      if (weather.temp_max > 35 && cycle.category !== "processed") {
        warnings.push(`Жара >35C — снизить интенсивность, усилить полив`);
        // Увеличиваем рекомендацию: при жаре урожайность падает
        recommended = Math.round(recommended * 1.1 * 2) / 2;
      }
      if (weather.temp_min < 5 && cycle.category !== "processed") {
        warnings.push(`Холод <5C — защита от заморозков`);
      }
      if (weather.humidity_max > 90 && cycle.category === "mushroom") {
        warnings.push(`Влажность >90% — риск плесени, усилить вентиляцию`);
      }
    }

    plans.push({
      product,
      weeklyAvgSales: weekly,
      dailyAvgSales: daily,
      currentStock,
      daysOfStock,
      recommendedProduction: recommended,
      priority,
      action,
      cycleDays: cycle.cycle_days,
      category: cycle.category,
      dayPattern: pattern,
      warnings,
    });
  }

  // Сортируем: critical > high > normal > low, внутри — по объёму рекомендации
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  plans.sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    return b.recommendedProduction - a.recommendedProduction;
  });

  return plans;
}

// -- Форматирование -----------------------------------------------------------

/**
 * Формирует HTML-отчёт для Telegram.
 * @param {ProductionPlan[]} plans
 * @param {{temp_max: number, temp_min: number, humidity_max: number, description: string}|null} weather
 * @returns {string}
 */
function formatTelegramReport(plans, weather) {
  const now = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Cordoba" });
  const nextMonday = new Date();
  nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));

  const lines = [];
  lines.push(`<b>Plan de Produccion -- semana ${fmtDate(nextMonday)}</b>`);
  lines.push(`${now}\n`);

  // Погода
  if (weather) {
    lines.push(`<b>Pogoda (pronostico):</b>`);
    lines.push(`  Temp: ${weather.temp_min}C...${weather.temp_max}C`);
    lines.push(`  Humedad max: ${weather.humidity_max}%`);
    if (weather.description) {
      lines.push(`  ${weather.description}`);
    }
    lines.push("");
  }

  // Критичные и приоритетные
  const urgent = plans.filter((p) => p.priority === "critical" || p.priority === "high");
  if (urgent.length > 0) {
    lines.push(`<b>!!! PRIORITET (zapas < ${CRITICAL_STOCK_DAYS} dney):</b>`);
    for (const p of urgent) {
      const icon = p.priority === "critical" ? "!!!" : "!";
      const dos = p.daysOfStock !== null ? `${p.daysOfStock.toFixed(1)}d` : "N/A";
      lines.push(
        `${icon} <b>${capitalize(p.product)}</b>: ` +
          `zapas ${p.currentStock.toFixed(1)}kg (${dos}) | ` +
          `proizvesti ${p.recommendedProduction.toFixed(1)}kg | ` +
          `accion: ${p.action}`,
      );
      for (const w of p.warnings) {
        lines.push(`    -> ${w}`);
      }
    }
    lines.push("");
  }

  // Основной план
  const active = plans.filter(
    (p) => p.recommendedProduction > 0 && p.priority !== "critical" && p.priority !== "high",
  );
  if (active.length > 0) {
    lines.push(`<b>Plan produccion:</b>`);
    for (const p of active) {
      const dos = p.daysOfStock !== null ? `${p.daysOfStock.toFixed(1)}d` : "-";
      lines.push(
        `  ${capitalize(p.product)}: ` +
          `${p.recommendedProduction.toFixed(1)}kg | ` +
          `venta avg ${p.weeklyAvgSales.toFixed(1)}kg/sem | ` +
          `stock ${p.currentStock.toFixed(1)}kg (${dos})`,
      );
    }
    lines.push("");
  }

  // Мониторинг (достаточно запаса)
  const monitoring = plans.filter((p) => p.recommendedProduction <= 0);
  if (monitoring.length > 0) {
    lines.push(`<b>OK (zapas suficiente):</b>`);
    for (const p of monitoring) {
      const dos = p.daysOfStock !== null ? `${p.daysOfStock.toFixed(1)}d` : "-";
      lines.push(`  ${capitalize(p.product)}: stock ${p.currentStock.toFixed(1)}kg (${dos})`);
    }
    lines.push("");
  }

  // Паттерн дней недели для топ продуктов
  const topByVolume = [...plans].sort((a, b) => b.weeklyAvgSales - a.weeklyAvgSales).slice(0, 5);
  if (topByVolume.length > 0 && topByVolume[0].weeklyAvgSales > 0) {
    lines.push(`<b>Patron semanal (top productos):</b>`);
    for (const p of topByVolume) {
      if (p.weeklyAvgSales <= 0) continue;
      const patternStr = p.dayPattern
        .map((v, i) => `${dayOfWeekName(i)}:${v.toFixed(1)}`)
        .join(" ");
      lines.push(`  ${capitalize(p.product)}: ${patternStr}`);
    }
    lines.push("");
  }

  // Предупреждения по погоде (общие)
  const allWarnings = plans.flatMap((p) => p.warnings);
  const uniqueWarnings = [...new Set(allWarnings)];
  if (uniqueWarnings.length > 0) {
    lines.push(`<b>Alertas clima:</b>`);
    for (const w of uniqueWarnings) {
      lines.push(`  -> ${w}`);
    }
  }

  // Итого
  const totalRecommended = plans.reduce((s, p) => s + p.recommendedProduction, 0);
  const criticalCount = plans.filter((p) => p.priority === "critical").length;
  const highCount = plans.filter((p) => p.priority === "high").length;
  lines.push(
    `\n<b>Total:</b> ${plans.length} productos, ` +
      `producir ${totalRecommended.toFixed(1)}kg | ` +
      `critico: ${criticalCount}, alto: ${highCount}`,
  );

  return lines.join("\n");
}

/**
 * Формирует строки задач для записи в "📋 Задачи".
 * Формат строки: [Дата, Задача, Приоритет, Категория, Объём кг, Статус]
 * @param {ProductionPlan[]} plans
 * @returns {string[][]}
 */
function buildTaskRows(plans) {
  const today = fmtDate(new Date());
  const nextMonday = new Date();
  nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
  const weekLabel = fmtDate(nextMonday);

  /** @type {string[][]} */
  const rows = [];

  for (const p of plans) {
    if (p.recommendedProduction <= 0) continue;

    const actionLabel =
      {
        plant: "Посадить/инокулировать",
        harvest: "Собрать урожай",
        process: "Переработать",
        monitor: "Мониторинг",
      }[p.action] || p.action;

    const priorityLabel =
      {
        critical: "КРИТИЧНО",
        high: "ВЫСОКИЙ",
        normal: "ОБЫЧНЫЙ",
        low: "НИЗКИЙ",
      }[p.priority] || p.priority;

    const warningNote = p.warnings.length > 0 ? ` | ${p.warnings.join("; ")}` : "";

    rows.push([
      today,
      `[${weekLabel}] ${actionLabel}: ${capitalize(p.product)} — ${p.recommendedProduction.toFixed(1)} кг` +
        ` (запас ${p.currentStock.toFixed(1)} кг, ` +
        `${p.daysOfStock !== null ? p.daysOfStock.toFixed(1) + "д" : "N/A"} дней)` +
        warningNote,
      priorityLabel,
      capitalize(p.category),
      String(p.recommendedProduction),
      "Новая",
    ]);
  }

  return rows;
}

// -- Главная функция ----------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Запуск production-planner...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Динамический импорт ESM-модуля sheets.js из CJS
  /** @type {{ readSheet: Function, appendToSheet: Function, PEPINO_SHEETS_ID: string }} */
  let readSheet, appendToSheet, PEPINO_SHEETS_ID;
  try {
    const sheetsModule = await import("./sheets.js");
    readSheet = sheetsModule.readSheet;
    appendToSheet = sheetsModule.appendToSheet;
    PEPINO_SHEETS_ID = sheetsModule.PEPINO_SHEETS_ID;
  } catch (err) {
    console.error(`[production-planner] Не удалось импортировать sheets.js: ${err.message}`);
    process.exit(1);
  }

  // Параллельное чтение трёх листов + запрос погоды
  let salesRaw, productionRaw, inventoryRaw;
  /** @type {{temp_max: number, temp_min: number, humidity_max: number, description: string}|null} */
  let weather = null;

  try {
    const [salesRes, productionRes, inventoryRes, weatherRes] = await Promise.all([
      readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F33F} Производство"),
      readSheet(PEPINO_SHEETS_ID, "\u{1F4E6} Склад"),
      fetchWeather().catch(() => null),
    ]);
    salesRaw = salesRes;
    productionRaw = productionRes;
    inventoryRaw = inventoryRes;
    weather = weatherRes;
  } catch (err) {
    const msg = `Не удалось прочитать Google Sheets: ${err.message}`;
    console.error(`[production-planner] ${msg}`);
    process.exit(1);
  }

  // Парсинг
  const salesRows = rowsToObjects(salesRaw);
  const productionRows = rowsToObjects(productionRaw);
  const inventoryRows = rowsToObjects(inventoryRaw);

  console.error(
    `[production-planner] Загружено: продажи=${salesRows.length}, ` +
      `производство=${productionRows.length}, склад=${inventoryRows.length}, ` +
      `погода=${weather ? "OK" : "нет"}`,
  );

  // Анализ
  const { weeklyAvg, dailyPattern, dailyAvg } = analyzeSales(salesRows, SALES_WINDOW_DAYS);
  const stock = parseInventory(inventoryRows);

  // Строим план
  const plans = buildPlan(weeklyAvg, dailyAvg, dailyPattern, stock, weather);

  // JSON-отчёт в stdout
  const result = {
    timestamp,
    dry_run: DRY_RUN,
    weather: weather || null,
    summary: {
      total_products: plans.length,
      critical: plans.filter((p) => p.priority === "critical").length,
      high: plans.filter((p) => p.priority === "high").length,
      normal: plans.filter((p) => p.priority === "normal").length,
      low: plans.filter((p) => p.priority === "low").length,
      total_recommended_kg:
        Math.round(plans.reduce((s, p) => s + p.recommendedProduction, 0) * 10) / 10,
    },
    plans: plans.map((p) => ({
      product: p.product,
      weekly_avg_sales_kg: Math.round(p.weeklyAvgSales * 10) / 10,
      daily_avg_sales_kg: Math.round(p.dailyAvgSales * 10) / 10,
      current_stock_kg: Math.round(p.currentStock * 10) / 10,
      days_of_stock: p.daysOfStock !== null ? Math.round(p.daysOfStock * 10) / 10 : null,
      recommended_production_kg: p.recommendedProduction,
      priority: p.priority,
      action: p.action,
      cycle_days: p.cycleDays,
      category: p.category,
      day_pattern: p.dayPattern,
      warnings: p.warnings,
    })),
    data_sources: {
      sales_rows: salesRows.length,
      production_rows: productionRows.length,
      inventory_rows: inventoryRows.length,
      sales_window_days: SALES_WINDOW_DAYS,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  // Запись задач в Sheets
  const taskRows = buildTaskRows(plans);

  if (!DRY_RUN && taskRows.length > 0) {
    try {
      await appendToSheet(PEPINO_SHEETS_ID, taskRows, "\u{1F4CB} Задачи");
      console.error(`[production-planner] Записано ${taskRows.length} задач в "Задачи"`);
    } catch (err) {
      console.error(`[production-planner] Ошибка записи в Sheets: ${err.message}`);
    }
  } else if (DRY_RUN && taskRows.length > 0) {
    console.error(`[production-planner] DRY RUN: пропуск записи ${taskRows.length} задач в Sheets`);
  }

  // Telegram
  const report = formatTelegramReport(plans, weather);

  if (!DRY_RUN) {
    try {
      await sendReport(report, TG_THREAD_PRODUCTION, "HTML");
      console.error("[production-planner] Отчёт отправлен в Telegram");
    } catch (err) {
      console.error(`[production-planner] Ошибка отправки в Telegram: ${err.message}`);
    }
  } else {
    console.error("[production-planner] DRY RUN: пропуск отправки Telegram");
    console.error(report);
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "production-planner",
    input: {
      sheets: ["Продажи", "Производство", "Склад"],
      sales_window_days: SALES_WINDOW_DAYS,
      weather_available: weather !== null,
      dry_run: DRY_RUN,
    },
    output: {
      products: plans.length,
      critical: plans.filter((p) => p.priority === "critical").length,
      high: plans.filter((p) => p.priority === "high").length,
      total_recommended_kg:
        Math.round(plans.reduce((s, p) => s + p.recommendedProduction, 0) * 10) / 10,
      tasks_written: DRY_RUN ? 0 : taskRows.length,
    },
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "production-planner",
    },
  }).catch(() => {});

  console.error(
    `[production-planner] Завершено за ${durationMs}мс. ` +
      `Продуктов: ${plans.length}, задач: ${taskRows.length}, ` +
      `критично: ${plans.filter((p) => p.priority === "critical").length}`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[production-planner] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
