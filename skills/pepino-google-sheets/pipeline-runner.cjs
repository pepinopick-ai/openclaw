#!/usr/bin/env node
/**
 * Pepino Pick -- Pipeline Runner (мета-оркестратор)
 *
 * Запускает логические цепочки скриптов последовательно с передачей контекста,
 * трекингом времени, обработкой ошибок и отчётом в Telegram + Langfuse.
 *
 * Пайплайны:
 *   morning  -- delivery-optimizer -> inventory-tracker -> morning-brief (06:00)
 *   evening  -- daily-pnl -> data-completeness-check -> alert-aggregator (20:30)
 *   sunday   -- waste-tracker -> production-planner -> knowledge-distiller -> ceo-weekly-digest (вс 17:00)
 *
 * Cron:
 *   0 6 * * *   node pipeline-runner.cjs morning
 *   30 20 * * * node pipeline-runner.cjs evening
 *   0 17 * * 0  node pipeline-runner.cjs sunday
 *
 * Usage:
 *   node pipeline-runner.cjs morning
 *   node pipeline-runner.cjs evening
 *   node pipeline-runner.cjs sunday
 *   node pipeline-runner.cjs --list          # показать все пайплайны
 *   node pipeline-runner.cjs --dry-run morning  # показать что запустится
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { send } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");

// ── Конфигурация ─────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const TG_THREAD_PIPELINE = 20; // Стратегия/Директор
const EXEC_TIMEOUT_MS = 120_000; // 2 минуты на шаг по умолчанию

/**
 * @typedef {object} PipelineStep
 * @property {string} name -- человекочитаемое имя шага
 * @property {string} script -- имя файла скрипта (.cjs / .js)
 * @property {string[]} [args] -- дополнительные аргументы
 * @property {number} [timeoutMs] -- таймаут для этого шага (мс)
 */

/**
 * @typedef {object} PipelineConfig
 * @property {string} name -- имя пайплайна
 * @property {string} description -- описание на русском
 * @property {string} schedule -- cron-расписание
 * @property {PipelineStep[]} steps -- шаги пайплайна
 */

/** @type {Record<string, PipelineConfig>} */
const PIPELINES = {
  morning: {
    name: "morning",
    description: "Утренний пайплайн: доставка -> чеклист -> склад -> бриф",
    schedule: "0 6 * * *",
    steps: [
      {
        name: "Оптимизация доставки",
        script: "delivery-optimizer.cjs",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "Операционный чеклист",
        script: "daily-ops-checklist.cjs",
        args: [],
        timeoutMs: 60_000,
      },
      {
        name: "Мониторинг запасов",
        script: "inventory-tracker.cjs",
        args: [],
        timeoutMs: 60_000,
      },
      {
        name: "Пересчёт агрегатов",
        script: "recalculate-aggregates.js",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "Утренний бриф",
        script: "morning-brief.js",
        args: [],
        timeoutMs: 120_000,
      },
    ],
  },

  evening: {
    name: "evening",
    description: "Вечерний пайплайн: агрегаты -> P&L -> полнота -> LLM costs -> алерты",
    schedule: "30 20 * * *",
    steps: [
      {
        name: "Пересчёт агрегатов",
        script: "recalculate-aggregates.js",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "Daily P&L",
        script: "daily-pnl.cjs",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "Проверка полноты данных",
        script: "data-completeness-check.js",
        args: [],
        timeoutMs: 60_000,
      },
      {
        name: "LLM costs",
        script: "llm-cost-telegram.cjs",
        args: [],
        timeoutMs: 60_000,
      },
      {
        name: "Агрегация алертов",
        script: "alert-aggregator.cjs",
        args: [],
        timeoutMs: 60_000,
      },
    ],
  },

  sunday: {
    name: "sunday",
    description: "Воскресный пайплайн: потери -> план производства -> знания -> CEO дайджест",
    schedule: "0 17 * * 0",
    steps: [
      {
        name: "Анализ потерь",
        script: "waste-tracker.cjs",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "Планирование производства",
        script: "production-planner.cjs",
        args: [],
        timeoutMs: 120_000,
      },
      {
        name: "Дистилляция знаний",
        script: "knowledge-distiller.cjs",
        args: [],
        timeoutMs: 90_000,
      },
      {
        name: "CEO дайджест",
        script: "ceo-weekly-digest.cjs",
        args: [],
        timeoutMs: 120_000,
      },
    ],
  },
};

// ── Результаты шагов ─────────────────────────────────────────────────────────

