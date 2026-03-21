#!/usr/bin/env node
/**
 * pepino-cli.cjs -- Единая CLI-точка входа в Pepino Agent OS
 *
 * Вместо запоминания 50+ скриптов, оператор использует одну команду:
 *   node pepino-cli.cjs <command> [args]
 *   или alias: pepino <command> [args]
 *
 * Категории команд:
 *   - Quick status: status, test, dashboard
 *   - Data queries: sales, clients, stock, pnl
 *   - Operations: checklist, expense, search
 *   - Analytics: scores, forecast, waste, radar
 *   - Pipelines: morning, evening, sunday
 *   - System: cron, logs, index, help
 */

"use strict";

const { execSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { apiHeaders } = require("./api-auth.cjs");

// ── Константы ────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const API_BASE = "http://127.0.0.1:4000";
const LOGS_DIR = "/home/roman/logs";

// ── ANSI-цвета ──────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

// Отключить цвета, если stdout не TTY или NO_COLOR установлен
const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR;
/** @param {string} code @param {string} text */
function c(code, text) {
  if (NO_COLOR) return text;
  return `${code}${text}${C.reset}`;
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

/**
 * Запустить shell-команду, вернуть stdout. При ошибке возвращает null.
 * @param {string} cmd
 * @param {number} timeoutMs
 * @returns {string | null}
 */
function shell(cmd, timeoutMs = 30_000) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return null;
  }
}

/**
 * Запустить скрипт из SCRIPT_DIR с аргументами, показать вывод в реальном времени.
 * @param {string} scriptName -- имя файла скрипта (например, "system-test.cjs")
 * @param {string[]} args -- дополнительные аргументы
 * @param {number} timeoutMs
 * @returns {{ exitCode: number, output: string }}
 */
function runScript(scriptName, args = [], timeoutMs = 120_000) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(c(C.red, `Скрипт не найден: ${scriptName}`));
    return { exitCode: 1, output: "" };
  }
  const cmd = `node "${scriptPath}" ${args.join(" ")}`;
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      cwd: SCRIPT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stdout.write(output);
    return { exitCode: 0, output };
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    process.stdout.write(output);
    return { exitCode: err.status || 1, output };
  }
}

/**
 * HTTP GET к Sheets API с авторизацией.
 * @param {string} endpoint -- путь (например, "/dashboard")
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, status?: number, data?: string, error?: string }>}
 */
