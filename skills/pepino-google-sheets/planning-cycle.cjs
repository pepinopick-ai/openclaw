#!/usr/bin/env node
/**
 * planning-cycle.cjs -- Структурированный цикл планирования и ревью Pepino Pick
 *
 * Самый важный автоматизированный процесс бизнеса:
 *   - Вечерний план на завтра (daily 20:00)
 *   - Недельный план (Sunday 19:00)
 *   - Месячный план (last day 19:00)
 *   - Ревью выполненных задач (daily 19:00)
 *
 * Источники данных:
 *   - farm-state.cjs (кеш Google Sheets: продажи, задачи, алерты, расходы, склад, производство)
 *   - client-analytics.cjs (RFM-анализ клиентов, статусы, тренды)
 *
 * Usage:
 *   node planning-cycle.cjs evening        # План на завтра (daily, 20:00)
 *   node planning-cycle.cjs weekly         # План на неделю (Sunday 19:00)
 *   node planning-cycle.cjs monthly        # План на следующий месяц (last day 19:00)
 *   node planning-cycle.cjs review         # Ревью задач за сегодня (daily 19:00)
 *   node planning-cycle.cjs --dry-run evening
 *
 * Cron:
 *   0 19 * * *   node planning-cycle.cjs review
 *   0 20 * * *   node planning-cycle.cjs evening
 *   0 19 * * 0   node planning-cycle.cjs weekly
 *   0 19 28-31 * * node planning-cycle.cjs monthly
 */

"use strict";

const { getState } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { parseNum, parseDate, fmtDate, fmtNum, daysBetween } = require("./helpers.cjs");

// -- Конфигурация ---------------------------------------------------------------

const TOPIC_DIRECTOR = 20;
const TOPIC_RESULTS = 112;
const TG_MAX_CHARS = 4000;

const DRY_RUN = process.argv.includes("--dry-run");

/** Дни недели по-русски */
const WEEKDAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

/** Колонки листа "Задачи" */
const TASK_COLS = {
  created: "Дата создания",
  task: "Задача",
  department: "Отдел",
  assignee: "Исполнитель",
  priority: "Приоритет",
  deadline: "Дедлайн",
  status: "Статус",
  quality: "Качество",
  notes: "Заметки",
};

// -- Утилиты --------------------------------------------------------------------

/**
 * Текущая дата/время в Аргентине (UTC-3).
 * @returns {Date}
 */
function nowART() {
  const now = new Date();
  // Смещаем на UTC-3: создаём Date, у которой getHours() = аргентинское время
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc - 3 * 3600000);
}

/**
 * Дата без времени (начало дня) в формате YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function dateKey(d) {
  return fmtDate(d);
}

/**
 * Начало текущего дня (00:00).
 * @returns {Date}
 */
function todayStart() {
  const d = nowART();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Сегодняшняя дата как строка YYYY-MM-DD.
 * @returns {string}
 */
function todayStr() {
  return dateKey(nowART());
}

/**
 * Дата завтра как строка YYYY-MM-DD.
 * @returns {string}
 */
function tomorrowStr() {
  const d = nowART();
  d.setDate(d.getDate() + 1);
  return dateKey(d);
}

/**
 * Стрелка тренда по сравнению двух чисел.
 * @param {number} current
 * @param {number} previous
 * @returns {string}
 */
function trendArrow(current, previous) {
  if (previous === 0) return current > 0 ? " ^" : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 5) return ` +${pct}%`;
  if (pct < -5) return ` ${pct}%`;
  return " =";
}

/**
 * Обрезает текст до максимальной длины, добавляя "..." если обрезан.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

/**
 * Является ли дата последним днём месяца (или рядом с ним: 28-31).
 * Для cron: запускаем 28-31, но выполняем только если это действительно последний день.
 * @returns {boolean}
 */
function isLastDayOfMonth() {
  const now = nowART();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.getDate() === 1;
}

// -- Извлечение данных из state -------------------------------------------------

/**
 * Получает продажи за указанный период.
 * @param {Record<string,string>[]} sales
 * @param {Date} from
 * @param {Date} to
 * @returns {Record<string,string>[]}
 */
function salesInRange(sales, from, to) {
  return sales.filter((row) => {
    const d = parseDate(row["Дата"] || row["Fecha"] || "");
    if (!d) return false;
    return d >= from && d <= to;
  });
}

/**
 * Суммирует выручку по массиву строк продаж.
 * @param {Record<string,string>[]} rows
 * @returns {number}
 */
function sumRevenue(rows) {
  return rows.reduce((sum, row) => {
    return sum + parseNum(row["Итого ARS"] || row["Сумма ARS"] || row["Сумма"] || 0);
  }, 0);
}

/**
 * Суммирует расходы за период.
 * @param {Record<string,string>[]} expenses
 * @param {Date} from
 * @param {Date} to
 * @returns {number}
 */
function sumExpenses(expenses, from, to) {
  return expenses
    .filter((row) => {
      const d = parseDate(row["Дата"] || row["Fecha"] || "");
      return d && d >= from && d <= to;
    })
    .reduce((sum, row) => {
      return sum + parseNum(row["Сумма"] || row["Сумма ARS"] || row["Monto"] || 0);
    }, 0);
}

