/**
 * Pepino Sheets API — shared auth helper
 * Reads the API token and provides authenticated fetch for all clients.
 *
 * Usage:
 *   import { apiHeaders, API_TOKEN } from "./api-auth.js";
 *   http.get(url, { headers: apiHeaders() }, ...);
 */

import fs from "fs";
import path from "path";

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

export const API_TOKEN = loadToken();

/** Returns headers object with Authorization bearer token */
export function apiHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    ...extra,
  };
}
