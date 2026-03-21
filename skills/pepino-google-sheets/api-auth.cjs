/**
 * Pepino Sheets API -- shared auth helper (CommonJS)
 * Читает API-токен и предоставляет заголовки авторизации для всех клиентов.
 *
 * Usage:
 *   const { apiHeaders, API_TOKEN } = require("./api-auth.cjs");
 *   http.get(url, { headers: apiHeaders() }, ...);
 */

const fs = require("fs");
const path = require("path");

const TOKEN_FILE = path.join(process.env.HOME || "/root", ".openclaw", ".sheets-api-token");

function loadToken() {
  if (process.env.SHEETS_API_TOKEN) return process.env.SHEETS_API_TOKEN;
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    console.warn(`[api-auth] Token file not found: ${TOKEN_FILE}. API calls will fail with 401.`);
    return "";
  }
}

const API_TOKEN = loadToken();

/** Returns headers object with Authorization bearer token */
function apiHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    ...extra,
  };
}

module.exports = { API_TOKEN, apiHeaders };
