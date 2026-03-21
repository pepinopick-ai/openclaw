#!/usr/bin/env node
/**
 * status-page.cjs -- Генерация статической HTML-страницы состояния системы
 *
 * Собирает данные из:
 *   - HTTP health-эндпоинтов сервисов (Sheets API, Langfuse, Grafana, n8n)
 *   - Sheets API /dashboard (бизнес-метрики)
 *   - Лог-файлов cron-задач (/home/roman/logs/)
 *   - Docker (docker ps)
 *   - Системных утилит (free, df, /proc/loadavg)
 *   - knowledge-index.json (база знаний)
 *
 * Вывод: /tmp/pepino-status.html
 * Cron: каждые 10 минут (можно вызывать из health-status.cjs или отдельно)
 */

const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { apiHeaders } = require("./api-auth.cjs");

const OUTPUT_PATH = "/tmp/pepino-status.html";
const LOGS_DIR = "/home/roman/logs";
const KNOWLEDGE_INDEX_PATH = path.join(
  process.env.HOME || "/root",
  ".openclaw/workspace/memory/knowledge-index.json",
);

// ── Конфигурация сервисов ───────────────────────────────────────────────────

/** @type {Array<{name: string, url: string, label: string}>} */
const SERVICES = [
  { name: "sheets_api", url: "http://127.0.0.1:4000/health", label: "Sheets API" },
  { name: "langfuse", url: "http://127.0.0.1:3001/api/public/health", label: "Langfuse" },
  { name: "grafana", url: "http://127.0.0.1:3000/api/health", label: "Grafana" },
  { name: "n8n", url: "http://127.0.0.1:5678/healthz", label: "n8n" },
];

// ── Конфигурация cron-задач с ожидаемым интервалом (минуты) ──────────────────

