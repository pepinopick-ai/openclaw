#!/usr/bin/env node
/**
 * self-improve.cjs -- SELF-IMPROVEMENT ENGINE (learning loop)
 *
 * Анализирует производительность системы по 7 измерениям, генерирует
 * рекомендации по улучшению. "Learning loop" по архитектуре Replit.
 *
 * Источники данных:
 *   - lessons.json       -- накопленные уроки
 *   - farm-state.cjs     -- состояние фермы
 *   - /home/roman/logs/  -- свежесть логов cron-задач
 *   - task-brain-backlog -- бэклог задач
 *   - /tmp/notification-throttle-state.json -- throttle-статистика
 *
 * CLI:
 *   node self-improve.cjs analyze          -- анализ системы
 *   node self-improve.cjs lessons          -- все уроки по доменам
 *   node self-improve.cjs recommendations  -- рекомендации улучшения
 *   node self-improve.cjs health           -- итоговый балл 0-100
 *   node self-improve.cjs --dry-run <cmd>
 *
 * Cron: 30 18 * * 0 (воскресенье 18:30, перед CEO-дайджестом)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const { parseNum, parseDate, fmtDate, daysBetween } = require("./helpers.cjs");
const { getState } = require("./farm-state.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Константы ----------------------------------------------------------------

const SCRIPTS_DIR = path.join(__dirname);
const LOGS_DIR = "/home/roman/logs";
const HOME = process.env.HOME || "/root";

const LESSONS_PATH = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "memory",
  "knowledge",
  "decisions",
  "lessons.json",
);
const BACKLOG_PATH = path.join(HOME, ".openclaw", "workspace", "memory", "task-brain-backlog.json");
const KNOWLEDGE_DIR = path.join(HOME, ".openclaw", "workspace", "memory", "knowledge");
const KNOWLEDGE_INDEX_PATH = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "memory",
  "knowledge-index.json",
);
const THROTTLE_STATE_PATH = "/tmp/notification-throttle-state.json";

/** Telegram-топик: Director/Strategy */
const TOPIC_STRATEGY = 20;

/** Ожидаемые интервалы обновления логов (в минутах) */
const CRON_EXPECTED_INTERVALS = {
  "farm-state.log": 15,
  "pepino-morning-brief.log": 24 * 60,
  "daily-pnl.log": 24 * 60,
  "expense-reminder.log": 24 * 60,
  "alert-aggregator.log": 60,
  "digital-twin.log": 24 * 60,
  "inventory-tracker.log": 24 * 60,
  "knowledge-indexer.log": 24 * 60,
};

// -- Утилиты ------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Синхронная shell-команда, возвращает stdout или null при ошибке.
 * @param {string} cmd
 * @returns {string|null}
 */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Читает JSON-файл, возвращает null при ошибке.
 * @param {string} filePath
 * @returns {*}
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Возвращает возраст файла в минутах (Infinity если не существует).
 * @param {string} filePath
 * @returns {number}
 */
function fileAgeMinutes(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / 60000;
  } catch {
    return Infinity;
  }
}

/**
 * Определяет, есть ли в логе строки ERROR/FATAL/Exception в последних N байтах.
 * @param {string} logPath
 * @param {number} [bytes=4096]
 * @returns {number} -- количество строк с ошибками
 */
function countLogErrors(logPath, bytes = 4096) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf-8");
    return (text.match(/\b(ERROR|FATAL|Exception|Uncaught)\b/gi) || []).length;
  } catch {
    return 0;
  }
}

// -- Измерение 1: Script Syntax -----------------------------------------------

/**
 * Проверяет синтаксис всех .cjs файлов через node --check.
 * @returns {{total: number, pass: number, fail: number, failures: string[]}}
 */
function checkScriptSyntax() {
  const files = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".cjs"))
    .map((f) => path.join(SCRIPTS_DIR, f));

  const failures = [];
  for (const file of files) {
    const result = shell(`node --check "${file}" 2>&1`);
    // node --check succeeds silently; any output means error
    if (result !== "" && result !== null) {
      failures.push(path.basename(file));
    }
  }

  return {
    total: files.length,
    pass: files.length - failures.length,
    fail: failures.length,
    failures,
  };
}

