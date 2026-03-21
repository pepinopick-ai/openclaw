/**
 * Shared Telegram message helper for Pepino Pick scripts.
 * Uses Telegram Bot API for message delivery with silent/loud notification control.
 *
 * Типы сообщений:
 *   sendStatus  -- тихое уведомление (без звука), для рутинных статусов
 *   sendAlert   -- громкое уведомление, для сбоев и критических событий
 *   sendReport  -- громкое уведомление, для отчётов (бриф, еженедельный)
 *
 * Конфигурация:
 *   Токен и чат берутся из env (PEPINO_TG_TOKEN, PEPINO_TG_CHAT_ID)
 *   или из значений по умолчанию.
 *
 * Usage:
 *   const { sendStatus, sendAlert, sendReport, send } = require('./telegram-helper.cjs');
 *   await sendStatus('Sync completed');         // тихое уведомление
 *   await sendAlert('API down!');               // громкое уведомление
 *   await sendReport('Daily P&L...', 111);      // громкое, в указанный топик
 *   await send('Custom', { silent: true, threadId: 113, parseMode: 'HTML' });
 */

const https = require("https");

// ── Конфигурация (env vars с fallback) ───────────────────────────────────────

const TG_TOKEN = process.env.PEPINO_TG_TOKEN || "8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00";
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || "-1003757515497";

// Топики по умолчанию
const TOPIC_STATUS = 113; // Мониторинг/здоровье системы
const TOPIC_BRIEF = 111; // Утренний бриф
const TOPIC_RESULTS = 112; // Итоги

// ── Базовая отправка ─────────────────────────────────────────────────────────

/**
 * Отправить сообщение в Telegram.
 *
 * @param {string} text - Текст сообщения
 * @param {object} options
 * @param {boolean} [options.silent=false] - Тихое уведомление (disable_notification)
 * @param {number}  [options.threadId] - ID топика (message_thread_id)
 * @param {string}  [options.parseMode='Markdown'] - Формат ('Markdown' | 'HTML')
 * @param {boolean} [options.disablePreview=true] - Отключить превью ссылок
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
function send(text, options = {}) {
  const {
    silent = false,
    threadId = TOPIC_STATUS,
    parseMode = "Markdown",
    disablePreview = true,
  } = options;

  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: parseMode,
    message_thread_id: threadId,
    disable_notification: silent,
    disable_web_page_preview: disablePreview,
  });

  return new Promise((resolve) => {
    const req = https.request(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `Telegram API ${res.statusCode}: ${body}` });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok) {
              resolve({ ok: false, error: parsed.description || body });
              return;
            }
            resolve({ ok: true, messageId: parsed.result?.message_id });
          } catch {
            resolve({ ok: false, error: `Невалидный ответ: ${body.slice(0, 200)}` });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

// ── Типизированные методы ────────────────────────────────────────────────────

/**
 * Статусное сообщение -- тихое уведомление (без звука на телефоне).
 * Для: healthcheck OK, sync done, data completeness OK.
 *
 * @param {string} text - Текст сообщения
 * @param {number} [threadId] - ID топика (по умолчанию: мониторинг)
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
function sendStatus(text, threadId = TOPIC_STATUS) {
  return send(text, { silent: true, threadId });
}

/**
 * Алерт -- громкое уведомление (телефон звонит/вибрирует).
 * Для: сбои, ошибки, критичные предупреждения.
 *
 * @param {string} text - Текст сообщения
 * @param {number} [threadId] - ID топика (по умолчанию: мониторинг)
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
function sendAlert(text, threadId = TOPIC_STATUS) {
  return send(text, { silent: false, threadId });
}

/**
 * Отчёт -- громкое уведомление.
 * Для: утренний бриф, еженедельный отчёт, вечерняя сводка.
 *
 * @param {string} text - Текст сообщения
 * @param {number} [threadId] - ID топика (по умолчанию: бриф)
 * @param {string} [parseMode='HTML'] - Формат парсинга
 * @returns {Promise<{ok: boolean, messageId?: number, error?: string}>}
 */
function sendReport(text, threadId = TOPIC_BRIEF, parseMode = "HTML") {
  return send(text, { silent: false, threadId, parseMode });
}

// ── Экспорт ──────────────────────────────────────────────────────────────────

module.exports = {
  send,
  sendStatus,
  sendAlert,
  sendReport,
  // Константы топиков для удобства импорта
  TOPIC_STATUS,
  TOPIC_BRIEF,
  TOPIC_RESULTS,
};
