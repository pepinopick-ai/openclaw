#!/usr/bin/env node
/**
 * health-status.cjs -- Мониторинг системных компонентов Pepino Pick
 *
 * Проверяет:
 *   - Sheets API (localhost:4000/health)
 *   - Grafana (localhost:3000/api/health)
 *   - n8n (localhost:5678/healthz)
 *   - Docker-контейнеры (docker ps)
 *   - Cron-задачи (по логам в /tmp и /home/roman/logs)
 *   - Системные ресурсы (диск, память, CPU)
 *
 * Вывод: JSON в stdout (для записи в /tmp/health-status.json через cron)
 * Cron: every 10 min, writes to /tmp/health-status.json
 */

const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { apiHeaders } = require("./api-auth.cjs");

// ── HTTP GET с таймаутом ─────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status?: number, data?: string, error?: string}>}
 */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: "timeout" }),
      timeoutMs,
    );
    try {
      http
        .get(url, { headers: apiHeaders() }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
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
 * Синхронная shell-команда, возвращает stdout или null при ошибке
 * @param {string} cmd
 * @returns {string | null}
 */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

// ── Проверки сервисов ────────────────────────────────────────────────────────

async function checkSheetsApi() {
  const res = await httpGet("http://localhost:4000/health");
  if (!res.ok) {
    return { name: "Sheets API", status: "error", detail: res.error || `HTTP ${res.status}` };
  }
  try {
    const h = JSON.parse(res.data);
    return {
      name: "Sheets API",
      status: "ok",
      detail: `uptime ${Math.round(h.uptime || 0)}s`,
      uptime_s: Math.round(h.uptime || 0),
    };
  } catch {
    return { name: "Sheets API", status: "ok", detail: "HTTP 200" };
  }
}

async function checkGrafana() {
  const res = await httpGet("http://localhost:3000/api/health");
  if (!res.ok) {
    return { name: "Grafana", status: "error", detail: res.error || `HTTP ${res.status}` };
  }
  try {
    const h = JSON.parse(res.data);
    return {
      name: "Grafana",
      status: "ok",
      detail: `v${h.version || "?"}`,
      version: h.version || "unknown",
    };
  } catch {
    return { name: "Grafana", status: "ok", detail: "HTTP 200" };
  }
}

async function checkN8n() {
  const res = await httpGet("http://localhost:5678/healthz");
  if (!res.ok) {
    return { name: "n8n", status: "error", detail: res.error || `HTTP ${res.status}` };
  }
  return { name: "n8n", status: "ok", detail: "healthy" };
}

// ── Docker-контейнеры ────────────────────────────────────────────────────────

function getDockerContainers() {
  const raw = shell(
    "docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.RunningFor}}\\t{{.Ports}}\\t{{.State}}' 2>/dev/null",
  );
  if (!raw) return [];

  return raw.split("\n").filter(Boolean).map((line) => {
    const [name, status, runningFor, ports, state] = line.split("\t");
    return {
      name: name || "",
      status: status || "",
      uptime: runningFor || "",
      ports: (ports || "").replace(/0\.0\.0\.0:/g, ":").replace(/:::/g, ":").slice(0, 80),
      state: state || "",
    };
  });
}

// ── Cron-задачи: определяем статус по логам ──────────────────────────────────

/**
 * @typedef {{name: string, schedule: string, log_file: string, last_run: string, status: string, next_run: string}} CronJobStatus
 */

function getCronJobs() {
  /** @type {CronJobStatus[]} */
  const jobs = [
    {
      name: "sync-telegram-to-sheets",
      schedule: "*/15 * * * *",
      log_file: "/home/roman/logs/sync-sheets.log",
    },
    {
      name: "pepino-healthcheck",
      schedule: "*/30 * * * *",
      log_file: "/tmp/pepino-healthcheck.log",
    },
    {
      name: "sync-dashboard (Grafana)",
      schedule: "*/5 * * * *",
      log_file: "/tmp/grafana-sync.log",
    },
    {
      name: "data-completeness-check",
      schedule: "0 20 * * *",
      log_file: "/home/roman/logs/data-completeness.log",
    },
    {
      name: "recalculate-aggregates",
      schedule: "0 7,20:30 * * *",
      log_file: "/home/roman/logs/recalculate.log",
    },
    {
      name: "daily-dashboard-update",
      schedule: "0 7,20 * * *",
      log_file: "/home/roman/logs/pepino-sheets-dashboard.log",
    },
    {
      name: "weekly-report",
      schedule: "0 18 * * 5",
      log_file: "/tmp/weekly-report.log",
    },
    {
      name: "morning-brief",
      schedule: "0 6 * * *",
      log_file: "/home/roman/logs/pepino-morning-brief.log",
    },
    {
      name: "evening-report",
      schedule: "0 21 * * *",
      log_file: "/home/roman/logs/pepino-evening-report.log",
    },
    {
      name: "pepino-backup",
      schedule: "0 3 * * *",
      log_file: "/home/roman/logs/pepino-backup.log",
    },
    {
      name: "reputation-monitor",
      schedule: "0 */4 * * *",
      log_file: "/home/roman/.openclaw/workspace/memory/reputation.log",
    },
  ];

  for (const job of jobs) {
    try {
      if (fs.existsSync(job.log_file)) {
        const stat = fs.statSync(job.log_file);
        const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60000);
        job.last_run = new Date(stat.mtimeMs).toISOString().slice(0, 19).replace("T", " ");

        // Определяем статус по свежести лога относительно расписания
        if (ageMinutes < 120) {
          job.status = "ok";
        } else if (ageMinutes < 1440) {
          job.status = "stale";
        } else {
          job.status = "error";
        }
      } else {
        job.last_run = "never";
        job.status = "unknown";
      }
    } catch {
      job.last_run = "error";
      job.status = "error";
    }
    // Приблизительный next_run -- не парсим cron, просто показываем расписание
    job.next_run = job.schedule;
  }

  return jobs;
}

// ── Системные ресурсы ────────────────────────────────────────────────────────

function getSystemResources() {
  // Диск
  const diskRaw = shell("df -h / --output=pcent 2>/dev/null | tail -1");
  const diskPct = diskRaw ? parseInt(diskRaw.trim().replace("%", "")) : -1;

  // Память
  const memRaw = shell("free -m 2>/dev/null | grep Mem");
  let memPct = -1;
  let memUsedMb = 0;
  let memTotalMb = 0;
  if (memRaw) {
    const parts = memRaw.split(/\s+/);
    memTotalMb = parseInt(parts[1]) || 0;
    memUsedMb = parseInt(parts[2]) || 0;
    memPct = memTotalMb > 0 ? Math.round((memUsedMb / memTotalMb) * 100) : -1;
  }

  // CPU load (1 min average)
  const loadRaw = shell("cat /proc/loadavg 2>/dev/null");
  let cpuLoad = -1;
  if (loadRaw) {
    cpuLoad = parseFloat(loadRaw.split(" ")[0]) || -1;
  }
  const cpuCores = parseInt(shell("nproc 2>/dev/null") || "1");
  const cpuPct = cpuLoad >= 0 ? Math.round((cpuLoad / cpuCores) * 100) : -1;

  return {
    disk_pct: diskPct,
    memory_pct: memPct,
    memory_used_mb: memUsedMb,
    memory_total_mb: memTotalMb,
    cpu_load_1m: cpuLoad,
    cpu_cores: cpuCores,
    cpu_pct: cpuPct,
  };
}

// ── Главная функция ──────────────────────────────────────────────────────────

async function main() {
  const [sheetsApi, grafana, n8n] = await Promise.all([
    checkSheetsApi(),
    checkGrafana(),
    checkN8n(),
  ]);

  const containers = getDockerContainers();
  const containersRunning = containers.filter((c) => c.state === "running").length;
  const containersTotal = containers.length;

  const cronJobs = getCronJobs();
  const resources = getSystemResources();

  const result = {
    timestamp: new Date().toISOString(),
    // Статусы сервисов (для stat-панелей)
    services: [sheetsApi, grafana, n8n],
    services_summary: {
      sheets_api: sheetsApi.status,
      grafana: grafana.status,
      n8n: n8n.status,
      containers_running: containersRunning,
      containers_total: containersTotal,
    },
    // Docker-контейнеры (для таблицы)
    containers,
    // Cron-задачи (для таблицы)
    cron_jobs: cronJobs,
    // Системные ресурсы (для stat-панелей)
    resources,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  const errorResult = {
    timestamp: new Date().toISOString(),
    error: err.message,
    services_summary: {
      sheets_api: "error",
      grafana: "error",
      n8n: "error",
      containers_running: 0,
      containers_total: 0,
    },
    containers: [],
    cron_jobs: [],
    resources: { disk_pct: -1, memory_pct: -1, cpu_pct: -1 },
  };
  process.stdout.write(JSON.stringify(errorResult, null, 2) + "\n");
  process.exit(1);
});