/**
 * Фильтрует задачи по статусу.
 * @param {Record<string,string>[]} tasks
 * @param {string[]} statuses
 * @returns {Record<string,string>[]}
 */
function tasksByStatus(tasks, statuses) {
  return tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    return statuses.some((st) => s === st || s.includes(st));
  });
}

/**
 * Фильтрует задачи с просроченным дедлайном.
 * @param {Record<string,string>[]} tasks
 * @returns {Record<string,string>[]}
 */
function overdueTasks(tasks) {
  const today = todayStart();
  return tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    if (s === "done" || s === "reviewed" || s === "отменена") return false;
    const dl = parseDate(t[TASK_COLS.deadline] || "");
    return dl && dl < today;
  });
}

/**
 * Считает незакрытые алерты по severity.
 * @param {Record<string,string>[]} alerts
 * @returns {{ total: number, p1: number, p2: number, items: Record<string,string>[] }}
 */
function openAlerts(alerts) {
  const open = alerts.filter((a) => {
    const s = (a["Статус"] || a["Status"] || "").toLowerCase();
    return s === "открыт" || s === "open" || s === "new";
  });
  return {
    total: open.length,
    p1: open.filter((a) => parseNum(a["Severity"] || a["Приоритет"] || 0) >= 4).length,
    p2: open.filter((a) => {
      const sev = parseNum(a["Severity"] || a["Приоритет"] || 0);
      return sev >= 3 && sev < 4;
    }).length,
    items: open,
  };
}

/**
 * Продукты с критическим/низким запасом.
 * @param {Record<string, { kg: number, days: number, status: string }>} stock
 * @returns {{ critical: string[], warning: string[] }}
 */
function lowStockItems(stock) {
  const critical = [];
  const warning = [];
  for (const [product, data] of Object.entries(stock)) {
    if (data.status === "critical") critical.push(`${product} (${data.kg} кг, ${data.days}д)`);
    else if (data.status === "warning") warning.push(`${product} (${data.kg} кг, ${data.days}д)`);
  }
  return { critical, warning };
}

// -- Вечерний план (evening) ----------------------------------------------------

/**
 * Генерирует вечерний план на завтра.
 * @param {object} state -- полное состояние фермы из farm-state.cjs
 * @param {{ clients: object[], summary: object }} clientAnalysis
 * @returns {string} -- HTML-форматированный текст для Telegram
 */
