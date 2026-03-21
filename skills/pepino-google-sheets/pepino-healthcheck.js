#!/usr/bin/env node
/**
 * Pepino Pick -- System Health Check
 *
 * Проверяет работоспособность всех 11 компонентов Agent OS:
 *   1.  Sheets API (порт 4000)
 *   2.  API-эндпоинты (kpi, pnl, production, sales, expenses, inventory, alerts, gaps)
 *   3.  OpenClaw Gateway (pgrep)
 *   4.  Grafana (173.212.218.29:3000)
 *   5.  Docker-контейнеры
 *   6.  Cron-задачи
 *   7.  Google credentials
 *   8.  Диск (>85% = предупреждение)
 *   9.  NotebookLM auth
 *   10. Фото-библиотека
 *   11. Актуальность данных (/gaps)
 *
 * Использование:
 *   node pepino-healthcheck.js                -- полная проверка
 *   node pepino-healthcheck.js --fix          -- автовосстановление упавших сервисов
 *   node pepino-healthcheck.js --telegram     -- отправить алерт при сбоях
 *   node pepino-healthcheck.js --fix --telegram
 */

import { execSync, exec as execCb } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import http from "http";
import https from "https";
import { createRequire } from "module";
import { apiHeaders } from "./api-auth.js";
import { trace } from "./langfuse-trace.js";

const require = createRequire(import.meta.url);
const { sendStatus, sendAlert, TOPIC_STATUS } = require("./telegram-helper.cjs");

const ARGS = process.argv.slice(2);
const FIX = ARGS.includes("--fix");
const NOTIFY_TG = ARGS.includes("--telegram");

const SHEETS_API = "http://localhost:4000";
const GRAFANA_URL = "http://173.212.218.29:3000";

const GOOGLE_CREDS_PATHS = [
  "/home/roman/openclaw/google-credentials.json",
  "/home/node/.openclaw/google-credentials.json",
];
const NOTEBOOKLM_STATE = "/home/roman/.notebooklm/storage_state.json";
const PHOTO_DIR = "/home/roman/pepino-photos";

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/** GET-запрос с таймаутом, возвращает {ok, status, data, error} */
function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const isLocal = url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
    try {
      mod
        .get(url, { ...(isLocal ? { headers: apiHeaders() } : {}) }, (res) => {
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

/** Синхронная shell-команда, возвращает stdout или null */
function shell(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

/** Асинхронная shell-команда (для --fix) */
function execAsync(cmd) {
  return new Promise((resolve) => {
    execCb(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
      });
    });
  });
}

// ── 11 проверок ──────────────────────────────────────────────────────────────

/** 1. Sheets API на порту 4000 */
async function checkSheetsApi() {
  const res = await httpGet(`${SHEETS_API}/health`);
  if (!res.ok) {
    return {
      name: "Sheets API (4000)",
      ok: false,
      detail: res.error || `HTTP ${res.status}`,
      fix: "restart-sheets-api",
    };
  }
  try {
    const h = JSON.parse(res.data);
    return {
      name: "Sheets API (4000)",
      ok: true,
      detail: `uptime ${Math.round(h.uptime || 0)}s, sheets: ${h.sheets || "?"}`,
    };
  } catch {
    return { name: "Sheets API (4000)", ok: true, detail: "HTTP 200, ответ не JSON" };
  }
}

/** 2. Все API-эндпоинты возвращают валидный JSON */
async function checkApiEndpoints() {
  const endpoints = [
    "kpi",
    "pnl",
    "production",
    "sales",
    "expenses",
    "inventory",
    "alerts",
    "gaps",
  ];
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await httpGet(`${SHEETS_API}/${ep}`);
      if (!res.ok) return { ep, ok: false };
      try {
        JSON.parse(res.data);
        return { ep, ok: true };
      } catch {
        return { ep, ok: false };
      }
    }),
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    return {
      name: "API endpoints",
      ok: true,
      detail: `${endpoints.length}/${endpoints.length} OK`,
    };
  }
  return {
    name: "API endpoints",
    ok: false,
    detail: `Сбой: ${failed.map((f) => "/" + f.ep).join(", ")}`,
    fix: "restart-sheets-api",
  };
}