// -- Измерение 2: Cron Reliability --------------------------------------------

/**
 * Проверяет свежесть ключевых лог-файлов.
 * @returns {{total: number, fresh: number, stale: number, results: object[]}}
 */
function checkCronReliability() {
  const results = [];
  for (const [logName, maxIntervalMin] of Object.entries(CRON_EXPECTED_INTERVALS)) {
    const logPath = path.join(LOGS_DIR, logName);
    const ageMin = fileAgeMinutes(logPath);
    // Предел = ожидаемый интервал × 2
    const threshold = maxIntervalMin * 2;
    const stale = ageMin > threshold;
    const missing = ageMin === Infinity;
    results.push({
      name: logName,
      ageMin: missing ? null : Math.round(ageMin),
      thresholdMin: threshold,
      stale,
      missing,
    });
  }

  const staleCount = results.filter((r) => r.stale).length;
  return {
    total: results.length,
    fresh: results.length - staleCount,
    stale: staleCount,
    results,
  };
}

// -- Измерение 3: Data Quality ------------------------------------------------

/**
 * Анализирует качество данных из farm-state.
 * @param {object} state -- farm-state snapshot
 * @returns {object}
 */
function checkDataQuality(state) {
  const now = new Date();
  const days30ago = new Date(now - 30 * 24 * 60 * 60 * 1000);

  // Уникальные даты за последние 30 дней
  const salesDates = new Set();
  const expenseDates = new Set();

  for (const row of state.sales || []) {
    const d = parseDate(row.date || row[0]);
    if (d && d >= days30ago) salesDates.add(d.toISOString().slice(0, 10));
  }

  for (const row of state.expenses || []) {
    const d = parseDate(row.date || row[0]);
    if (d && d >= days30ago) expenseDates.add(d.toISOString().slice(0, 10));
  }

  // Считаем количество рабочих дней за последние 30 дней (все дни = 30)
  const totalDays = 30;

  // Продукты с нулевым остатком
  const zeroStock = (state.inventory || []).filter((item) => {
    const qty = parseNum(item.quantity || item[2] || 0);
    return qty <= 0;
  }).length;

  // Клиенты без заказов >30 дней
  let dormantClients = 0;
  for (const client of state.clients || []) {
    const lastOrder = parseDate(client.lastOrder || client.last_order || client[3]);
    if (!lastOrder || daysBetween(lastOrder, now) > 30) dormantClients++;
  }

  return {
    salesCoverage: Math.round((salesDates.size / totalDays) * 100),
    expenseCoverage: Math.round((expenseDates.size / totalDays) * 100),
    salesDaysEntered: salesDates.size,
    expenseDaysEntered: expenseDates.size,
    totalDays,
    zeroStockCount: zeroStock,
    dormantClients,
  };
}

// -- Измерение 4: Task Management ---------------------------------------------

/**
 * Анализирует бэклог задач.
 * @returns {object}
 */
function checkTaskManagement() {
  const backlog = readJson(BACKLOG_PATH);
  if (!backlog || !Array.isArray(backlog.tasks)) {
    return { available: false };
  }

  const tasks = backlog.tasks;
  const now = new Date();

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  // Просроченные: задачи с dueDate < now и статусом !== done
  const overdue = open.filter((t) => {
    if (!t.dueDate) return false;
    const due = parseDate(t.dueDate);
    return due && due < now;
  });

  // Задачи без ревью (done, но без quality)
  const unreviewed = done.filter((t) => t.quality == null);

  // Средняя оценка качества
  const reviewedTasks = done.filter((t) => t.quality != null);
  const avgQuality =
    reviewedTasks.length > 0
      ? reviewedTasks.reduce((s, t) => s + (t.quality || 0), 0) / reviewedTasks.length
      : 0;

  const completionRate = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;

  return {
    available: true,
    total: tasks.length,
    open: open.length,
    done: done.length,
    overdue: overdue.length,
    unreviewed: unreviewed.length,
    completionRate,
    avgQuality: Math.round(avgQuality * 10) / 10,
  };
}