function buildEveningPlan(state, clientAnalysis) {
  const today = todayStart();
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);

  const sales = state.sales || [];
  const expenses = state.expenses || [];
  const tasks = state.tasks || [];
  const alerts = state.alerts || [];
  const stock = state.analytics?.stock || {};

  // -- Итоги сегодня --
  const todaySales = salesInRange(sales, today, todayEnd);
  const todayRevenue = sumRevenue(todaySales);
  const todayExpenses = sumExpenses(expenses, today, todayEnd);
  const deliveriesToday = todaySales.length;

  const doneTasks = tasksByStatus(tasks, ["done", "reviewed"]).filter((t) => {
    const d = parseDate(t[TASK_COLS.created] || "");
    return d && dateKey(d) === todayStr();
  });

  const overdue = overdueTasks(tasks);
  const alertInfo = openAlerts(alerts);

  // -- План на завтра --
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // Доставки на завтра (продажи с датой = завтра или дедлайном = завтра)
  const tomorrowSales = salesInRange(sales, tomorrow, tomorrowEnd);

  // Задачи с приоритетом 1-2 (просроченные или на завтра)
  const mustDoTasks = tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    if (s === "done" || s === "reviewed" || s === "отменена") return false;
    const prio = parseNum(t[TASK_COLS.priority] || 5);
    const dl = parseDate(t[TASK_COLS.deadline] || "");
    return prio <= 2 || (dl && dl <= tomorrowEnd);
  });

  // Клиенты at-risk
  const atRiskClients = (clientAnalysis.clients || []).filter((c) => c.status === "at_risk");

  // Склад: критические позиции
  const stockInfo = lowStockItems(stock);

  // -- Формируем HTML --
  const lines = [];
  const tomorrowLabel = tomorrowStr();
  const dayOfWeek = WEEKDAYS_RU[tomorrow.getDay()];

  lines.push(`<b>ПЛАН НА ${tomorrowLabel} (${dayOfWeek})</b>`);
  lines.push("");

  // Итоги сегодня
  lines.push("<b>--- Итоги сегодня ---</b>");
  lines.push(`Выручка: <b>${fmtNum(Math.round(todayRevenue))} ARS</b>`);
  lines.push(`Доставки: ${deliveriesToday}`);
  lines.push(`Задачи: ${doneTasks.length} done / ${overdue.length} overdue`);
  lines.push(`Алерты: ${alertInfo.total} open (P1: ${alertInfo.p1})`);
  if (todayExpenses > 0) {
    lines.push(`Расходы: ${fmtNum(Math.round(todayExpenses))} ARS`);
  }
  lines.push("");

  // ОБЯЗАТЕЛЬНО
  lines.push("<b>ОБЯЗАТЕЛЬНО:</b>");
  if (tomorrowSales.length > 0) {
    lines.push(`  Доставки: ${tomorrowSales.length} заказ(ов)`);
    for (const s of tomorrowSales.slice(0, 5)) {
      const client = s["Клиент"] || s["Cliente"] || "?";
      const product = s["Продукт"] || s["Товар"] || "";
      const kg = s["Кол-во кг"] || s["Cantidad kg"] || "";
      lines.push(`    - ${client}: ${product} ${kg} кг`);
    }
    if (tomorrowSales.length > 5) {
      lines.push(`    ... и ещё ${tomorrowSales.length - 5}`);
    }
  }
  if (overdue.length > 0) {
    lines.push(`  Просроченные задачи (${overdue.length}):`);
    for (const t of overdue.slice(0, 3)) {
      const name = t[TASK_COLS.task] || "?";
      const dl = t[TASK_COLS.deadline] || "";
      lines.push(`    - ${name} (дедлайн: ${dl})`);
    }
  }
  if (stockInfo.critical.length > 0) {
    lines.push(`  Критический запас: ${stockInfo.critical.join(", ")}`);
  }
  if (alertInfo.p1 > 0) {
    lines.push(`  P1 алерты (${alertInfo.p1}):`);
    for (const a of alertInfo.items
      .filter((x) => parseNum(x["Severity"] || x["Приоритет"] || 0) >= 4)
      .slice(0, 3)) {
      lines.push(`    - ${a["Описание"] || a["Description"] || a["Тип"] || "?"}`);
    }
  }
  if (
    tomorrowSales.length === 0 &&
    overdue.length === 0 &&
    stockInfo.critical.length === 0 &&
    alertInfo.p1 === 0
  ) {
    lines.push("  Нет критических дел");
  }
  lines.push("");

  // ВАЖНО
  lines.push("<b>ВАЖНО:</b>");
  if (atRiskClients.length > 0) {
    lines.push(
      `  Связаться: ${atRiskClients
        .slice(0, 3)
        .map((c) => `${c.name} (${c.daysSinceLast}д)`)
        .join(", ")}`,
    );
  }
  if (stockInfo.warning.length > 0) {
    lines.push(`  Запас на исходе: ${stockInfo.warning.slice(0, 3).join(", ")}`);
  }

  // Проверяем, есть ли расходы за последние 3 дня
  const threeDaysAgo = new Date(today);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const recentExpenses = expenses.filter((e) => {
    const d = parseDate(e["Дата"] || "");
    return d && d >= threeDaysAgo;
  });
  if (recentExpenses.length === 0) {
    lines.push("  Внести расходы (нет записей 3+ дней)");
  }

  const shouldDoTasks = mustDoTasks.filter((t) => {
    const prio = parseNum(t[TASK_COLS.priority] || 5);
    return prio >= 3 && prio <= 4;
  });
  if (shouldDoTasks.length > 0) {
    lines.push(`  Задачи P3-P4 (${shouldDoTasks.length}):`);
    for (const t of shouldDoTasks.slice(0, 2)) {
      lines.push(`    - ${t[TASK_COLS.task] || "?"}`);
    }
  }

  if (
    atRiskClients.length === 0 &&
    stockInfo.warning.length === 0 &&
    recentExpenses.length > 0 &&
    shouldDoTasks.length === 0
  ) {
    lines.push("  Все в порядке");
  }
  lines.push("");

  // РАЗВИТИЕ
  lines.push("<b>РАЗВИТИЕ:</b>");
  const growthTasks = tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    if (s === "done" || s === "reviewed" || s === "отменена") return false;
    const dept = (t[TASK_COLS.department] || "").toLowerCase();
    return dept.includes("маркетинг") || dept.includes("развитие") || dept.includes("стратег");
  });
  if (growthTasks.length > 0) {
    for (const t of growthTasks.slice(0, 3)) {
      lines.push(`  - ${t[TASK_COLS.task] || "?"}`);
    }
  } else {
    lines.push("  - Контент для соцсетей / новые клиенты");
  }
  lines.push("");

  // Тайминг
  lines.push("<b>Тайминг:</b>");
  lines.push("  06-07 Обход теплицы + сбор");
  lines.push("  07-08 Упаковка + подготовка");
  lines.push("  08-12 Доставки + допзадачи");
  lines.push("  12-13 Обед + ввод данных");
  lines.push("  13-16 Производственные работы");
  lines.push("  16-17 Маркетинг + звонки");
  lines.push("  17-18 Планирование + отчёт");
  lines.push("");

  // Мультипликатор дня
  lines.push("<b>Мультипликатор дня:</b>");
  const multiplier = findMultiplierAction(overdue, atRiskClients, stockInfo, alertInfo);
  lines.push(`  ${multiplier}`);
  lines.push("");

  lines.push("<i>Скажи что изменить</i>");

  return truncate(lines.join("\n"), TG_MAX_CHARS);
}

/**
 * Находит одно высокоуровневое действие, решающее несколько проблем.
 * @param {Record<string,string>[]} overdue
 * @param {object[]} atRiskClients
 * @param {{ critical: string[], warning: string[] }} stockInfo
 * @param {{ total: number, p1: number }} alertInfo
 * @returns {string}
 */
