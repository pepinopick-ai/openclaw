#!/usr/bin/env node
/**
 * self-healer.cjs -- Самовосстанавливающийся монитор Pepino Pick
 *
 * Обнаруживает и автоматически устраняет типичные проблемы:
 *   1. Docker -- контейнеры unhealthy/restarting -> docker restart
 *   2. Sheets API -- localhost:4000/health недоступен -> docker restart pepino-sheets-api
 *   3. Langfuse -- localhost:3001/api/public/health недоступен -> docker compose restart
 *   4. Диск -- >85% предупреждение, >90% docker image prune -f
 *   5. Память -- >90% предупреждение, >95% определяет top consumer + алерт
 *   6. Cron-логи -- пропущенные запуски по давности файлов
 *   7. Zombie-процессы -- node-процессы старше 2 часов
 *
 * Действия:
 *   - Безопасные (restart, prune) -- выполняются автоматически
 *   - Опасные (высокая память, zombie) -- только алерт
 *
 * Использование:
 *   node self-healer.cjs              -- полный цикл с авто-фиксом
 *   node self-healer.cjs --dry-run    -- только диагностика, без действий
 *   node self-healer.cjs --quiet      -- без Telegram (только stdout)
 *
 * Cron: каждые 30 минут
 */

"use strict";

const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { sendAlert, sendStatus } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { apiHeaders } = require("./api-auth.cjs");

// ── Аргументы командной строки ──────────────────────────────────────────────

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const QUIET = ARGS.includes("--quiet");

// Топик для self-healer отчётов
const TOPIC_HEALER = 20;

// ── Утилиты ────────────────────────────────────────────────────────────────

/**
 * Синхронная shell-команда, возвращает stdout или null при ошибке
 * @param {string} cmd
 * @param {number} [timeoutMs=15000]
 * @returns {string | null}
 */
function shell(cmd, timeoutMs = 15000) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

/**
 * HTTP GET с таймаутом
 * @param {string} url
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ok: boolean, status?: number, data?: string, error?: string}>}
 */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
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
 * Выполнить действие по исправлению (или залогировать в dry-run режиме)
 * @param {string} description
 * @param {string} cmd
 * @returns {{executed: boolean, output: string | null}}
 */
