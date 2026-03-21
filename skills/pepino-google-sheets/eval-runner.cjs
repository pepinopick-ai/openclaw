/**
 * Eval Runner для Pepino Pick Agent OS.
 *
 * Создаёт датасет тест-кейсов в Langfuse, позволяет скорить трейсы
 * и выводить агрегированный отчёт по качеству.
 *
 * Команды:
 *   node eval-runner.cjs seed           — загрузить 15 тест-кейсов в Langfuse
 *   node eval-runner.cjs score <id> <v> — оценить трейс (0-1)
 *   node eval-runner.cjs report         — сводка по оценкам
 *
 * Зависимости: нет (встроенный http).
 * Auth: Basic base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const LANGFUSE_HOST = process.env.LANGFUSE_HOST || "http://127.0.0.1:3001";

/** @returns {{ publicKey: string, secretKey: string }} */
function loadKeys() {
  let publicKey = process.env.LANGFUSE_PUBLIC_KEY || "";
  let secretKey = process.env.LANGFUSE_SECRET_KEY || "";

  // Фоллбэк: парсим ~/.profile если env vars не заданы
  if (!publicKey || !secretKey) {
    try {
      const profilePath = path.join(process.env.HOME || "/root", ".profile");
      const profile = fs.readFileSync(profilePath, "utf-8");
      const pkMatch = profile.match(/LANGFUSE_PUBLIC_KEY="([^"]+)"/);
      const skMatch = profile.match(/LANGFUSE_SECRET_KEY="([^"]+)"/);
      if (pkMatch) publicKey = publicKey || pkMatch[1];
      if (skMatch) secretKey = secretKey || skMatch[1];
    } catch {
      // ~/.profile не найден — не критично
    }
  }

  if (!publicKey || !secretKey) {
    console.error("[eval-runner] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY не заданы.");
    process.exit(1);
  }

  return { publicKey, secretKey };
}

// ---------------------------------------------------------------------------
// HTTP-клиент (без зависимостей)
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string> }} opts
 * @param {string} [body]
 * @returns {Promise<{ status: number, data: any, raw: string }>}
 */
function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const req = client.request(parsed, opts, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // ответ не JSON — оставляем строку
        }
        resolve({ status: res.statusCode || 0, data, raw });
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Langfuse request timeout (15s)"));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Выполняет авторизованный запрос к Langfuse API.
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} apiPath — путь вида /api/public/...
 * @param {object} [payload]
 * @returns {Promise<{ status: number, data: any }>}
 */
async function langfuse(method, apiPath, payload) {
  const { publicKey, secretKey } = loadKeys();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  const url = `${LANGFUSE_HOST}${apiPath}`;
  const bodyStr = payload ? JSON.stringify(payload) : undefined;

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };

  if (bodyStr) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
  }

  const res = await request(url, { method, headers }, bodyStr);

  if (res.status >= 400) {
    const detail = typeof res.data === "object" ? JSON.stringify(res.data) : res.raw;
    throw new Error(`Langfuse ${method} ${apiPath} -> ${res.status}: ${detail.slice(0, 300)}`);
  }

  return { status: res.status, data: res.data };
}

// ---------------------------------------------------------------------------
// Тест-кейсы
// ---------------------------------------------------------------------------

const DATASET_NAME = "pepino-eval-v1";