function apiGet(endpoint, timeoutMs = 10_000) {
  const url = `${API_BASE}${endpoint}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
    try {
      http
        .get(url, { headers: apiHeaders() }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ ok: res.statusCode < 400, status: res.statusCode, data });
          });
        })
        .on("error", (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: e.message });
        });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

/**
 * Вывести разделительную линию с заголовком.
 * @param {string} title
 */
function header(title) {
  const line = "─".repeat(Math.max(50 - title.length - 2, 10));
  console.log(`\n${c(C.cyan, `── ${title} ${line}`)}`);
}

/**
 * Вывести значок статуса.
 * @param {boolean} ok
 * @returns {string}
 */
function statusIcon(ok) {
  return ok ? c(C.green, "OK") : c(C.red, "FAIL");
}

// ── Команды ──────────────────────────────────────────────────────────────────

// -- Quick status --

async function cmdStatus() {
  header("PEPINO AGENT OS -- System Status");

  // Docker
  const dockerRaw = shell("docker ps --format '{{.Names}}\\t{{.State}}' 2>/dev/null");
  if (dockerRaw) {
    const containers = dockerRaw.split("\n").filter(Boolean);
    const running = containers.filter((l) => l.includes("running")).length;
    console.log(`${c(C.bold, "Docker:")} ${running}/${containers.length} containers running`);
    for (const line of containers) {
      const [name, state] = line.split("\t");
      const icon = state === "running" ? c(C.green, "+") : c(C.red, "x");
      console.log(`  ${icon} ${name}`);
    }
  } else {
    console.log(`${c(C.bold, "Docker:")} ${c(C.red, "not available")}`);
  }

  // RAM
  const memRaw = shell("free -m | grep Mem");
  if (memRaw) {
    const parts = memRaw.split(/\s+/);
    const total = parseInt(parts[1]) || 0;
    const used = parseInt(parts[2]) || 0;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    const color = pct > 90 ? C.red : pct > 75 ? C.yellow : C.green;
    console.log(`${c(C.bold, "RAM:")}    ${c(color, `${used}/${total} MB (${pct}%)`)}`);
  }

  // Disk
  const diskRaw = shell("df -h / --output=pcent,avail 2>/dev/null | tail -1");
  if (diskRaw) {
    const parts = diskRaw.trim().split(/\s+/);
    const pct = parseInt(parts[0]) || 0;
    const color = pct > 90 ? C.red : pct > 75 ? C.yellow : C.green;
    console.log(`${c(C.bold, "Disk:")}   ${c(color, `${pct}% used`)} (${parts[1] || "?"} free)`);
  }

  // CPU
  const loadRaw = shell("cat /proc/loadavg 2>/dev/null");
  const nproc = parseInt(shell("nproc 2>/dev/null") || "1");
  if (loadRaw) {
    const load = parseFloat(loadRaw.split(" ")[0]);
    const pct = Math.round((load / nproc) * 100);
    const color = pct > 90 ? C.red : pct > 60 ? C.yellow : C.green;
    console.log(`${c(C.bold, "CPU:")}    ${c(color, `load ${load} / ${nproc} cores (${pct}%)`)}`);
  }

  // Сервисы
  header("Services");
  const services = [
    { name: "Sheets API", url: `${API_BASE}/health` },
    { name: "Grafana", url: "http://127.0.0.1:3000/api/health" },
    { name: "n8n", url: "http://127.0.0.1:5678/healthz" },
    { name: "Langfuse", url: "http://127.0.0.1:3001/api/public/health" },
  ];

  const results = await Promise.all(
    services.map((s) =>
      apiGet(s.url.replace(API_BASE, "").replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), 5000)
        .then((r) => ({ ...s, ok: r.ok }))
        // Для не-Sheets API сервисов, делаем прямой запрос
        .catch(() => ({ ...s, ok: false })),
    ),
  );

  // Перепроверяем сервисы напрямую (не через Sheets API proxy)
  for (const svc of services) {
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false }), 5000);
      http
        .get(svc.url, { headers: apiHeaders() }, (res) => {
          clearTimeout(timer);
          resolve({ ok: res.statusCode < 400 });
        })
        .on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false });
        });
    });
    console.log(
      `  ${statusIcon(res.ok)} ${svc.name} (${svc.url.replace("http://127.0.0.1:", ":")})`,
    );
  }

  console.log("");
}

function cmdTest() {
  header("PEPINO AGENT OS -- System Test");
  const { exitCode, output } = runScript("system-test.cjs", []);

  // Подсчёт pass/fail по выводу
  const passCount = (output.match(/PASS|OK|✓/gi) || []).length;
  const failCount = (output.match(/FAIL|ERROR|✗/gi) || []).length;
  console.log(
    `\n${c(C.bold, "Summary:")} ${c(C.green, `${passCount} passed`)}, ${c(C.red, `${failCount} failed`)}`,
  );
  process.exitCode = exitCode;
}

async function cmdDashboard() {
  header("PEPINO AGENT OS -- Dashboard");

  const res = await apiGet("/dashboard");
  if (!res.ok) {
    console.log(c(C.red, `Dashboard недоступен: ${res.error || `HTTP ${res.status}`}`));
    process.exitCode = 1;
    return;
  }

  try {
    const data = JSON.parse(res.data);
    // Компактный вывод ключевых метрик
    if (data.kpi) {
      console.log(c(C.bold, "KPIs:"));
      for (const [key, val] of Object.entries(data.kpi)) {
        console.log(`  ${key}: ${val}`);
      }
    }
    if (data.alerts && data.alerts.length > 0) {
      console.log(c(C.bold, "\nAlerts:"));
      for (const alert of data.alerts) {
        const icon = alert.severity === "critical" ? c(C.red, "!") : c(C.yellow, "~");
        console.log(`  ${icon} ${alert.message || JSON.stringify(alert)}`);
      }
    }
    // Если нет структурированных полей, показать весь JSON компактно
    if (!data.kpi && !data.alerts) {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch {
    // Ответ не JSON -- показываем как есть
    console.log(res.data);
  }

  console.log("");
}

// -- Data queries (делегируем в telegram-commands.cjs) --

function cmdSales(period) {
  header("Sales Summary");
  const args = ["sales"];
  if (period) args.push(period);
  runScript("telegram-commands.cjs", args);
}

function cmdClients() {
  header("Client Health Overview");
  runScript("telegram-commands.cjs", ["clients"]);
}

function cmdStock() {
  header("Inventory / Stock");
  runScript("telegram-commands.cjs", ["stock"]);
}

function cmdPnl(period) {
  header("P&L Summary");
  const args = ["pnl"];
  if (period) args.push(period);
  runScript("telegram-commands.cjs", args);
}

// -- Operations --

function cmdChecklist() {
  header("Daily Operations Checklist");
  runScript("daily-ops-checklist.cjs", ["--dry-run"]);
}

function cmdExpense(text) {
  if (!text) {
    console.error(c(C.red, 'Usage: pepino expense "описание сумма"'));
    console.error(c(C.dim, '  Пример: pepino expense "субстрат 5000"'));
    process.exitCode = 1;
    return;
  }
  header("Quick Expense Entry");
  runScript("expense-quick-entry.cjs", [`"${text}"`]);
}

function cmdSearch(query) {
  if (!query) {
    console.error(c(C.red, 'Usage: pepino search "запрос"'));
    process.exitCode = 1;
    return;
  }
  header("Knowledge Search");
  runScript("knowledge-retriever.cjs", [`"${query}"`]);
}

// -- Analytics --

function cmdScores() {
  header("Client Health Scores");
  runScript("client-scorer.cjs", ["--dry-run"]);
}

async function cmdForecast() {
  header("Cashflow Forecast");

  const res = await apiGet("/forecast");
  if (!res.ok) {
    console.log(c(C.red, `Forecast endpoint недоступен: ${res.error || `HTTP ${res.status}`}`));
    // Фолбэк: запускаем cashflow-forecast.cjs если есть
    if (fs.existsSync(path.join(SCRIPT_DIR, "cashflow-forecast.cjs"))) {
      console.log(c(C.dim, "Запускаю cashflow-forecast.cjs..."));
      runScript("cashflow-forecast.cjs", ["--dry-run"]);
    }
    return;
  }

  try {
    const data = JSON.parse(res.data);
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log(res.data);
  }
}

async function cmdWaste() {
  header("Waste Tracker");

  const res = await apiGet("/waste");
  if (!res.ok) {
    console.log(c(C.red, `Waste endpoint недоступен: ${res.error || `HTTP ${res.status}`}`));
    // Фолбэк: запускаем waste-tracker.cjs если есть
    if (fs.existsSync(path.join(SCRIPT_DIR, "waste-tracker.cjs"))) {
      console.log(c(C.dim, "Запускаю waste-tracker.cjs..."));
      runScript("waste-tracker.cjs", ["--dry-run"]);
    }
    return;
  }

  try {
    const data = JSON.parse(res.data);
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log(res.data);
  }
}

function cmdRadar(stream) {
  header("Trend Radar");
  const args = ["--dry-run"];
  if (stream) args.push(stream);
  runScript("trend-radar.cjs", args);
}

// -- Pipelines --

function cmdPipeline(pipeline) {
  header(`Pipeline: ${pipeline}`);
  runScript("pipeline-runner.cjs", ["--dry-run", pipeline]);
}

// -- System --

function cmdCron() {
  header("Cron Jobs");

  // Показать crontab
  const crontab = shell("crontab -l 2>/dev/null");
  if (!crontab) {
    console.log(c(C.yellow, "Crontab пуст или недоступен"));
    return;
  }

  const lines = crontab.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  console.log(c(C.bold, `${lines.length} active cron jobs:\n`));

  for (const line of lines) {
    // Извлекаем имя скрипта из строки cron
    const scriptMatch = line.match(/([a-z0-9_-]+\.(?:cjs|js))/i);
    const scriptName = scriptMatch ? scriptMatch[1] : null;

    // Находим лог-файл для определения последнего запуска
    let lastRun = c(C.dim, "unknown");
    if (scriptName) {
      const logPaths = [
        path.join(LOGS_DIR, scriptName.replace(/\.(cjs|js)$/, ".log")),
        `/tmp/${scriptName.replace(/\.(cjs|js)$/, ".log")}`,
      ];
      for (const logPath of logPaths) {
        try {
          const stat = fs.statSync(logPath);
          const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60_000);
          if (ageMin < 60) {
            lastRun = c(C.green, `${ageMin}m ago`);
          } else if (ageMin < 1440) {
            lastRun = c(C.yellow, `${Math.round(ageMin / 60)}h ago`);
          } else {
            lastRun = c(C.red, `${Math.round(ageMin / 1440)}d ago`);
          }
          break;
        } catch {
          // Файл не найден, пробуем следующий путь
        }
      }
    }

    // Выводим: расписание | скрипт | последний запуск
    const schedule = line.substring(0, line.indexOf("/") > 0 ? line.indexOf("cd ") : 50).trim();
    const shortSchedule = schedule.length > 25 ? schedule.substring(0, 25) + "..." : schedule;
    console.log(
      `  ${c(C.dim, shortSchedule.padEnd(28))} ${(scriptName || "?").padEnd(32)} ${lastRun}`,
    );
  }

  console.log("");
}

function cmdLogs(scriptName) {
  header("Logs");

  if (!scriptName) {
    // Показать список доступных лог-файлов
    console.log(c(C.bold, "Usage: pepino logs <script>\n"));
    console.log("Available logs:");
    const logDirs = [LOGS_DIR, "/tmp"];
    for (const dir of logDirs) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
        for (const file of files.sort()) {
          try {
            const stat = fs.statSync(path.join(dir, file));
            const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60_000);
            let age;
            if (ageMin < 60) age = `${ageMin}m ago`;
            else if (ageMin < 1440) age = `${Math.round(ageMin / 60)}h ago`;
            else age = `${Math.round(ageMin / 1440)}d ago`;
            console.log(`  ${c(C.dim, age.padEnd(12))} ${path.join(dir, file)}`);
          } catch {
            // stat ошибка -- пропускаем
          }
        }
      } catch {
        // readdir ошибка -- пропускаем
      }
    }
    return;
  }

  // Найти лог-файл по имени скрипта
  const baseName = scriptName.replace(/\.(cjs|js|log)$/, "");
  const candidates = [
    path.join(LOGS_DIR, `${baseName}.log`),
    path.join(LOGS_DIR, `pepino-${baseName}.log`),
    `/tmp/${baseName}.log`,
    `/tmp/pepino-${baseName}.log`,
  ];

  let logPath = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      logPath = candidate;
      break;
    }
  }

  // Если передали полный путь
  if (!logPath && fs.existsSync(scriptName)) {
    logPath = scriptName;
  }

  if (!logPath) {
    console.error(c(C.red, `Log not found for: ${scriptName}`));
    console.error(c(C.dim, `Searched: ${candidates.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  console.log(c(C.dim, `File: ${logPath}\n`));
  const tail = shell(`tail -20 "${logPath}"`);
  if (tail) {
    console.log(tail);
  } else {
    console.log(c(C.yellow, "(empty or unreadable)"));
  }

  console.log("");
}

function cmdIndex() {
  header("Knowledge Index Stats");
  runScript("knowledge-indexer.cjs", ["stats"]);
}

function cmdHelp() {
  const help = `
${c(C.bold, "PEPINO AGENT OS")} ${c(C.dim, "-- Unified CLI")}

${c(C.cyan, "Quick status:")}
  ${c(C.bold, "status")}              System health (docker, ram, disk, services)
  ${c(C.bold, "test")}                Run system tests, show pass/fail count
  ${c(C.bold, "dashboard")}           Fetch /dashboard endpoint, compact summary

${c(C.cyan, "Data queries:")}
  ${c(C.bold, "sales")} [today|week|month]   Sales summary for period
  ${c(C.bold, "clients")}             Client health overview
  ${c(C.bold, "stock")}               Inventory with days-of-stock
  ${c(C.bold, "pnl")} [week|month]    P&L summary

${c(C.cyan, "Operations:")}
  ${c(C.bold, "checklist")}           Daily operations checklist (dry-run)
  ${c(C.bold, "expense")} "text"      Quick expense entry (e.g. "substrate 5000")
  ${c(C.bold, "search")} "query"      Search knowledge base

${c(C.cyan, "Analytics:")}
  ${c(C.bold, "scores")}              Client health scores (RFM)
  ${c(C.bold, "forecast")}            Cashflow forecast
  ${c(C.bold, "waste")}               Waste tracking
  ${c(C.bold, "radar")} [stream]      Trend radar (streams: ai-agents, agro-tech, sales, marketing)

${c(C.cyan, "Pipelines:")}
  ${c(C.bold, "morning")}             Morning pipeline (dry-run)
  ${c(C.bold, "evening")}             Evening pipeline (dry-run)
  ${c(C.bold, "sunday")}              Sunday pipeline (dry-run)

${c(C.cyan, "System:")}
  ${c(C.bold, "cron")}                List cron jobs with last run time
  ${c(C.bold, "logs")} [script]       Tail last 20 lines of script log
  ${c(C.bold, "index")}               Knowledge indexer stats
  ${c(C.bold, "n8n")} [list|status]    n8n workflow overview
  ${c(C.bold, "help")}                Show this help

${c(C.dim, "Alias: alias pepino='node /home/roman/openclaw/skills/pepino-google-sheets/pepino-cli.cjs'")}
`;
  console.log(help);
}

// ── Маршрутизация команд ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || "").toLowerCase();
  const rest = args.slice(1);

  switch (command) {
    // Quick status
    case "status":
      await cmdStatus();
      break;
    case "test":
      cmdTest();
      break;
    case "dashboard":
      await cmdDashboard();
      break;

    // Data queries
    case "sales":
      cmdSales(rest[0]);
      break;
    case "clients":
      cmdClients();
      break;
    case "stock":
      cmdStock();
      break;
    case "pnl":
      cmdPnl(rest[0]);
      break;

    // Operations
    case "checklist":
      cmdChecklist();
      break;
    case "expense":
      cmdExpense(rest.join(" "));
      break;
    case "search":
      cmdSearch(rest.join(" "));
      break;

    // Analytics
    case "scores":
      cmdScores();
      break;
    case "forecast":
      await cmdForecast();
      break;
    case "waste":
      await cmdWaste();
      break;
    case "radar":
      cmdRadar(rest[0]);
      break;

    // Pipelines
    case "morning":
      cmdPipeline("morning");
      break;
    case "evening":
      cmdPipeline("evening");
      break;
    case "sunday":
      cmdPipeline("sunday");
      break;

    // System
    case "cron":
      cmdCron();
      break;
    case "logs":
      cmdLogs(rest[0]);
      break;
    case "index":
      cmdIndex();
      break;
    case "n8n":
      try {
        const out = execSync(
          "node " + path.join(__dirname, "n8n-client.cjs") + " " + (rest[0] || "status"),
          { encoding: "utf8", timeout: 15000 },
        );
        console.log(out);
      } catch (e) {
        console.error(e.stdout || e.message);
      }
      break;

    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;

    case "":
      cmdHelp();
      break;

    default:
      console.error(c(C.red, `Unknown command: ${command}`));
      console.error(c(C.dim, 'Run "pepino help" for available commands.'));
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c(C.red, `Fatal error: ${err.message}`));
  process.exitCode = 1;
});
