import { readFileSync } from "fs";
import { google } from "googleapis";

const PEPINO_SHEETS_ID = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";

async function getAuth() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// sheetName is REQUIRED in all functions — prevents accidental writes to wrong sheet

export async function writeToSheet(spreadsheetId, data, sheetName) {
  if (!sheetName) throw new Error("sheetName is required");
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: "USER_ENTERED",
    resource: { values: data },
  });
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function appendToSheet(spreadsheetId, data, sheetName) {
  if (!sheetName) throw new Error("sheetName is required");
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: data },
  });
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function readSheet(spreadsheetId, sheetName) {
  if (!sheetName) throw new Error("sheetName is required");
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'`,
  });
  return response.data.values || [];
}

export async function clearSheet(spreadsheetId, sheetName) {
  if (!sheetName) throw new Error("sheetName is required");
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${sheetName}'`,
  });
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function listSheets(spreadsheetId) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  return response.data.sheets.map((s) => s.properties.title);
}

/**
 * Log AI spend to the "AI Spend" sheet.
 * @param {string} agent - Agent name (e.g. "pepino-agronomy")
 * @param {string} model - Model used (e.g. "haiku", "sonnet")
 * @param {number} tokensIn - Input tokens
 * @param {number} tokensOut - Output tokens
 * @param {number} costUsd - Cost in USD
 * @param {string} caseId - Case identifier
 * @param {string} riskLevel - Risk level (low/medium/high/critical)
 */
export async function logAiSpend(agent, model, tokensIn, tokensOut, costUsd, caseId, riskLevel) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  // Read current spend to calculate remaining budget
  const data = await readSheet(PEPINO_SHEETS_ID, "AI Spend");
  const today = now.slice(0, 10);
  const todaySpend = data
    .filter((r) => r[0] && r[0].startsWith(today))
    .reduce((sum, r) => sum + (parseFloat(r[5]) || 0), 0);
  const remaining = Math.max(0, 2.0 - todaySpend - costUsd);

  await appendToSheet(
    PEPINO_SHEETS_ID,
    [[now, agent, model, tokensIn, tokensOut, costUsd, caseId, riskLevel, remaining.toFixed(4)]],
    "AI Spend",
  );
  return { todaySpend: todaySpend + costUsd, remaining };
}

/**
 * Create a new sheet tab if it doesn't exist.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 */
export async function createSheetIfNotExists(spreadsheetId, sheetName) {
  const existing = await listSheets(spreadsheetId);
  if (existing.includes(sheetName)) return false;

  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
  return true;
}

export { PEPINO_SHEETS_ID };