/** 3. OpenClaw Gateway */
async function checkGateway() {
  const pid = shell("pgrep -f 'openclaw.*gateway' | head -1");
  if (!pid) {
    return {
      name: "OpenClaw Gateway",
      ok: false,
      detail: "Процесс не найден",
      fix: "restart-gateway",
    };
  }
  const uptime = shell(`ps -p ${pid} -o etime= 2>/dev/null`) || "?";
  const mem = shell(`ps -p ${pid} -o rss= 2>/dev/null`);
  const memMb = mem ? Math.round(parseInt(mem) / 1024) : "?";
  return {
    name: "OpenClaw Gateway",
    ok: true,
    detail: `PID ${pid}, uptime ${uptime}, RAM ${memMb}MB`,
  };
}

/** 4. Grafana */
async function checkGrafana() {
  const res = await httpGet(`${GRAFANA_URL}/api/health`);
  if (!res.ok) {
    return {
      name: "Grafana",
      ok: false,
      detail: res.error || `HTTP ${res.status}`,
      fix: "restart-grafana",
    };
  }
  try {
    const h = JSON.parse(res.data);
    return {
      name: "Grafana",
      ok: true,
      detail: `${h.database || "ok"}, v${h.version || "?"}`,
    };
  } catch {
    return { name: "Grafana", ok: true, detail: "HTTP 200" };
  }
}

/** 5. Docker-контейнеры */
async function checkDocker() {
  const raw = shell("docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null");
  if (raw === null) {
    return { name: "Docker containers", ok: false, detail: "docker ps недоступен" };
  }
  if (!raw) {
    return { name: "Docker containers", ok: false, detail: "Нет запущенных контейнеров" };
  }
  const lines = raw.split("\n").filter(Boolean);
  const down = lines.filter((l) => !l.includes("Up"));
  if (down.length > 0) {
    return {
      name: "Docker containers",
      ok: false,
      detail: `Не Up: ${down.map((d) => d.split(":")[0]).join(", ")}`,
    };
  }
  return {
    name: "Docker containers",
    ok: true,
    detail: `${lines.length} контейнеров Up`,
  };
}

/** 6. Cron-задачи */
async function checkCronJobs() {
  const crontab = shell("crontab -l 2>/dev/null") || "";
  const required = [
    "sync-telegram-to-sheets.js",
    "pepino-healthcheck.js",
    "sync-dashboard.cjs",
    "health-status.cjs",
    "morning-brief",
    "recalculate-aggregates.js",
    "daily-dashboard-update.js",
    "inventory-tracker.cjs",
    "churn-detector.cjs",
    "auto-pricing.cjs",
    "weekly-report.js",
    "data-completeness-check.js",
    "daily-pnl.cjs",
    "llm-cost-telegram.cjs",
  ];
  const missing = required.filter((r) => !crontab.includes(r));
  if (missing.length === 0) {
    return {
      name: "Cron jobs",
      ok: true,
      detail: `${required.length}/${required.length} активны`,
    };
  }
  return {
    name: "Cron jobs",
    ok: false,
    detail: `Отсутствуют: ${missing.join(", ")}`,
  };
}

/** 7. Google credentials */
async function checkGoogleCreds() {
  for (const p of GOOGLE_CREDS_PATHS) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (data.client_email) {
          return {
            name: "Google credentials",
            ok: true,
            detail: `${data.client_email} (${p})`,
          };
        }
        return {
          name: "Google credentials",
          ok: false,
          detail: `${p} -- нет client_email`,
        };
      } catch {
        return {
          name: "Google credentials",
          ok: false,
          detail: `${p} -- невалидный JSON`,
        };
      }
    }
  }
  return {
    name: "Google credentials",
    ok: false,
    detail: `Файл не найден: ${GOOGLE_CREDS_PATHS.join(" / ")}`,
  };
}

/** 8. Дисковое пространство */
async function checkDiskSpace() {
  const raw = shell("df -h / --output=pcent 2>/dev/null | tail -1");
  if (!raw) {
    return { name: "Disk space", ok: true, detail: "Не удалось проверить (df)" };
  }
  const pct = parseInt(raw.trim().replace("%", ""));
  if (isNaN(pct)) {
    return { name: "Disk space", ok: true, detail: `Неизвестный формат: ${raw}` };
  }
  if (pct > 85) {
    return { name: "Disk space", ok: false, detail: `${pct}% занято (порог 85%)` };
  }
  return { name: "Disk space", ok: true, detail: `${pct}% занято` };
}