// -- Измерение 5: Lessons Patterns --------------------------------------------

/**
 * Анализирует накопленные уроки.
 * @returns {object}
 */
function checkLessonsPatterns() {
  const lessons = readJson(LESSONS_PATH);
  if (!lessons) return { available: false, count: 0 };

  const list = Array.isArray(lessons) ? lessons : lessons.lessons || [];
  if (!list.length) return { available: true, count: 0, domains: {}, themes: [] };

  // Группировка по доменам
  /** @type {Record<string, number>} */
  const domains = {};
  for (const lesson of list) {
    const domain = lesson.domain || "other";
    domains[domain] = (domains[domain] || 0) + 1;
  }

  // Повторяющиеся темы: слова из title/text встречаются в 3+ уроках
  /** @type {Record<string, number>} */
  const wordCounts = {};
  const stopWords = new Set([
    "и",
    "в",
    "на",
    "с",
    "для",
    "по",
    "это",
    "не",
    "что",
    "как",
    "из",
    "от",
    "у",
  ]);
  for (const lesson of list) {
    const text = `${lesson.title || ""} ${lesson.text || lesson.content || ""}`.toLowerCase();
    const words = text.match(/[а-яёa-z]{4,}/gi) || [];
    const unique = new Set(words);
    for (const w of unique) {
      if (!stopWords.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
    }
  }
  const themes = Object.entries(wordCounts)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  // Тренд качества: среднее quality первой и второй половины
  const withQuality = list.filter((l) => l.quality != null);
  let qualityTrend = "stable";
  if (withQuality.length >= 4) {
    const half = Math.floor(withQuality.length / 2);
    const older = withQuality.slice(0, half);
    const newer = withQuality.slice(half);
    const avgOlder = older.reduce((s, l) => s + l.quality, 0) / older.length;
    const avgNewer = newer.reduce((s, l) => s + l.quality, 0) / newer.length;
    if (avgNewer > avgOlder + 0.3) qualityTrend = "improving";
    else if (avgNewer < avgOlder - 0.3) qualityTrend = "declining";
  }

  return {
    available: true,
    count: list.length,
    domains,
    themes,
    qualityTrend,
    list,
  };
}

// -- Измерение 6: Memory Health -----------------------------------------------

/**
 * Проверяет актуальность knowledge-базы.
 * @returns {object}
 */
function checkMemoryHealth() {
  let totalFiles = 0;
  let staleFiles = 0;
  const staleThresholdMin = 7 * 24 * 60; // 7 дней

  function countDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          countDir(full);
        } else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
          totalFiles++;
          if (fileAgeMinutes(full) > staleThresholdMin) staleFiles++;
        }
      }
    } catch {
      // директория недоступна — пропускаем
    }
  }

  if (fs.existsSync(KNOWLEDGE_DIR)) countDir(KNOWLEDGE_DIR);

  const indexAgeMin = fileAgeMinutes(KNOWLEDGE_INDEX_PATH);
  const indexStale = indexAgeMin > staleThresholdMin;

  return {
    totalFiles,
    staleFiles,
    indexAgeMin: indexAgeMin === Infinity ? null : Math.round(indexAgeMin),
    indexStale,
  };
}

// -- Измерение 7: Notification Health -----------------------------------------

/**
 * Анализирует состояние notification-throttle.
 * @returns {object}
 */
function checkNotificationHealth() {
  const state = readJson(THROTTLE_STATE_PATH);
  if (!state) return { available: false };

  const today = new Date().toISOString().slice(0, 10);
  let sentToday = 0;
  let queued = 0;
  let dedupHits = 0;

  // sent — массив отправленных (с timestamp)
  for (const entry of state.sent || []) {
    const ts = entry.timestamp || entry.ts;
    if (!ts) continue;
    const tsStr = typeof ts === "number" ? new Date(ts).toISOString() : String(ts);
    if (tsStr.startsWith(today)) sentToday++;
  }

  queued = (state.queue || []).length;
  dedupHits = state.dedupHits || 0;

  return {
    available: true,
    sentToday,
    queued,
    dedupHits,
    highDedup: dedupHits > 20,
  };
}

