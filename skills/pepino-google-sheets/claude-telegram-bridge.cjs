#!/usr/bin/env node
/**
 * claude-telegram-bridge.cjs -- Мост между Claude Code CLI и Telegram-топиком
 *
 * Архитектура:
 *   Пользователь пишет в Telegram-топик "Claude Brain"
 *   -> Скрипт ловит сообщение через long polling (отдельный бот!)
 *   -> Отправляет текст в `claude -p` (подписка, не API)
 *   -> Ответ Claude возвращается в Telegram
 *
 * ВАЖНО: Использует ОТДЕЛЬНОГО бота (не OpenClaw gateway), чтобы избежать
 * конфликта long polling. Создайте бота через @BotFather:
 *   1. /newbot -> "Claude Brain" -> @claude_brain_pepino_bot (или свое имя)
 *   2. Добавьте бота в группу Pepino Pick
 *   3. Дайте права на чтение сообщений в нужном топике
 *   4. Установите CLAUDE_BRAIN_BOT_TOKEN=<токен>
 *   5. Узнайте thread_id: отправьте сообщение в топик, проверьте через getUpdates
 *
 * Env vars:
 *   CLAUDE_BRAIN_BOT_TOKEN  -- токен ОТДЕЛЬНОГО бота (обязательно)
 *   CLAUDE_BRAIN_CHAT_ID    -- ID группы (default: -1003757515497)
 *   CLAUDE_BRAIN_THREAD_ID  -- ID топика/треда (обязательно)
 *
 * CLI:
 *   node claude-telegram-bridge.cjs                    -- запуск
 *   node claude-telegram-bridge.cjs --dry-run          -- без реальной отправки
 *   node claude-telegram-bridge.cjs --find-thread      -- показать входящие сообщения для поиска thread_id
 *   node --check claude-telegram-bridge.cjs            -- валидация синтаксиса
 *
 * Лог: /home/roman/logs/claude-bridge.log
 */

"use strict";

const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Конфигурация ────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.CLAUDE_BRAIN_BOT_TOKEN || "";
const CHAT_ID = process.env.CLAUDE_BRAIN_CHAT_ID || "-1003757515497";
const THREAD_ID = parseInt(process.env.CLAUDE_BRAIN_THREAD_ID || "0", 10);
const POLL_INTERVAL_MS = 3000;
const CLAUDE_TIMEOUT_MS = 120_000;
const MAX_TG_MESSAGE_LEN = 4000;
const SESSION_FILE = "/tmp/claude-brain-session.json";
const LOG_FILE = "/home/roman/logs/claude-bridge.log";
const WORKING_DIR = "/home/roman/openclaw/skills/pepino-google-sheets";

const DRY_RUN = process.argv.includes("--dry-run");
const FIND_THREAD = process.argv.includes("--find-thread");

// ── Системный промпт для Claude ─────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "Ты Claude Brain -- AI-мозг Pepino Pick в Telegram.",
  "Ты имеешь доступ ко всем скриптам в ~/openclaw/skills/pepino-google-sheets/.",
  "",
  "Полезные команды (выполняй через Bash tool):",
  "  node ml-search.cjs 'запрос'                      -- поиск на MercadoLibre",
  "  node farm-state.cjs refresh                       -- обновить кеш фермы",
  "  node expense-quick-entry.cjs 'описание сумма'     -- записать расход",
  "  node task-brain.cjs add 'описание задачи'         -- добавить задачу",
  "  node digital-twin.cjs                             -- состояние фермы",
  "  node knowledge-retriever.cjs search 'запрос'      -- поиск в базе знаний",
  "",
  "Правила ответа:",
  "  - Отвечай на русском если сообщение на русском, на испанском если на испанском",
  "  - Будь кратким -- это Telegram, не эссе",
  "  - Если нужны данные -- используй скрипты, не выдумывай",
  "  - Для финансов: НЕ выполняй транзакции >50K ARS без подтверждения",
].join("\n");

// ── Логирование ─────────────────────────────────────────────────────────────

/**
 * Записать строку в лог-файл и stdout
 * @param {string} level
 * @param {string} msg
 */
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Если директория логов недоступна -- пишем только в stdout
  }
}

// ── Telegram API ────────────────────────────────────────────────────────────

/**
 * Вызов метода Telegram Bot API
 * @param {string} method
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ok: boolean, result?: unknown, description?: string}>}
 */