function findMultiplierAction(overdue, atRiskClients, stockInfo, alertInfo) {
  // Приоритеты: если есть P1 алерты -- они всегда первые
  if (alertInfo.p1 > 0) {
    return "Закрыть P1 алерты -- разблокирует операционку";
  }
  // Если много просроченных задач + at-risk клиенты -- "блиц-день"
  if (overdue.length >= 3 && atRiskClients.length >= 2) {
    return "Блиц-обзвон at-risk клиентов + закрытие просроченных -- 2 проблемы за 1 действие";
  }
  // Если критический запас
  if (stockInfo.critical.length >= 2) {
    return "Экстренный сбор урожая -- закроет дефицит склада + обеспечит доставки";
  }
  // Если много at-risk клиентов
  if (atRiskClients.length >= 3) {
    return `Обзвонить ${atRiskClients.length} at-risk клиентов -- предотвратить отток`;
  }
  // Если много просроченных
  if (overdue.length >= 3) {
    return `Разобрать ${overdue.length} просроченных задач -- снять завалы`;
  }
  // По умолчанию
  return "Сфокусироваться на одной стратегической задаче (маркетинг / новый продукт)";
}

// -- Недельный план (weekly) ----------------------------------------------------

/**
 * Генерирует недельный план.
 * @param {object} state
 * @param {{ clients: object[], summary: object }} clientAnalysis
 * @returns {string}
 */
function buildWeeklyPlan(state, clientAnalysis) {
  const now = nowART();
  const today = todayStart();
  const sales = state.sales || [];
  const expenses = state.expenses || [];
  const tasks = state.tasks || [];
  const stock = state.analytics?.stock || {};
  const production = state.production || [];

  // Период: последняя неделя vs предыдущая
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  const thisWeekSales = salesInRange(sales, weekAgo, today);
  const prevWeekSales = salesInRange(sales, twoWeeksAgo, weekAgo);
  const thisWeekRevenue = sumRevenue(thisWeekSales);
  const prevWeekRevenue = sumRevenue(prevWeekSales);
  const thisWeekExpenses = sumExpenses(expenses, weekAgo, today);
  const thisWeekMargin =
    thisWeekRevenue > 0
      ? Math.round(((thisWeekRevenue - thisWeekExpenses) / thisWeekRevenue) * 100)
      : 0;

  // Задачи
  const completedTasks = tasksByStatus(tasks, ["done", "reviewed"]);
  const overdue = overdueTasks(tasks);
  const allOpen = tasksByStatus(tasks, ["planned", "in_progress"]);

  // Клиенты
  const summary = clientAnalysis.summary || {};
  const atRisk = (clientAnalysis.clients || []).filter((c) => c.status === "at_risk");
  const churned = (clientAnalysis.clients || []).filter((c) => c.status === "churned");

  // Производство за неделю
  const weekProduction = production.filter((p) => {
    const d = parseDate(p["Дата"] || "");
    return d && d >= weekAgo;
  });
  const totalKgProduced = weekProduction.reduce(
    (sum, p) => sum + parseNum(p["Кг"] || p["Количество"] || p["Вес кг"] || 0),
    0,
  );

  // Склад
  const stockInfo = lowStockItems(stock);

  const lines = [];

  // -- Итоги недели --
  lines.push("<b>НЕДЕЛЬНЫЙ ПЛАН</b>");
  lines.push(`<b>${fmtDate(weekAgo)} -- ${todayStr()}</b>`);
  lines.push("");

  lines.push("<b>--- Итоги недели ---</b>");
  lines.push(
    `Выручка: <b>${fmtNum(Math.round(thisWeekRevenue))} ARS</b>${trendArrow(thisWeekRevenue, prevWeekRevenue)}`,
  );
  lines.push(`Расходы: ${fmtNum(Math.round(thisWeekExpenses))} ARS`);
  lines.push(`Маржа: ${thisWeekMargin}%`);
  if (thisWeekExpenses === 0) {
    lines.push("  <i>расходы не внесены</i>");
  }
  lines.push(`Доставки: ${thisWeekSales.length} (пред: ${prevWeekSales.length})`);
  lines.push(`Производство: ${fmtNum(Math.round(totalKgProduced))} кг`);
  lines.push(
    `Задачи: ${completedTasks.length} done / ${overdue.length} overdue / ${allOpen.length} open`,
  );
  lines.push(
    `Клиенты: ${summary.active || 0} active / ${summary.at_risk || 0} at-risk / ${summary.churned || 0} churned`,
  );
  lines.push("");

  // -- Цели недели (MAX 5) --
  lines.push("<b>--- Цели недели ---</b>");

  const revenueTarget = Math.round(thisWeekRevenue * 1.05);
  lines.push(`1. Выручка: ${fmtNum(revenueTarget)} ARS (+5%)`);

  if (atRisk.length > 0) {
    lines.push(`2. Клиенты: связаться с ${Math.min(atRisk.length, 5)} at-risk`);
  } else {
    lines.push("2. Клиенты: привлечь 1 нового");
  }

  lines.push(`3. Производство: обеспечить запас (${stockInfo.critical.length} critical)`);

  if (thisWeekExpenses === 0 || thisWeekMargin < 35) {
    lines.push("4. Финансы: внести все расходы, целевая маржа 35%+");
  } else {
    lines.push(`4. Финансы: удержать маржу ${thisWeekMargin}%+`);
  }

  lines.push("5. Развитие: 1 стратегическая задача");
  lines.push("");

  // -- Задачи по дням --
  lines.push("<b>--- Задачи по дням ---</b>");
  const openTasks = [...overdue, ...allOpen];
  const perDay = Math.max(1, Math.ceil(openTasks.length / 5));

  const dayLabels = ["Пн", "Вт", "Ср", "Чт", "Пт"];
  const dayDescriptions = [
    "свежий старт, крупные задачи",
    "доставки, производство",
    "клиенты, производство",
    "доставки, маркетинг",
    "админ, расходы, планирование",
  ];

  for (let i = 0; i < 5; i++) {
    const dayTasks = openTasks.slice(i * perDay, (i + 1) * perDay);
    const taskList =
      dayTasks.length > 0
        ? dayTasks
            .slice(0, 2)
            .map((t) => t[TASK_COLS.task] || "?")
            .join(", ")
        : dayDescriptions[i];
    lines.push(`  <b>${dayLabels[i]}:</b> ${taskList}`);
  }
  lines.push("");

  // -- Развитие бизнеса --
  lines.push("<b>--- Развитие ---</b>");
  const growthTasks = tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    if (s === "done" || s === "reviewed" || s === "отменена") return false;
    const dept = (t[TASK_COLS.department] || "").toLowerCase();
    return dept.includes("маркетинг") || dept.includes("развитие") || dept.includes("стратег");
  });
  if (growthTasks.length > 0) {
    lines.push(`  ${growthTasks[0][TASK_COLS.task] || "Стратегическая задача"}`);
  } else {
    lines.push("  Определить 1 задачу на развитие");
  }
  lines.push("");

  // -- Риски недели --
  lines.push("<b>--- Риски ---</b>");
  if (stockInfo.critical.length > 0) {
    lines.push(`  Дефицит: ${stockInfo.critical.slice(0, 3).join(", ")}`);
  }
  if (overdue.length > 0) {
    lines.push(`  Просроченных задач: ${overdue.length}`);
  }
  if (churned.length > 0) {
    lines.push(`  Ушедшие клиенты: ${churned.length}`);
  }
  if (stockInfo.critical.length === 0 && overdue.length === 0 && churned.length === 0) {
    lines.push("  Критических рисков нет");
  }

  return truncate(lines.join("\n"), TG_MAX_CHARS);
}

