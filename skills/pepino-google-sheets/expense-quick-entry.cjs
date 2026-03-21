#!/usr/bin/env node
/**
 * Pepino Pick -- Быстрый ввод расходов из CLI / Telegram
 *
 * Решает проблему "расходы не внесены" (маржа показывает 100%).
 *
 * Формат листа "💰 Расходы":
 *   [Дата, Наименование, Кол-во, Единицы, Сумма ARS, Курс USD, Сумма USD]
 *
 * Примеры:
 *   node expense-quick-entry.cjs "субстрат 5000"
 *   node expense-quick-entry.cjs "доставка 3500 наличные"
 *   node expense-quick-entry.cjs "зарплата Мигель 45000"
 *   node expense-quick-entry.cjs "электричество 12000 перевод"
 *   node expense-quick-entry.cjs --list       # расходы за сегодня
 *   node expense-quick-entry.cjs --week       # итоги за неделю по категориям
 *
 * Cron: не предусмотрен (ручной инструмент)
 */

"use strict";

const { trace } = require("./langfuse-trace.cjs");

// ── Настройки ───────────────────────────────────────────────────────────────

const EXPENSES_SHEET = "\u{1F4B0} Расходы";

/** Курс USD — берём live из currency-updater, fallback 1435 */
let DEFAULT_EXCHANGE_RATE = 1435;
try {
  const { getBlueRate } = require("./currency-updater.cjs");
  DEFAULT_EXCHANGE_RATE = getBlueRate(1435);
} catch {
  /* fallback */
}

// ── Категории: ключевые слова → каноническое название ────────────────────

/** @type {Record<string, string[]>} категория → массив ключевых слов */
const CATEGORY_KEYWORDS = {
  Топливо: ["дизель", "бензин", "газ", "топливо", "нафта", "gasoil", "nafta"],
  Материалы: [
    "субстрат",
    "земля",
    "семена",
    "удобрение",
    "торф",
    "перлит",
    "агроволокно",
    "укрывной",
    "пленка",
    "плёнка",
    "мульча",
    "компост",
  ],
  Логистика: ["доставка", "транспорт", "фрахт", "flete", "envio", "перевозка", "грузчик"],
  Персонал: ["зарплата", "расчет", "расчёт", "оплата труда", "аванс", "бонус", "premio"],
  Коммунальные: [
    "электричество",
    "свет",
    "вода",
    "газ природный",
    "интернет",
    "связь",
    "телефон",
    "luz",
    "agua",
  ],
  "Защита растений": [
    "защита",
    "пестицид",
    "фунгицид",
    "инсектицид",
    "гербицид",
    "опрыскиватель",
    "обработка",
  ],
  Проживание: ["проживание", "пьяхе", "пьяхи", "аренда", "alquiler", "жилье", "жильё"],
  Упаковка: [
    "контейнер",
    "ведро",
    "ведра",
    "фляжка",
    "фляжки",
    "крышка",
    "крышки",
    "пакет",
    "коробка",
    "ящик",
    "лоток",
    "упаковка",
  ],
  Ремонт: [
    "ремонт",
    "замена",
    "починка",
    "запчасть",
    "ремнабор",
    "шланг",
    "насос",
    "труба",
    "кран",
    "вентиль",
    "инжектор",
    "диафрагма",
    "correa",
  ],
  Стройматериалы: ["доска", "доски", "профиль", "сетка", "проволока", "гвозди", "саморез"],
  Техника: [
    "масло",
    "ТО ",
    "фильтр",
    "квадрацикл",
    "квадроцикл",
    "трактор",
    "мотоблок",
    "генератор",
  ],
  Прочее: [],
};

/** Способы оплаты: ключевые слова → каноническое название */
const PAYMENT_KEYWORDS = {
  наличные: ["наличные", "нал", "cash", "efectivo", "кэш"],
  перевод: ["перевод", "transfer", "transferencia", "безнал", "банк"],
  карта: ["карта", "card", "tarjeta", "дебетовая", "кредитная"],
};