/**
 * @typedef {object} StepResult
 * @property {string} name -- имя шага
 * @property {string} script -- файл скрипта
 * @property {"ok"|"error"|"skipped"} status -- статус выполнения
 * @property {number} durationMs -- время выполнения (мс)
 * @property {string} stdout -- вывод скрипта (обрезанный)
 * @property {string} stderr -- stderr (обрезанный)
 * @property {string} [error] -- текст ошибки при неудаче
 */

// ── Запуск одного шага ───────────────────────────────────────────────────────

/**
 * Выполняет один шаг пайплайна через child_process.execSync.
 * При ошибке НЕ бросает исключение — возвращает результат с status="error".
 *
 * @param {PipelineStep} step
 * @param {boolean} dryRun
 * @returns {StepResult}
 */
function runStep(step, dryRun) {
  const scriptPath = path.join(SCRIPT_DIR, step.script);
  const args = (step.args || []).join(" ");
  const cmd = `node ${scriptPath}${args ? " " + args : ""}`;
  const timeout = step.timeoutMs || EXEC_TIMEOUT_MS;

  if (dryRun) {
    return {
      name: step.name,
      script: step.script,
      status: "skipped",
      durationMs: 0,
      stdout: "",
      stderr: "",
    };
  }

  const startMs = Date.now();

  try {
    const output = execSync(cmd, {
      timeout,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024, // 5 МБ
      env: { ...process.env },
      cwd: SCRIPT_DIR,
    });

    const durationMs = Date.now() - startMs;

    return {
      name: step.name,
      script: step.script,
      status: "ok",
      durationMs,
      stdout: truncate(output || "", 2000),
      stderr: "",
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;

    return {
      name: step.name,
      script: step.script,
      status: "error",
      durationMs,
      stdout: truncate(err.stdout || "", 2000),
      stderr: truncate(err.stderr || "", 2000),
      error: err.message ? err.message.split("\n")[0] : "Unknown error",
    };
  }
}

// ── Запуск пайплайна ─────────────────────────────────────────────────────────

/**
 * Выполняет все шаги пайплайна последовательно.
 * При ошибке шага — логирует и продолжает со следующим.
 *
 * @param {PipelineConfig} pipeline
 * @param {boolean} dryRun
 * @returns {Promise<{results: StepResult[], totalMs: number}>}
 */
async function runPipeline(pipeline, dryRun) {
  const pipelineStart = Date.now();
  const ts = new Date().toISOString();

  console.error(
    `[${ts}] Pipeline "${pipeline.name}" starting (${pipeline.steps.length} steps)` +
      `${dryRun ? " [DRY RUN]" : ""}`,
  );

  /** @type {StepResult[]} */
  const results = [];

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const stepNum = i + 1;

    console.error(`  [${stepNum}/${pipeline.steps.length}] ${step.name} (${step.script})...`);

    const result = runStep(step, dryRun);
    results.push(result);

    if (result.status === "ok") {
      console.error(`  [${stepNum}/${pipeline.steps.length}] OK (${result.durationMs}ms)`);
    } else if (result.status === "error") {
      console.error(
        `  [${stepNum}/${pipeline.steps.length}] FAIL (${result.durationMs}ms): ${result.error}`,
      );
      // Продолжаем со следующим шагом
    } else {
      console.error(`  [${stepNum}/${pipeline.steps.length}] SKIPPED (dry-run)`);
    }
  }

  const totalMs = Date.now() - pipelineStart;
  console.error(`Pipeline "${pipeline.name}" finished in ${totalMs}ms`);

  return { results, totalMs };
}

// ── Форматирование отчёта ────────────────────────────────────────────────────

/**
 * Формирует HTML-сообщение с итогами пайплайна для Telegram.
 *
 * @param {PipelineConfig} pipeline
 * @param {StepResult[]} results
 * @param {number} totalMs
 * @returns {string}
 */