/** @type {Array<{name: string, schedule: string, log_file: string, expectedIntervalMin: number}>} */
const CRON_JOBS = [
  {
    name: "sync-telegram-to-sheets",
    schedule: "*/15 * * * *",
    log_file: `${LOGS_DIR}/sync-sheets.log`,
    expectedIntervalMin: 20,
  },
  {
    name: "pepino-healthcheck",
    schedule: "*/30 * * * *",
    log_file: "/tmp/pepino-healthcheck.log",
    expectedIntervalMin: 35,
  },
  {
    name: "sync-dashboard (Grafana)",
    schedule: "*/5 * * * *",
    log_file: "/tmp/grafana-sync.log",
    expectedIntervalMin: 10,
  },
  {
    name: "health-status",
    schedule: "*/10 * * * *",
    log_file: "/tmp/health-status.json",
    expectedIntervalMin: 15,
  },
  {
    name: "inventory-tracker",
    schedule: "3 8 * * *",
    log_file: `${LOGS_DIR}/inventory-tracker.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "churn-detector",
    schedule: "3 10 * * 1-5",
    log_file: `${LOGS_DIR}/churn-detector.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "daily-pnl",
    schedule: "7 21 * * *",
    log_file: `${LOGS_DIR}/daily-pnl.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "morning-brief",
    schedule: "0 6 * * *",
    log_file: `${LOGS_DIR}/pepino-morning-brief.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "evening-report",
    schedule: "0 21 * * *",
    log_file: `${LOGS_DIR}/pepino-evening-report.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "data-completeness",
    schedule: "0 20 * * *",
    log_file: `${LOGS_DIR}/data-completeness.log`,
    expectedIntervalMin: 1500,
  },
  {
    name: "recalculate-aggregates",
    schedule: "0 7,20:30",
    log_file: `${LOGS_DIR}/recalculate.log`,
    expectedIntervalMin: 900,
  },
  {
    name: "daily-dashboard-update",
    schedule: "0 7,20",
    log_file: `${LOGS_DIR}/pepino-sheets-dashboard.log`,
    expectedIntervalMin: 900,
  },
  {
    name: "weekly-report",
    schedule: "0 18 * * 5",
    log_file: "/tmp/weekly-report.log",
    expectedIntervalMin: 10200,
  },
  {
    name: "auto-pricing",
    schedule: "7 12 * * 1,3,5",
    log_file: `${LOGS_DIR}/auto-pricing.log`,
    expectedIntervalMin: 3000,
  },
  {
    name: "pepino-backup",
    schedule: "0 3 * * *",
    log_file: `${LOGS_DIR}/pepino-backup.log`,
    expectedIntervalMin: 1500,
  },
];

// ── Утилиты ─────────────────────────────────────────────────────────────────

/**
 * Синхронная shell-команда, возвращает stdout или null при ошибке
 * @param {string} cmd
 * @returns {string | null}
 */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * HTTP GET с замером времени ответа
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status?: number, data?: string, error?: string, responseMs: number}>}
 */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setTimeout(
      () => resolve({ ok: false, error: "timeout", responseMs: timeoutMs }),
      timeoutMs,
    );
    try {
      http
        .get(url, { headers: apiHeaders() }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({
              ok: res.statusCode < 400,
              status: res.statusCode,
              data,
              responseMs: Date.now() - start,
            });
          });
        })
        .on("error", (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: e.message, responseMs: Date.now() - start });
        });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, responseMs: Date.now() - start });
    }
  });
}

/**
 * Экранирование HTML-спецсимволов
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Форматирование даты в читаемый вид (dd.mm.yyyy HH:MM)
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${d}.${m}.${y} ${hh}:${mm}`;
}

/**
 * Человекочитаемый возраст в минутах/часах/днях
 * @param {number} ageMinutes
 * @returns {string}
 */
function formatAge(ageMinutes) {
  if (ageMinutes < 1) return "< 1 min";
  if (ageMinutes < 60) return `${ageMinutes} min ago`;
  if (ageMinutes < 1440) return `${Math.round(ageMinutes / 60)} hr ago`;
  return `${Math.round(ageMinutes / 1440)} day(s) ago`;
}

// ── Сбор данных ─────────────────────────────────────────────────────────────

/**
 * Проверяем все сервисы параллельно
 * @returns {Promise<Array<{name: string, label: string, ok: boolean, responseMs: number, detail: string}>>}
 */
async function checkServices() {
  const results = await Promise.all(
    SERVICES.map(async (svc) => {
      const res = await httpGet(svc.url);
      let detail = "";
      if (res.ok) {
        try {
          const parsed = JSON.parse(res.data);
          if (parsed.version) detail = `v${parsed.version}`;
          else if (parsed.status) detail = parsed.status;
          else if (parsed.uptime) detail = `uptime ${Math.round(parsed.uptime)}s`;
          else detail = "healthy";
        } catch {
          detail = `HTTP ${res.status || 200}`;
        }
      } else {
        detail = res.error || `HTTP ${res.status}`;
      }
      return {
        name: svc.name,
        label: svc.label,
        ok: res.ok,
        responseMs: res.responseMs,
        detail,
      };
    }),
  );
  return results;
}

/**
 * Бизнес-метрики из Sheets API /dashboard
 * @returns {Promise<{salesToday: string, margin: string, openAlerts: string, stockCritical: string}>}
 */
async function getBusinessMetrics() {
  const defaults = { salesToday: "N/A", margin: "N/A", openAlerts: "N/A", stockCritical: "N/A" };
  const res = await httpGet("http://127.0.0.1:4000/dashboard");
  if (!res.ok) return defaults;
  try {
    const data = JSON.parse(res.data);
    return {
      salesToday:
        data.sales_today != null
          ? `$${Number(data.sales_today).toLocaleString()}`
          : data.salesToday != null
            ? `$${Number(data.salesToday).toLocaleString()}`
            : defaults.salesToday,
      margin:
        data.margin_pct != null
          ? `${data.margin_pct}%`
          : data.margin != null
            ? `${data.margin}%`
            : defaults.margin,
      openAlerts:
        data.open_alerts != null
          ? String(data.open_alerts)
          : data.openAlerts != null
            ? String(data.openAlerts)
            : defaults.openAlerts,
      stockCritical:
        data.stock_critical != null
          ? String(data.stock_critical)
          : data.stockCritical != null
            ? String(data.stockCritical)
            : defaults.stockCritical,
    };
  } catch {
    return defaults;
  }
}

/**
 * Статус cron-задач по mtime логов
 * @returns {Array<{name: string, schedule: string, lastRun: string, ageStr: string, status: string}>}
 */
function getCronStatus() {
  return CRON_JOBS.map((job) => {
    try {
      if (!fs.existsSync(job.log_file)) {
        return {
          name: job.name,
          schedule: job.schedule,
          lastRun: "never",
          ageStr: "-",
          status: "unknown",
        };
      }
      const stat = fs.statSync(job.log_file);
      const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60_000);
      const lastRun = formatDate(new Date(stat.mtimeMs));
      const ageStr = formatAge(ageMinutes);

      /** @type {string} */
      let status;
      if (stat.size === 0) {
        status = "empty";
      } else if (ageMinutes <= job.expectedIntervalMin) {
        status = "ok";
      } else if (ageMinutes <= job.expectedIntervalMin * 2) {
        status = "stale";
      } else {
        status = "overdue";
      }

      return { name: job.name, schedule: job.schedule, lastRun, ageStr, status };
    } catch {
      return {
        name: job.name,
        schedule: job.schedule,
        lastRun: "error",
        ageStr: "-",
        status: "error",
      };
    }
  });
}