// ── Хелперы ─────────────────────────────────────────────────────────────────

/**
 * Определяет категорию по описанию расхода.
 * @param {string} text - описание расхода
 * @returns {string} каноническое название категории
 */
function detectCategory(text) {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === "Прочее") continue;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return category;
    }
  }
  return "Прочее";
}

/**
 * Определяет способ оплаты по тексту.
 * @param {string} text
 * @returns {string} способ оплаты
 */
function detectPaymentMethod(text) {
  const lower = text.toLowerCase();
  for (const [method, keywords] of Object.entries(PAYMENT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return method;
    }
  }
  return "наличные";
}

/**
 * Извлекает сумму из текста.
 * Ищет числа, игнорируя числа которые очевидно являются количеством (1-9 перед "шт"/"кг"/"л").
 * @param {string} text
 * @returns {number|null}
 */
function extractAmount(text) {
  // Убираем слова со способом оплаты, чтобы не мешали
  let cleaned = text;
  for (const keywords of Object.values(PAYMENT_KEYWORDS)) {
    for (const kw of keywords) {
      // \b не работает с кириллицей -- используем пробельные границы
      cleaned = cleaned.replace(new RegExp(`(?<=^|\\s)${kw}(?=$|\\s)`, "gi"), "");
    }
  }

  // Ищем все числа
  const numbers = [];
  const re = /(\d[\d\s.,]*\d|\d+)/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const raw = match[1].replace(/\s/g, "").replace(",", ".");
    const num = parseFloat(raw);
    if (!isNaN(num) && num > 0) numbers.push(num);
  }

  if (numbers.length === 0) return null;

  // Берём наибольшее число как сумму (суммы обычно больше количества)
  return Math.max(...numbers);
}

/**
 * Очищает описание от суммы и способа оплаты, оставляя суть.
 * @param {string} text
 * @param {number} amount
 * @param {string} paymentMethod
 * @returns {string}
 */
function cleanDescription(text, amount, paymentMethod) {
  let desc = text;

  // Убираем сумму (с кириллическими границами вместо \b)
  const amountStr = String(amount);
  desc = desc.replace(new RegExp(`(?<=^|\\s)${amountStr}(?=$|\\s)`), "").trim();

  // Убираем способ оплаты
  for (const keywords of Object.values(PAYMENT_KEYWORDS)) {
    for (const kw of keywords) {
      desc = desc.replace(new RegExp(`(?<=^|\\s)${kw}(?=$|\\s)`, "gi"), "").trim();
    }
  }

  // Убираем лишние пробелы
  desc = desc.replace(/\s{2,}/g, " ").trim();

  return desc || text;
}

/**
 * Безопасное извлечение числа из строки.
 * @param {*} val
 * @returns {number}
 */
function parseNum(val) {
  if (val === undefined || val === null || val === "") return 0;
  const cleaned = String(val)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.\-]/g, "");
  return parseFloat(cleaned) || 0;
}

/**
 * Форматирует дату как YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Преобразует массив строк из Sheets в массив объектов (первая строка — заголовки).
 * @param {string[][]} rows
 * @returns {Record<string, string>[]}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((/** @type {string} */ h) => String(h).trim());
  return rows.slice(1).map((row) => {
    /** @type {Record<string, string>} */
    const obj = {};
    headers.forEach((key, i) => {
      obj[key] = row[i] ?? "";
    });
    return obj;
  });
}

// ── Парсинг входных данных ──────────────────────────────────────────────────

/**
 * Парсит текстовый ввод в структурированный расход.
 * @param {string} input - "субстрат 5000", "зарплата Мигель 45000 перевод"
 * @returns {{ description: string, category: string, amount: number, paymentMethod: string } | null}
 */
