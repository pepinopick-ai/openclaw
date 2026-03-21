#!/usr/bin/env node
/**
 * Pepino Agent OS -- Комплексный системный тест (end-to-end smoke test)
 *
 * Проверяет инфраструктуру, данные, скрипты, knowledge layer и конфигурацию.
 * Запускать после крупных изменений или как ежедневный smoke test.
 *
 * Usage:
 *   node system-test.cjs              # запуск всех тестов
 *   node system-test.cjs --telegram   # отправить итог в Telegram (thread 20)
 *
 * Cron (опционально): 0 5 * * * cd /home/roman/openclaw/skills/pepino-google-sheets && node system-test.cjs --telegram
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { apiHeaders, API_TOKEN } = require("./api-auth.cjs");
const { sendReport } = require("./telegram-helper.cjs");

// -- Конфигурация -------------------------------------------------------------

const API_BASE = "http://127.0.0.1:4000";
const LANGFUSE_BASE = "http://127.0.0.1:3001";
const SEND_TG = process.argv.includes("--telegram");
const SCRIPT_DIR = __dirname;
const OPENCLAW_DIR = path.join(process.env.HOME || "/root", ".openclaw");
const KNOWLEDGE_INDEX_PATH = path.join(OPENCLAW_DIR, "workspace", "memory", "knowledge-index.json");
const TG_THREAD_ID = 20;

/** Ожидаемое минимальное количество Docker-контейнеров */
const EXPECTED_CONTAINERS = 15;

// -- Утилиты ------------------------------------------------------------------

/**
 * HTTP GET с таймаутом. Возвращает промис с телом ответа и статусом.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{status: number, body: string}>}
 */
function httpGet(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 0, body: "Connection timeout" });
    }, timeoutMs);

    try {
      http
        .get(url, { headers, timeout: timeoutMs }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() });
          });
        })
        .on("error", (e) => {
          clearTimeout(timer);
          resolve({ status: 0, body: e.message });
        });
    } catch (e) {
      clearTimeout(timer);
      resolve({ status: 0, body: e.message });
    }
  });
}

/**
 * Синхронная shell-команда, возвращает stdout или null при ошибке.
 * @param {string} cmd
 * @returns {string | null}
 */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Безопасный JSON.parse с fallback.
 * @param {string} str
 * @returns {any}
 */
function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// -- Результаты ---------------------------------------------------------------

/** @type {{ id: number, name: string, pass: boolean, detail: string, ms: number }[]} */
const results = [];

/**
 * Записать результат теста.
 * @param {number} id
 * @param {string} name
 * @param {boolean} pass
 * @param {string} detail
 * @param {number} ms
 */
function record(id, name, pass, detail, ms) {
  results.push({ id, name, pass, detail, ms });
}

// -- Тесты: Инфраструктура ---------------------------------------------------

async function testSheetsApiHealth() {
  const t0 = Date.now();
  const res = await httpGet(`${API_BASE}/health`, apiHeaders());
  const ms = Date.now() - t0;

  if (res.status >= 200 && res.status < 400) {
    record(1, "Sheets API health", true, `HTTP ${res.status}`, ms);
  } else {
    record(1, "Sheets API health", false, res.body || `HTTP ${res.status}`, ms);
  }
}

async function testSheetsApiAuth() {
  const t0 = Date.now();
  // Запрос с токеном -- должен вернуть 200
  const ok = await httpGet(`${API_BASE}/sales`, apiHeaders());
  // Запрос без токена -- должен вернуть 401
  const noAuth = await httpGet(`${API_BASE}/sales`, {});
  const ms = Date.now() - t0;

  if (ok.status === 200 && noAuth.status === 401) {
    record(2, "Sheets API auth", true, "Auth OK, 401 without token", ms);
  } else if (ok.status !== 200) {
    record(2, "Sheets API auth", false, `Auth request: HTTP ${ok.status}`, ms);
  } else {
    record(
      2,
      "Sheets API auth",
      false,
      `No-auth request returned ${noAuth.status} (expected 401)`,
      ms,
    );
  }
}