// -- Месячный план (monthly) ----------------------------------------------------

/**
 * Генерирует месячный план.
 * @param {object} state
 * @param {{ clients: object[], summary: object }} clientAnalysis
 * @returns {string}
 */
function buildMonthlyPlan(state, clientAnalysis) {
  const today = todayStart();
  const sales = state.sales || [];
  const expenses = state.expenses || [];
  const tasks = state.tasks || [];

  // Текущий месяц
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);

  const thisMonthSales = salesInRange(sales, monthStart, today);
  const prevMonthSales = salesInRange(sales, prevMonthStart, prevMonthEnd);
  const thisMonthRevenue = sumRevenue(thisMonthSales);
  const prevMonthRevenue = sumRevenue(prevMonthSales);
  const thisMonthExpenses = sumExpenses(expenses, monthStart, today);
  const prevMonthExpenses = sumExpenses(expenses, prevMonthStart, prevMonthEnd);

  const thisMonthMargin =
    thisMonthRevenue > 0
      ? Math.round(((thisMonthRevenue - thisMonthExpenses) / thisMonthRevenue) * 100)
      : 0;
  const prevMonthMargin =
    prevMonthRevenue > 0
      ? Math.round(((prevMonthRevenue - prevMonthExpenses) / prevMonthRevenue) * 100)
      : 0;

  // Топ клиенты
  const clientList = clientAnalysis.clients || [];
  const top5Clients = clientList.slice(0, 5);

  // Топ продукты
  const products = state.analytics?.products || {};
  const topProducts = Object.entries(products)
    .sort((a, b) => b[1].kg - a[1].kg)
    .slice(0, 3);

  // Клиенты
  const summary = clientAnalysis.summary || {};
  const newClients = clientList.filter((c) => c.status === "new");
  const churned = clientList.filter((c) => c.status === "churned");

  const lines = [];
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const monthNames = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  const nextMonthName = monthNames[nextMonth.getMonth()];
  const curMonthName = monthNames[today.getMonth()];

  lines.push(`<b>ПЛАН НА ${nextMonthName.toUpperCase()} ${nextMonth.getFullYear()}</b>`);
  lines.push("");

  // -- Итоги месяца --
  lines.push(`<b>--- Итоги ${curMonthName} ---</b>`);
  lines.push(
    `Выручка: <b>${fmtNum(Math.round(thisMonthRevenue))} ARS</b>${trendArrow(thisMonthRevenue, prevMonthRevenue)}`,
  );
  lines.push(
    `Расходы: ${fmtNum(Math.round(thisMonthExpenses))} ARS${trendArrow(thisMonthExpenses, prevMonthExpenses)}`,
  );
  lines.push(`Маржа: ${thisMonthMargin}% (пред: ${prevMonthMargin}%)`);
  if (thisMonthExpenses === 0) {
    lines.push("  <i>расходы не внесены</i>");
  }
  lines.push(`Доставки: ${thisMonthSales.length} (пред: ${prevMonthSales.length})`);
  lines.push(
    `Клиенты: +${newClients.length} новых / -${churned.length} ушли / ${summary.total || 0} всего`,
  );
  lines.push("");

  // Топ-5 клиентов
  lines.push("<b>Топ-5 клиентов:</b>");
  for (const c of top5Clients) {
    lines.push(`  ${c.name}: ${fmtNum(Math.round(c.totalArs))} ARS (${c.orderCount} заказов)`);
  }
  lines.push("");

  // Топ-3 продукта
  lines.push("<b>Топ-3 продукта:</b>");
  for (const [name, data] of topProducts) {
    lines.push(
      `  ${name}: ${fmtNum(Math.round(data.kg))} кг / ${fmtNum(Math.round(data.ars))} ARS`,
    );
  }
  lines.push("");

  // -- Цели месяца (MAX 3 OKRs) --
  lines.push(`<b>--- Цели на ${nextMonthName} ---</b>`);
  const revenueTarget = Math.round(thisMonthRevenue * 1.1);
  lines.push(`1. Выручка: ${fmtNum(revenueTarget)} ARS (+10%)`);
  lines.push(`2. Маржа: ${Math.max(thisMonthMargin + 5, 35)}%`);
  lines.push("3. Стратегия: определить 1 рост-инициативу");
  lines.push("");

  // -- Ключевые задачи по неделям --
  lines.push("<b>--- Задачи по неделям ---</b>");
  lines.push("  Нед 1: Закрыть хвосты прошлого месяца, наладить ритм");
  lines.push("  Нед 2: Фокус на продажах и клиентах");
  lines.push("  Нед 3: Производство + оптимизация процессов");
  lines.push("  Нед 4: Итоги + планирование следующего месяца");
  lines.push("");

  // -- Стратегические инициативы --
  lines.push("<b>--- Стратегические инициативы ---</b>");
  if (churned.length > 0) {
    lines.push(`  - Реактивация ${churned.length} ушедших клиентов`);
  }
  if (thisMonthMargin < 35) {
    lines.push("  - Оптимизация затрат (маржа ниже цели 35%)");
  }
  lines.push("  - Тестирование нового продукта / канала");
  lines.push("  - Улучшение 1 процесса (автоматизация)");

  return truncate(lines.join("\n"), TG_MAX_CHARS);
}