function formatPipelineReport(pipeline, results, totalMs) {
  const now = new Date().toLocaleString("ru-RU", {
    timeZone: "America/Argentina/Cordoba",
  });

  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;
  const skipCount = results.filter((r) => r.status === "skipped").length;

  const allOk = errCount === 0 && skipCount === 0;
  const headerIcon = allOk ? "OK" : errCount > 0 ? "!!!" : "---";

  const lines = [];
  lines.push(`<b>${headerIcon} Pipeline: ${pipeline.name}</b>`);
  lines.push(`${pipeline.description}`);
  lines.push(`${now} | ${formatDuration(totalMs)}\n`);

  // Результаты по шагам
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const stepIcon = r.status === "ok" ? "[ok]" : r.status === "error" ? "[FAIL]" : "[skip]";

    let line = `${i + 1}. ${stepIcon} ${r.name}`;
    if (r.status !== "skipped") {
      line += ` (${formatDuration(r.durationMs)})`;
    }
    lines.push(line);

    if (r.status === "error" && r.error) {
      // Показываем краткую причину ошибки
      const shortError = r.error.length > 120 ? r.error.slice(0, 120) + "..." : r.error;
      lines.push(`   Ошибка: ${escapeHtml(shortError)}`);
    }
  }

  // Итого
  lines.push("");
  lines.push(`<b>Итого:</b> ${okCount} ok, ${errCount} fail, ${skipCount} skip`);

  return lines.join("\n");
}

/**
 * Форматирует длительность в человекочитаемый вид.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  if (ms < 60_000) return `${sec}s`;
  const min = Math.floor(ms / 60_000);
  const remainSec = Math.round((ms % 60_000) / 1000);
  return `${min}m${remainSec}s`;
}

/**
 * Экранирует HTML-спецсимволы для Telegram.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Обрезает строку до maxLen символов.
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || "";
  return s.slice(0, maxLen) + "...[truncated]";
}

// ── Langfuse трейсинг ────────────────────────────────────────────────────────

/**
 * Отправляет трейс пайплайна в Langfuse с отдельными span'ами на каждый шаг.
 * Использует Ingestion API напрямую (расширяет базовый trace()).
 *
 * @param {PipelineConfig} pipeline
 * @param {StepResult[]} results
 * @param {number} totalMs
 * @returns {Promise<void>}
 */