function fix(description, cmd) {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] ${description}: ${cmd}`);
    return { executed: false, output: null };
  }
  console.log(`[FIX] ${description}: ${cmd}`);
  const output = shell(cmd, 30000);
  return { executed: true, output };
}

// ── Результат проверки ───────────────────────────────────────────────────────

/**
 * @typedef {"ok" | "warn" | "fixed" | "alert"} CheckLevel
 * @typedef {{name: string, level: CheckLevel, detail: string}} CheckResult
 */

/** @type {CheckResult[]} */
const results = [];

/**
 * Добавить результат проверки
 * @param {string} name
 * @param {CheckLevel} level
 * @param {string} detail
 */
function report(name, level, detail) {
  results.push({ name, level, detail });
  const prefix = { ok: "OK", warn: "WARN", fixed: "FIXED", alert: "ALERT" }[level];
  console.log(`[${prefix}] ${name}: ${detail}`);
}

// ── 1. Docker: проверка контейнеров ─────────────────────────────────────────

function checkDocker() {
  const raw = shell('docker ps -a --format "{{.Names}}:{{.Status}}:{{.State}}" 2>/dev/null');
  if (!raw) {
    report("Docker", "alert", "docker ps не отвечает");
    return;
  }

  const lines = raw.split("\n").filter(Boolean);
  let allHealthy = true;

  for (const line of lines) {
    const [name, status, state] = line.split(":");
    if (!name) continue;

    // Проверяем unhealthy, restarting, exited контейнеры
    const isUnhealthy = (status || "").toLowerCase().includes("unhealthy");
    const isRestarting = (state || "").toLowerCase() === "restarting";
    const isExited = (state || "").toLowerCase() === "exited";

    if (isUnhealthy || isRestarting) {
      allHealthy = false;
      const result = fix(
        `Перезапуск контейнера ${name} (${isUnhealthy ? "unhealthy" : "restarting"})`,
        `docker restart ${name}`,
      );
      report(
        `Docker/${name}`,
        result.executed ? "fixed" : "warn",
        `${isUnhealthy ? "unhealthy" : "restarting"} -> ${result.executed ? "restarted" : "dry-run"}`,
      );
    } else if (isExited) {
      // Выключенные контейнеры -- только предупреждение, не перезапускаем
      allHealthy = false;
      report(`Docker/${name}`, "warn", "exited (не перезапускаем автоматически)");
    }
  }

  if (allHealthy) {
    report("Docker", "ok", `${lines.length} контейнеров работают`);
  }
}

// ── 2. Sheets API ────────────────────────────────────────────────────────────

async function checkSheetsApi() {
  const res = await httpGet("http://127.0.0.1:4000/health");
  if (res.ok) {
    report("Sheets API", "ok", "healthy");
    return;
  }

  // API не отвечает -- перезапускаем контейнер
  const result = fix("Sheets API не отвечает", "docker restart pepino-sheets-api");
  report(
    "Sheets API",
    result.executed ? "fixed" : "alert",
    `${res.error || "HTTP " + res.status} -> ${result.executed ? "restarted" : "dry-run"}`,
  );
}

// ── 3. Langfuse ──────────────────────────────────────────────────────────────

async function checkLangfuse() {
  const res = await httpGet("http://127.0.0.1:3001/api/public/health");
  if (res.ok) {
    report("Langfuse", "ok", "healthy");
    return;
  }

  // Langfuse не отвечает -- перезапускаем через docker compose
  const result = fix(
    "Langfuse не отвечает",
    "cd /home/roman/openclaw/infra/langfuse && docker compose restart",
  );
  report(
    "Langfuse",
    result.executed ? "fixed" : "alert",
    `${res.error || "HTTP " + res.status} -> ${result.executed ? "compose restarted" : "dry-run"}`,
  );
}

// ── 4. Диск ──────────────────────────────────────────────────────────────────

function checkDisk() {
  const diskRaw = shell("df -h / --output=pcent 2>/dev/null | tail -1");
  if (!diskRaw) {
    report("Disk", "warn", "не удалось получить данные df");
    return;
  }

  const diskPct = parseInt(diskRaw.trim().replace("%", ""), 10);
  if (isNaN(diskPct)) {
    report("Disk", "warn", `неожиданный вывод df: ${diskRaw}`);
    return;
  }

  if (diskPct > 90) {
    const result = fix(
      `Диск заполнен на ${diskPct}%, очистка Docker-образов`,
      "docker image prune -f",
    );
    report(
      "Disk",
      result.executed ? "fixed" : "alert",
      `${diskPct}% -> ${result.executed ? "prune выполнен" : "dry-run"}`,
    );
  } else if (diskPct > 85) {
    report("Disk", "warn", `${diskPct}% заполнено (порог 90%)`);
  } else {
    report("Disk", "ok", `${diskPct}% использовано`);
  }
}

// ── 5. Память ────────────────────────────────────────────────────────────────

function checkMemory() {
  const memRaw = shell("free -m 2>/dev/null | grep Mem");
  if (!memRaw) {
    report("Memory", "warn", "не удалось получить данные free");
    return;
  }

  const parts = memRaw.split(/\s+/);
  const totalMb = parseInt(parts[1], 10) || 0;
  const usedMb = parseInt(parts[2], 10) || 0;
  const memPct = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : -1;

  if (memPct > 95) {
    // Критичный уровень -- определяем top consumer
    const topProcess = shell(
      "ps aux --sort=-%mem | head -2 | tail -1 | awk '{printf \"%s (PID %s, %s%%)\", $11, $2, $4}'",
    );
    report(
      "Memory",
      "alert",
      `${memPct}% (${usedMb}/${totalMb} MB), top: ${topProcess || "unknown"}`,
    );
  } else if (memPct > 90) {
    report("Memory", "warn", `${memPct}% (${usedMb}/${totalMb} MB)`);
  } else {
    report("Memory", "ok", `${memPct}% (${usedMb}/${totalMb} MB)`);
  }
}

// ── 6. Cron-логи ─────────────────────────────────────────────────────────────

/**
 * Проверяет свежесть лог-файла
 * @param {string} name -- название задачи
 * @param {string} logPath -- путь к логу
 * @param {number} maxAgeMin -- максимально допустимый возраст в минутах
 */
function checkLogFreshness(name, logPath, maxAgeMin) {
  if (!fs.existsSync(logPath)) {
    report(`Cron/${name}`, "warn", `лог не найден: ${logPath}`);
    return;
  }

  try {
    const stat = fs.statSync(logPath);
    const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);

    if (ageMin > maxAgeMin) {
      const ageHours = Math.round(ageMin / 60);
      report(
        `Cron/${name}`,
        "alert",
        `последнее обновление ${ageHours}ч назад (лимит ${Math.round(maxAgeMin / 60)}ч)`,
      );
    } else {
      report(`Cron/${name}`, "ok", `обновлён ${ageMin} мин назад`);
    }
  } catch (e) {
    report(`Cron/${name}`, "warn", `ошибка чтения: ${e.message}`);
  }
}

function checkCronLogs() {
  // morning-brief: ежедневно в 6:00, допуск 26 часов
  checkLogFreshness("morning-brief", "/home/roman/logs/pepino-morning-brief.log", 26 * 60);

  // sync-telegram-to-sheets: каждые 15 мин, допуск 30 мин
  checkLogFreshness("sync-sheets", "/home/roman/logs/sync-sheets.log", 30);

  // recalculate-aggregates: дважды в день, допуск 14 часов
  checkLogFreshness("recalculate", "/home/roman/logs/recalculate.log", 14 * 60);
}

// ── 7. Zombie/долгие node-процессы ───────────────────────────────────────────

function checkStaleProcesses() {
  // Получаем node-процессы с временем запуска (etime в формате [[DD-]HH:]MM:SS)
  const raw = shell('ps -eo pid,etime,comm,args --no-headers | grep "[n]ode" 2>/dev/null');
  if (!raw) {
    report("Processes", "ok", "нет node-процессов");
    return;
  }

  const lines = raw.split("\n").filter(Boolean);
  /** @type {string[]} */
  const stale = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const pid = parts[0];
    const etime = parts[1]; // формат: MM:SS, HH:MM:SS, или D-HH:MM:SS

    // Парсим elapsed time в минутах
    let totalMinutes = 0;
    if (etime.includes("-")) {
      // D-HH:MM:SS
      const [days, rest] = etime.split("-");
      const [hh, mm] = rest.split(":");
      totalMinutes = parseInt(days, 10) * 1440 + parseInt(hh, 10) * 60 + parseInt(mm, 10);
    } else {
      const segments = etime.split(":");
      if (segments.length === 3) {
        // HH:MM:SS
        totalMinutes = parseInt(segments[0], 10) * 60 + parseInt(segments[1], 10);
      } else if (segments.length === 2) {
        // MM:SS
        totalMinutes = parseInt(segments[0], 10);
      }
    }

    // Предупреждаем о процессах старше 2 часов
    if (totalMinutes >= 120) {
      const cmdSuffix = parts.slice(3).join(" ").slice(0, 60);
      stale.push(`PID ${pid} (${etime}): ${cmdSuffix}`);
    }
  }

  if (stale.length > 0) {
    report(
      "Processes",
      "warn",
      `${stale.length} node-процессов работают >2ч:\n  ${stale.join("\n  ")}`,
    );
  } else {
    report("Processes", "ok", `${lines.length} node-процессов, все в норме`);
  }
}

// ── Формирование Telegram-отчёта ─────────────────────────────────────────────

/**
 * Собирает результаты проверок в текст для Telegram
 * @returns {{text: string, hasProblems: boolean}}
 */
function buildTelegramReport() {
  const alerts = results.filter((r) => r.level === "alert");
  const warnings = results.filter((r) => r.level === "warn");
  const fixes = results.filter((r) => r.level === "fixed");
  const oks = results.filter((r) => r.level === "ok");

  const hasProblems = alerts.length > 0 || warnings.length > 0 || fixes.length > 0;

  // Если всё в порядке -- не отправляем (тишина = норма)
  if (!hasProblems) {
    return { text: "", hasProblems: false };
  }

  const modeLabel = DRY_RUN ? " [DRY-RUN]" : "";
  const lines = [`*Self-Healer${modeLabel}*`];
  const now = new Date().toLocaleString("ru-RU", { timeZone: "America/Argentina/Buenos_Aires" });
  lines.push(`_${now}_\n`);

  if (alerts.length > 0) {
    lines.push("*ALERT:*");
    for (const r of alerts) {
      lines.push(`  ${r.name}: ${r.detail}`);
    }
  }

  if (fixes.length > 0) {
    lines.push("\n*AUTO-FIXED:*");
    for (const r of fixes) {
      lines.push(`  ${r.name}: ${r.detail}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("\n*WARN:*");
    for (const r of warnings) {
      lines.push(`  ${r.name}: ${r.detail}`);
    }
  }

  lines.push(
    `\n${oks.length} OK / ${fixes.length} fixed / ${warnings.length} warn / ${alerts.length} alert`,
  );

  return { text: lines.join("\n"), hasProblems: true };
}

