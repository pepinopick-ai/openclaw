#!/usr/bin/env node
/**
 * Pepino Pick — Historical Data Migration
 * Source: 1lH1LNi7MDhi_aN4UZVfmexhinERjsn70X0JDVU9_GQw
 * Target: 1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc
 *
 * Migration mapping:
 *   Огурцы          → 🌿 Производство (daily cucumber harvest)
 *   Томаты          → 🌿 Производство (tomato harvest)
 *   Соленые огурцы   → 📦 Склад (pickled cucumbers)
 *   Соленые томаты   → 📦 Склад (pickled tomatoes)
 *   Квашенная капуста → 📦 Склад (sauerkraut)
 *   Продажи         → 🛒 Продажи (all sales)
 *   Расходы         → 💰 Расходы (all expenses)
 *   логистика       → логистика (new sheet, as-is)
 *   Клиенты         → Клиенты (client database)
 *   Тележка         → 🛒 Продажи (client: Тележка)
 *   Гастроном1      → 🛒 Продажи (client: Гастроном1)
 *   У Беларуса      → 🛒 Продажи (client: У Беларуса)
 */

import { readFileSync } from "fs";
import {
  readSheet,
  writeToSheet,
  appendToSheet,
  clearSheet,
  createSheetIfNotExists,
  PEPINO_SHEETS_ID,
} from "./sheets.js";

const SOURCE_ID = "1lH1LNi7MDhi_aN4UZVfmexhinERjsn70X0JDVU9_GQw";
const source = JSON.parse(readFileSync("/tmp/pepino-source-data.json", "utf-8"));

// ── Date parsing ─────────────────────────────────────────────────────────────

const SPANISH_MONTHS = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

function parseDate(raw) {
  if (!raw || raw === "") return "";
  const s = raw.toString().trim();

  // "sábado, noviembre 15, 2025" or "lunes, diciembre 8, 2025"
  const spanishMatch = s.match(/\w+,\s+(\w+)\s+(\d+),\s+(\d{4})/);
  if (spanishMatch) {
    const month = SPANISH_MONTHS[spanishMatch[1].toLowerCase()];
    if (month) {
      const day = spanishMatch[2].padStart(2, "0");
      return `${spanishMatch[3]}-${month}-${day}`;
    }
  }

  // "04.11.2025" or "04/11/2025"
  const dotMatch = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dotMatch) {
    const day = dotMatch[1].padStart(2, "0");
    const month = dotMatch[2].padStart(2, "0");
    return `${dotMatch[3]}-${month}-${day}`;
  }

  // "28/12/2025" or "3/2/2026" (d/m/yyyy)
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, "0");
    const month = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  // "20/03/2026" (dd/mm/yyyy)
  const ddmmMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmMatch) {
    return `${ddmmMatch[3]}-${ddmmMatch[2]}-${ddmmMatch[1]}`;
  }

  // "18.02" (dd.mm, assume current year or 2026)
  const shortMatch = s.match(/^(\d{1,2})[./](\d{1,2})$/);
  if (shortMatch) {
    const day = shortMatch[1].padStart(2, "0");
    const month = shortMatch[2].padStart(2, "0");
    return `2026-${month}-${day}`;
  }

  // Already yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return s; // return as-is if can't parse
}

// ── Number parsing (Argentine format) ────────────────────────────────────────

function parseNum(raw) {
  if (!raw || raw === "" || raw === "-") return "";
  let s = raw.toString().trim();
  // Remove $ sign and spaces
  s = s.replace(/^\$\s*/, "").replace(/\s/g, "");
  // "$2.500,00" → "2500.00" (dots are thousands, comma is decimal)
  // First check if it has both dots and comma → Argentine format
  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",") && !s.includes(".")) {
    // "0,58" → "0.58"
    s = s.replace(",", ".");
  }
  // Remove any remaining non-numeric except dot and minus
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? "" : n;
}

function formatNum(n) {
  if (n === "" || n === null || n === undefined) return "";
  return typeof n === "number" ? n : n;
}

// ── Migration functions ──────────────────────────────────────────────────────

