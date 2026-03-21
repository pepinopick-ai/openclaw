#!/usr/bin/env node
/**
 * Pepino Pick -- Alert Aggregator
 *
 * Агрегатор алертов: собирает предупреждения из всех автоматизаций в единый
 * приоритизированный фид. Предотвращает "alert fatigue" через дедупликацию
 * и батчинг по приоритетам.
 *
 * Источники:
 *   1. Google Sheets лист "Алерты"
 *   2. /tmp/health-status.json (health-status.cjs)
 *   3. /home/roman/logs/self-healer.log (последняя запись)
 *   4. Логи cron-скриптов (ошибки за последние 4 часа)
 *
 * Приоритеты:
 *   P1 -- немедленное действие (stock critical, container down, API unreachable, margin <20%)
 *   P2 -- сегодня (stock warning, at_risk client, expense anomaly, cron missed)
 *   P3 -- на этой неделе (stale data, cosmetic, optimization)
 *
 * Поведение:
 *   - P1 есть -> громкий Telegram в тред 20
 *   - Только P2/P3 -> тихая сводка
 *   - Ничего -> молчим (zero spam)
 *
 * Usage:
 *   node alert-aggregator.cjs              -- полный запуск
 *   node alert-aggregator.cjs --dry-run    -- без отправки в Telegram
 *
 * Cron: 0 *\/2 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/alert-aggregator.cjs >> /home/roman/logs/alert-aggregator.log 2>&1
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { trace } = require("./langfuse-trace.cjs");
const { sendAlert, send } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// -- Настройки ----------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

/** Тред для алертов (Стратегия/Директор) */
const TG_THREAD_ALERTS = 20;

/** Окно дедупликации: не повторять алерт того же type+source за N часов */
const DEDUP_WINDOW_HOURS = 4;

/** Файл с историей отправленных алертов (для дедупликации между запусками) */
const DEDUP_STATE_FILE = "/tmp/alert-aggregator-state.json";

/** Логи для проверки ошибок */
const LOG_FILES = [
  { name: "morning-brief", path: "/home/roman/logs/pepino-morning-brief.log" },
  { name: "inventory-tracker", path: "/home/roman/logs/inventory-tracker.log" },
  { name: "healthcheck", path: "/tmp/pepino-healthcheck.log" },
  { name: "daily-pnl", path: "/home/roman/logs/daily-pnl.log" },
];

// -- Типы ---------------------------------------------------------------------

/**
 * @typedef {Object} Alert
 * @property {string} type -- уникальный тип алерта (stock_critical, container_down и т.д.)
 * @property {string} source -- откуда пришёл (sheets, health, self-healer, log)
 * @property {"P1"|"P2"|"P3"} priority
 * @property {string} message -- человекочитаемое описание
 * @property {string} timestamp -- ISO timestamp
 */

// -- Дедупликация -------------------------------------------------------------

/**
 * Загружает историю отправленных алертов.
 * @returns {Record<string, string>} ключ -> ISO timestamp последней отправки
 */