// -- Агрегатный анализ --------------------------------------------------------

/**
 * Запускает все проверки, возвращает полный отчёт.
 * @returns {Promise<object>}
 */
async function runAnalysis() {
  const start = Date.now();

  // farm-state может быть недоступен (API офлайн) — обрабатываем gracefully
  let farmState = { sales: [], expenses: [], inventory: [], clients: [] };
  try {
    farmState = await getState();
  } catch (err) {
    // продолжаем с пустым state
  }

  const syntax = checkScriptSyntax();
  const cron = checkCronReliability();
  const data = checkDataQuality(farmState);
  const tasks = checkTaskManagement();
  const lessons = checkLessonsPatterns();
  const memory = checkMemoryHealth();
  const notif = checkNotificationHealth();

  const duration = Date.now() - start;

  return {
    syntax,
    cron,
    data,
    tasks,
    lessons,
    memory,
    notif,
    duration,
    timestamp: new Date().toISOString(),
  };
}

// -- Скоринг ------------------------------------------------------------------

/**
 * Вычисляет итоговый балл здоровья 0-100.
 * @param {object} analysis
 * @returns {object}
 */
function computeHealthScore(analysis) {
  const { syntax, cron, data, tasks } = analysis;

  // Script syntax: /20
  const syntaxScore = Math.max(0, 20 - syntax.fail * 2);

  // Cron reliability: /20
  const cronScore = Math.max(0, 20 - cron.stale * 4);

  // Data quality: /20 (expenses 70% + sales 30%)
  const dataScore = Math.round((data.expenseCoverage / 100) * 14 + (data.salesCoverage / 100) * 6);

  // Task management: /20 (completion 10 + review rate 5 + quality 5)
  let taskScore = 10;
  if (tasks.available) {
    const completionPart = Math.round((tasks.completionRate / 100) * 10);
    const reviewRate = tasks.done > 0 ? 1 - tasks.unreviewed / tasks.done : 1;
    const reviewPart = Math.round(reviewRate * 5);
    const qualityPart = Math.round(Math.min(tasks.avgQuality / 5, 1) * 5);
    taskScore = completionPart + reviewPart + qualityPart;
  }

  // System uptime: /20 — проверяем здоровье через существующие индикаторы
  // (Sheets API, Docker, memory)
  let uptimeScore = 20;
  const healthFile = readJson("/tmp/health-status.json");
  if (healthFile) {
    const errors = (healthFile.services || []).filter((s) => s.status === "error").length;
    uptimeScore = Math.max(0, 20 - errors * 5);
  }

  const total = Math.min(100, syntaxScore + cronScore + dataScore + taskScore + uptimeScore);

  return {
    total,
    breakdown: {
      syntax: { score: syntaxScore, max: 20, label: "Script Syntax" },
      cron: { score: cronScore, max: 20, label: "Cron Reliability" },
      data: { score: dataScore, max: 20, label: "Data Quality" },
      tasks: { score: taskScore, max: 20, label: "Task Management" },
      uptime: { score: uptimeScore, max: 20, label: "System Uptime" },
    },
  };
}

// -- Рекомендации -------------------------------------------------------------

/**
 * Генерирует список рекомендаций по результатам анализа.
 * @param {object} analysis
 * @returns {object[]}
 */