async function migrateProduction() {
  console.log("\n=== 🌿 ПРОИЗВОДСТВО ===");

  const rows = [
    ["Дата", "Продукт", "Блок №", "Субстрат кг", "Дата инокуляции",
     "Дата плодоношения", "Урожай кг", "Биоэффективность %", "Статус",
     "Теплица №", "Примечание"],
  ];

  // Cucumbers: each row has harvest by variety (6 columns) + total
  const cucumbers = source["Огурцы"] || [];
  let cucSkipped = 0;
  let cucAdded = 0;

  for (let i = 1; i < cucumbers.length; i++) {
    const r = cucumbers[i];
    const date = parseDate(r[0]);
    if (!date || date.length < 8) continue;

    const total = parseNum(r[9]); // "Итого в день"
    if (!total || total <= 0) {
      cucSkipped++;
      continue;
    }

    const waste = parseNum(r[7]) || 0;
    const wastePct = r[8] || "";
    const sold = parseNum(r[10]) || "";
    const pickled = parseNum(r[11]) || "";
    const freeStock = parseNum(r[12]) || "";

    // Detail by variety for note
    const varieties = ["Директор", "Бьерн", "4097", "Амелия", "Твигу", "Орфеус"];
    const details = varieties
      .map((v, idx) => {
        const val = parseNum(r[idx + 1]);
        return val ? `${v}:${val}кг` : "";
      })
      .filter(Boolean)
      .join(", ");

    const note = [
      details,
      waste > 0 ? `отход:${waste}кг(${wastePct})` : "",
      sold ? `продано:${sold}кг` : "",
      pickled ? `засолка:${pickled}кг` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    rows.push([
      date, "Огурец", "", "", "", "", total, "", "сбор", "Теплица 1", note,
    ]);
    cucAdded++;
  }
  console.log(`  Огурцы: ${cucAdded} дней добавлено, ${cucSkipped} пропущено (пустые)`);

  // Tomatoes
  const tomatoes = source["Томаты"] || [];
  let tomAdded = 0;
  for (let i = 1; i < tomatoes.length; i++) {
    const r = tomatoes[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    const harvested = parseNum(r[1]);
    if (!harvested) continue;
    const sold = parseNum(r[2]) || "";

    rows.push([
      date, "Томат", "", "", "", "", harvested, "", "сбор", "Теплица 1",
      sold ? `продано:${sold}кг` : "",
    ]);
    tomAdded++;
  }
  console.log(`  Томаты: ${tomAdded} записей`);

  // Write
  await clearSheet(PEPINO_SHEETS_ID, "🌿 Производство");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "🌿 Производство");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в 🌿 Производство`);

  return rows.length - 1;
}

async function migrateSales() {
  console.log("\n=== 🛒 ПРОДАЖИ ===");

  const rows = [
    ["Дата", "Клиент", "Продукт", "Кол-во кг", "Цена ARS/кг",
     "Сумма ARS", "Сумма USD", "Канал", "Оплата", "Статус",
     "Доставка ARS", "Примечание"],
  ];

  // Main sales sheet
  const sales = source["Продажи"] || [];
  let lastDate = "";
  let mainAdded = 0;

  for (let i = 1; i < sales.length; i++) {
    const r = sales[i];
    const rawDate = r[0];
    const date = parseDate(rawDate);

    // Use last known date if this row has no date (continuation)
    const effectiveDate = date && date.length >= 8 ? date : lastDate;
    if (date && date.length >= 8) lastDate = date;

    const product = r[1] || "";
    const qty = parseNum(r[2]);
    const price = parseNum(r[3]);
    const total = parseNum(r[4]);
    const client = r[5] || "";
    const delivery = parseNum(r[6]);
    const totalWithDelivery = parseNum(r[7]);
    const usdRate = parseNum(r[8]);
    const usdAmount = r[9] ? r[9].toString().replace(/[^0-9.,]/g, "").replace(",", ".") : "";
    const usd = parseFloat(usdAmount) || "";

    // Skip summary/total rows
    if (!product && !qty && !total) continue;
    if (product === "" && !client && qty > 1000) continue; // total row

    // Skip the very last row if it's a summary
    if (i === sales.length - 1 && !product) continue;

    rows.push([
      effectiveDate, client, product, qty || "", price || "",
      total || "", usd || "", "", "", "оплачено",
      delivery || "", "",
    ]);
    mainAdded++;
  }
  console.log(`  Продажи (основные): ${mainAdded} записей`);

  // Client-specific sheets: Тележка, Гастроном1, У Беларуса
  for (const [sheetName, clientName] of [
    ["Тележка", "Тележка"],
    ["Гастроном1", "Гастроном1"],
    ["У Беларуса", "У Беларуса"],
  ]) {
    const clientRows = source[sheetName] || [];
    let added = 0;

    for (let i = 1; i < clientRows.length; i++) {
      const r = clientRows[i];
      const date = parseDate(r[0]);
      if (!date || date.length < 8) continue;

      const product = r[1] || "";
      const qty = parseNum(r[2]);
      const total = parseNum(r[3]);

      if (!product && !qty && !total) continue;

      rows.push([
        date, clientName, product, qty || "", "",
        total || "", "", "ресторан", "", "оплачено", "", "",
      ]);
      added++;
    }
    console.log(`  ${sheetName}: ${added} записей`);
  }

  // Write
  await clearSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "🛒 Продажи");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в 🛒 Продажи`);

  return rows.length - 1;
}