/**
 * Docker-контейнеры
 * @returns {Array<{name: string, status: string, uptime: string, state: string}>}
 */
function getDockerContainers() {
  const raw = shell(
    "docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.State}}' 2>/dev/null",
  );
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, status, uptime, state] = line.split("\t");
      return { name: name || "", status: status || "", uptime: uptime || "", state: state || "" };
    });
}

/**
 * Системные ресурсы
 * @returns {{ramUsedMb: number, ramTotalMb: number, ramPct: number, diskUsed: string, diskTotal: string, diskPct: number, load1: string, load5: string, load15: string, cpuCores: number}}
 */
function getSystemResources() {
  // RAM
  const memRaw = shell("free -m 2>/dev/null | grep Mem");
  let ramUsedMb = 0,
    ramTotalMb = 0,
    ramPct = 0;
  if (memRaw) {
    const parts = memRaw.split(/\s+/);
    ramTotalMb = parseInt(parts[1]) || 0;
    ramUsedMb = parseInt(parts[2]) || 0;
    ramPct = ramTotalMb > 0 ? Math.round((ramUsedMb / ramTotalMb) * 100) : 0;
  }

  // Disk
  const diskRaw = shell("df -h / 2>/dev/null | tail -1");
  let diskUsed = "?",
    diskTotal = "?",
    diskPct = 0;
  if (diskRaw) {
    const parts = diskRaw.split(/\s+/);
    diskTotal = parts[1] || "?";
    diskUsed = parts[2] || "?";
    diskPct = parseInt((parts[4] || "0").replace("%", "")) || 0;
  }

  // Load
  const loadRaw = shell("cat /proc/loadavg 2>/dev/null");
  let load1 = "?",
    load5 = "?",
    load15 = "?";
  if (loadRaw) {
    const parts = loadRaw.split(" ");
    load1 = parts[0] || "?";
    load5 = parts[1] || "?";
    load15 = parts[2] || "?";
  }

  const cpuCores = parseInt(shell("nproc 2>/dev/null") || "1");

  return {
    ramUsedMb,
    ramTotalMb,
    ramPct,
    diskUsed,
    diskTotal,
    diskPct,
    load1,
    load5,
    load15,
    cpuCores,
  };
}

/**
 * Индекс базы знаний
 * @returns {{docsCount: number, chunksCount: number, lastIndexed: string}}
 */
function getKnowledgeIndex() {
  const defaults = { docsCount: 0, chunksCount: 0, lastIndexed: "N/A" };
  try {
    if (!fs.existsSync(KNOWLEDGE_INDEX_PATH)) return defaults;
    const raw = fs.readFileSync(KNOWLEDGE_INDEX_PATH, "utf8");
    const data = JSON.parse(raw);
    const docs = Array.isArray(data.documents) ? data.documents : [];
    let chunks = 0;
    for (const doc of docs) {
      chunks += Array.isArray(doc.chunks) ? doc.chunks.length : 0;
    }
    const lastIndexed = data.updated_at ? formatDate(new Date(data.updated_at)) : "N/A";
    return { docsCount: docs.length, chunksCount: chunks, lastIndexed };
  } catch {
    return defaults;
  }
}

// ── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface-hover: #22253a;
  --border: #2a2d3a;
  --text: #e0e0e6;
  --text-dim: #8b8fa3;
  --green: #34d399;
  --red: #f87171;
  --yellow: #fbbf24;
  --blue: #60a5fa;
  --purple: #a78bfa;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}