function generateRecommendations(analysis) {
  const { syntax, cron, data, tasks, lessons, memory } = analysis;
  /** @type {{priority: "CRITICAL"|"IMPROVE"|"OPTIMIZE", what: string, why: string, how: string, impact: string}[]} */
  const recs = [];

  // --- CRITICAL ---

  if (syntax.fail > 0) {
    recs.push({
      priority: "CRITICAL",
      what: `Синтаксические ошибки в ${syntax.fail} скрипт(ах)`,
      why: `Файлы: ${syntax.failures.join(", ")}`,
      how: `node --check <файл>.cjs && исправить ошибки`,
      impact: "Скрипты не запустятся при следующем вызове",
    });
  }

  if (data.expenseCoverage < 50) {
    recs.push({
      priority: "CRITICAL",
      what: `Расходы вносятся только ${data.expenseCoverage}% дней`,
      why: `Маржа показывает ~100% (нереально без расходов)`,
      how: `pepino expense "описание сумма"`,
      impact: "+50% точность P&L",
    });
  }

  const staleCritical = cron.results.filter((r) => r.stale && r.name === "farm-state.log");
  if (staleCritical.length > 0) {
    recs.push({
      priority: "CRITICAL",
      what: "farm-state кеш не обновляется",
      why: `Последнее обновление: ${staleCritical[0].ageMin} мин назад (лимит: ${staleCritical[0].thresholdMin} мин)`,
      how: `node /home/roman/openclaw/skills/pepino-google-sheets/farm-state.cjs refresh`,
      impact: "Все скрипты читают устаревшие данные",
    });
  }

  // --- IMPROVE ---

  if (data.expenseCoverage >= 50 && data.expenseCoverage < 80) {
    recs.push({
      priority: "IMPROVE",
      what: `Расходы вносятся ${data.expenseCoverage}% дней (цель: 80%)`,
      why: "P&L неточный, маржа завышена",
      how: `pepino expense "описание сумма"`,
      impact: "+20% точность отчётности",
    });
  }

  if (tasks.available && tasks.unreviewed > 3) {
    recs.push({
      priority: "IMPROVE",
      what: `${tasks.unreviewed} задач без ревью`,
      why: "Теряем lessons learned, не видим тренды качества",
      how: `node task-brain.cjs review`,
      impact: "+20% эффективность планирования",
    });
  }

  if (tasks.available && tasks.overdue > 0) {
    recs.push({
      priority: "IMPROVE",
      what: `${tasks.overdue} просроченных задач`,
      why: "Накапливается технический долг",
      how: `node task-brain.cjs matrix   # пересмотреть приоритеты`,
      impact: "Снижение стресса, чистый бэклог",
    });
  }

  const staleOther = cron.results.filter((r) => r.stale && r.name !== "farm-state.log");
  for (const staleCron of staleOther.slice(0, 3)) {
    recs.push({
      priority: "IMPROVE",
      what: `Стал лог: ${staleCron.name}`,
      why: staleCron.missing
        ? "Файл не создан — скрипт не запускался"
        : `Последнее обновление ${staleCron.ageMin} мин назад (лимит: ${staleCron.thresholdMin} мин)`,
      how: `Проверить crontab -l | grep ${staleCron.name.replace(".log", "")}`,
      impact: "Восстановить надёжность мониторинга",
    });
  }

  if (lessons.available && lessons.themes && lessons.themes.length > 0) {
    const topTheme = lessons.themes[0];
    recs.push({
      priority: "IMPROVE",
      what: `Повторяющаяся тема в уроках: "${topTheme.word}" (${topTheme.count}× )`,
      why: "Системная проблема, требующая решения, а не очередного урока",
      how: `node task-brain.cjs add "Решить системно: ${topTheme.word}"`,
      impact: "Прекратить повторение одинаковых ошибок",
    });
  }

  // --- OPTIMIZE ---

  if (memory.indexStale) {
    recs.push({
      priority: "OPTIMIZE",
      what: `Knowledge index устарел (${memory.indexAgeMin != null ? Math.round(memory.indexAgeMin / 60 / 24) + " дн." : "N/A"})`,
      why: "Поиск возвращает неактуальные результаты",
      how: `node knowledge-search.cjs reindex`,
      impact: "Более точный контекст для агентов",
    });
  }

  if (data.zeroStockCount > 0) {
    recs.push({
      priority: "OPTIMIZE",
      what: `${data.zeroStockCount} позиций с нулевым остатком`,
      why: "Потенциальные упущенные продажи",
      how: `Пополнить запасы или убрать из активного ассортимента`,
      impact: "Снизить число отказов клиентам",
    });
  }

  if (tasks.available && tasks.avgQuality > 0 && tasks.avgQuality < 3.5) {
    recs.push({
      priority: "OPTIMIZE",
      what: `Средняя оценка задач: ${tasks.avgQuality}/5`,
      why: "Качество выполнения ниже ожидаемого",
      how: `node task-brain.cjs review --week   # анализ причин`,
      impact: "Выявить системные барьеры",
    });
  }

  return recs;
}