async function migrateExpenses() {
  console.log("\n=== 💰 РАСХОДЫ ===");

  const rows = [
    ["Дата", "Категория", "Описание", "Кол-во", "Единицы",
     "Сумма ARS", "Курс USD", "Сумма USD", "Примечание"],
  ];

  const expenses = source["Расходы"] || [];
  let added = 0;

  for (let i = 1; i < expenses.length; i++) {
    const r = expenses[i];
    const date = parseDate(r[0]);
    if (!date || date.length < 8) continue;

    const name = r[1] || "";
    const qty = parseNum(r[2]) || "";
    const unit = r[3] || "";
    const amount = parseNum(r[4]);
    const usdRate = parseNum(r[5]) || "";
    const usdAmount = parseNum(r[6]) || "";

    if (!name && !amount) continue;
    // Skip total rows
    if (name === "" && amount > 1000000) continue;

    // Auto-categorize
    let category = "другое";
    const lc = name.toLowerCase();
    if (/дизель|бензин|газ|nafta/i.test(lc)) category = "топливо";
    else if (/семена|semilla/i.test(lc)) category = "семена";
    else if (/удобрен|fertiliz|abono/i.test(lc)) category = "удобрения";
    else if (/субстрат|sustrato|tierra/i.test(lc)) category = "субстрат";
    else if (/электри|свет|luz|edenor/i.test(lc)) category = "электричество";
    else if (/вод|agua/i.test(lc)) category = "вода";
    else if (/аренд|alquiler/i.test(lc)) category = "аренда";
    else if (/упаков|envase|банк|ведр|bolsa/i.test(lc)) category = "упаковка";
    else if (/ремонт|repair|инструмент|herramienta/i.test(lc)) category = "ремонт";
    else if (/доставк|transporte|flete/i.test(lc)) category = "логистика";
    else if (/зарплат|salario|sueldo/i.test(lc)) category = "зарплата";
    else if (/перц|приправ|специ|соль|сахар|уксус/i.test(lc)) category = "ингредиенты";

    rows.push([date, category, name, qty, unit, amount || "", usdRate, usdAmount, ""]);
    added++;
  }
  console.log(`  Расходы: ${added} записей`);

  // Overwrite expenses sheet with new headers
  await clearSheet(PEPINO_SHEETS_ID, "💰 Расходы");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "💰 Расходы");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в 💰 Расходы`);

  return rows.length - 1;
}

async function migrateInventory() {
  console.log("\n=== 📦 СКЛАД ===");

  const rows = [
    ["Дата", "Позиция", "Категория", "Операция", "Кол-во",
     "Ед. измерения", "Остаток", "Поставщик", "Цена ARS/ед", "Примечание"],
  ];

  // Pickled cucumbers
  const pickledCuc = source["Соленые огурцы"] || [];
  for (let i = 1; i < pickledCuc.length; i++) {
    const r = pickledCuc[i];
    const date = parseDate(r[0]);
    if (!date) continue;

    const made = parseNum(r[1]) || "";
    const sold = parseNum(r[2]) || "";
    const stock = parseNum(r[3]) || "";
    const note = r[13] || r[4] || "";

    if (made) {
      rows.push([date, "Соленый огурец", "консервация", "приход", made, "кг", stock, "", "", note]);
    }
    if (sold) {
      rows.push([date, "Соленый огурец", "консервация", "расход", sold, "кг", "", "", "", "продано"]);
    }
  }
  console.log(`  Соленые огурцы: ${pickledCuc.length - 1} записей`);

  // Pickled tomatoes
  const pickledTom = source["Соленые томаты"] || [];
  for (let i = 1; i < pickledTom.length; i++) {
    const r = pickledTom[i];
    const date = parseDate(r[0]);
    if (!date) continue;

    const made = parseNum(r[1]) || "";
    const sold = parseNum(r[2]) || "";
    const stock = parseNum(r[3]) || "";

    if (made) {
      rows.push([date, "Соленый томат", "консервация", "приход", made, "кг", stock, "", "", ""]);
    }
  }
  console.log(`  Соленые томаты: ${pickledTom.length - 1} записей`);

  // Sauerkraut
  const cabbage = source["Квашенная капуста"] || [];
  for (let i = 1; i < cabbage.length; i++) {
    const r = cabbage[i];
    const date = parseDate(r[0]);
    if (!date) continue;

    const kvash = parseNum(r[1]) || "";
    const pelustka = parseNum(r[2]) || "";
    const sold = parseNum(r[3]) || "";
    const stock = parseNum(r[4]) || "";

    if (kvash) {
      rows.push([date, "Квашенная капуста", "консервация", "приход", kvash, "кг", stock, "", "", ""]);
    }
    if (pelustka) {
      rows.push([date, "Капуста пелюстка", "консервация", "приход", pelustka, "кг", stock, "", "", ""]);
    }
  }
  console.log(`  Квашенная капуста: ${cabbage.length - 1} записей`);

  await clearSheet(PEPINO_SHEETS_ID, "📦 Склад");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "📦 Склад");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в 📦 Склад`);

  return rows.length - 1;
}

