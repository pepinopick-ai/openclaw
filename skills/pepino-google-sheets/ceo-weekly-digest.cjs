#!/usr/bin/env node
/**
 * Pepino Pick -- CEO Weekly Digest
 *
 * Комплексная еженедельная сводка для CEO: финансы, клиенты, склад,
 * алерты, задачи, прогноз и рекомендация.
 *
 * Источники данных (Google Sheets через sheets.js):
 *   - "🛒 Продажи"     -- выручка за неделю vs предыдущая
 *   - "💰 Расходы"     -- расходы за неделю vs предыдущая
 *   - "🌿 Производство" -- объёмы производства
 *   - "📦 Склад"       -- текущие остатки
 *   - "⚠️ Алерты"      -- нерешённые алерты
 *   - "📋 Задачи"      -- открытые/просроченные задачи
 *
 * Cron: 0 20 * * 0 (воскресенье 20:00)
 * Usage: node ceo-weekly-digest.cjs [--dry-run]
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");
const { sendReport, TOPIC_RESULTS } = require("./telegram-helper.cjs");
const { normalize } = require("./product-aliases.cjs");

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_MESSAGE_LENGTH = 4000;

// -- Хелперы ------------------------------------------------------------------

/** Безопасное извлечение числа из строки (запятые, пробелы, валюта) */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/** ISO-дата (YYYY-MM-DD) */
function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

/** Дата N дней назад */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/** День недели (0=вс, 1=пн ... 6=сб) */
function dayOfWeek(dateString) {
  return new Date(dateString).getDay();
}

/** Стрелка тренда */
function trendArrow(current, previous) {
  if (previous === 0) return "→";
  const pct = ((current - previous) / previous) * 100;
  if (pct > 5) return "↑";
  if (pct < -5) return "↓";
  return "→";
}

/** Процент изменения с форматированием */
function pctChange(current, previous) {
  if (previous === 0) return current > 0 ? "+∞%" : "0%";
  const pct = Math.round(((current - previous) / previous) * 100);
  return (pct > 0 ? "+" : "") + pct + "%";
}

/** Форматирование числа с разделителем тысяч */
function fmt(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

/** Извлечение даты из строки Sheets (поддержка DD/MM/YYYY, YYYY-MM-DD) */
function extractDate(row) {
  const raw = row["Дата"] || row["дата"] || row["date"] || "";
  if (!raw) return "";
  const s = String(raw).trim();
  // DD/MM/YYYY или DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/** Извлечение суммы продажи */
function saleTotal(row) {
  return parseNum(
    row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["total_ars"] || row["Total"] || 0,
  );
}

/** Извлечение суммы расходов */
function expenseTotal(row) {
  return parseNum(
    row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || row["amount_ars"] || row["Amount"] || 0,
  );
}

/** Преобразование raw Sheets-строк (с заголовком) в массив объектов */
function toObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] || "";
    });
    return obj;
  });
}

// -- Анализ данных ------------------------------------------------------------

/**
 * Фильтрует записи за период [fromDate, toDate] по строковому сравнению YYYY-MM-DD.
 * @param {object[]} rows
 * @param {string} from - YYYY-MM-DD (включительно)
 * @param {string} to - YYYY-MM-DD (включительно)
 */
function filterByDateRange(rows, from, to) {
  return rows.filter((r) => {
    const d = extractDate(r);
    return d >= from && d <= to;
  });
}

/**
 * Раздел 1: Финансы недели
 * Выручка, расходы, маржа, тренды vs предыдущая неделя.
 */
function analyzeFinances(sales, expenses) {
  const today = dateStr(new Date());
  const weekStart = dateStr(daysAgo(7));
  const prevWeekStart = dateStr(daysAgo(14));

  const thisWeekSales = filterByDateRange(sales, weekStart, today);
  const prevWeekSales = filterByDateRange(sales, prevWeekStart, dateStr(daysAgo(8)));

  const thisWeekExpenses = filterByDateRange(expenses, weekStart, today);
  const prevWeekExpenses = filterByDateRange(expenses, prevWeekStart, dateStr(daysAgo(8)));

  const revenue = thisWeekSales.reduce((s, r) => s + saleTotal(r), 0);
  const prevRevenue = prevWeekSales.reduce((s, r) => s + saleTotal(r), 0);

  const expenseSum = thisWeekExpenses.reduce((s, r) => s + expenseTotal(r), 0);
  const prevExpenseSum = prevWeekExpenses.reduce((s, r) => s + expenseTotal(r), 0);

  const margin = revenue > 0 ? Math.round((1 - expenseSum / revenue) * 100) : 0;
  const prevMargin = prevRevenue > 0 ? Math.round((1 - prevExpenseSum / prevRevenue) * 100) : 0;

  return {
    revenue,
    prevRevenue,
    expenseSum,
    prevExpenseSum,
    margin,
    prevMargin,
    salesCount: thisWeekSales.length,
    expensesNoData: expenseSum <= 0 && revenue > 0,
  };
}