// -- Ревью (review) -------------------------------------------------------------

/**
 * Генерирует ревью задач за сегодня.
 * @param {object} state
 * @returns {{ message: string, updates: { task: string, status: string, quality: number, notes: string }[] }}
 */
function buildReview(state) {
  const today = todayStart();
  const tasks = state.tasks || [];

  // Задачи выполненные сегодня
  const doneTasks = tasks.filter((t) => {
    const s = (t[TASK_COLS.status] || "").toLowerCase().trim();
    if (s !== "done") return false;
    // Проверяем по дедлайну или дате создания (для сегодняшних)
    const dl = parseDate(t[TASK_COLS.deadline] || "");
    const cr = parseDate(t[TASK_COLS.created] || "");
    return (dl && dateKey(dl) === todayStr()) || (cr && dateKey(cr) === todayStr());
  });

  // Просроченные
  const overdue = overdueTasks(tasks);

  // Категории задержек
  const delayReasons = {
    time: 0,
    resources: 0,
    blocked: 0,
    forgotten: 0,
  };
  for (const t of overdue) {
    const notes = (t[TASK_COLS.notes] || "").toLowerCase();
    if (notes.includes("блок") || notes.includes("жд")) delayReasons.blocked++;
    else if (notes.includes("ресурс") || notes.includes("нет")) delayReasons.resources++;
    else if (notes.includes("врем") || notes.includes("не успе")) delayReasons.time++;
    else delayReasons.forgotten++;
  }

  const lines = [];
  lines.push(`<b>РЕВЬЮ ДНЯ: ${todayStr()}</b>`);
  lines.push("");

  // Выполненные задачи
  if (doneTasks.length > 0) {
    lines.push(`<b>Выполнено (${doneTasks.length}):</b>`);
    /** @type {{ task: string, status: string, quality: number, notes: string }[]} */
    const updates = [];

    for (const t of doneTasks) {
      const name = t[TASK_COLS.task] || "?";
      const quality = parseNum(t[TASK_COLS.quality] || 0);
      const qualityLabel = quality > 0 ? `Q${quality}/5` : "Q?";

      // Оценка своевременности
      const dl = parseDate(t[TASK_COLS.deadline] || "");
      let timeliness = "вовремя";
      if (dl) {
        const diff = daysBetween(dl, today);
        if (dl < today) timeliness = `опоздание ${diff}д`;
        else if (diff >= 1) timeliness = `досрочно ${diff}д`;
      }

      lines.push(`  ${qualityLabel} | ${timeliness} | ${name}`);

      updates.push({
        task: name,
        status: "reviewed",
        quality: quality || 3,
        notes: `Reviewed ${todayStr()}: ${timeliness}`,
      });
    }
    lines.push("");

    return {
      message: truncate(buildReviewWithOverdue(lines, overdue, delayReasons), TG_MAX_CHARS),
      updates,
    };
  }

  lines.push("Нет задач со статусом 'done' за сегодня.");
  lines.push("");

  return {
    message: truncate(buildReviewWithOverdue(lines, overdue, delayReasons), TG_MAX_CHARS),
    updates: [],
  };
}