// ── Главная функция ──────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`\n=== Self-Healer ${DRY_RUN ? "[DRY-RUN] " : ""}${new Date().toISOString()} ===\n`);

  // Параллельные HTTP-проверки
  const [sheetsResult, langfuseResult] = await Promise.all([checkSheetsApi(), checkLangfuse()]);

  // Синхронные проверки
  checkDocker();
  checkDisk();
  checkMemory();
  checkCronLogs();
  checkStaleProcesses();

  const durationMs = Date.now() - startMs;

  // Сводка в stdout
  const alerts = results.filter((r) => r.level === "alert").length;
  const warnings = results.filter((r) => r.level === "warn").length;
  const fixes = results.filter((r) => r.level === "fixed").length;
  const oks = results.filter((r) => r.level === "ok").length;

  console.log(
    `\n--- Итого: ${oks} OK / ${fixes} fixed / ${warnings} warn / ${alerts} alert (${durationMs}ms) ---\n`,
  );

  // Telegram: отправляем только если есть проблемы
  if (!QUIET) {
    const { text, hasProblems } = buildTelegramReport();
    if (hasProblems) {
      const isUrgent = alerts > 0;
      if (isUrgent) {
        await sendAlert(text, TOPIC_HEALER);
      } else {
        await sendStatus(text, TOPIC_HEALER);
      }
    }
  }

  // Langfuse trace
  await trace({
    name: "self-healer",
    input: { dry_run: DRY_RUN, quiet: QUIET },
    output: {
      total: results.length,
      ok: oks,
      fixed: fixes,
      warn: warnings,
      alert: alerts,
      checks: results,
    },
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", script: "self-healer" },
  });
}

main().catch((err) => {
  console.error(`[self-healer] Критическая ошибка: ${err.message}`);
  process.exit(1);
});