function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ ok: false, description: "JSON parse error" });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(35_000, () => {
      req.destroy(new Error("Telegram API timeout"));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Отправить "печатает..." в чат
 */
async function sendTyping() {
  try {
    await tgApi("sendChatAction", {
      chat_id: CHAT_ID,
      message_thread_id: THREAD_ID,
      action: "typing",
    });
  } catch {
    // typing -- не критично
  }
}

/**
 * Отправить сообщение в Telegram (с разбивкой по длине)
 * @param {string} text
 * @param {number} [replyToId]
 */
async function sendMessage(text, replyToId) {
  if (DRY_RUN) {
    log("DRY", `Would send (${text.length} chars): ${text.slice(0, 200)}...`);
    return;
  }

  const chunks = splitMessage(text, MAX_TG_MESSAGE_LEN);

  for (const chunk of chunks) {
    /** @type {Record<string, unknown>} */
    const payload = {
      chat_id: CHAT_ID,
      message_thread_id: THREAD_ID,
      text: chunk,
      disable_web_page_preview: true,
    };

    // Пробуем HTML, при ошибке -- plain text
    payload.parse_mode = "HTML";
    const res = await tgApi("sendMessage", payload);

    if (!res.ok && res.description?.includes("parse")) {
      // HTML не прошёл -- отправляем как plain text
      delete payload.parse_mode;
      await tgApi("sendMessage", payload);
    }
  }
}

/**
 * Разбить текст на чанки по максимальной длине.
 * Разделяет по переносу строки если возможно.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Ищем последний перенос строки в пределах лимита
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) {
      // Слишком рано -- режем по пробелу
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // Ничего не нашли -- режем жёстко
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Сессия Claude ───────────────────────────────────────────────────────────

/**
 * Получить или создать session ID (валидный UUID, сбрасывается раз в 24ч)
 * @returns {string}
 */
function getSessionId() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    const age = Date.now() - (data.created || 0);
    if (age < 86_400_000 && data.sessionId) {
      return data.sessionId;
    }
    // Сессия устарела
    log("INFO", "Сессия старше 24ч -- создаю новую");
  } catch {
    // Файл не существует или повреждён
  }

  const sessionId = crypto.randomUUID();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, created: Date.now() }));
  log("INFO", `Новая сессия: ${sessionId}`);
  return sessionId;
}

/**
 * Сбросить сессию вручную
 */
function resetSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // Файл не существует -- ok
  }
  log("INFO", "Сессия сброшена");
}

// ── Вызов Claude CLI ────────────────────────────────────────────────────────

/**
 * Отправить сообщение в Claude CLI и получить ответ.
 * Использует spawn для неблокирующего ожидания.
 * @param {string} message
 * @returns {Promise<string>}
 */
function callClaude(message) {
  return new Promise((resolve, reject) => {
    if (DRY_RUN) {
      resolve(`[DRY RUN] Echo: ${message}`);
      return;
    }

    const args = [
      "-p",
      "--model",
      "sonnet",
      "--append-system-prompt",
      SYSTEM_PROMPT,
      "--permission-mode",
      "auto",
      message,
    ];

    const proc = spawn("claude", args, {
      cwd: WORKING_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      reject(new Error("Claude timeout (120s). Попробуй разбить запрос на части."));
    }, CLAUDE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const errMsg = stderr.trim().slice(0, 300) || `exit code ${code}`;
        log("ERROR", `Claude CLI error: ${errMsg}`);
        reject(new Error(`Claude error: ${errMsg}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить Claude CLI: ${err.message}`));
    });
  });
}

// ── Очередь сообщений ───────────────────────────────────────────────────────

/** @type {Array<{msg: object, resolve: Function}>} */
let messageQueue = [];
let isProcessing = false;
let processedCount = 0;

/**
 * Добавить сообщение в очередь и запустить обработку
 * @param {object} msg -- Telegram message object
 */
function enqueue(msg) {
  messageQueue.push(msg);
  log("INFO", `В очереди: ${messageQueue.length} | Обработано: ${processedCount}`);
  drainQueue();
}

/**
 * Обработать очередь (max 1 concurrent)
 */
async function drainQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;

  const msg = messageQueue.shift();
  try {
    await processMessage(msg);
  } catch (e) {
    log("ERROR", `processMessage error: ${e.message}`);
  }

  processedCount++;
  isProcessing = false;

  if (messageQueue.length > 0) {
    drainQueue();
  }
}

/**
 * Обработать одно входящее сообщение
 * @param {object} msg
 */