async function tracePipeline(pipeline, results, totalMs) {
  const http = require("http");
  const https = require("https");

  const LANGFUSE_HOST = process.env.LANGFUSE_HOST || "http://localhost:3001";
  const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
  const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";

  // Если ключи не настроены — молча пропускаем
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return;

  const traceId = crypto.randomUUID();
  const now = new Date().toISOString();
  const pipelineStartTime = new Date(Date.now() - totalMs).toISOString();

  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;

  /** @type {Array<object>} */
  const events = [];

  // Корневой trace
  events.push({
    id: crypto.randomUUID(),
    type: "trace-create",
    timestamp: now,
    body: {
      id: traceId,
      name: `pipeline/${pipeline.name}`,
      input: {
        pipeline: pipeline.name,
        steps: pipeline.steps.map((s) => s.script),
      },
      output: {
        ok: okCount,
        errors: errCount,
        total_ms: totalMs,
      },
      metadata: {
        skill: "pepino-google-sheets",
        pipeline: pipeline.name,
        schedule: pipeline.schedule,
      },
    },
  });

  // Span на каждый шаг
  let elapsed = 0;
  for (const result of results) {
    const spanStart = new Date(Date.now() - totalMs + elapsed).toISOString();
    elapsed += result.durationMs;
    const spanEnd = new Date(Date.now() - totalMs + elapsed).toISOString();

    events.push({
      id: crypto.randomUUID(),
      type: "span-create",
      timestamp: now,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: `step/${result.script}`,
        startTime: spanStart,
        endTime: spanEnd,
        input: { script: result.script },
        output: {
          status: result.status,
          duration_ms: result.durationMs,
          error: result.error || null,
          stdout_preview: result.stdout.slice(0, 500) || null,
        },
        metadata: {
          step_name: result.name,
          status: result.status,
        },
        level: result.status === "error" ? "ERROR" : "DEFAULT",
        statusMessage: result.status === "error" ? result.error || "Step failed" : undefined,
      },
    });
  }

  const payload = JSON.stringify({
    batch: events,
    metadata: {
      batch_size: events.length,
      sdk_name: "pepino-pipeline-runner",
      sdk_version: "1.0.0",
    },
  });

  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString("base64");

  try {
    const parsed = new URL(`${LANGFUSE_HOST}/api/public/ingestion`);
    const client = parsed.protocol === "https:" ? https : http;

    await new Promise((resolve, reject) => {
      const req = client.request(
        parsed,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${auth}`,
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode >= 400) {
              console.error(
                `[pipeline-runner] Langfuse ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`,
              );
            }
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Langfuse timeout"));
      });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error(`[pipeline-runner] Langfuse trace error: ${err.message}`);
  }
}

// ── Вывод списка пайплайнов ──────────────────────────────────────────────────

function showList() {
  console.log("\nДоступные пайплайны:\n");
  for (const [key, cfg] of Object.entries(PIPELINES)) {
    console.log(`  ${key}`);
    console.log(`    ${cfg.description}`);
    console.log(`    Расписание: ${cfg.schedule}`);
    console.log(`    Шаги:`);
    for (let i = 0; i < cfg.steps.length; i++) {
      const s = cfg.steps[i];
      const arrow = i < cfg.steps.length - 1 ? " ->" : "";
      console.log(`      ${i + 1}. ${s.name} (${s.script})${arrow}`);
    }
    console.log();
  }
}

// ── Dry-run вывод ────────────────────────────────────────────────────────────

/**
 * Показывает что запустит пайплайн без реального выполнения.
 * @param {PipelineConfig} pipeline
 */
function showDryRun(pipeline) {
  console.log(`\n[DRY RUN] Pipeline: ${pipeline.name}`);
  console.log(`${pipeline.description}`);
  console.log(`Расписание: ${pipeline.schedule}\n`);
  console.log("Шаги которые будут выполнены:");
  for (let i = 0; i < pipeline.steps.length; i++) {
    const s = pipeline.steps[i];
    const scriptPath = path.join(SCRIPT_DIR, s.script);
    const timeout = s.timeoutMs || EXEC_TIMEOUT_MS;
    console.log(`  ${i + 1}. ${s.name}`);
    console.log(`     Команда: node ${scriptPath}`);
    console.log(`     Таймаут: ${formatDuration(timeout)}`);
    if (s.args && s.args.length > 0) {
      console.log(`     Аргументы: ${s.args.join(" ")}`);
    }
  }
  console.log("\nТелеграм: thread #" + TG_THREAD_PIPELINE);
  console.log("Langfuse: trace pipeline/" + pipeline.name);
  console.log();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Флаги
  const showListFlag = args.includes("--list");
  const dryRun = args.includes("--dry-run");

  // Удаляем флаги, оставляем имя пайплайна
  const positional = args.filter((a) => !a.startsWith("--"));

  if (showListFlag) {
    showList();
    return;
  }

  if (positional.length === 0) {
    console.error("Использование:");
    console.error("  node pipeline-runner.cjs <pipeline>     # запустить пайплайн");
    console.error("  node pipeline-runner.cjs --list         # список пайплайнов");
    console.error("  node pipeline-runner.cjs --dry-run <pipeline>");
    console.error("");
    console.error(`Доступные пайплайны: ${Object.keys(PIPELINES).join(", ")}`);
    process.exit(1);
  }

  const pipelineName = positional[0];
  const pipeline = PIPELINES[pipelineName];

  if (!pipeline) {
    console.error(
      `Неизвестный пайплайн: "${pipelineName}". ` +
        `Доступные: ${Object.keys(PIPELINES).join(", ")}`,
    );
    process.exit(1);
  }

  // Dry-run: только показать план
  if (dryRun) {
    showDryRun(pipeline);
    return;
  }

  // Запуск пайплайна
  const { results, totalMs } = await runPipeline(pipeline, false);

  // Формируем и выводим отчёт
  const report = formatPipelineReport(pipeline, results, totalMs);
  const plainReport = report.replace(/<[^>]+>/g, "");
  console.log("\n" + plainReport);

  // Отправка в Telegram (thread 20)
  try {
    const tgResult = await send(report, {
      silent: false,
      threadId: TG_THREAD_PIPELINE,
      parseMode: "HTML",
    });
    if (tgResult.ok) {
      console.error("[pipeline-runner] Отчёт отправлен в Telegram");
    } else {
      console.error(`[pipeline-runner] Telegram error: ${tgResult.error}`);
    }
  } catch (err) {
    console.error(`[pipeline-runner] Telegram send failed: ${err.message}`);
  }

  // Langfuse трейс со span'ами
  try {
    await tracePipeline(pipeline, results, totalMs);
    console.error("[pipeline-runner] Langfuse trace sent");
  } catch (err) {
    console.error(`[pipeline-runner] Langfuse error: ${err.message}`);
  }

  // Exit code: 0 даже при ошибках шагов (пайплайн завершился)
  // Но если ВСЕ шаги упали — exit 1
  const allFailed = results.every((r) => r.status === "error");
  if (allFailed) {
    console.error("[pipeline-runner] Все шаги завершились с ошибкой");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[pipeline-runner] Fatal: ${err.message}`);
  process.exit(1);
});