async function migrateClients() {
  console.log("\n=== КЛИЕНТЫ ===");

  const rows = [
    ["Название", "Описание", "Сайт", "Контакт", "Контактное лицо",
     "Стадия", "Комментарии", "Условия работы", "Что закупает", "Объём/мес"],
  ];

  const clients = source["Клиенты"] || [];
  for (let i = 1; i < clients.length; i++) {
    const r = clients[i];
    if (!r[0]) continue;
    rows.push([
      r[0] || "", r[1] || "", r[2] || "", r[3] || "", r[4] || "",
      r[5] || "", r[6] || "", r[7] || "", r[8] || "", r[9] || "",
    ]);
  }
  console.log(`  Клиенты: ${rows.length - 1} записей`);

  await clearSheet(PEPINO_SHEETS_ID, "Клиенты");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "Клиенты");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в Клиенты`);

  return rows.length - 1;
}

async function migrateLogistics() {
  console.log("\n=== ЛОГИСТИКА ===");

  await createSheetIfNotExists(PEPINO_SHEETS_ID, "🚛 Логистика");

  const rows = [
    ["Дата", "Марка авто", "Км до", "Км после", "Проехали км",
     "Дизель до", "Дизель после", "Расход", "ТО", "Пеахе"],
  ];

  const logistics = source["логистика"] || [];
  for (let i = 1; i < logistics.length; i++) {
    const r = logistics[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    rows.push([
      date, r[1] || "", r[2] || "", r[3] || "", parseNum(r[4]) || "",
      r[5] || "", r[6] || "", r[7] || "", r[8] || "", r[9] || "",
    ]);
  }

  await writeToSheet(PEPINO_SHEETS_ID, rows, "🚛 Логистика");
  console.log(`  ✅ Записано: ${rows.length - 1} строк в 🚛 Логистика`);

  return rows.length - 1;
}

async function migrateClientDetails() {
  console.log("\n=== ДЕТАЛИ КЛИЕНТОВ (отдельные листы) ===");

  let total = 0;

  for (const [sheetName, targetName] of [
    ["Тележка", "📋 Тележка"],
    ["Гастроном1", "📋 Гастроном1"],
    ["У Беларуса", "📋 У Беларуса"],
  ]) {
    await createSheetIfNotExists(PEPINO_SHEETS_ID, targetName);

    const srcRows = source[sheetName] || [];
    if (srcRows.length <= 1) continue;

    // Copy headers + data as-is (preserve original format for client details)
    const rows = [srcRows[0]];
    for (let i = 1; i < srcRows.length; i++) {
      const r = [...srcRows[i]];
      r[0] = parseDate(r[0]) || r[0]; // normalize date
      rows.push(r);
    }

    await writeToSheet(PEPINO_SHEETS_ID, rows, targetName);
    console.log(`  ✅ ${targetName}: ${rows.length - 1} строк`);
    total += rows.length - 1;
  }

  return total;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  МИГРАЦИЯ ИСТОРИЧЕСКИХ ДАННЫХ PEPINO PICK    ║");
  console.log("║  Источник: 1lH1LNi...GQw (13 листов)        ║");
  console.log("║  Назначение: 1AB9nk...yoc (основная таблица) ║");
  console.log("╚══════════════════════════════════════════════╝");

  const results = {};

  results["🌿 Производство"] = await migrateProduction();
  results["🛒 Продажи"] = await migrateSales();
  results["💰 Расходы"] = await migrateExpenses();
  results["📦 Склад"] = await migrateInventory();
  results["Клиенты"] = await migrateClients();
  results["🚛 Логистика"] = await migrateLogistics();
  results["📋 Детали клиентов"] = await migrateClientDetails();

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║               ИТОГИ МИГРАЦИИ                 ║");
  console.log("╠══════════════════════════════════════════════╣");
  let total = 0;
  for (const [name, count] of Object.entries(results)) {
    console.log(`║  ${name.padEnd(25)} ${String(count).padStart(5)} строк  ║`);
    total += count;
  }
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  ИТОГО                        ${String(total).padStart(5)} строк  ║`);
  console.log("╚══════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