async function processMessage(msg) {
  const text = msg.text || msg.caption || "";
  if (!text) return;

  // Игнорируем команды (пусть OpenClaw или BotFather обрабатывают)
  if (text.startsWith("/")) return;

  // Игнорируем ботов
  if (msg.from?.is_bot) return;

  const senderName = msg.from?.first_name || "Unknown";

  // Специальные команды управления сессией
  const lower = text.toLowerCase().trim();
  if (lower === "новая сессия" || lower === "reset" || lower === "new session") {
    resetSession();
    await sendMessage("Сессия сброшена. Начинаем с чистого листа.");
    return;
  }

  if (lower === "status" || lower === "статус") {
    const session = getSessionId();
    const qLen = messageQueue.length;
    const uptime = Math.round(process.uptime() / 60);
    await sendMessage(
      `Claude Brain status:\n` +
        `  Uptime: ${uptime} min\n` +
        `  Session: ${session.slice(0, 8)}...\n` +
        `  Queue: ${qLen}\n` +
        `  Processed: ${processedCount}`,
    );
    return;
  }

  log("INFO", `[${senderName}] ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

  // Typing indicator (обновляем каждые 4 секунды пока Claude думает)
  const typingInterval = setInterval(sendTyping, 4000);
  await sendTyping();

  try {
    const response = await callClaude(text);
    clearInterval(typingInterval);

    if (response) {
      await sendMessage(response);
      log("INFO", `Ответ: ${response.length} chars`);
    } else {
      await sendMessage("Claude вернул пустой ответ.");
    }
  } catch (e) {
    clearInterval(typingInterval);
    await sendMessage(`Ошибка: ${e.message}`);
    log("ERROR", e.message);
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

let lastUpdateId = 0;
let isShuttingDown = false;

/**
 * Один цикл long polling
 */
async function poll() {
  if (isShuttingDown) return;

  try {
    const result = await tgApi("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message"],
    });

    if (!result.ok) {
      log("WARN", `getUpdates failed: ${result.description || "unknown error"}`);
      // Возможно конфликт polling -- ждём и повторяем
      if (result.description?.includes("conflict")) {
        log(
          "ERROR",
          "Conflict: другой процесс использует этот токен. Убедитесь что это ОТДЕЛЬНЫЙ бот.",
        );
        await sleep(10_000);
      }
    }

    if (result.ok && Array.isArray(result.result)) {
      for (const update of result.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;

        // --find-thread: показываем все входящие сообщения
        if (FIND_THREAD) {
          console.log(
            `chat_id=${msg.chat?.id} thread_id=${msg.message_thread_id || "none"} ` +
              `from=${msg.from?.first_name} text="${(msg.text || "").slice(0, 50)}"`,
          );
          continue;
        }

        // Фильтруем: только наш чат и наш тред
        if (String(msg.chat?.id) !== String(CHAT_ID)) continue;
        if (msg.message_thread_id !== THREAD_ID) continue;

        enqueue(msg);
      }
    }
  } catch (e) {
    log("ERROR", `Poll error: ${e.message}`);
    await sleep(5000);
  }

  // Следующий цикл
  if (!isShuttingDown) {
    setTimeout(poll, POLL_INTERVAL_MS);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("INFO", `Получен ${signal}. Завершение...`);

  // Даём текущей обработке завершиться (макс 5 сек)
  const deadline = setTimeout(() => {
    log("WARN", "Принудительное завершение");
    process.exit(1);
  }, 5000);
  deadline.unref();

  const waitForDrain = () => {
    if (!isProcessing) {
      log("INFO", `Завершено. Обработано сообщений: ${processedCount}`);
      process.exit(0);
    }
    setTimeout(waitForDrain, 200);
  };
  waitForDrain();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Точка входа ─────────────────────────────────────────────────────────────

function main() {
  // Валидация
  if (!BOT_TOKEN) {
    console.error(
      "CLAUDE_BRAIN_BOT_TOKEN не установлен.\n\n" +
        "Инструкция:\n" +
        "  1. Откройте @BotFather в Telegram\n" +
        "  2. /newbot -> имя: 'Claude Brain' -> username: любой свободный\n" +
        "  3. Скопируйте токен\n" +
        "  4. Добавьте бота в группу Pepino Pick\n" +
        "  5. export CLAUDE_BRAIN_BOT_TOKEN='ваш_токен'\n" +
        "  6. export CLAUDE_BRAIN_THREAD_ID=<id топика>\n" +
        "  7. node claude-telegram-bridge.cjs --find-thread  (найти thread_id)\n",
    );
    process.exit(1);
  }

  if (!THREAD_ID && !FIND_THREAD) {
    console.error(
      "CLAUDE_BRAIN_THREAD_ID не установлен.\n\n" +
        "Для поиска thread_id:\n" +
        "  1. Отправьте сообщение в нужный топик группы\n" +
        "  2. Запустите: node claude-telegram-bridge.cjs --find-thread\n" +
        "  3. Найдите thread_id в выводе\n" +
        "  4. export CLAUDE_BRAIN_THREAD_ID=<найденный id>\n",
    );
    process.exit(1);
  }

  if (FIND_THREAD) {
    log("INFO", "Режим поиска thread_id. Отправьте сообщение в нужный топик...");
    log("INFO", "Нажмите Ctrl+C для остановки.\n");
    poll();
    return;
  }

  log("INFO", "Claude Brain bridge запущен");
  log("INFO", `  Bot token: ${BOT_TOKEN.slice(0, 8)}...${BOT_TOKEN.slice(-4)}`);
  log("INFO", `  Chat ID: ${CHAT_ID}`);
  log("INFO", `  Thread ID: ${THREAD_ID}`);
  log("INFO", `  Poll interval: ${POLL_INTERVAL_MS}ms`);
  log("INFO", `  Claude timeout: ${CLAUDE_TIMEOUT_MS}ms`);
  log("INFO", `  Working dir: ${WORKING_DIR}`);
  log("INFO", `  Dry run: ${DRY_RUN}`);
  log("INFO", `  Session file: ${SESSION_FILE}`);
  log("INFO", `  Log file: ${LOG_FILE}`);
  log("INFO", "  Press Ctrl+C to stop\n");

  poll();
}

main();