/** @type {{ input: string, expected_output: string, metadata: { domain: string } }[]} */
const TEST_CASES = [
  // -- Sales --
  {
    input: "Какая выручка за эту неделю?",
    expected_output: "Ответ должен содержать сумму в ARS (аргентинских песо)",
    metadata: { domain: "sales" },
  },
  {
    input: "Кто наш лучший клиент?",
    expected_output: "Ответ должен упомянуть 'У Беларуса' (top client by revenue)",
    metadata: { domain: "sales" },
  },
  {
    input: "Сколько клиентов at risk?",
    expected_output: "Ответ должен содержать конкретное число клиентов с риском оттока",
    metadata: { domain: "sales" },
  },

  // -- Agro --
  {
    input: "Что готово к сбору?",
    expected_output: "Ответ должен содержать список продуктов с ожидаемыми датами сбора",
    metadata: { domain: "agro" },
  },
  {
    input: "Какая температура в теплице?",
    expected_output: "Ответ должен содержать текущую температуру (в градусах Цельсия)",
    metadata: { domain: "agro" },
  },
  {
    input: "Есть ли проблемы с болезнями?",
    expected_output: "Ответ должен проверить алерты по болезням и сообщить статус",
    metadata: { domain: "agro" },
  },

  // -- Finance --
  {
    input: "Какая текущая маржа?",
    expected_output: "Ответ должен содержать процент маржи (gross margin %)",
    metadata: { domain: "finance" },
  },
  {
    input: "Какой курс Blue сегодня?",
    expected_output: "Ответ должен содержать курсы покупки и продажи доллара Blue",
    metadata: { domain: "finance" },
  },
  {
    input: "Расходы за неделю?",
    expected_output: "Ответ должен содержать категории расходов с суммами в ARS",
    metadata: { domain: "finance" },
  },

  // -- Operations --
  {
    input: "Какие задачи просрочены?",
    expected_output: "Ответ должен содержать список просроченных задач (overdue)",
    metadata: { domain: "operations" },
  },
  {
    input: "Есть ли критические алерты?",
    expected_output: "Ответ должен проверить лист алертов и сообщить о критических",
    metadata: { domain: "operations" },
  },
  {
    input: "Что на складе?",
    expected_output: "Ответ должен содержать список продуктов с количествами (кг/шт)",
    metadata: { domain: "operations" },
  },

  // -- Routing --
  {
    input: "Запиши расход: субстрат 5000",
    expected_output: "Должен использовать маршрут expense-quick-entry для записи расхода",
    metadata: { domain: "routing" },
  },
  {
    input: "Покажи прогноз на неделю",
    expected_output: "Должен использовать маршрут forecast для показа прогноза",
    metadata: { domain: "routing" },
  },
  {
    input: "Запиши урожай огурцов 25 кг",
    expected_output: "Должен использовать маршрут log/production для записи урожая",
    metadata: { domain: "routing" },
  },
];

// ---------------------------------------------------------------------------
// Команда: seed
// ---------------------------------------------------------------------------

async function cmdSeed() {
  console.log(
    `[eval-runner] Создаю датасет "${DATASET_NAME}" с ${TEST_CASES.length} тест-кейсами...\n`,
  );

  // Создаём или получаем существующий датасет
  let datasetId;
  try {
    const res = await langfuse("POST", "/api/public/v2/datasets", {
      name: DATASET_NAME,
      description: "Pepino Pick Agent OS — eval dataset v1 (15 test cases across 5 domains)",
      metadata: {
        version: 1,
        domains: ["sales", "agro", "finance", "operations", "routing"],
        created: new Date().toISOString(),
      },
    });
    datasetId = res.data?.id;
    console.log(`  Датасет создан: ${datasetId || "(ok)"}`);
  } catch (err) {
    // Датасет может уже существовать — это нормально
    if (String(err).includes("409") || String(err).includes("already exists")) {
      console.log("  Датасет уже существует, добавляю items...");
    } else {
      throw err;
    }
  }

  // Создаём items
  let created = 0;
  let skipped = 0;

  for (const tc of TEST_CASES) {
    try {
      await langfuse("POST", "/api/public/dataset-items", {
        datasetName: DATASET_NAME,
        input: { question: tc.input },
        expectedOutput: { criteria: tc.expected_output },
        metadata: tc.metadata,
      });
      created++;
      console.log(`  [+] ${tc.metadata.domain.padEnd(12)} "${tc.input.slice(0, 45)}..."`);
    } catch (err) {
      // Дубликат — пропускаем
      if (String(err).includes("409")) {
        skipped++;
        console.log(`  [=] ${tc.metadata.domain.padEnd(12)} (уже существует)`);
      } else {
        console.error(`  [!] Ошибка: ${err.message}`);
      }
    }
  }

  console.log(`\nГотово: создано ${created}, пропущено ${skipped}, всего ${TEST_CASES.length}`);
}

// ---------------------------------------------------------------------------
// Команда: score
// ---------------------------------------------------------------------------

/**
 * @param {string} traceId
 * @param {string} scoreStr
 * @param {string} [comment]
 */
async function cmdScore(traceId, scoreStr, comment) {
  if (!traceId || scoreStr == null) {
    console.error("Использование: node eval-runner.cjs score <trace_id> <score 0-1> [comment]");
    process.exit(1);
  }

  const value = parseFloat(scoreStr);
  if (isNaN(value) || value < 0 || value > 1) {
    console.error("Score должен быть числом от 0 до 1.");
    process.exit(1);
  }

  console.log(`[eval-runner] Отправляю score: traceId=${traceId}, value=${value}`);

  /** @type {{ traceId: string, name: string, value: number, dataType: string, comment?: string }} */
  const payload = {
    traceId,
    name: "quality",
    value,
    dataType: "NUMERIC",
  };

  if (comment) {
    payload.comment = comment;
  }

  const res = await langfuse("POST", "/api/public/scores", payload);
  console.log(`Готово. Score ID: ${res.data?.id || "(ok)"}`);
}