/**
 * Раздел 2: Топ-3 клиента недели по выручке.
 */
function topClients(sales) {
  const today = dateStr(new Date());
  const weekStart = dateStr(daysAgo(7));
  const thisWeek = filterByDateRange(sales, weekStart, today);

  const byClient = {};
  for (const r of thisWeek) {
    const client = r["Клиент"] || r["клиент"] || r["client"] || "Неизвестный";
    if (!client || client === "Тест") continue;
    byClient[client] = (byClient[client] || 0) + saleTotal(r);
  }

  return Object.entries(byClient)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, rev]) => ({ name, revenue: rev }));
}

/**
 * Раздел 3: Склад -- продукты с <5 дней запаса, общая оценка стоимости.
 * Потребление считается из продаж за 7 дней.
 */
function analyzeInventory(inventory, sales) {
  const today = dateStr(new Date());
  const weekStart = dateStr(daysAgo(7));
  const thisWeek = filterByDateRange(sales, weekStart, today);

  // Среднее дневное потребление по продукту
  const dailyConsumption = {};
  for (const r of thisWeek) {
    const product = normalize(r["Продукт"] || r["продукт"] || r["product"] || "");
    const qty = parseNum(r["Кол-во кг"] || r["Кол-во"] || r["qty_kg"] || r["Количество"] || 0);
    dailyConsumption[product] = (dailyConsumption[product] || 0) + qty;
  }
  // Делим на 7 дней
  for (const p of Object.keys(dailyConsumption)) {
    dailyConsumption[p] = dailyConsumption[p] / 7;
  }

  const critical = []; // <5 дней запаса
  let totalValue = 0;

  for (const row of inventory) {
    const product = normalize(
      row["Продукт"] || row["продукт"] || row["Товар"] || row["product"] || "",
    );
    if (!product) continue;

    const stock = parseNum(row["Остаток"] || row["Кол-во"] || row["остаток"] || row["stock"] || 0);
    const price = parseNum(row["Цена"] || row["цена"] || row["price"] || row["Цена за кг"] || 0);

    totalValue += stock * price;

    const daily = dailyConsumption[product] || 0;
    const daysOfStock = daily > 0 ? Math.round(stock / daily) : stock > 0 ? 999 : 0;

    if (daysOfStock < 5) {
      critical.push({
        product,
        stock: Math.round(stock),
        daysOfStock,
        daily: Math.round(daily * 10) / 10,
      });
    }
  }

  critical.sort((a, b) => a.daysOfStock - b.daysOfStock);

  return { critical, totalValue };
}

/**
 * Раздел 4: Алерты -- количество нерешённых, топ-3 по серьёзности.
 */
function analyzeAlerts(alerts) {
  const unresolved = alerts.filter((r) => {
    const status = (r["Статус"] || r["статус"] || r["status"] || "").toLowerCase();
    return (
      !status.includes("решен") &&
      !status.includes("закрыт") &&
      !status.includes("resolved") &&
      !status.includes("closed")
    );
  });

  // Сортировка по severity (higher = worse)
  const sorted = [...unresolved].sort((a, b) => {
    const sa = parseNum(a["Серьёзность"] || a["severity"] || a["Приоритет"] || 0);
    const sb = parseNum(b["Серьёзность"] || b["severity"] || b["Приоритет"] || 0);
    return sb - sa;
  });

  const top3 = sorted.slice(0, 3).map((r) => ({
    description: r["Описание"] || r["описание"] || r["description"] || "Без описания",
    severity: r["Серьёзность"] || r["severity"] || r["Приоритет"] || "?",
    zone: r["Зона"] || r["зона"] || r["zone"] || "",
  }));

  return { total: unresolved.length, top3 };
}

