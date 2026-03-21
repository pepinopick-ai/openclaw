/**
 * Легковесный клиент для отправки трейсов в Langfuse.
 * Без внешних зависимостей — только встроенный http/https.
 *
 * Использование:
 *   const { trace } = require("./langfuse-trace.cjs");
 *   await trace({
 *     name: "sheets-sync",
 *     input: { action: "update", sheet: "Sales" },
 *     output: { rows: 42 },
 *     model: "gpt-4o",
 *     tokens: { input: 500, output: 120 },
 *     duration_ms: 3200,
 *     metadata: { skill: "pepino-google-sheets" },
 *   });
 */

"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");

const LANGFUSE_HOST = process.env.LANGFUSE_HOST || "http://localhost:3001";
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";

/**
 * Отправляет HTTP-запрос без внешних зависимостей.
 * @param {string} url
 * @param {object} options
 * @param {string} body
 * @returns {Promise<{status: number, body: string}>}
 */
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const req = client.request(parsed, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Langfuse request timeout (10s)"));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Отправляет трейс + generation в Langfuse через Ingestion API.
 *
 * @param {object} params
 * @param {string} params.name — название операции
 * @param {*} [params.input] — входные данные
 * @param {*} [params.output] — результат
 * @param {string} [params.model] — название модели (gpt-4o, claude-sonnet и т.д.)
 * @param {{input?: number, output?: number}} [params.tokens] — количество токенов
 * @param {number} [params.cost] — стоимость в USD
 * @param {number} [params.duration_ms] — длительность в мс
 * @param {object} [params.metadata] — произвольные метаданные
 * @returns {Promise<void>}
 */
async function trace({ name, input, output, model, tokens, cost, duration_ms, metadata }) {
  // Если ключи не настроены — молча пропускаем
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return;
  }

  const traceId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();

  const events = [
    {
      id: crypto.randomUUID(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: traceId,
        name,
        input: input != null ? input : undefined,
        output: output != null ? output : undefined,
        metadata: metadata || undefined,
      },
    },
  ];

  // Если передана модель или токены — добавляем generation
  if (model || tokens) {
    const startTime = duration_ms ? new Date(Date.now() - duration_ms).toISOString() : now;

    events.push({
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: now,
      body: {
        id: generationId,
        traceId,
        name: name + "/generation",
        model: model || undefined,
        input: input != null ? input : undefined,
        output: output != null ? output : undefined,
        startTime,
        endTime: now,
        usage: {
          input: tokens?.input || 0,
          output: tokens?.output || 0,
          unit: "TOKENS",
        },
        costDetails: cost != null ? { total: cost } : undefined,
        metadata: metadata || undefined,
      },
    });
  }

  const payload = JSON.stringify({
    batch: events,
    metadata: {
      batch_size: events.length,
      sdk_name: "pepino-langfuse-cjs",
      sdk_version: "1.0.0",
    },
  });

  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString("base64");

  try {
    const res = await request(
      `${LANGFUSE_HOST}/api/public/ingestion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      payload,
    );

    if (res.status >= 400) {
      console.error(`[langfuse-trace] Ошибка ${res.status}: ${res.body.slice(0, 200)}`);
    }
  } catch (err) {
    // Не роняем основной процесс из-за проблем с observability
    console.error(`[langfuse-trace] Не удалось отправить трейс: ${err.message}`);
  }
}

module.exports = { trace };