h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 4px;
}
.subtitle {
  color: var(--text-dim);
  font-size: 0.85rem;
  margin-bottom: 28px;
}
h2 {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 28px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

/* Сетка карточек сервисов */
.grid { display: grid; gap: 12px; }
.grid-4 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.grid-4b { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  transition: background 0.15s;
}
.card:hover { background: var(--surface-hover); }
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
.dot.red { background: var(--red); box-shadow: 0 0 6px var(--red); }
.dot.yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
.card-label {
  font-weight: 500;
  font-size: 0.95rem;
}
.card-value {
  font-size: 1.4rem;
  font-weight: 700;
  margin-bottom: 2px;
}
.card-detail {
  font-size: 0.78rem;
  color: var(--text-dim);
}

/* Таблицы */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th {
  text-align: left;
  color: var(--text-dim);
  font-weight: 500;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}
tr:last-child td { border-bottom: none; }
.table-wrap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

/* Индикаторы статуса в таблице */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.badge.ok { background: rgba(52,211,153,0.15); color: var(--green); }
.badge.stale { background: rgba(251,191,36,0.15); color: var(--yellow); }
.badge.overdue, .badge.error { background: rgba(248,113,113,0.15); color: var(--red); }
.badge.unknown, .badge.empty { background: rgba(139,143,163,0.15); color: var(--text-dim); }
.badge.running { background: rgba(52,211,153,0.15); color: var(--green); }
.badge.exited { background: rgba(248,113,113,0.15); color: var(--red); }

/* Системные ресурсы -- прогресс-бар */
.progress-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.progress-bar {
  flex: 1;
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}
.progress-label {
  font-size: 0.82rem;
  min-width: 40px;
  text-align: right;
  font-weight: 500;
}

/* Footer */
.footer {
  margin-top: 32px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 0.75rem;
  color: var(--text-dim);
  text-align: center;
}
`;

// ── Генерация HTML ──────────────────────────────────────────────────────────

/**
 * Генерирует карточку сервиса
 * @param {{label: string, ok: boolean, responseMs: number, detail: string}} svc
 * @returns {string}
 */
function renderServiceCard(svc) {
  const dotClass = svc.ok ? "green" : "red";
  const statusText = svc.ok ? "Online" : "Offline";
  return `
    <div class="card">
      <div class="card-header">
        <span class="dot ${dotClass}"></span>
        <span class="card-label">${escapeHtml(svc.label)}</span>
      </div>
      <div class="card-value">${statusText}</div>
      <div class="card-detail">${svc.responseMs}ms &middot; ${escapeHtml(svc.detail)}</div>
    </div>`;
}

/**
 * Генерирует карточку бизнес-метрики
 * @param {string} label
 * @param {string} value
 * @param {string} color
 * @returns {string}
 */
function renderMetricCard(label, value, color) {
  return `
    <div class="card">
      <div class="card-label" style="margin-bottom:6px">${escapeHtml(label)}</div>
      <div class="card-value" style="color:var(--${color})">${escapeHtml(value)}</div>
    </div>`;
}

/**
 * Генерирует прогресс-бар
 * @param {string} label
 * @param {number} pct
 * @param {string} detail
 * @returns {string}
 */
function renderProgressRow(label, pct, detail) {
  const color = pct > 85 ? "var(--red)" : pct > 70 ? "var(--yellow)" : "var(--green)";
  return `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:0.85rem">${escapeHtml(label)}</span>
        <span style="font-size:0.82rem;color:var(--text-dim)">${escapeHtml(detail)}</span>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div>
        </div>
        <span class="progress-label">${pct}%</span>
      </div>
    </div>`;
}

/**
 * Генерирует полный HTML-документ
 */
async function generateHtml() {
  // Параллельный сбор данных
  const [services, metrics] = await Promise.all([checkServices(), getBusinessMetrics()]);
  const cronJobs = getCronStatus();
  const containers = getDockerContainers();
  const resources = getSystemResources();
  const knowledge = getKnowledgeIndex();
  const now = formatDate(new Date());

  // -- Секция сервисов --
  const servicesHtml = services.map(renderServiceCard).join("");

  // -- Секция бизнес-метрик --
  const metricsHtml = [
    renderMetricCard("Sales Today", metrics.salesToday, "green"),
    renderMetricCard("Margin %", metrics.margin, "blue"),
    renderMetricCard("Open Alerts", metrics.openAlerts, "yellow"),
    renderMetricCard("Stock Critical", metrics.stockCritical, "red"),
  ].join("");

  // -- Таблица cron-задач --
  const cronRows = cronJobs
    .map((job) => {
      const badgeClass = job.status;
      return `
      <tr>
        <td>${escapeHtml(job.name)}</td>
        <td><code>${escapeHtml(job.schedule)}</code></td>
        <td>${escapeHtml(job.lastRun)}</td>
        <td>${escapeHtml(job.ageStr)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(job.status)}</span></td>
      </tr>`;
    })
    .join("");

  // -- Таблица Docker --
  const dockerRows = containers
    .map((c) => {
      const badgeClass = c.state === "running" ? "running" : "exited";
      return `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(c.state)}</span></td>
        <td>${escapeHtml(c.status)}</td>
        <td>${escapeHtml(c.uptime)}</td>
      </tr>`;
    })
    .join("");

  // -- Ресурсы --
  const loadPct =
    resources.cpuCores > 0
      ? Math.round((parseFloat(resources.load1) / resources.cpuCores) * 100)
      : 0;
  const resourcesHtml = [
    renderProgressRow(
      "RAM",
      resources.ramPct,
      `${resources.ramUsedMb} / ${resources.ramTotalMb} MB`,
    ),
    renderProgressRow("Disk", resources.diskPct, `${resources.diskUsed} / ${resources.diskTotal}`),
    renderProgressRow(
      "CPU Load",
      loadPct,
      `${resources.load1} / ${resources.load5} / ${resources.load15} (${resources.cpuCores} cores)`,
    ),
  ].join("");

  // -- Knowledge --
  const knowledgeHtml = `
    <div class="grid grid-4b" style="margin-top:8px">
      ${renderMetricCard("Documents", String(knowledge.docsCount), "blue")}
      ${renderMetricCard("Chunks", String(knowledge.chunksCount), "purple")}
      ${renderMetricCard("Last Indexed", knowledge.lastIndexed, "green")}
    </div>`;

  // -- Сборка --
  const servicesOnline = services.filter((s) => s.ok).length;
  const overallStatus =
    servicesOnline === services.length
      ? "All Systems Operational"
      : `${servicesOnline}/${services.length} Services Online`;
  const overallColor = servicesOnline === services.length ? "var(--green)" : "var(--yellow)";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pepino Pick Agent OS v2 -- System Status</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>Pepino Pick Agent OS v2 -- System Status</h1>
  <div class="subtitle">${escapeHtml(now)} &middot; <span style="color:${overallColor}">${escapeHtml(overallStatus)}</span></div>

  <h2>Services</h2>
  <div class="grid grid-4">${servicesHtml}</div>

  <h2>Business Metrics</h2>
  <div class="grid grid-4b">${metricsHtml}</div>

  <h2>Cron Jobs</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Schedule</th>
          <th>Last Run</th>
          <th>Age</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${cronRows}</tbody>
    </table>
  </div>

  <h2>Docker Containers (${containers.filter((c) => c.state === "running").length}/${containers.length} running)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>State</th>
          <th>Status</th>
          <th>Uptime</th>
        </tr>
      </thead>
      <tbody>${dockerRows.length > 0 ? dockerRows : '<tr><td colspan="4" style="color:var(--text-dim)">No containers found</td></tr>'}</tbody>
    </table>
  </div>

  <h2>System Resources</h2>
  <div class="card" style="padding:20px">${resourcesHtml}</div>

  <h2>Knowledge Index</h2>
  ${knowledgeHtml}

  <div class="footer">
    Pepino Pick Agent OS v2 &middot; Auto-generated by status-page.cjs &middot; Updated ${escapeHtml(now)}
  </div>
</body>
</html>`;
}

// ── Точка входа ─────────────────────────────────────────────────────────────

async function main() {
  const html = await generateHtml();
  fs.writeFileSync(OUTPUT_PATH, html, "utf8");
  console.log(`[status-page] Written ${(html.length / 1024).toFixed(1)} KB to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(`[status-page] Fatal: ${err.message}`);
  process.exit(1);
});