function parseExpenseInput(input) {
  if (!input || !input.trim()) return null;

  const text = input.trim();
  const amount = extractAmount(text);

  if (!amount || amount <= 0) {
    return null;
  }

  const paymentMethod = detectPaymentMethod(text);
  const category = detectCategory(text);
  const description = cleanDescription(text, amount, paymentMethod);

  return { description, category, amount, paymentMethod };
}

// ── Команды ─────────────────────────────────────────────────────────────────

/**
 * Записывает расход в Google Sheets.
 * Формат строки: [Дата, Наименование, Кол-во, Единицы, Сумма ARS, Курс USD, Сумма USD]
 * @param {{ description: string, category: string, amount: number, paymentMethod: string }} expense
 */
async function writeExpense(expense) {
  const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");

  const today = fmtDate(new Date());
  const exchangeRate = DEFAULT_EXCHANGE_RATE;
  const amountUsd = (expense.amount / exchangeRate).toFixed(2).replace(".", ",");

  // Наименование включает категорию и способ оплаты для удобства поиска
  const name = `${expense.description} [${expense.category}] (${expense.paymentMethod})`;

  const row = [
    today, // Дата
    name, // Наименование
    "1", // Кол-во
    "шт", // Единицы
    String(expense.amount), // Сумма ARS
    String(exchangeRate), // Курс USD
    amountUsd, // Сумма USD
  ];

  await appendToSheet(PEPINO_SHEETS_ID, [row], EXPENSES_SHEET);

  return { row, sheetUrl: `https://docs.google.com/spreadsheets/d/${PEPINO_SHEETS_ID}` };
}

/**
 * Показывает расходы за сегодня.
 */
async function listToday() {
  const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
  const rows = await readSheet(PEPINO_SHEETS_ID, EXPENSES_SHEET);
  const expenses = rowsToObjects(rows);

  const today = fmtDate(new Date());
  const todayExpenses = expenses.filter((e) => {
    const d = (e["Дата"] || "").trim();
    return d === today;
  });

  if (todayExpenses.length === 0) {
    console.log(`\nРасходы за ${today}: нет записей`);
    console.log('Используйте: node expense-quick-entry.cjs "описание сумма"');
    return;
  }

  let total = 0;
  console.log(`\nРасходы за ${today}:`);
  console.log("-".repeat(60));

  for (const exp of todayExpenses) {
    const name = exp["Наименование"] || "";
    const amount = parseNum(exp["Сумма ARS"]);
    total += amount;
    console.log(`  ${name}: ${amount.toLocaleString("ru-RU")} ARS`);
  }

  console.log("-".repeat(60));
  console.log(`  ИТОГО: ${total.toLocaleString("ru-RU")} ARS (${todayExpenses.length} записей)`);
}

/**
 * Показывает итоги за неделю, сгруппированные по категориям.
 */