function loadDedupState() {
  try {
    if (fs.existsSync(DEDUP_STATE_FILE)) {
      const raw = fs.readFileSync(DEDUP_STATE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch {
    // Повреждённый файл -- начинаем с чистого листа
  }
  return {};
}

/**
 * Сохраняет обновлённую историю алертов.
 * @param {Record<string, string>} state
 */
function saveDedupState(state) {
  try {
    fs.writeFileSync(DEDUP_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error(`[alert-aggregator] Не удалось сохранить dedup state: ${err.message}`);
  }
}

/**
 * Формирует ключ дедупликации.
 * @param {Alert} alert
 * @returns {string}
 */
function dedupKey(alert) {
  return `${alert.type}::${alert.source}`;
}

/**
 * Фильтрует алерты, убирая дубликаты в пределах DEDUP_WINDOW_HOURS.
 * @param {Alert[]} alerts
 * @param {Record<string, string>} state
 * @returns {Alert[]}
 */
function deduplicateAlerts(alerts, state) {
  const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  /** @type {Alert[]} */
  const unique = [];

  for (const alert of alerts) {
    const key = dedupKey(alert);
    const lastSent = state[key] ? new Date(state[key]).getTime() : 0;

    if (lastSent > cutoff) {
      // Уже отправляли в пределах окна -- пропускаем
      continue;
    }

    unique.push(alert);
  }

  return unique;
}

// -- Источник 1: Google Sheets лист "Алерты" ----------------------------------

/**
 * Читает алерты из листа "Алерты" в Google Sheets.
 * Ожидаемые колонки: Дата, Тип, Приоритет, Описание, Источник, Статус
 * @returns {Promise<Alert[]>}
 */
async function collectSheetsAlerts() {
  /** @type {Alert[]} */
  const alerts = [];

  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(PEPINO_SHEETS_ID, "\u26A0\uFE0F Алерты");

    if (!rows || rows.length < 2) return alerts;

    const headers = rows[0].map((h) => String(h).trim());
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000);

    for (let i = 1; i < rows.length; i++) {
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = rows[i]?.[j] ?? "";
      }

      // Пропускаем закрытые алерты
      const status = (row["Статус"] || row["Status"] || "").toLowerCase();
      if (status === "closed" || status === "закрыт" || status === "resolved") {
        continue;
      }

      const dateStr = row["Дата"] || row["Date"] || row["Timestamp"] || "";
      const alertDate = dateStr ? new Date(dateStr) : null;

      // Берём только свежие (в пределах окна дедупликации)
      if (alertDate && alertDate < cutoff) continue;

      const rawPriority = (row["Приоритет"] || row["Priority"] || "P3").toUpperCase();
      const priority = ["P1", "P2", "P3"].includes(rawPriority) ? rawPriority : "P3";

      const type = (row["Тип"] || row["Type"] || "sheets_alert").trim();
      const message = (row["Описание"] || row["Description"] || row["Сообщение"] || "").trim();
      const source = (row["Источник"] || row["Source"] || "sheets").trim();

      if (!message) continue;

      alerts.push({
        type,
        source: `sheets/${source}`,
        priority,
        message,
        timestamp: alertDate ? alertDate.toISOString() : new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`[alert-aggregator] Sheets алерты: ${err.message}`);
    // Недоступность Sheets -- это сам по себе P1 алерт
    alerts.push({
      type: "sheets_api_error",
      source: "alert-aggregator",
      priority: "P1",
      message: `Не удалось прочитать лист Алерты: ${err.message}`,
      timestamp: new Date().toISOString(),
    });
  }

  return alerts;
}

// -- Источник 2: health-status.json -------------------------------------------

/**
 * Читает /tmp/health-status.json и извлекает проблемы.
 * @returns {Alert[]}
 */
function collectHealthAlerts() {
  /** @type {Alert[]} */
  const alerts = [];
  const healthPath = "/tmp/health-status.json";

  try {
    if (!fs.existsSync(healthPath)) {
      alerts.push({
        type: "health_status_missing",
        source: "health-status",
        priority: "P2",
        message: "health-status.json отсутствует -- мониторинг не работает",
        timestamp: new Date().toISOString(),
      });
      return alerts;
    }

    const stat = fs.statSync(healthPath);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;

    // Если файл старше 30 минут -- мониторинг завис
    if (ageMinutes > 30) {
      alerts.push({
        type: "health_status_stale",
        source: "health-status",
        priority: "P2",
        message: `health-status.json устарел (${Math.round(ageMinutes)} мин.) -- cron мониторинга завис?`,
        timestamp: new Date().toISOString(),
      });
    }

    const raw = fs.readFileSync(healthPath, "utf8");
    const health = JSON.parse(raw);

    // Проверяем сервисы
    if (health.services && Array.isArray(health.services)) {
      for (const svc of health.services) {
        if (svc.status === "error") {
          alerts.push({
            type: "service_down",
            source: `health/${svc.name}`,
            priority: "P1",
            message: `${svc.name} недоступен: ${svc.detail || "unknown error"}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Проверяем Docker-контейнеры
    if (health.containers && Array.isArray(health.containers)) {
      for (const c of health.containers) {
        if (c.state !== "running") {
          alerts.push({
            type: "container_down",
            source: `docker/${c.name}`,
            priority: "P1",
            message: `Контейнер ${c.name} не запущен (state: ${c.state})`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Проверяем cron-задачи
    if (health.cron_jobs && Array.isArray(health.cron_jobs)) {
      for (const job of health.cron_jobs) {
        if (job.status === "error") {
          alerts.push({
            type: "cron_failed",
            source: `cron/${job.name}`,
            priority: "P2",
            message: `Cron ${job.name} не выполнялся (лог: ${job.last_run || "never"})`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Проверяем системные ресурсы
    if (health.resources) {
      const r = health.resources;
      if (r.disk_pct >= 90) {
        alerts.push({
          type: "disk_critical",
          source: "system",
          priority: "P1",
          message: `Диск заполнен на ${r.disk_pct}%`,
          timestamp: new Date().toISOString(),
        });
      } else if (r.disk_pct >= 80) {
        alerts.push({
          type: "disk_warning",
          source: "system",
          priority: "P2",
          message: `Диск заполнен на ${r.disk_pct}%`,
          timestamp: new Date().toISOString(),
        });
      }

      if (r.memory_pct >= 95) {
        alerts.push({
          type: "memory_critical",
          source: "system",
          priority: "P1",
          message: `Память: ${r.memory_pct}% (${r.memory_used_mb}/${r.memory_total_mb} MB)`,
          timestamp: new Date().toISOString(),
        });
      } else if (r.memory_pct >= 85) {
        alerts.push({
          type: "memory_warning",
          source: "system",
          priority: "P2",
          message: `Память: ${r.memory_pct}% (${r.memory_used_mb}/${r.memory_total_mb} MB)`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error(`[alert-aggregator] Health alerts: ${err.message}`);
  }

  return alerts;
}

// -- Источник 3: self-healer.log ----------------------------------------------

/**
 * Читает последнюю запись из self-healer.log.
 * @returns {Alert[]}
 */
function collectSelfHealerAlerts() {
  /** @type {Alert[]} */
  const alerts = [];
  const logPath = "/home/roman/logs/self-healer.log";

  try {
    if (!fs.existsSync(logPath)) return alerts;

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return alerts;

    // Берём последнюю строку
    const lastLine = lines[lines.length - 1];
    const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;

    // Пробуем извлечь timestamp из строки (формат [YYYY-MM-DDTHH:MM:SS] или YYYY-MM-DD HH:MM:SS)
    const tsMatch = lastLine.match(/\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\]?/);
    if (tsMatch) {
      const entryTime = new Date(tsMatch[1]).getTime();
      if (entryTime < cutoff) return alerts;
    }

    // Ищем признаки ошибки или восстановления
    const lower = lastLine.toLowerCase();
    if (lower.includes("error") || lower.includes("fail") || lower.includes("restart")) {
      alerts.push({
        type: "self_healer_action",
        source: "self-healer",
        priority: "P2",
        message: `Self-healer: ${lastLine.slice(0, 200)}`,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`[alert-aggregator] Self-healer log: ${err.message}`);
  }

  return alerts;
}

// -- Источник 4: Логи cron-скриптов -------------------------------------------

/**
 * Проверяет лог-файлы на наличие ошибок за последние DEDUP_WINDOW_HOURS часов.
 * @returns {Alert[]}
 */
function collectLogAlerts() {
  /** @type {Alert[]} */
  const alerts = [];
  const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;

  for (const logDef of LOG_FILES) {
    try {
      if (!fs.existsSync(logDef.path)) continue;

      const stat = fs.statSync(logDef.path);
      // Пропускаем файлы, не обновлявшиеся в пределах окна
      if (stat.mtimeMs < cutoff) continue;

      // Читаем последние 4 KB (достаточно для обнаружения ошибок)
      const fd = fs.openSync(logDef.path, "r");
      const fileSize = stat.size;
      const readSize = Math.min(fileSize, 4096);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
      fs.closeSync(fd);

      const tail = buffer.toString("utf8");
      const lines = tail.split("\n").filter(Boolean);

      // Считаем ошибки в хвосте лога
      const errorLines = lines.filter((line) => {
        const lower = line.toLowerCase();
        return (
          lower.includes("[error]") ||
          lower.includes("[fatal]") ||
          lower.includes("фатальная ошибка") ||
          lower.includes("fail") ||
          (lower.includes("error") && !lower.includes("error:"))
        );
      });

      if (errorLines.length > 0) {
        // Берём последнюю ошибку
        const lastError = errorLines[errorLines.length - 1].trim().slice(0, 150);

        // FATAL -> P1, обычные ошибки -> P2
        const isFatal =
          lastError.toLowerCase().includes("[fatal]") ||
          lastError.toLowerCase().includes("фатальная");
        const priority = isFatal ? "P1" : "P2";

        alerts.push({
          type: "cron_error",
          source: `log/${logDef.name}`,
          priority,
          message: `${logDef.name}: ${lastError}`,
          timestamp: new Date(stat.mtimeMs).toISOString(),
        });
      }
    } catch (err) {
      console.error(`[alert-aggregator] Лог ${logDef.path}: ${err.message}`);
    }
  }

  return alerts;
}

// -- Классификация приоритетов ------------------------------------------------

/**
 * Дополнительно корректирует приоритет на основе ключевых слов в сообщении.
 * Правила из спецификации:
 *   P1: stock critical (<1 day), container down, API unreachable, margin <20%
 *   P2: stock warning (<3 days), at_risk client, expense anomaly, cron missed
 *   P3: stale data, cosmetic, optimization
 * @param {Alert} alert
 * @returns {"P1"|"P2"|"P3"}
 */
function refinePriority(alert) {
  const msg = alert.message.toLowerCase();
  const type = alert.type.toLowerCase();

  // P1 паттерны
  if (
    type === "container_down" ||
    type === "service_down" ||
    type === "sheets_api_error" ||
    type === "disk_critical" ||
    type === "memory_critical" ||
    msg.includes("api unreachable") ||
    msg.includes("недоступен")
  ) {
    return "P1";
  }

  // Маржа <20% -> P1
  const marginMatch = msg.match(/маржа\s*(\d+)%/i);
  if (marginMatch && parseInt(marginMatch[1]) < 20) {
    return "P1";
  }

  // Stock critical (<1 day) -> P1
  if ((type.includes("stock") || type.includes("inventory")) && msg.includes("critical")) {
    return "P1";
  }

  // P2 паттерны
  if (
    type === "cron_failed" ||
    type === "cron_error" ||
    type === "disk_warning" ||
    type === "memory_warning" ||
    type === "self_healer_action" ||
    msg.includes("at_risk") ||
    msg.includes("warning") ||
    msg.includes("expense anomal")
  ) {
    return "P2";
  }

  // P3 паттерны
  if (
    type.includes("stale") ||
    type.includes("cosmetic") ||
    type.includes("optimization") ||
    msg.includes("stale") ||
    msg.includes("устарел")
  ) {
    return "P3";
  }

  // Сохраняем исходный приоритет
  return alert.priority;
}

// -- Форматирование Telegram-сообщения ----------------------------------------

/**
 * Формирует HTML-сообщение для Telegram.
 * @param {Alert[]} alerts
 * @returns {string}
 */
function formatTelegramMessage(alerts) {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "America/Argentina/Cordoba",
  });

  const p1 = alerts.filter((a) => a.priority === "P1");
  const p2 = alerts.filter((a) => a.priority === "P2");
  const p3 = alerts.filter((a) => a.priority === "P3");

  const lines = [];

  if (p1.length > 0) {
    lines.push(`<b>!!! ALERT AGGREGATOR -- ${now}</b>\n`);
    lines.push(`<b>P1 -- НЕМЕДЛЕННОЕ ДЕЙСТВИЕ (${p1.length})</b>`);
    for (const a of p1) {
      lines.push(`  !!! [${a.source}] ${a.message}`);
    }
  } else {
    lines.push(`<b>Alert Aggregator -- ${now}</b>\n`);
  }

  if (p2.length > 0) {
    lines.push(`\n<b>P2 -- Сегодня (${p2.length})</b>`);
    for (const a of p2) {
      lines.push(`  ! [${a.source}] ${a.message}`);
    }
  }

  if (p3.length > 0) {
    lines.push(`\n<b>P3 -- На этой неделе (${p3.length})</b>`);
    for (const a of p3) {
      lines.push(`  [${a.source}] ${a.message}`);
    }
  }

  lines.push(
    `\n<b>Итого:</b> ${alerts.length} алертов (P1: ${p1.length}, P2: ${p2.length}, P3: ${p3.length})`,
  );

  return lines.join("\n");
}

// -- Главная функция ----------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Запуск alert-aggregator...${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Параллельный сбор алертов из всех источников
  const [sheetsAlerts, healthAlerts, selfHealerAlerts, logAlerts] = await Promise.all([
    collectSheetsAlerts(),
    Promise.resolve(collectHealthAlerts()),
    Promise.resolve(collectSelfHealerAlerts()),
    Promise.resolve(collectLogAlerts()),
  ]);

  // Объединяем все алерты
  /** @type {Alert[]} */
  let allAlerts = [...sheetsAlerts, ...healthAlerts, ...selfHealerAlerts, ...logAlerts];

  console.error(
    `[alert-aggregator] Собрано: sheets=${sheetsAlerts.length}, health=${healthAlerts.length}, ` +
      `self-healer=${selfHealerAlerts.length}, logs=${logAlerts.length}, total=${allAlerts.length}`,
  );

  // Уточняем приоритеты на основе содержания
  for (const alert of allAlerts) {
    alert.priority = refinePriority(alert);
  }

  // Дедупликация
  const dedupState = loadDedupState();
  const uniqueAlerts = deduplicateAlerts(allAlerts, dedupState);

  console.error(
    `[alert-aggregator] После дедупликации: ${uniqueAlerts.length} из ${allAlerts.length}`,
  );

  // Сортируем по приоритету
  const priorityOrder = { P1: 0, P2: 1, P3: 2 };
  uniqueAlerts.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // JSON-отчёт в stdout
  const result = {
    timestamp,
    dry_run: DRY_RUN,
    summary: {
      total_collected: allAlerts.length,
      after_dedup: uniqueAlerts.length,
      p1: uniqueAlerts.filter((a) => a.priority === "P1").length,
      p2: uniqueAlerts.filter((a) => a.priority === "P2").length,
      p3: uniqueAlerts.filter((a) => a.priority === "P3").length,
    },
    sources: {
      sheets: sheetsAlerts.length,
      health: healthAlerts.length,
      self_healer: selfHealerAlerts.length,
      logs: logAlerts.length,
    },
    alerts: uniqueAlerts,
  };

  console.log(JSON.stringify(result, null, 2));

  // Решаем: отправлять или нет
  if (uniqueAlerts.length === 0) {
    console.error("[alert-aggregator] Нет новых алертов -- молчим");
  } else {
    const hasP1 = uniqueAlerts.some((a) => a.priority === "P1");
    const message = formatTelegramMessage(uniqueAlerts);

    if (DRY_RUN) {
      console.error("[alert-aggregator] DRY RUN: пропуск отправки Telegram");
      console.error(message);
    } else {
      try {
        // Маппинг приоритетов: P1 -> "critical", P2 -> "normal", P3 -> "low"
        const hasP3Only = !hasP1 && uniqueAlerts.every((a) => a.priority === "P3");
        const throttlePriority = hasP1 ? "critical" : hasP3Only ? "low" : "normal";

        if (sendThrottled) {
          await sendThrottled(message, {
            thread: TG_THREAD_ALERTS,
            silent: !hasP1,
            priority: throttlePriority,
            parseMode: "HTML",
          });
          console.error(
            `[alert-aggregator] Алерт отправлен через throttle (priority=${throttlePriority})`,
          );
        } else if (hasP1) {
          // Fallback: громкое уведомление при P1
          await sendAlert(message, TG_THREAD_ALERTS);
          console.error("[alert-aggregator] P1 алерт отправлен (LOUD)");
        } else {
          // Fallback: тихое уведомление при P2/P3
          await send(message, {
            silent: true,
            threadId: TG_THREAD_ALERTS,
            parseMode: "HTML",
          });
          console.error("[alert-aggregator] Сводка P2/P3 отправлена (quiet)");
        }

        // Обновляем dedup state после успешной отправки
        const now = new Date().toISOString();
        for (const alert of uniqueAlerts) {
          dedupState[dedupKey(alert)] = now;
        }

        // Чистим старые записи (старше 24 часов)
        const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
        for (const [key, ts] of Object.entries(dedupState)) {
          if (new Date(ts).getTime() < staleThreshold) {
            delete dedupState[key];
          }
        }

        saveDedupState(dedupState);
      } catch (err) {
        console.error(`[alert-aggregator] Ошибка отправки Telegram: ${err.message}`);
      }
    }
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  await trace({
    name: "alert-aggregator",
    input: {
      sources: result.sources,
      dry_run: DRY_RUN,
    },
    output: result.summary,
    duration_ms: durationMs,
    metadata: {
      skill: "pepino-google-sheets",
      script: "alert-aggregator",
    },
  });

  console.error(
    `[alert-aggregator] Завершено за ${durationMs}мс. ` +
      `Собрано: ${allAlerts.length}, уникальных: ${uniqueAlerts.length}`,
  );
}

// -- Запуск -------------------------------------------------------------------

main().catch((err) => {
  console.error(`[alert-aggregator] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