// -- Форматирование -----------------------------------------------------------

/** Полоска прогресса для вывода score */
function scoreBar(score, max) {
  const pct = score / max;
  const filled = Math.round(pct * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/**
 * Форматирует результат `analyze` в читаемый текст.
 * @param {object} analysis
 * @returns {string}
 */
function formatAnalysis(analysis) {
  const { syntax, cron, data, tasks, lessons, memory, notif, duration } = analysis;
  const lines = [];

  lines.push("*АНАЛИЗ СИСТЕМЫ PEPINO PICK*");
  lines.push(
    `_${new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}_`,
  );
  lines.push("");

  // Script Syntax
  lines.push(`*1. Синтаксис скриптов* (${syntax.pass}/${syntax.total})`);
  if (syntax.fail === 0) {
    lines.push(`  OK — все ${syntax.total} .cjs файлов проходят проверку`);
  } else {
    lines.push(`  ОШИБКИ: ${syntax.failures.join(", ")}`);
  }

  // Cron
  lines.push("");
  lines.push(`*2. Надёжность cron* (${cron.fresh}/${cron.total} свежих)`);
  for (const r of cron.results) {
    const icon = r.stale ? "STALE" : "OK";
    const age = r.missing ? "нет файла" : `${r.ageMin} мин назад`;
    lines.push(`  ${icon}  ${r.name.replace(".log", "")}: ${age}`);
  }

  // Data Quality
  lines.push("");
  lines.push("*3. Качество данных*");
  lines.push(`  Продажи: ${data.salesCoverage}% дней (${data.salesDaysEntered}/${data.totalDays})`);
  lines.push(
    `  Расходы: ${data.expenseCoverage}% дней (${data.expenseDaysEntered}/${data.totalDays})`,
  );
  lines.push(`  Нулевой остаток: ${data.zeroStockCount} позиций`);
  lines.push(`  Неактивных клиентов: ${data.dormantClients}`);

  // Tasks
  lines.push("");
  lines.push("*4. Задачи*");
  if (tasks.available) {
    lines.push(`  Всего: ${tasks.total} | Открытых: ${tasks.open} | Выполнено: ${tasks.done}`);
    lines.push(`  Просроченных: ${tasks.overdue} | Без ревью: ${tasks.unreviewed}`);
    lines.push(`  Выполнение: ${tasks.completionRate}% | Ср. оценка: ${tasks.avgQuality}/5`);
  } else {
    lines.push("  Бэклог не найден");
  }

  // Lessons
  lines.push("");
  lines.push("*5. Уроки*");
  if (lessons.available) {
    lines.push(`  Всего: ${lessons.count} | Тренд качества: ${lessons.qualityTrend}`);
    if (lessons.themes && lessons.themes.length > 0) {
      lines.push(
        `  Повторяющиеся темы: ${lessons.themes.map((t) => `${t.word}(${t.count})`).join(", ")}`,
      );
    }
    const topDomain = Object.entries(lessons.domains || {}).sort((a, b) => b[1] - a[1])[0];
    if (topDomain) lines.push(`  Топ-домен: ${topDomain[0]} (${topDomain[1]} уроков)`);
  } else {
    lines.push("  Файл уроков не найден");
  }

  // Memory
  lines.push("");
  lines.push("*6. Memory Health*");
  lines.push(`  Файлов в knowledge: ${memory.totalFiles}`);
  lines.push(`  Устаревших файлов: ${memory.staleFiles}`);
  lines.push(`  Knowledge index: ${memory.indexStale ? "устарел" : "актуален"}`);

  // Notifications
  lines.push("");
  lines.push("*7. Уведомления*");
  if (notif.available) {
    lines.push(`  Отправлено сегодня: ${notif.sentToday} | В очереди: ${notif.queued}`);
    if (notif.highDedup)
      lines.push(`  ВНИМАНИЕ: высокий dedup (${notif.dedupHits}) — скрипты дублируются?`);
  } else {
    lines.push("  Throttle state недоступен");
  }

  lines.push("");
  lines.push(`_Анализ выполнен за ${duration} мс_`);

  return lines.join("\n");
}

/**
 * Форматирует health-score.
 * @param {object} score
 * @param {object} analysis
 * @returns {string}
 */
function formatHealth(score, analysis) {
  const { data, tasks, syntax } = analysis;
  const lines = [];

  const grade =
    score.total >= 90
      ? "Отлично"
      : score.total >= 75
        ? "Хорошо"
        : score.total >= 60
          ? "Требует внимания"
          : "Критично";

  lines.push(`*ЗДОРОВЬЕ СИСТЕМЫ: ${score.total}/100 — ${grade}*`);
  lines.push("");

  for (const [, dim] of Object.entries(score.breakdown)) {
    const bar = scoreBar(dim.score, dim.max);
    lines.push(`${bar} ${dim.score}/${dim.max} ${dim.label}`);
  }

  // Топ-3 рекомендации
  const recs = generateRecommendations(analysis);
  const critical = recs.filter((r) => r.priority === "CRITICAL");
  const improve = recs.filter((r) => r.priority === "IMPROVE");
  const top3 = [...critical, ...improve].slice(0, 3);

  if (top3.length > 0) {
    lines.push("");
    lines.push("*Приоритетные действия:*");
    top3.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.what}`);
      lines.push(`   → ${r.how}`);
    });
  }

  return lines.join("\n");
}

/**
 * Форматирует рекомендации.
 * @param {object[]} recs
 * @returns {string}
 */
function formatRecommendations(recs) {
  if (recs.length === 0) return "*Рекомендаций нет — система в отличном состоянии!*";

  const lines = ["*РЕКОМЕНДАЦИИ ПО УЛУЧШЕНИЮ*", ""];

  const critical = recs.filter((r) => r.priority === "CRITICAL");
  const improve = recs.filter((r) => r.priority === "IMPROVE");
  const optimize = recs.filter((r) => r.priority === "OPTIMIZE");

  if (critical.length > 0) {
    lines.push("CRITICAL:");
    critical.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.what}`);
      lines.push(`   Почему: ${r.why}`);
      lines.push(`   Как: \`${r.how}\``);
      lines.push(`   Impact: ${r.impact}`);
    });
  }

  if (improve.length > 0) {
    if (critical.length > 0) lines.push("");
    lines.push("УЛУЧШИТЬ:");
    improve.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.what}`);
      lines.push(`   Почему: ${r.why}`);
      lines.push(`   Как: \`${r.how}\``);
      lines.push(`   Impact: ${r.impact}`);
    });
  }

  if (optimize.length > 0) {
    if (critical.length + improve.length > 0) lines.push("");
    lines.push("ОПТИМИЗИРОВАТЬ:");
    optimize.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.what}`);
      lines.push(`   Как: \`${r.how}\``);
    });
  }

  return lines.join("\n");
}

