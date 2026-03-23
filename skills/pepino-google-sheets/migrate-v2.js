#!/usr/bin/env node
/**
 * Pepino Pick — Historical Data Migration v2
 * VERIFIED NUMBERS:
 *   Огурцы:   4 751,74 кг
 *   Томаты:     596,5  кг
 *   Продажи: 26 842 587,50 ARS (235 записей, НЕ дублировать клиентские листы)
 *   Расходы:  5 005 496,44 ARS (72 записи)
 *   Клиенты:  из листа Продажи (уникальные)
 */

import { readFileSync } from "fs";
import { writeToSheet, clearSheet, createSheetIfNotExists, PEPINO_SHEETS_ID } from "./sheets.js";

const src = JSON.parse(readFileSync("/tmp/pepino-source-data.json", "utf-8"));

// ── Argentine number parser ──────────────────────────────────────────────────

const SPANISH_MONTHS = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

function parseDate(raw) {
  if (!raw || raw === "") return "";
  const s = raw.toString().trim();

  const spanishMatch = s.match(/\w+,\s+(\w+)\s+(\d+),\s+(\d{4})/);
  if (spanishMatch) {
    const month = SPANISH_MONTHS[spanishMatch[1].toLowerCase()];
    if (month) return `${spanishMatch[3]}-${month}-${spanishMatch[2].padStart(2, "0")}`;
  }

  const dotMatch = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dotMatch)
    return `${dotMatch[3]}-${dotMatch[2].padStart(2, "0")}-${dotMatch[1].padStart(2, "0")}`;

  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch)
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`;

  const shortMatch = s.match(/^(\d{1,2})[./](\d{1,2})$/);
  if (shortMatch) return `2026-${shortMatch[2].padStart(2, "0")}-${shortMatch[1].padStart(2, "0")}`;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function parseArgNum(raw) {
  if (!raw || raw === "" || raw === "-") return null;
  let s = raw
    .toString()
    .replace(/^\$\s*/, "")
    .trim();
  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── 1. ПРОИЗВОДСТВО ──────────────────────────────────────────────────────────

async function migrateProduction() {
  console.log("\n═══ 🌿 ПРОИЗВОДСТВО ═══");

  const header = [
    "Дата",
    "Продукт",
    "Сорта/детали",
    "Урожай кг",
    "Отход кг",
    "% отхода",
    "Продано кг",
    "Засолка кг",
    "Остаток кг",
    "Бронь кг",
    "Теплица",
  ];
  const rows = [header];

  // Огурцы — skip last 2 rows (total + empty date)
  const cuc = src["Огурцы"];
  let cucTotal = 0;
  const varieties = ["Директор", "Бьерн", "4097", "Амелия", "Твигу", "Орфеус"];

  for (let i = 1; i < cuc.length - 2; i++) {
    const r = cuc[i];
    const date = parseDate(r[0]);
    if (!date || date.length < 8) continue;

    const total = parseArgNum(r[9]);
    if (total === null || total <= 0) continue;

    const details = varieties
      .map((v, idx) => {
        const val = parseArgNum(r[idx + 1]);
        return val ? `${v}:${val}` : "";
      })
      .filter(Boolean)
      .join(", ");

    rows.push([
      date,
      "Огурец",
      details,
      total,
      parseArgNum(r[7]) ?? "",
      r[8] || "",
      parseArgNum(r[10]) ?? "",
      parseArgNum(r[11]) ?? "",
      parseArgNum(r[12]) ?? "",
      parseArgNum(r[13]) ?? "",
      "Теплица 1",
    ]);
    cucTotal += total;
  }
  console.log(`  Огурцы: ${rows.length - 1} дней, ${cucTotal.toFixed(2)} кг`);

  // Томаты
  const tom = src["Томаты"];
  let tomTotal = 0;
  for (let i = 1; i < tom.length; i++) {
    const r = tom[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    const harvested = parseArgNum(r[1]);
    if (!harvested) continue;
    const sold = parseArgNum(r[2]);

    rows.push([date, "Томат", "", harvested, "", "", sold ?? "", "", "", "", "Теплица 1"]);
    tomTotal += harvested;
  }
  console.log(`  Томаты: ${tom.length - 1} записей, ${tomTotal.toFixed(1)} кг`);

  await clearSheet(PEPINO_SHEETS_ID, "🌿 Производство");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "🌿 Производство");
  console.log(`  ✅ Записано: ${rows.length - 1} строк`);
  console.log(
    `  📊 Контроль: огурцы ${cucTotal.toFixed(2)} + томаты ${tomTotal.toFixed(1)} = ${(cucTotal + tomTotal).toFixed(1)} кг`,
  );
  return rows.length - 1;
}

// ── 2. ПРОДАЖИ ───────────────────────────────────────────────────────────────

async function migrateSales() {
  console.log("\n═══ 🛒 ПРОДАЖИ ═══");

  const header = [
    "Дата",
    "Клиент",
    "Продукт",
    "Кол-во кг",
    "Цена ARS/кг",
    "Сумма ARS",
    "Доставка ARS",
    "Итого ARS",
    "Курс USD",
    "Сумма USD",
    "Статус",
    "Примечание",
  ];
  const rows = [header];

  const sales = src["Продажи"];
  let lastDate = "";
  let totalARS = 0;

  // Skip last row (total/summary)
  for (let i = 1; i < sales.length - 1; i++) {
    const r = sales[i];
    const rawDate = r[0];
    const date = parseDate(rawDate);
    const effectiveDate = date && date.length >= 8 ? date : lastDate;
    if (date && date.length >= 8) lastDate = date;

    const product = r[1] || "";
    const qty = parseArgNum(r[2]);
    const price = parseArgNum(r[3]);
    const subtotal = parseArgNum(r[4]);
    const client = r[5] || "";
    const delivery = parseArgNum(r[6]);
    const totalWithDel = parseArgNum(r[7]);
    const usdRate = parseArgNum(r[8]);
    const usdRaw = r[9] ? r[9].toString().replace(/[^0-9.,]/g, "") : "";
    const usd = parseArgNum(usdRaw);

    // Skip empty rows
    if (!product && !qty && !subtotal) continue;

    rows.push([
      effectiveDate,
      client,
      product,
      qty ?? "",
      price ?? "",
      subtotal ?? "",
      delivery ?? "",
      totalWithDel ?? "",
      usdRate ?? "",
      usd ?? "",
      "оплачено",
      "",
    ]);
    totalARS += subtotal || 0;
  }

  await clearSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "🛒 Продажи");
  console.log(`  ✅ Записано: ${rows.length - 1} строк`);
  console.log(`  📊 Контроль: ${totalARS.toLocaleString("en")} ARS`);
  return rows.length - 1;
}

// ── 3. РАСХОДЫ ───────────────────────────────────────────────────────────────

async function migrateExpenses() {
  console.log("\n═══ 💰 РАСХОДЫ ═══");

  const header = [
    "Дата",
    "Наименование",
    "Кол-во",
    "Единицы",
    "Сумма ARS",
    "Курс USD",
    "Сумма USD",
  ];
  const rows = [header];

  const exp = src["Расходы"];
  let totalARS = 0;

  // Skip last row (total)
  for (let i = 1; i < exp.length - 1; i++) {
    const r = exp[i];
    const date = parseDate(r[0]);
    if (!date || date.length < 8) continue;

    const name = r[1] || "";
    const qty = parseArgNum(r[2]);
    const unit = r[3] || "";
    const amount = parseArgNum(r[4]);
    const usdRate = parseArgNum(r[5]);
    const usdAmount = parseArgNum(r[6]);

    if (!name && !amount) continue;

    rows.push([date, name, qty ?? "", unit, amount ?? "", usdRate ?? "", usdAmount ?? ""]);
    totalARS += amount || 0;
  }

  await clearSheet(PEPINO_SHEETS_ID, "💰 Расходы");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "💰 Расходы");
  console.log(`  ✅ Записано: ${rows.length - 1} строк`);
  console.log(`  📊 Контроль: ${totalARS.toLocaleString("en")} ARS`);
  return rows.length - 1;
}

// ── 4. СКЛАД ─────────────────────────────────────────────────────────────────

async function migrateInventory() {
  console.log("\n═══ 📦 СКЛАД ═══");

  const header = [
    "Дата",
    "Позиция",
    "Категория",
    "Операция",
    "Кол-во кг",
    "Остаток кг",
    "Примечание",
  ];
  const rows = [header];

  // Соленые огурцы
  const pickCuc = src["Соленые огурцы"];
  for (let i = 1; i < pickCuc.length; i++) {
    const r = pickCuc[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    const made = parseArgNum(r[1]);
    const sold = parseArgNum(r[2]);
    const stock = parseArgNum(r[3]);
    const note = r[13] || "";

    if (made)
      rows.push([date, "Соленый огурец", "консервация", "засолка", made, stock ?? "", note]);
    if (sold) rows.push([date, "Соленый огурец", "консервация", "продано", sold, "", ""]);
  }

  // Соленые томаты
  const pickTom = src["Соленые томаты"];
  for (let i = 1; i < pickTom.length; i++) {
    const r = pickTom[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    const made = parseArgNum(r[1]);
    const stock = parseArgNum(r[3]);
    if (made) rows.push([date, "Соленый томат", "консервация", "засолка", made, stock ?? "", ""]);
  }

  // Квашенная капуста
  const cab = src["Квашенная капуста"];
  for (let i = 1; i < cab.length; i++) {
    const r = cab[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    const pelustka = parseArgNum(r[2]);
    const stock = parseArgNum(r[4]);
    if (pelustka)
      rows.push([date, "Капуста пелюстка", "консервация", "засолка", pelustka, stock ?? "", ""]);
  }

  await clearSheet(PEPINO_SHEETS_ID, "📦 Склад");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "📦 Склад");
  console.log(`  ✅ Записано: ${rows.length - 1} строк`);
  return rows.length - 1;
}

// ── 5. КЛИЕНТЫ (из Продаж) ──────────────────────────────────────────────────

async function migrateClients() {
  console.log("\n═══ 👥 КЛИЕНТЫ ═══");

  const header = [
    "Клиент",
    "Кол-во продаж",
    "Общая сумма ARS",
    "Средний чек ARS",
    "Последняя продажа",
    "Продукты",
  ];
  const rows = [header];

  const sales = src["Продажи"];
  const clients = {};

  for (let i = 1; i < sales.length - 1; i++) {
    const r = sales[i];
    const client = (r[5] || "").trim();
    if (!client) continue;

    const date = parseDate(r[0]);
    const product = r[1] || "";
    const total = parseArgNum(r[4]) || 0;

    if (!clients[client]) {
      clients[client] = { count: 0, total: 0, lastDate: "", products: new Set() };
    }
    clients[client].count++;
    clients[client].total += total;
    if (date > clients[client].lastDate) clients[client].lastDate = date;
    if (product) clients[client].products.add(product);
  }

  // Sort by total descending
  const sorted = Object.entries(clients).sort((a, b) => b[1].total - a[1].total);

  for (const [name, data] of sorted) {
    rows.push([
      name,
      data.count,
      Math.round(data.total),
      Math.round(data.total / data.count),
      data.lastDate,
      [...data.products].join(", "),
    ]);
  }

  await clearSheet(PEPINO_SHEETS_ID, "Клиенты");
  await writeToSheet(PEPINO_SHEETS_ID, rows, "Клиенты");
  console.log(`  ✅ ${rows.length - 1} клиентов (из листа Продажи)`);
  return rows.length - 1;
}

// ── 6. ЛОГИСТИКА ─────────────────────────────────────────────────────────────

async function migrateLogistics() {
  console.log("\n═══ 🚛 ЛОГИСТИКА ═══");

  await createSheetIfNotExists(PEPINO_SHEETS_ID, "🚛 Логистика");

  const header = [
    "Дата",
    "Марка авто",
    "Км до",
    "Км после",
    "Проехали км",
    "Дизель до",
    "Дизель после",
    "Расход",
    "ТО",
    "Пеахе",
  ];
  const rows = [header];

  const log = src["логистика"];
  for (let i = 1; i < log.length; i++) {
    const r = log[i];
    const date = parseDate(r[0]);
    if (!date) continue;
    rows.push([
      date,
      r[1] || "",
      r[2] || "",
      r[3] || "",
      parseArgNum(r[4]) ?? "",
      r[5] || "",
      r[6] || "",
      r[7] || "",
      r[8] || "",
      r[9] || "",
    ]);
  }

  await writeToSheet(PEPINO_SHEETS_ID, rows, "🚛 Логистика");
  console.log(`  ✅ ${rows.length - 1} записей`);
  return rows.length - 1;
}

// ── 7. КЛИЕНТСКИЕ ЛИСТЫ (справочные) ────────────────────────────────────────

async function migrateClientSheets() {
  console.log("\n═══ 📋 СПРАВОЧНЫЕ ЛИСТЫ КЛИЕНТОВ ═══");

  let total = 0;
  for (const [srcName, targetName] of [
    ["Тележка", "📋 Тележка"],
    ["Гастроном1", "📋 Гастроном1"],
    ["У Беларуса", "📋 У Беларуса"],
  ]) {
    await createSheetIfNotExists(PEPINO_SHEETS_ID, targetName);

    const srcRows = src[srcName];
    if (srcRows.length <= 1) continue;

    const rows = [srcRows[0]];
    for (let i = 1; i < srcRows.length; i++) {
      const r = [...srcRows[i]];
      r[0] = parseDate(r[0]) || r[0];
      rows.push(r);
    }

    await writeToSheet(PEPINO_SHEETS_ID, rows, targetName);
    console.log(`  ✅ ${targetName}: ${rows.length - 1} строк`);
    total += rows.length - 1;
  }
  return total;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   МИГРАЦИЯ v2 — ПРОВЕРЕННЫЕ ЧИСЛА             ║");
  console.log("╚═══════════════════════════════════════════════╝");

  const r = {};
  r["🌿 Производство"] = await migrateProduction();
  r["🛒 Продажи"] = await migrateSales();
  r["💰 Расходы"] = await migrateExpenses();
  r["📦 Склад"] = await migrateInventory();
  r["👥 Клиенты"] = await migrateClients();
  r["🚛 Логистика"] = await migrateLogistics();
  r["📋 Справочные"] = await migrateClientSheets();

  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║              ИТОГИ МИГРАЦИИ v2                 ║");
  console.log("╠═══════════════════════════════════════════════╣");
  let total = 0;
  for (const [name, count] of Object.entries(r)) {
    console.log(`║  ${name.padEnd(22)} ${String(count).padStart(5)} строк   ║`);
    total += count;
  }
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(`║  ИТОГО                   ${String(total).padStart(5)} строк   ║`);
  console.log("╚═══════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