/** 9. NotebookLM auth */
async function checkNotebookLM() {
  if (!existsSync(NOTEBOOKLM_STATE)) {
    return {
      name: "NotebookLM auth",
      ok: false,
      detail: `Файл не найден: ${NOTEBOOKLM_STATE}`,
    };
  }
  try {
    const stat = statSync(NOTEBOOKLM_STATE);
    const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
    if (ageDays > 10) {
      return {
        name: "NotebookLM auth",
        ok: false,
        detail: `Токен устарел: ${Math.round(ageDays)} дн. (лимит 10)`,
      };
    }
    return {
      name: "NotebookLM auth",
      ok: true,
      detail: `Возраст: ${Math.round(ageDays)} дн.`,
    };
  } catch (e) {
    return { name: "NotebookLM auth", ok: false, detail: e.message };
  }
}

/** 10. Фото-библиотека */
async function checkPhotoLibrary() {
  if (!existsSync(PHOTO_DIR)) {
    return {
      name: "Photo library",
      ok: false,
      detail: `Директория не существует: ${PHOTO_DIR}`,
    };
  }
  const count = shell(
    `find ${PHOTO_DIR} -type f \\( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' -o -name '*.heic' \\) 2>/dev/null | wc -l`,
  );
  const dirs = shell(`ls -d ${PHOTO_DIR}/2* 2>/dev/null | wc -l`) || "0";
  return {
    name: "Photo library",
    ok: true,
    detail: `${(count || "0").trim()} фото, ${dirs.trim()} дней`,
  };
}

/** 11. Актуальность данных через /gaps */
async function checkDataFreshness() {
  const res = await httpGet(`${SHEETS_API}/gaps`);
  if (!res.ok) {
    return {
      name: "Data freshness",
      ok: false,
      detail: "GET /gaps недоступен",
      fix: "restart-sheets-api",
    };
  }
  try {
    const gaps = JSON.parse(res.data);
    const issues = [];

    if (gaps.missing_today_production) issues.push("нет производства сегодня");
    if (gaps.missing_today_sales) issues.push("нет продаж сегодня");
    if (gaps.overdue_tasks > 0) issues.push(`${gaps.overdue_tasks} просроченных задач`);
    if (gaps.open_alerts > 0) issues.push(`${gaps.open_alerts} открытых алертов`);

    if (issues.length === 0) {
      return { name: "Data freshness", ok: true, detail: "Данные актуальны" };
    }
    return { name: "Data freshness", ok: false, detail: issues.join(", ") };
  } catch {
    return { name: "Data freshness", ok: false, detail: "Невалидный JSON от /gaps" };
  }
}

// ── --fix: автовосстановление ────────────────────────────────────────────────