/**
 * Форматирует уроки, сгруппированные по доменам.
 * @param {object} lessonsData
 * @returns {string}
 */
function formatLessons(lessonsData) {
  if (!lessonsData.available || lessonsData.count === 0) {
    return "*Уроки ещё не накоплены*\nДобавляйте: `node task-brain.cjs done 'задача' --lesson 'текст'`";
  }

  const list = lessonsData.list || [];
  const lines = [`*LESSONS LEARNED (всего: ${list.length})*`, ""];

  // Группировка по доменам
  /** @type {Record<string, object[]>} */
  const byDomain = {};
  for (const lesson of list) {
    const domain = lesson.domain || "other";
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(lesson);
  }

  const domainIcons = {
    operations: "Операции",
    finance: "Финансы",
    production: "Производство",
    sales: "Продажи",
    marketing: "Маркетинг",
    logistics: "Логистика",
    hr: "Команда",
    strategy: "Стратегия",
    other: "Разное",
  };

  for (const [domain, domainLessons] of Object.entries(byDomain).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const label = domainIcons[domain] || domain;
    lines.push(`*${label} (${domainLessons.length}):*`);
    for (const lesson of domainLessons.slice(0, 5)) {
      const title = lesson.title || lesson.text || lesson.content || "(без названия)";
      const dateStr = lesson.date ? ` (${lesson.date.slice(0, 10)})` : "";
      const tags = lesson.tags
        ? ` [${(Array.isArray(lesson.tags) ? lesson.tags : [lesson.tags]).join(", ")}]`
        : "";
      lines.push(`  - "${title.slice(0, 80)}"${tags}${dateStr}`);
    }
    if (domainLessons.length > 5) lines.push(`  ...ещё ${domainLessons.length - 5}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// -- CLI Entry Point ----------------------------------------------------------

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const cmd = args[0] || "health";

  const startMs = Date.now();

  if (cmd === "analyze") {
    const analysis = await runAnalysis();
    const text = formatAnalysis(analysis);
    process.stdout.write(text + "\n");

    if (!DRY_RUN) {
      await sendThrottled(text, { thread: TOPIC_STRATEGY, priority: "normal" });
    } else {
      process.stdout.write("[dry-run] Telegram не отправлен\n");
    }

    await trace({
      name: "self-improve:analyze",
      input: { command: "analyze", dryRun: DRY_RUN },
      output: { scriptFail: analysis.syntax.fail, staleCron: analysis.cron.stale },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets" },
    });
  } else if (cmd === "health") {
    const analysis = await runAnalysis();
    const score = computeHealthScore(analysis);
    const text = formatHealth(score, analysis);
    process.stdout.write(text + "\n");

    if (!DRY_RUN) {
      await sendThrottled(text, { thread: TOPIC_STRATEGY, priority: "normal" });
    } else {
      process.stdout.write("[dry-run] Telegram не отправлен\n");
    }

    await trace({
      name: "self-improve:health",
      input: { command: "health", dryRun: DRY_RUN },
      output: { total: score.total, breakdown: score.breakdown },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets" },
    });
  } else if (cmd === "recommendations") {
    const analysis = await runAnalysis();
    const recs = generateRecommendations(analysis);
    const text = formatRecommendations(recs);
    process.stdout.write(text + "\n");

    if (!DRY_RUN) {
      await sendThrottled(text, { thread: TOPIC_STRATEGY, priority: "normal" });
    } else {
      process.stdout.write("[dry-run] Telegram не отправлен\n");
    }

    await trace({
      name: "self-improve:recommendations",
      input: { command: "recommendations", dryRun: DRY_RUN },
      output: {
        total: recs.length,
        critical: recs.filter((r) => r.priority === "CRITICAL").length,
      },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets" },
    });
  } else if (cmd === "lessons") {
    // Уроки не требуют полного анализа
    const lessonsData = checkLessonsPatterns();
    const text = formatLessons(lessonsData);
    process.stdout.write(text + "\n");

    if (!DRY_RUN) {
      await sendThrottled(text, { thread: TOPIC_STRATEGY, priority: "normal" });
    } else {
      process.stdout.write("[dry-run] Telegram не отправлен\n");
    }

    await trace({
      name: "self-improve:lessons",
      input: { command: "lessons", dryRun: DRY_RUN },
      output: { count: lessonsData.count },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets" },
    });
  } else {
    process.stderr.write(`Неизвестная команда: ${cmd}\n`);
    process.stderr.write(
      "Использование: node self-improve.cjs [analyze|lessons|recommendations|health] [--dry-run]\n",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`self-improve.cjs: ${err.message}\n`);
  process.exit(1);
});
