import { readFileSync } from "fs";
/**
 * Greenhouse Sheets — универсальный модуль для Google Sheets API
 * Сервисный аккаунт: pepino-pick-bot@peak-plasma-467720-i8.iam.gserviceaccount.com
 */
import { google } from "googleapis";

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getAuth() {
  const credPath =
    process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";
  const credentials = JSON.parse(readFileSync(credPath));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: "v4", auth });
}

// ─── Base Operations ─────────────────────────────────────────────────────────

/** Записать данные с A1 (перезапись) */
export async function writeToSheet(spreadsheetId, data, sheetName = "Лист1") {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    resource: { values: data },
  });
  return url(spreadsheetId);
}

/** Добавить строки в конец */
export async function appendToSheet(spreadsheetId, data, sheetName = "Лист1") {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: data },
  });
  return url(spreadsheetId);
}

/** Прочитать все данные */
export async function readSheet(spreadsheetId, sheetName = "Лист1", range = "A1:Z2000") {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${range}`,
  });
  return response.data.values || [];
}

/** Очистить лист */
export async function clearSheet(spreadsheetId, sheetName = "Лист1") {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A1:Z2000`,
  });
  return url(spreadsheetId);
}

/** Обновить конкретный диапазон */
export async function updateRange(spreadsheetId, range, data, sheetName = "Лист1") {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${range}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: data },
  });
  return url(spreadsheetId);
}

/** Получить метаданные таблицы (листы, размеры) */
export async function getSpreadsheetMeta(spreadsheetId) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  return response.data;
}

/** Создать новый лист в существующей таблице */
export async function addSheet(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
  return url(spreadsheetId);
}

// ─── Greenhouse-Specific ─────────────────────────────────────────────────────

/** ID таблиц тепличного хозяйства (заполни после создания) */
export const GREENHOUSE_SHEETS = {
  production: process.env.GH_SHEET_PRODUCTION || "", // Производство
  sales: process.env.GH_SHEET_SALES || "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc",
  inventory: process.env.GH_SHEET_INVENTORY || "", // Склад/остатки
  pnl: process.env.GH_SHEET_PNL || "", // P&L
  engineering: process.env.GH_SHEET_ENGINEERING || "", // Инженерные расчёты
  market: process.env.GH_SHEET_MARKET || "", // Рыночные цены
};

/** Записать дневной производственный отчёт */
export async function logProduction(date, culture, batchId, planKg, factKg, notes = "") {
  const spreadsheetId = GREENHOUSE_SHEETS.production;
  if (!spreadsheetId) throw new Error("GH_SHEET_PRODUCTION не задан");
  const pct = planKg > 0 ? ((factKg / planKg) * 100).toFixed(1) + "%" : "N/A";
  return appendToSheet(
    spreadsheetId,
    [[date, culture, batchId, planKg, factKg, pct, notes]],
    "Производство",
  );
}

/** Записать продажу */
export async function logSale(date, client, product, kg, pricePerKg, notes = "") {
  const spreadsheetId = GREENHOUSE_SHEETS.sales;
  if (!spreadsheetId) throw new Error("GH_SHEET_SALES не задан");
  const total = (kg * pricePerKg).toFixed(2);
  return appendToSheet(
    spreadsheetId,
    [[date, client, product, kg, pricePerKg, total, notes]],
    "Продажи",
  );
}

/** Обновить остатки склада */
export async function logInventoryMove(date, action, product, qty, notes = "") {
  const spreadsheetId = GREENHOUSE_SHEETS.inventory;
  if (!spreadsheetId) throw new Error("GH_SHEET_INVENTORY не задан");
  return appendToSheet(spreadsheetId, [[date, action, product, qty, notes]], "Движения");
}

/** Записать инженерный расчёт */
export async function logEngCalc(date, system, params, result, notes = "") {
  const spreadsheetId = GREENHOUSE_SHEETS.engineering;
  if (!spreadsheetId) throw new Error("GH_SHEET_ENGINEERING не задан");
  return appendToSheet(
    spreadsheetId,
    [[date, system, JSON.stringify(params), JSON.stringify(result), notes]],
    "Расчёты",
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function url(id) {
  return `https://docs.google.com/spreadsheets/d/${id}`;
}
