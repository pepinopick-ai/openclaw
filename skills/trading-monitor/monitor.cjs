#!/usr/bin/env node
/**
 * Trading Monitor — утилиты для проверки торгового бота
 * Используется Claude как вспомогательный инструмент через shell
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WORKSPACE = "/home/roman/.openclaw/workspace";
const LOG_FILE = `${WORKSPACE}/memory/trading_bot.log`;
const SCALPER_DB = `${WORKSPACE}/memory/scalper.db`;
const DAEMON_DB = `${WORKSPACE}/memory/trading_daemon.db`;
const START_SCRIPT = `${WORKSPACE}/start_bot.sh`;
const ENV_FILE = `${WORKSPACE}/scripts/.env.trading`;

// ── Загрузка env ──────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// ── Проверка процесса ─────────────────────────────────────────────
function isRunning() {
  try {
    const out = execSync("pgrep -f trading_daemon.py", { encoding: "utf8" }).trim();
    return out.length > 0 ? out.split("\n").map(Number) : [];
  } catch {
    return [];
  }
}

// ── Последние строки лога ─────────────────────────────────────────
function tailLog(n = 30) {
  if (!fs.existsSync(LOG_FILE)) return "Лог не найден";
  const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n");
  return lines.slice(-n).join("\n");
}

// ── SQLite запрос ─────────────────────────────────────────────────
function sqliteQuery(db, query) {
  if (!fs.existsSync(db)) return null;
  try {
    return execSync(`sqlite3 "${db}" "${query}"`, { encoding: "utf8" }).trim();
  } catch (e) {
    return null;
  }
}

// ── Статистика сделок ─────────────────────────────────────────────
function getTradeStats() {
  const recent = sqliteQuery(
    SCALPER_DB,
    "SELECT COUNT(*) as total, SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END) as wins, " +
      "SUM(pnl_usd) as total_pnl, AVG(pnl_usd) as avg_pnl " +
      "FROM trades WHERE close_time > datetime('now','-7 days')",
  );
  const today = sqliteQuery(
    SCALPER_DB,
    "SELECT SUM(pnl_usd) FROM trades WHERE date(close_time)=date('now')",
  );
  return { recent, today };
}

// ── Последние сделки ──────────────────────────────────────────────
function getLastTrades(n = 10) {
  const rows = sqliteQuery(
    SCALPER_DB,
    `SELECT symbol, direction, entry, exit_price, pnl_usd, pnl_pct, status, close_time ` +
      `FROM trades ORDER BY close_time DESC LIMIT ${n}`,
  );
  return rows || "Нет сделок";
}

// ── Открытые арб позиции ──────────────────────────────────────────
function getArbPositions() {
  const rows = sqliteQuery(
    DAEMON_DB,
    "SELECT symbol, rate_pct, capital_usdt, collected_usd, opened_at FROM arb_positions",
  );
  return rows || "Нет арб-позиций";
}

// ── PnL за сегодня из лога ────────────────────────────────────────
function getTodayPnlFromLog() {
  if (!fs.existsSync(LOG_FILE)) return null;
  const content = fs.readFileSync(LOG_FILE, "utf8");
  const matches = [...content.matchAll(/PnL сегодня: \$([+-]?\d+\.\d+)/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

// ── Полный статус ─────────────────────────────────────────────────
function fullStatus() {
  const pids = isRunning();
  const running = pids.length > 0;
  const pnl = getTodayPnlFromLog();
  const stats = getTradeStats();
  const lastLog = tailLog(5);

  let report = [];
  report.push(`## Trading Bot Status`);
  report.push(
    `**Процесс:** ${running ? `✅ Работает (PID: ${pids.join(", ")})` : "🔴 НЕ ЗАПУЩЕН"}`,
  );
  report.push(`**PnL сегодня:** ${pnl !== null ? `$${pnl}` : "нет данных"}`);

  if (stats.recent) {
    const parts = stats.recent.split("|");
    report.push(`**7д сделок:** ${parts[0] || 0} (побед: ${parts[1] || 0})`);
    report.push(`**7д PnL:** $${parseFloat(parts[2] || 0).toFixed(4)}`);
    const total = parseInt(parts[0]) || 0;
    const wins = parseInt(parts[1]) || 0;
    if (total > 0) report.push(`**Win rate:** ${((wins / total) * 100).toFixed(1)}%`);
  }

  report.push(`\n**Последний лог:**\n\`\`\`\n${lastLog}\n\`\`\``);

  // Алерты
  const alerts = checkAlerts(running, pnl);
  if (alerts.length > 0) {
    report.push(`\n## ⚠️ Алерты`);
    alerts.forEach((a) => report.push(`- ${a}`));
  }

  return report.join("\n");
}

// ── Проверка алертов ──────────────────────────────────────────────
function checkAlerts(running, pnl) {
  const alerts = [];
  if (!running) {
    alerts.push("🔴 **Бот не запущен!** Нужен перезапуск: `/bot restart`");
  }
  if (pnl !== null && parseFloat(pnl) < -15) {
    alerts.push(`🔴 **Просадка ${pnl}$** — близко к дневному лимиту (-3% от капитала)`);
  }
  // Проверка свежести лога
  if (fs.existsSync(LOG_FILE)) {
    const stat = fs.statSync(LOG_FILE);
    const ageMin = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMin > 30) {
      alerts.push(`🟡 **Лог не обновлялся ${Math.round(ageMin)} минут** — возможно бот завис`);
    }
  }
  return alerts;
}

// ── Отправка в Telegram ───────────────────────────────────────────
function sendTelegram(text) {
  const env = loadEnv();
  const token = env.TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "Telegram не настроен";

  const payload = JSON.stringify({
    chat_id: chatId,
    text: text.replace(/\*\*/g, "").replace(/```[^`]*```/gs, "[log]"),
    disable_web_page_preview: true,
  });

  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import urllib.request, json, sys
data = json.loads(sys.stdin.read())
params = json.dumps(data).encode()
req = urllib.request.Request(
  f"https://api.telegram.org/bot${token}/sendMessage",
  data=params, headers={"Content-Type":"application/json"})
r = urllib.request.urlopen(req, timeout=10)
print("OK:", r.status)
`,
    ],
    { input: payload, encoding: "utf8" },
  );

  return result.stdout || result.stderr || "error";
}

