import { readFileSync } from "fs";
import { google } from "googleapis";

async function getAuth() {
  const credentials = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_PATH));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export async function writeToSheet(spreadsheetId, data, sheetName = "Лист1") {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    resource: { values: data },
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function appendToSheet(spreadsheetId, data, sheetName = "Лист1") {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: data },
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function readSheet(spreadsheetId, sheetName = "Лист1") {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z1000`,
  });

  return response.data.values || [];
}

export async function clearSheet(spreadsheetId, sheetName = "Лист1") {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A1:Z1000`,
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}