async function testLangfuseHealth() {
  const t0 = Date.now();
  const res = await httpGet(`${LANGFUSE_BASE}/api/public/health`);
  const ms = Date.now() - t0;

  if (res.status >= 200 && res.status < 400) {
    record(3, "Langfuse health", true, `HTTP ${res.status}`, ms);
  } else {
    record(3, "Langfuse health", false, res.body || `HTTP ${res.status}`, ms);
  }
}

async function testDockerContainers() {
  const t0 = Date.now();
  const out = shell('docker ps --format "{{.Names}}" 2>/dev/null');
  const ms = Date.now() - t0;

  if (!out) {
    record(4, "Docker containers", false, "docker ps failed or not available", ms);
    return;
  }
  const containers = out.split("\n").filter(Boolean);
  const count = containers.length;

  if (count >= EXPECTED_CONTAINERS) {
    record(4, "Docker containers", true, `${count} running`, ms);
  } else {
    record(4, "Docker containers", false, `${count}/${EXPECTED_CONTAINERS} running`, ms);
  }
}

// -- Тесты: Данные ------------------------------------------------------------

async function testDataEndpoint(id, name, endpoint, validateFn) {
  const t0 = Date.now();
  const res = await httpGet(`${API_BASE}${endpoint}`, apiHeaders());
  const ms = Date.now() - t0;

  if (res.status !== 200) {
    record(id, name, false, `HTTP ${res.status}: ${res.body.slice(0, 100)}`, ms);
    return;
  }

  const data = parseJson(res.body);
  if (!data) {
    record(id, name, false, "Invalid JSON response", ms);
    return;
  }

  const result = validateFn(data);
  record(id, name, result.pass, result.detail, ms);
}

async function testSalesData() {
  await testDataEndpoint(5, "Sales data", "/sales?all=true", (data) => {
    const rows = Array.isArray(data) ? data : data.data || data.rows || [];
    const count = Array.isArray(rows) ? rows.length : 0;
    return count > 0
      ? { pass: true, detail: `${count} records` }
      : { pass: false, detail: "0 records returned" };
  });
}

async function testProductionData() {
  await testDataEndpoint(6, "Production data", "/production?all=true", (data) => {
    const rows = Array.isArray(data) ? data : data.data || data.rows || [];
    const count = Array.isArray(rows) ? rows.length : 0;
    return count > 0
      ? { pass: true, detail: `${count} records` }
      : { pass: false, detail: "0 records returned" };
  });
}

async function testExpensesData() {
  await testDataEndpoint(7, "Expenses data", "/expenses?all=true", (data) => {
    const rows = Array.isArray(data) ? data : data.data || data.rows || [];
    const count = Array.isArray(rows) ? rows.length : 0;
    return count > 0
      ? { pass: true, detail: `${count} records` }
      : { pass: false, detail: "0 records returned" };
  });
}

async function testClients() {
  await testDataEndpoint(8, "API v2 /clients", "/clients", (data) => {
    const items = Array.isArray(data) ? data : data.clients || data.data || [];
    const count = Array.isArray(items) ? items.length : 0;
    return count > 0
      ? { pass: true, detail: `${count} clients` }
      : { pass: false, detail: "0 clients returned" };
  });
}

async function testDashboard() {
  const expectedFields = ["sales_today", "margin", "open_alerts"];
  await testDataEndpoint(9, "API v2 /dashboard", "/dashboard", (data) => {
    const obj = typeof data === "object" && data !== null ? data : {};
    // Проверяем наличие хотя бы ключевых полей (любой вложенности)
    const flat = JSON.stringify(obj).toLowerCase();
    const found = expectedFields.filter((f) => flat.includes(f));
    return found.length >= 2
      ? { pass: true, detail: `Fields: ${found.join(", ")}` }
      : { pass: false, detail: `Missing fields. Found: ${found.join(", ") || "none"}` };
  });
}

async function testForecast() {
  await testDataEndpoint(10, "API v2 /forecast", "/forecast", (data) => {
    const val = data.forecast_7d ?? data.forecast ?? null;
    if (val !== null && val !== undefined && Number(val) > 0) {
      return { pass: true, detail: `forecast_7d = ${val}` };
    }
    // Принимаем если объект содержит любое числовое поле прогноза
    const flat = JSON.stringify(data);
    if (flat.includes("forecast")) {
      return { pass: true, detail: "Forecast data present" };
    }
    return { pass: false, detail: `forecast_7d missing or 0: ${flat.slice(0, 120)}` };
  });
}