const FIX_ACTIONS = {
  "restart-sheets-api": async () => {
    shell("fuser -k 4000/tcp 2>/dev/null");
    await new Promise((r) => setTimeout(r, 1000));
    await execAsync(
      "cd /home/roman/openclaw/skills/pepino-google-sheets && nohup node sheets-api.js > /tmp/sheets-api.log 2>&1 &",
    );
    // Подождать запуск
    await new Promise((r) => setTimeout(r, 3000));
    const check = await httpGet(`${SHEETS_API}/health`);
    return check.ok ? "Sheets API перезапущен" : "Sheets API не поднялся, см. /tmp/sheets-api.log";
  },

  "restart-gateway": async () => {
    shell("pkill -9 -f 'openclaw-gateway' 2>/dev/null || true");
    shell("pkill -9 -f 'openclaw.*gateway' 2>/dev/null || true");
    await new Promise((r) => setTimeout(r, 1000));
    await execAsync(
      "nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const pid = shell("pgrep -f 'openclaw.*gateway' | head -1");
    return pid
      ? `Gateway перезапущен, PID ${pid}`
      : "Gateway не поднялся, см. /tmp/openclaw-gateway.log";
  },

  "restart-grafana": async () => {
    const result = await execAsync("cd /home/roman/grafana && docker compose up -d");
    return result.ok ? "Grafana перезапущена" : `Ошибка: ${result.stderr}`;
  },
};

// ── Telegram уведомление (через telegram-helper.cjs) ─────────────────────────
// sendStatus (тихое) и sendAlert (громкое) импортированы из telegram-helper.cjs

// ── Главный запуск ───────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  // Запускаем все 11 проверок параллельно
  const results = await Promise.all([
    checkSheetsApi(), // 1
    checkApiEndpoints(), // 2
    checkGateway(), // 3
    checkGrafana(), // 4
    checkDocker(), // 5
    checkCronJobs(), // 6
    checkGoogleCreds(), // 7
    checkDiskSpace(), // 8
    checkNotebookLM(), // 9
    checkPhotoLibrary(), // 10
    checkDataFreshness(), // 11
  ]);

  const elapsed = Date.now() - startTime;
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const pct = Math.round((passed / total) * 100);

  // Вывод результатов
  console.log("=".repeat(60));
  console.log(`  PEPINO PICK -- HEALTH CHECK  ${new Date().toLocaleString("ru-RU")}`);
  console.log("=".repeat(60));

  for (const r of results) {
    const mark = r.ok ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${r.name.padEnd(25)} ${r.detail}`);
  }

  console.log("-".repeat(60));
  console.log(`  Health: ${pct}% (${passed}/${total})  elapsed: ${elapsed}ms`);
  console.log("=".repeat(60));

  // --fix: попытка автовосстановления
  if (FIX) {
    const fixable = results.filter((r) => !r.ok && r.fix);
    if (fixable.length === 0) {
      console.log("\n[fix] Нет сервисов для автовосстановления.");
    } else {
      // Убираем дубли fix-ов
      const uniqueFixes = [...new Set(fixable.map((r) => r.fix))];
      console.log(`\n[fix] Автовосстановление: ${uniqueFixes.length} действий...`);

      for (const fixName of uniqueFixes) {
        const action = FIX_ACTIONS[fixName];
        if (!action) {
          console.log(`  [fix] ${fixName}: нет обработчика, пропуск`);
          continue;
        }
        console.log(`  [fix] ${fixName}...`);
        try {
          const msg = await action();
          console.log(`  [fix] ${fixName}: ${msg}`);
        } catch (e) {
          console.log(`  [fix] ${fixName}: ошибка -- ${e.message}`);
        }
      }
    }
  }

  // --telegram: отправить уведомление
  //   Все OK  → тихое (silent) уведомление, телефон не звонит
  //   Есть сбои → громкое (alert) уведомление
  const failures = results.filter((r) => !r.ok);
  if (NOTIFY_TG) {
    const lines = [`*PEPINO HEALTH CHECK -- ${pct}% (${passed}/${total})*`, ""];
    for (const r of results) {
      const mark = r.ok ? "OK" : "FAIL";
      lines.push(`[${mark}] *${r.name}*: ${r.detail}`);
    }
    if (FIX) {
      lines.push("", "_--fix применен_");
    }

    const message = lines.join("\n");

    if (failures.length > 0) {
      // Громкое уведомление при сбоях
      const result = await sendAlert(message, TOPIC_STATUS);
      console.log(
        result.ok
          ? "\nАлерт отправлен в Telegram (громкое, топик #113)"
          : `\nОшибка отправки алерта: ${result.error}`,
      );
    } else {
      // Тихое уведомление при полном здоровье
      const result = await sendStatus(message, TOPIC_STATUS);
      console.log(
        result.ok
          ? "\nСтатус отправлен в Telegram (тихое, топик #113)"
          : `\nОшибка отправки статуса: ${result.error}`,
      );
    }
  }

  await trace({
    name: "healthcheck",
    input: { checks: total, fix: FIX, telegram: NOTIFY_TG },
    output: { passed, failed: failures.length, pct },
    duration_ms: Date.now() - startTime,
    metadata: { skill: "pepino-google-sheets", cron: "healthcheck" },
  }).catch(() => {});

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Health check failed:", e.message);
  process.exit(1);
});