async function showWeekSummary() {
  const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
  const rows = await readSheet(PEPINO_SHEETS_ID, EXPENSES_SHEET);
  const expenses = rowsToObjects(rows);

  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = fmtDate(weekAgo);
  const todayStr = fmtDate(today);

  const weekExpenses = expenses.filter((e) => {
    const d = (e["Дата"] || "").trim();
    return d >= weekAgoStr && d <= todayStr;
  });

  if (weekExpenses.length === 0) {
    console.log(`\nРасходы за неделю (${weekAgoStr} - ${todayStr}): нет записей`);
    return;
  }

  // Группировка по категориям (определяем по наименованию)
  /** @type {Record<string, { total: number, count: number, items: string[] }>} */
  const byCategory = {};
  let grandTotal = 0;

  for (const exp of weekExpenses) {
    const name = exp["Наименование"] || "";
    const amount = parseNum(exp["Сумма ARS"]);
    grandTotal += amount;

    // Пробуем извлечь категорию из квадратных скобок (наш формат)
    const bracketMatch = name.match(/\[([^\]]+)\]/);
    const category = bracketMatch ? bracketMatch[1] : detectCategory(name);

    if (!byCategory[category]) {
      byCategory[category] = { total: 0, count: 0, items: [] };
    }
    byCategory[category].total += amount;
    byCategory[category].count += 1;
    byCategory[category].items.push(
      `${exp["Дата"]}: ${name} -- ${amount.toLocaleString("ru-RU")} ARS`,
    );
  }

  // Сортировка по сумме (убывание)
  const sorted = Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total);

  console.log(`\nРасходы за неделю (${weekAgoStr} - ${todayStr}):`);
  console.log("=".repeat(60));

  for (const [category, data] of sorted) {
    const pct = grandTotal > 0 ? Math.round((data.total / grandTotal) * 100) : 0;
    console.log(
      `\n  ${category}: ${data.total.toLocaleString("ru-RU")} ARS (${pct}%, ${data.count} записей)`,
    );
    for (const item of data.items) {
      console.log(`    - ${item}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(
    `  ИТОГО: ${grandTotal.toLocaleString("ru-RU")} ARS (${weekExpenses.length} записей)`,
  );

  const avgDaily = grandTotal / 7;
  console.log(`  Среднедневной: ${Math.round(avgDaily).toLocaleString("ru-RU")} ARS`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const args = process.argv.slice(2);

  // Режим --list: показать расходы за сегодня
  if (args.includes("--list")) {
    await listToday();
    return;
  }

  // Режим --week: показать итоги за неделю
  if (args.includes("--week")) {
    await showWeekSummary();
    return;
  }

  // Режим --help
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
Pepino Pick -- Быстрый ввод расходов

Использование:
  node expense-quick-entry.cjs "описание сумма [способ_оплаты]"
  node expense-quick-entry.cjs --list       показать расходы за сегодня
  node expense-quick-entry.cjs --week       итоги за неделю по категориям
  node expense-quick-entry.cjs --help       эта справка

Примеры:
  node expense-quick-entry.cjs "субстрат 5000"
  node expense-quick-entry.cjs "доставка 3500 наличные"
  node expense-quick-entry.cjs "зарплата Мигель 45000 перевод"
  node expense-quick-entry.cjs "электричество 12000"
  node expense-quick-entry.cjs "дизель 30л 52000"

Категории (автоопределение):
  Топливо, Материалы, Логистика, Персонал, Коммунальные,
  Защита растений, Проживание, Упаковка, Ремонт, Стройматериалы,
  Техника, Прочее

Способы оплаты: наличные (по умолчанию), перевод, карта
`);
    return;
  }

  // Основной режим: запись расхода
  const input = args.join(" ");
  const expense = parseExpenseInput(input);

  if (!expense) {
    console.error("[ERROR] Не удалось распознать сумму. Убедитесь, что в тексте есть число.");
    console.error('Пример: node expense-quick-entry.cjs "субстрат 5000"');
    process.exit(1);
  }

  console.log(`\nРаспознано:`);
  console.log(`  Описание:     ${expense.description}`);
  console.log(`  Категория:    ${expense.category}`);
  console.log(`  Сумма:        ${expense.amount.toLocaleString("ru-RU")} ARS`);
  console.log(`  Оплата:       ${expense.paymentMethod}`);

  try {
    const result = await writeExpense(expense);
    console.log(`\n[OK] Расход записан в "${EXPENSES_SHEET}"`);
    console.log(`  Строка: ${JSON.stringify(result.row)}`);
    console.log(`  Sheets: ${result.sheetUrl}`);
  } catch (err) {
    console.error(`\n[ERROR] Не удалось записать расход: ${err.message}`);
    process.exit(1);
  }

  // Langfuse trace
  await trace({
    name: "expense-quick-entry",
    input: { raw: input },
    output: {
      description: expense.description,
      category: expense.category,
      amount_ars: expense.amount,
      payment_method: expense.paymentMethod,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", script: "expense-quick-entry" },
  }).catch(() => {});
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