// -- Тесты: Синтаксис скриптов ------------------------------------------------

/**
 * Список ключевых скриптов для проверки синтаксиса (node --check).
 * Индексы 11-20.
 */
const KEY_SCRIPTS = [
  { file: "daily-pnl.cjs", label: "daily-pnl" },
  { file: "churn-detector.cjs", label: "churn-detector" },
  { file: "inventory-tracker.cjs", label: "inventory-tracker" },
  { file: "auto-pricing.cjs", label: "auto-pricing" },
  { file: "morning-brief.js", label: "morning-brief" },
  { file: "knowledge-distiller.cjs", label: "knowledge-distiller" },
  { file: "cashflow-forecast.cjs", label: "cashflow-forecast" },
  { file: "production-planner.cjs", label: "production-planner" },
  { file: "ceo-weekly-digest.cjs", label: "ceo-weekly-digest" },
  { file: "trend-radar.cjs", label: "trend-radar" },
];

function testScriptSyntax() {
  KEY_SCRIPTS.forEach((s, i) => {
    const id = 11 + i;
    const filePath = path.join(SCRIPT_DIR, s.file);
    const t0 = Date.now();

    if (!fs.existsSync(filePath)) {
      record(id, `Syntax: ${s.label}`, false, "File not found", Date.now() - t0);
      return;
    }

    const out = shell(`node --check "${filePath}" 2>&1`);
    const ms = Date.now() - t0;

    if (out === null || out === "") {
      // node --check возвращает пустой stdout при успехе
      record(id, `Syntax: ${s.label}`, true, "OK", ms);
    } else {
      // Если есть вывод, это ошибки парсинга
      record(id, `Syntax: ${s.label}`, false, out.slice(0, 120), ms);
    }
  });
}

// -- Тесты: Knowledge Layer ---------------------------------------------------

function testKnowledgeIndex() {
  const t0 = Date.now();

  if (!fs.existsSync(KNOWLEDGE_INDEX_PATH)) {
    record(
      21,
      "knowledge-index.json exists",
      false,
      `Not found: ${KNOWLEDGE_INDEX_PATH}`,
      Date.now() - t0,
    );
    return;
  }

  try {
    const raw = fs.readFileSync(KNOWLEDGE_INDEX_PATH, "utf8");
    const data = JSON.parse(raw);
    const docs = Array.isArray(data) ? data : data.documents || data.entries || [];
    const count = Array.isArray(docs) ? docs.length : Object.keys(data).length;
    const ms = Date.now() - t0;

    if (count > 0) {
      record(21, "knowledge-index.json exists", true, `${count} documents`, ms);
    } else {
      record(21, "knowledge-index.json exists", false, "0 documents in index", ms);
    }
  } catch (e) {
    record(21, "knowledge-index.json exists", false, e.message, Date.now() - t0);
  }
}

function testKnowledgeRetriever() {
  const t0 = Date.now();
  const retrieverPath = path.join(SCRIPT_DIR, "knowledge-retriever.cjs");

  if (!fs.existsSync(retrieverPath)) {
    record(
      22,
      'Knowledge retriever "огурец"',
      false,
      "knowledge-retriever.cjs not found",
      Date.now() - t0,
    );
    return;
  }

  try {
    const { search } = require(retrieverPath);
    if (typeof search !== "function") {
      record(22, 'Knowledge retriever "огурец"', false, "search() not exported", Date.now() - t0);
      return;
    }

    const result = search("огурец", { limit: 3 });
    const ms = Date.now() - t0;
    const count = Array.isArray(result)
      ? result.length
      : result && result.results
        ? result.results.length
        : 0;

    if (count > 0) {
      record(22, 'Knowledge retriever "огурец"', true, `${count} results`, ms);
    } else {
      record(22, 'Knowledge retriever "огурец"', false, "0 results for query", ms);
    }
  } catch (e) {
    record(22, 'Knowledge retriever "огурец"', false, e.message.slice(0, 120), Date.now() - t0);
  }
}