/**
 * Раздел 5: Задачи -- открытые, просроченные, завершённые на этой неделе.
 */
function analyzeTasks(tasks) {
  const today = dateStr(new Date());
  const weekStart = dateStr(daysAgo(7));

  let open = 0;
  let overdue = 0;
  let completedThisWeek = 0;

  for (const r of tasks) {
    const status = (r["Статус"] || r["статус"] || r["status"] || "").toLowerCase();
    const deadline = r["Дедлайн"] || r["дедлайн"] || r["deadline"] || r["Срок"] || "";
    const completedDate = r["Дата завершения"] || r["completed_date"] || "";

    const isOpen =
      !status.includes("готово") &&
      !status.includes("done") &&
      !status.includes("завершен") &&
      !status.includes("закрыт");

    if (isOpen) {
      open++;
      if (deadline && deadline < today) {
        overdue++;
      }
    }

    // Завершена на этой неделе
    if (!isOpen && completedDate >= weekStart && completedDate <= today) {
      completedThisWeek++;
    }
  }

  return { open, overdue, completedThisWeek };
}

/**
 * Раздел 6: Прогноз выручки на следующую неделю.
 * Метод: средняя выручка по дням недели за последние 4 недели.
 */
function forecastRevenue(sales) {
  const fourWeeksAgo = dateStr(daysAgo(28));
  const today = dateStr(new Date());
  const recentSales = filterByDateRange(sales, fourWeeksAgo, today);

  // Выручка по дню недели (0-6)
  const byDow = {};
  const countByDow = {};

  for (const r of recentSales) {
    const d = extractDate(r);
    if (!d) continue;
    const dow = dayOfWeek(d);
    byDow[dow] = (byDow[dow] || 0) + saleTotal(r);
    countByDow[dow] = (countByDow[dow] || 0) + 1;
  }

  // Прогноз = сумма средних по каждому дню недели
  let forecast = 0;
  for (let dow = 0; dow < 7; dow++) {
    const total = byDow[dow] || 0;
    const count = countByDow[dow] || 0;
    // Среднее за 4 недели (примерно 4 вхождения каждого дня)
    const weeksWithData = Math.max(1, Math.ceil(count / Math.max(1, count)));
    // Простая средняя: total / кол-во недель (примерно 4)
    const avgPerDay = count > 0 ? total / Math.ceil(count / 1) : 0;
    forecast += avgPerDay;
  }

  return Math.round(forecast);
}

/**
 * Раздел 7: Рекомендация недели -- одна действенная рекомендация.
 * Приоритет: маржа -> отток -> склад -> задачи.
 */
function generateRecommendation(finances, inventoryData, alertsData, tasksData, top3Clients) {
  // Маржа критически низкая
  if (finances.margin > 0 && finances.margin < 30) {
    return "Маржа ниже 30%. Пересмотрите цены или сократите крупнейшую статью расходов на этой неделе.";
  }

  // Расходы не внесены
  if (finances.expensesNoData) {
    return "Расходы не внесены за неделю. Маржа может быть завышена. Обновите лист расходов.";
  }

  // Критический дефицит на складе
  if (inventoryData.critical.length > 0) {
    const worst = inventoryData.critical[0];
    return `${worst.product} на складе осталось на ${worst.daysOfStock} дн. Закажите поставку или скорректируйте продажи.`;
  }

  // Много нерешённых алертов
  if (alertsData.total > 5) {
    return `Накопилось ${alertsData.total} нерешённых алертов. Выделите 30 мин на разбор топ-3 в понедельник.`;
  }

  // Просроченные задачи
  if (tasksData.overdue > 3) {
    return `${tasksData.overdue} просроченных задач. Проведите ревизию приоритетов в понедельник.`;
  }

  // Выручка падает
  if (finances.prevRevenue > 0 && finances.revenue < finances.prevRevenue * 0.85) {
    return "Выручка упала на >15%. Свяжитесь с крупными клиентами и предложите спецусловия.";
  }

  // Выручка растёт
  if (finances.prevRevenue > 0 && finances.revenue > finances.prevRevenue * 1.15) {
    return "Выручка выросла на >15%! Проверьте, хватит ли производственных мощностей на следующую неделю.";
  }

  // По умолчанию
  return "Бизнес стабилен. Сфокусируйтесь на одном улучшении процесса (производство или логистика).";
}