// ---------------------------------------------------------------------------
// Команда: report
// ---------------------------------------------------------------------------

async function cmdReport() {
  console.log("[eval-runner] Загружаю scores из Langfuse...\n");

  // Загружаем все quality scores (пагинация — до 500 за раз)
  /** @type {{ name: string, value: number, traceId: string, comment?: string, createdAt?: string }[]} */
  let allScores = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const res = await langfuse(
      "GET",
      `/api/public/scores?name=quality&limit=${limit}&page=${page}`,
    );

    const scores = res.data?.data || [];
    if (scores.length === 0) break;

    allScores = allScores.concat(scores);

    // Если вернулось меньше лимита — больше страниц нет
    if (scores.length < limit) break;
    page++;
  }

  if (allScores.length === 0) {
    console.log("Нет оценок. Сначала оцените трейсы командой:");
    console.log("  node eval-runner.cjs score <trace_id> <0-1> [comment]");
    return;
  }

  // Агрегация
  const values = allScores.map((s) => s.value);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Распределение по бакетам
  const buckets = { poor: 0, fair: 0, good: 0, great: 0 };
  for (const v of values) {
    if (v < 0.25) buckets.poor++;
    else if (v < 0.5) buckets.fair++;
    else if (v < 0.75) buckets.good++;
    else buckets.great++;
  }

  // Тренд: последние 7 дней vs предыдущие
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  const recentScores = allScores.filter((s) => {
    const ts = s.createdAt ? new Date(s.createdAt).getTime() : 0;
    return now - ts < weekMs;
  });
  const olderScores = allScores.filter((s) => {
    const ts = s.createdAt ? new Date(s.createdAt).getTime() : 0;
    return now - ts >= weekMs;
  });

  const recentAvg =
    recentScores.length > 0
      ? recentScores.reduce((a, s) => a + s.value, 0) / recentScores.length
      : null;
  const olderAvg =
    olderScores.length > 0
      ? olderScores.reduce((a, s) => a + s.value, 0) / olderScores.length
      : null;

  // Вывод
  console.log("=== Pepino Pick Eval Report ===\n");
  console.log(`Всего оценок:   ${allScores.length}`);
  console.log(`Средний score:  ${avg.toFixed(3)}`);
  console.log(`Мин / Макс:     ${min.toFixed(2)} / ${max.toFixed(2)}`);
  console.log("");
  console.log("Распределение:");
  console.log(`  [0.00-0.25) poor:   ${buckets.poor}`);
  console.log(`  [0.25-0.50) fair:   ${buckets.fair}`);
  console.log(`  [0.50-0.75) good:   ${buckets.good}`);
  console.log(`  [0.75-1.00] great:  ${buckets.great}`);
  console.log("");

  if (recentAvg !== null && olderAvg !== null) {
    const delta = recentAvg - olderAvg;
    const arrow = delta > 0.01 ? "^" : delta < -0.01 ? "v" : "=";
    console.log("Тренд (7 дней):");
    console.log(`  Текущая неделя: ${recentAvg.toFixed(3)} (${recentScores.length} scores)`);
    console.log(`  Предыдущий:     ${olderAvg.toFixed(3)} (${olderScores.length} scores)`);
    console.log(`  Динамика:       ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} ${arrow}`);
  } else if (recentAvg !== null) {
    console.log(
      `Тренд: только текущая неделя (${recentScores.length} scores), avg=${recentAvg.toFixed(3)}`,
    );
  } else {
    console.log("Тренд: нет данных за последние 7 дней");
  }

  // Последние 5 оценок
  console.log("\nПоследние 5 оценок:");
  const latest = allScores
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 5);

  for (const s of latest) {
    const date = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16) : "?";
    const cmt = s.comment ? ` | ${s.comment}` : "";
    console.log(`  ${date}  score=${s.value.toFixed(2)}  trace=${s.traceId.slice(0, 8)}...${cmt}`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "seed":
      await cmdSeed();
      break;

    case "score":
      await cmdScore(args[0], args[1], args.slice(2).join(" ") || undefined);
      break;

    case "report":
      await cmdReport();
      break;

    default:
      console.log("Pepino Pick Eval Runner");
      console.log("");
      console.log("Команды:");
      console.log(
        "  node eval-runner.cjs seed              — создать датасет в Langfuse (15 тест-кейсов)",
      );
      console.log("  node eval-runner.cjs score <id> <0-1>  — оценить трейс (0=плохо, 1=отлично)");
      console.log("  node eval-runner.cjs report            — сводный отчёт по оценкам");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`[eval-runner] Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