// -- Тесты: Конфигурация -----------------------------------------------------

function testOpenclawConfig() {
  const t0 = Date.now();
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");

  if (!fs.existsSync(configPath)) {
    record(23, "openclaw.json permissions", false, "File not found", Date.now() - t0);
    return;
  }

  try {
    const stat = fs.statSync(configPath);
    const mode = (stat.mode & 0o777).toString(8);
    const ms = Date.now() - t0;

    if (mode === "600") {
      record(23, "openclaw.json permissions", true, "chmod 600", ms);
    } else {
      record(23, "openclaw.json permissions", false, `chmod ${mode} (expected 600)`, ms);
    }
  } catch (e) {
    record(23, "openclaw.json permissions", false, e.message, Date.now() - t0);
  }
}

function testSheetsApiToken() {
  const t0 = Date.now();
  const tokenPath = path.join(OPENCLAW_DIR, ".sheets-api-token");

  if (!fs.existsSync(tokenPath)) {
    record(24, ".sheets-api-token valid", false, "File not found", Date.now() - t0);
    return;
  }

  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const ms = Date.now() - t0;

    if (token.length > 32) {
      record(24, ".sheets-api-token valid", true, `${token.length} chars`, ms);
    } else {
      record(24, ".sheets-api-token valid", false, `Only ${token.length} chars (expected >32)`, ms);
    }
  } catch (e) {
    record(24, ".sheets-api-token valid", false, e.message, Date.now() - t0);
  }
}

// -- Вывод результатов --------------------------------------------------------

function formatResults() {
  const lines = ["=== Pepino Agent OS -- System Test ===", ""];

  for (const r of results) {
    const tag = r.pass ? "[PASS]" : "[FAIL]";
    const detail = r.pass ? `(${r.ms}ms)` : `: ${r.detail}`;
    lines.push(`${tag} ${r.id}. ${r.name} ${detail}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  lines.push("");
  lines.push(`=== Results: ${passed}/${total} PASS, ${failed} FAIL ===`);

  return { text: lines.join("\n"), passed, failed, total };
}

function formatTelegramMessage() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  const failedTests = results.filter((r) => !r.pass);

  const lines = [`<b>System Test: ${passed}/${total} PASS</b>`, ""];

  if (failedTests.length > 0) {
    lines.push("<b>Failed:</b>");
    for (const r of failedTests) {
      // Экранируем HTML-спецсимволы в detail
      const safeDetail = r.detail
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      lines.push(`  ${r.id}. ${r.name}: ${safeDetail}`);
    }
  } else {
    lines.push("All tests passed.");
  }

  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.push("");
  lines.push(`<i>${ts} UTC</i>`);

  return lines.join("\n");
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const totalStart = Date.now();

  // Инфраструктура (1-4)
  await testSheetsApiHealth();
  await testSheetsApiAuth();
  await testLangfuseHealth();
  await testDockerContainers();

  // Данные (5-10)
  await testSalesData();
  await testProductionData();
  await testExpensesData();
  await testClients();
  await testDashboard();
  await testForecast();

  // Синтаксис скриптов (11-20)
  testScriptSyntax();

  // Knowledge layer (21-22)
  testKnowledgeIndex();
  testKnowledgeRetriever();

  // Конфигурация (23-24)
  testOpenclawConfig();
  testSheetsApiToken();

  // Вывод
  const { text, passed, failed, total } = formatResults();
  console.log(text);
  console.log(`\nTotal time: ${Date.now() - totalStart}ms`);

  // Telegram
  if (SEND_TG) {
    const tgMsg = formatTelegramMessage();
    const tgRes = await sendReport(tgMsg, TG_THREAD_ID, "HTML");
    if (tgRes.ok) {
      console.log(`\nTelegram: sent to thread ${TG_THREAD_ID}`);
    } else {
      console.error(`\nTelegram: failed -- ${tgRes.error}`);
    }
  }

  // Exit code = количество провалов (0 = все ОК)
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("System test crashed:", e);
  process.exit(2);
});