// -- Форматирование -----------------------------------------------------------

function formatDigest(
  finances,
  top3,
  inventoryData,
  alertsData,
  tasksData,
  forecast,
  recommendation,
) {
  const today = dateStr(new Date());
  const weekStart = dateStr(daysAgo(7));
  const lines = [];

  lines.push(`<b>CEO Weekly Digest</b>`);
  lines.push(`${weekStart} — ${today}\n`);

  // 1. Финансы
  const revArrow = trendArrow(finances.revenue, finances.prevRevenue);
  const expArrow = trendArrow(finances.expenseSum, finances.prevExpenseSum);
  const mrgArrow = trendArrow(finances.margin, finances.prevMargin);

  lines.push(`<b>1. Финансы недели</b>`);
  lines.push(
    `Выручка: ${fmt(finances.revenue)} ARS ${revArrow} ${pctChange(finances.revenue, finances.prevRevenue)}`,
  );
  lines.push(
    `Расходы: ${fmt(finances.expenseSum)} ARS ${expArrow} ${pctChange(finances.expenseSum, finances.prevExpenseSum)}`,
  );

  if (finances.expensesNoData) {
    lines.push(`Маржа: --% (расходы не внесены)`);
  } else {
    const mEmoji = finances.margin >= 50 ? "OK" : finances.margin >= 35 ? "NORM" : "LOW";
    lines.push(
      `Маржа: ${finances.margin}% ${mrgArrow} (пред: ${finances.prevMargin}%) [${mEmoji}]`,
    );
  }
  lines.push(`Продаж: ${finances.salesCount}\n`);

  // 2. Топ-3 клиента
  lines.push(`<b>2. Топ-3 клиента</b>`);
  if (top3.length === 0) {
    lines.push(`Нет продаж за неделю`);
  } else {
    for (let i = 0; i < top3.length; i++) {
      lines.push(`${i + 1}. ${top3[i].name} — ${fmt(top3[i].revenue)} ARS`);
    }
  }
  lines.push("");

  // 3. Склад
  lines.push(`<b>3. Склад</b>`);
  if (inventoryData.critical.length === 0) {
    lines.push(`Все позиции в норме (>5 дн. запаса)`);
  } else {
    for (const item of inventoryData.critical.slice(0, 5)) {
      const icon = item.daysOfStock <= 1 ? "!!" : item.daysOfStock <= 3 ? "!" : "";
      lines.push(`${icon} ${item.product}: ${item.stock} кг, ~${item.daysOfStock} дн.`);
    }
  }
  if (inventoryData.totalValue > 0) {
    lines.push(`Стоимость остатков: ~${fmt(inventoryData.totalValue)} ARS`);
  }
  lines.push("");

  // 4. Алерты
  lines.push(`<b>4. Алерты</b>`);
  if (alertsData.total === 0) {
    lines.push(`Нет нерешённых алертов`);
  } else {
    lines.push(`Нерешённых: ${alertsData.total}`);
    for (const a of alertsData.top3) {
      const zone = a.zone ? ` [${a.zone}]` : "";
      const desc = a.description.length > 60 ? a.description.slice(0, 57) + "..." : a.description;
      lines.push(`- (${a.severity}) ${desc}${zone}`);
    }
  }
  lines.push("");

  // 5. Задачи
  lines.push(`<b>5. Задачи</b>`);
  lines.push(`Открытых: ${tasksData.open}, просрочено: ${tasksData.overdue}`);
  if (tasksData.completedThisWeek > 0) {
    lines.push(`Завершено за неделю: ${tasksData.completedThisWeek}`);
  }
  lines.push("");

  // 6. Прогноз
  lines.push(`<b>6. Прогноз</b>`);
  if (forecast > 0) {
    lines.push(`Ожидаемая выручка след. неделя: ~${fmt(forecast)} ARS`);
  } else {
    lines.push(`Недостаточно данных для прогноза`);
  }
  lines.push("");

  // 7. Рекомендация
  lines.push(`<b>7. Рекомендация</b>`);
  lines.push(recommendation);

  let result = lines.join("\n");

  // Обрезаем до MAX_MESSAGE_LENGTH, если дайджест слишком длинный
  if (result.length > MAX_MESSAGE_LENGTH) {
    result = result.slice(0, MAX_MESSAGE_LENGTH - 20) + "\n\n[обрезано]";
  }

  return result;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] CEO Weekly Digest starting...`);

  // Throttled Telegram sender (dedup + rate limit + quiet hours)
  let sendThrottled;
  try { sendThrottled = require("./notification-throttle.cjs").sendThrottled; } catch { sendThrottled = null; }

  // farm-state cache (avoids direct Sheets API calls when fresh)
  let farmState = null;
  try { farmState = await require("./farm-state.cjs").getState(); } catch {}

  // Читаем все листы — из кеша или напрямую
  let sales, expenses, production, inventory, alerts, tasks;

  if (farmState) {
    sales = farmState.sales || [];
    expenses = farmState.expenses || [];
    production = farmState.production || [];
    inventory = farmState.inventory || [];
    alerts = farmState.alerts || [];
    tasks = farmState.tasks || [];
    console.log(`[cache] Данные из farm-state (возраст: ${Math.round((Date.now() - new Date(farmState.updatedAt || 0)) / 60000)}мин)`);
  } else {
    try {
      const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");

      const [salesRaw, expRaw, prodRaw, invRaw, alertsRaw, tasksRaw] = await Promise.all([
        readSheet(PEPINO_SHEETS_ID, "🛒 Продажи"),
        readSheet(PEPINO_SHEETS_ID, "💰 Расходы"),
        readSheet(PEPINO_SHEETS_ID, "🌿 Производство"),
        readSheet(PEPINO_SHEETS_ID, "📦 Склад"),
        readSheet(PEPINO_SHEETS_ID, "⚠️ Алерты"),
        readSheet(PEPINO_SHEETS_ID, "📋 Задачи"),
      ]);

      sales = toObjects(salesRaw);
      expenses = toObjects(expRaw);
      production = toObjects(prodRaw);
      inventory = toObjects(invRaw);
      alerts = toObjects(alertsRaw);
      tasks = toObjects(tasksRaw);
    } catch (err) {
      console.error(`[FATAL] Не удалось прочитать Google Sheets: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(
    `Данные: продажи=${sales.length}, расходы=${expenses.length}, производство=${production.length}, склад=${inventory.length}, алерты=${alerts.length}, задачи=${tasks.length}`,
  );

  // Анализ каждой секции
  const finances = analyzeFinances(sales, expenses);
  const top3 = topClients(sales);
  const inventoryData = analyzeInventory(inventory, sales);
  const alertsData = analyzeAlerts(alerts);
  const tasksData = analyzeTasks(tasks);
  const forecast = forecastRevenue(sales);
  const recommendation = generateRecommendation(
    finances,
    inventoryData,
    alertsData,
    tasksData,
    top3,
  );

  // Форматирование
  const digest = formatDigest(
    finances,
    top3,
    inventoryData,
    alertsData,
    tasksData,
    forecast,
    recommendation,
  );

  // Вывод в консоль (без HTML-тегов для читаемости)
  console.log("\n" + digest.replace(/<[^>]+>/g, "") + "\n");

  // Отправка в Telegram
  if (!DRY_RUN) {
    try {
      const sender = sendThrottled || sendReport;
      const result = await sender(digest, sendThrottled ? { thread: TOPIC_RESULTS, parseMode: "HTML", priority: "normal" } : TOPIC_RESULTS, sendThrottled ? undefined : "HTML");
      if (result && result.ok) {
        console.log("[OK] Digest sent to Telegram");
      } else if (result && result.error) {
        console.error(`[ERROR] Telegram: ${result.error}`);
      } else {
        console.log("[OK] Digest sent to Telegram");
      }
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Telegram не отправлен");
  }

  // Langfuse трейс
  await trace({
    name: "ceo-weekly-digest",
    input: {
      sales: sales.length,
      expenses: expenses.length,
      production: production.length,
      inventory: inventory.length,
      alerts: alerts.length,
      tasks: tasks.length,
    },
    output: {
      revenue: finances.revenue,
      prev_revenue: finances.prevRevenue,
      margin: finances.margin,
      unresolved_alerts: alertsData.total,
      open_tasks: tasksData.open,
      overdue_tasks: tasksData.overdue,
      forecast,
      critical_stock_items: inventoryData.critical.length,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "ceo-weekly-digest" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