/**
 * Дополняет ревью секцией про просроченные задачи.
 * @param {string[]} lines
 * @param {Record<string,string>[]} overdue
 * @param {{ time: number, resources: number, blocked: number, forgotten: number }} delayReasons
 * @returns {string}
 */
function buildReviewWithOverdue(lines, overdue, delayReasons) {
  if (overdue.length > 0) {
    lines.push(`<b>Просрочено (${overdue.length}):</b>`);

    for (const t of overdue.slice(0, 5)) {
      const name = t[TASK_COLS.task] || "?";
      const dl = t[TASK_COLS.deadline] || "?";
      const prio = t[TASK_COLS.priority] || "?";
      lines.push(`  P${prio} | дл: ${dl} | ${name}`);
    }
    if (overdue.length > 5) {
      lines.push(`  ... и ещё ${overdue.length - 5}`);
    }
    lines.push("");

    // Причины задержек
    const reasons = [];
    if (delayReasons.time > 0) reasons.push(`нехватка времени (${delayReasons.time})`);
    if (delayReasons.blocked > 0) reasons.push(`заблокировано (${delayReasons.blocked})`);
    if (delayReasons.resources > 0) reasons.push(`нет ресурсов (${delayReasons.resources})`);
    if (delayReasons.forgotten > 0)
      reasons.push(`забыто/не классифицировано (${delayReasons.forgotten})`);
    if (reasons.length > 0) {
      lines.push(`<b>Причины задержек:</b> ${reasons.join(", ")}`);
    }
  } else {
    lines.push("Просроченных задач нет.");
  }

  return lines.join("\n");
}

// -- Обновление задач в Sheets --------------------------------------------------

/**
 * Обновляет статус задач в Google Sheets (переводит done -> reviewed).
 * @param {{ task: string, status: string, quality: number, notes: string }[]} updates
 * @returns {Promise<number>} -- количество обновлённых
 */