// ── CLI ───────────────────────────────────────────────────────────
const cmd = process.argv[2];

switch (cmd) {
  case "status":
    console.log(fullStatus());
    break;
  case "check": {
    const pids = isRunning();
    const pnl = getTodayPnlFromLog();
    const alerts = checkAlerts(pids.length > 0, pnl);
    console.log(`Процесс: ${pids.length > 0 ? "✅" : "🔴"} | PnL: ${pnl ?? "n/a"}$`);
    if (alerts.length) console.log(alerts.join("\n"));
    break;
  }
  case "log":
    console.log(tailLog(parseInt(process.argv[3]) || 30));
    break;
  case "trades":
    console.log(getLastTrades(parseInt(process.argv[3]) || 10));
    break;
  case "arb":
    console.log(getArbPositions());
    break;
  case "restart": {
    const pids = isRunning();
    if (pids.length) {
      execSync(`kill ${pids.join(" ")}`);
      console.log(`Остановлен PID: ${pids.join(", ")}`);
    }
    execSync(`nohup bash ${START_SCRIPT} >> ${LOG_FILE} 2>&1 &`);
    console.log("Бот перезапущен");
    break;
  }
  case "alert": {
    const pids = isRunning();
    const pnl = getTodayPnlFromLog();
    const alerts = checkAlerts(pids.length > 0, pnl);
    const msg =
      alerts.length > 0
        ? `⚠️ Trading Bot Alerts:\n${alerts.join("\n")}`
        : `✅ Trading Bot OK\nПроцесс: ${pids.length > 0 ? "работает" : "НЕ ЗАПУЩЕН"}\nPnL: ${pnl ?? "n/a"}$`;
    console.log(sendTelegram(msg));
    break;
  }
  default:
    console.log("Usage: node monitor.js [status|check|log|trades|arb|restart|alert]");
}