async function updateTaskStatuses(updates) {
  if (updates.length === 0 || DRY_RUN) return 0;

  try {
    const { readSheet, writeToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const sheetName = "\u{1F4CB} Задачи";
    const rows = await readSheet(PEPINO_SHEETS_ID, sheetName);

    if (!rows || rows.length < 2) return 0;

    const headers = rows[0].map((h) => String(h).trim());
    const statusIdx = headers.indexOf("Статус");
    const qualityIdx = headers.indexOf("Качество");
    const notesIdx = headers.indexOf("Заметки");
    const taskIdx = headers.indexOf("Задача");

    if (statusIdx === -1 || taskIdx === -1) {
      console.error("[planning-cycle] Не найдены колонки Статус/Задача в листе Задачи");
      return 0;
    }

    let updated = 0;
    for (const upd of updates) {
      for (let i = 1; i < rows.length; i++) {
        const taskName = (rows[i][taskIdx] || "").trim();
        if (taskName === upd.task) {
          rows[i][statusIdx] = upd.status;
          if (qualityIdx !== -1 && upd.quality > 0) {
            rows[i][qualityIdx] = String(upd.quality);
          }
          if (notesIdx !== -1 && upd.notes) {
            const existing = rows[i][notesIdx] || "";
            rows[i][notesIdx] = existing ? `${existing}; ${upd.notes}` : upd.notes;
          }
          updated++;
          break;
        }
      }
    }

    if (updated > 0) {
      await writeToSheet(PEPINO_SHEETS_ID, rows, sheetName);
    }

    return updated;
  } catch (err) {
    console.error(`[planning-cycle] Ошибка обновления задач: ${err.message}`);
    return 0;
  }
}

// -- Отправка в Telegram --------------------------------------------------------

/**
 * Отправляет сообщение в Telegram через notification-throttle.
 * @param {string} message
 * @param {number} thread
 * @param {string} label -- для логирования
 * @returns {Promise<void>}
 */
async function sendToTelegram(message, thread, label) {
  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Telegram thread=${thread} label="${label}":`);
    console.log(message);
    console.log("---");
    return;
  }

  const result = await sendThrottled(message, {
    thread,
    silent: false,
    priority: "high",
    parseMode: "HTML",
  });

  if (!result.ok) {
    console.error(`[planning-cycle] Ошибка отправки в Telegram (${label}): ${result.error}`);
  } else {
    console.error(`[planning-cycle] Отправлено в thread=${thread} (${label}): ${result.action}`);
  }
}

// -- Главные команды ------------------------------------------------------------

/**
 * Вечерний план.
 * @returns {Promise<void>}
 */
async function runEvening() {
  const startMs = Date.now();
  console.error("[planning-cycle] Генерация вечернего плана...");

  const [state, clientAnalysis] = await Promise.all([getState(), analyzeClients()]);

  const message = buildEveningPlan(state, clientAnalysis);
  await sendToTelegram(message, TOPIC_DIRECTOR, "evening-plan");

  await trace({
    name: "planning-cycle/evening",
    input: { date: todayStr(), dryRun: DRY_RUN },
    output: { messageLength: message.length },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", command: "evening" },
  }).catch(() => {});
}

/**
 * Недельный план.
 * @returns {Promise<void>}
 */
async function runWeekly() {
  const startMs = Date.now();
  console.error("[planning-cycle] Генерация недельного плана...");

  const [state, clientAnalysis] = await Promise.all([getState(), analyzeClients()]);

  const message = buildWeeklyPlan(state, clientAnalysis);

  // Отправляем в Director и Итоги
  await sendToTelegram(message, TOPIC_DIRECTOR, "weekly-plan-director");

  // Краткая сводка для Итогов (первые 2 секции)
  const summaryLines = message.split("\n").slice(0, 20).join("\n");
  await sendToTelegram(summaryLines, TOPIC_RESULTS, "weekly-plan-results");

  await trace({
    name: "planning-cycle/weekly",
    input: { date: todayStr(), dryRun: DRY_RUN },
    output: { messageLength: message.length },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", command: "weekly" },
  }).catch(() => {});
}

/**
 * Месячный план.
 * @returns {Promise<void>}
 */
async function runMonthly() {
  const startMs = Date.now();

  // Проверяем: действительно ли сегодня последний день месяца
  // (cron запускается 28-31, но план нужен только в последний день)
  if (!isLastDayOfMonth() && !DRY_RUN) {
    console.error("[planning-cycle] Не последний день месяца, пропускаем monthly.");
    return;
  }

  console.error("[planning-cycle] Генерация месячного плана...");

  const [state, clientAnalysis] = await Promise.all([getState(), analyzeClients()]);

  const message = buildMonthlyPlan(state, clientAnalysis);
  await sendToTelegram(message, TOPIC_DIRECTOR, "monthly-plan");

  await trace({
    name: "planning-cycle/monthly",
    input: { date: todayStr(), dryRun: DRY_RUN },
    output: { messageLength: message.length },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", command: "monthly" },
  }).catch(() => {});
}

/**
 * Ревью дня.
 * @returns {Promise<void>}
 */
async function runReview() {
  const startMs = Date.now();
  console.error("[planning-cycle] Генерация ревью дня...");

  const state = await getState();
  const { message, updates } = buildReview(state);

  // Обновляем статусы задач в Sheets (done -> reviewed)
  const updatedCount = await updateTaskStatuses(updates);
  if (updatedCount > 0) {
    console.error(`[planning-cycle] Обновлено задач: ${updatedCount}`);
  }

  await sendToTelegram(message, TOPIC_DIRECTOR, "daily-review");

  await trace({
    name: "planning-cycle/review",
    input: { date: todayStr(), dryRun: DRY_RUN },
    output: {
      messageLength: message.length,
      tasksReviewed: updates.length,
      tasksUpdated: updatedCount,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", command: "review" },
  }).catch(() => {});
}

// -- CLI ------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.filter((a) => !a.startsWith("--"));
  const command = args[2] || "";

  if (DRY_RUN) {
    console.error("[planning-cycle] Режим --dry-run: Telegram и Sheets не обновляются.");
  }

  /** @type {Record<string, () => Promise<void>>} */
  const commands = {
    evening: runEvening,
    weekly: runWeekly,
    monthly: runMonthly,
    review: runReview,
  };

  const handler = commands[command];
  if (!handler) {
    console.error("Usage: node planning-cycle.cjs <command> [--dry-run]");
    console.error("");
    console.error("Commands:");
    console.error("  evening   План на завтра (daily 20:00)");
    console.error("  weekly    План на неделю (Sunday 19:00)");
    console.error("  monthly   План на месяц (last day 19:00)");
    console.error("  review    Ревью задач дня (daily 19:00)");
    console.error("");
    console.error("Options:");
    console.error("  --dry-run  Без отправки в Telegram и записи в Sheets");
    console.error("");
    console.error("Cron:");
    console.error("  0 19 * * *     review");
    console.error("  0 20 * * *     evening");
    console.error("  0 19 * * 0     weekly");
    console.error("  0 19 28-31 * * monthly");
    process.exit(1);
  }

  handler()
    .then(() => {
      console.error(`[planning-cycle] ${command} завершён.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[planning-cycle] ОШИБКА (${command}): ${err.message}`);
      if (DRY_RUN) console.error(err.stack);
      process.exit(1);
    });
}

// -- Экспорт для использования из других скриптов -------------------------------

module.exports = {
  runEvening,
  runWeekly,
  runMonthly,
  runReview,
  // Утилиты для тестирования
  buildEveningPlan,
  buildWeeklyPlan,
  buildMonthlyPlan,
  buildReview,
  findMultiplierAction,
};
