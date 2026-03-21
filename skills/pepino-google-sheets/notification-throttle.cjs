/**
 * Notification Throttle -- обёртка над telegram-helper.cjs с защитой от флуда.
 *
 * Возможности:
 *   1. Дедупликация -- одинаковые сообщения (по хешу) не отправляются повторно в течение 4ч
 *   2. Rate limiting -- макс. 5 сообщений/час на тред; остальные батчатся в одно сводное
 *   3. Тихие часы -- 22:00-06:00 (UTC-3, Аргентина). Только P1/CRITICAL проходят, остальные в очередь на 06:05
 *   4. Приоритетный override -- "CRITICAL", "P1", "!!!", severity >= 4 отправляются всегда
 *   5. Состояние хранится в /tmp/notification-throttle-state.json
 *   6. Автоматическая очистка очереди при каждом вызове
 *
 * Использование:
 *   const { sendThrottled, flushQueue } = require("./notification-throttle.cjs");
 *   await sendThrottled("Отчёт...", { thread: 20, silent: false, priority: "normal" });
 *   await flushQueue();
 *
 * CLI:
 *   node notification-throttle.cjs flush   -- отправить отложенные сообщения
 *   node notification-throttle.cjs stats   -- статистика за сегодня
 */

const fs = require("fs");
const crypto = require("crypto");
const { send } = require("./telegram-helper.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const STATE_PATH = "/tmp/notification-throttle-state.json";

/** Максимум сообщений в час на один тред */
const MAX_PER_HOUR = 5;

/** Окно дедупликации (мс) -- 4 часа */
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Максимальный возраст записей в sent (мс) -- 24 часа, для очистки */
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Тихие часы (включительно): с 22:00 до 05:59 по UTC-3 */
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 6;

/** Смещение Аргентины от UTC в часах */
const ARGENTINA_UTC_OFFSET = -3;

/** Ключевые слова для приоритетного override */
const CRITICAL_KEYWORDS = ["CRITICAL", "P1", "!!!"];

// ── Утилиты ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 хеш сообщения (первые 16 символов для компактности).
 * @param {string} text
 * @returns {string}
 */
function hashMessage(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Текущий час в Аргентине (UTC-3).
 * @returns {number} 0-23
 */
function argentinaHour() {
  const now = new Date();
  // getUTCHours + offset, нормализуем в 0-23
  const hour = (now.getUTCHours() + ARGENTINA_UTC_OFFSET + 24) % 24;
  return hour;
}

/**
 * Проверяет, попадает ли текущее время в тихие часы.
 * Тихие часы: 22:00 - 05:59 (Аргентина).
 * @returns {boolean}
 */
function isQuietHours() {
  const hour = argentinaHour();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Определяет, является ли сообщение критическим (bypass всех фильтров).
 * @param {string} text - текст сообщения
 * @param {number} [severity] - числовой приоритет (>= 4 = критический)
 * @returns {boolean}
 */
function isCritical(text, severity) {
  if (typeof severity === "number" && severity >= 4) return true;
  for (const kw of CRITICAL_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  return false;
}

/**
 * Ближайшее время 06:05 по Аргентине (UTC-3) в виде ISO-строки.
 * Если сейчас до 06:05 -- сегодня, иначе -- завтра.
 * @returns {string}
 */
function nextFlushTime() {
  const now = new Date();
  // Целевое время: 06:05 по Аргентине = 09:05 UTC
  const target = new Date(now);
  target.setUTCHours(9, 5, 0, 0); // 06:05 ART = 09:05 UTC
  if (target <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

// ── Управление состоянием ───────────────────────────────────────────────────

/**
 * Загружает состояние из файла. Очищает устаревшие записи.
 * @returns {{ sent: Array<{hash: string, thread: number, ts: number, priority: string}>, queued: Array<{message: string, thread: number, options: object, scheduled_for: string}> }}
 */
function loadState() {
  /** @type {{ sent: any[], queued: any[] }} */
  let state = { sent: [], queued: [] };

  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sent) && Array.isArray(parsed.queued)) {
        state = parsed;
      }
    }
  } catch {
    // Повреждённый файл -- начинаем с чистого состояния
    state = { sent: [], queued: [] };
  }

  // Очистка sent старше 24 часов
  const cutoff = Date.now() - SENT_TTL_MS;
  state.sent = state.sent.filter((/** @type {{ ts: number }} */ entry) => entry.ts > cutoff);

  return state;
}

/**
 * Сохраняет состояние в файл (атомарно через rename).
 * @param {{ sent: any[], queued: any[] }} state
 */
function saveState(state) {
  const tmpPath = STATE_PATH + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, STATE_PATH);
  } catch (err) {
    // Fallback: прямая запись
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      console.error("[throttle] Не удалось сохранить state:", err.message);
    }
  }
}

// ── Проверки throttling ─────────────────────────────────────────────────────

/**
 * Было ли сообщение с таким хешем отправлено в указанный тред за последние 4 часа.
 * @param {{ sent: any[] }} state
 * @param {string} hash
 * @param {number} thread
 * @returns {boolean}
 */
function isDuplicate(state, hash, thread) {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  return state.sent.some(
    (/** @type {{ hash: string, thread: number, ts: number }} */ e) =>
      e.hash === hash && e.thread === thread && e.ts > cutoff,
  );
}

/**
 * Количество сообщений, отправленных в тред за последний час.
 * @param {{ sent: any[] }} state
 * @param {number} thread
 * @returns {number}
 */
function messagesInLastHour(state, thread) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return state.sent.filter(
    (/** @type {{ thread: number, ts: number }} */ e) => e.thread === thread && e.ts > cutoff,
  ).length;
}

// ── Основные функции ────────────────────────────────────────────────────────

/**
 * Отправить сообщение с throttling.
 * Интерфейс аналогичен telegram-helper.cjs send(), но с добавлением throttle-логики.
 *
 * @param {string} message - Текст сообщения
 * @param {object} [options]
 * @param {number}  [options.thread=113] - ID топика (message_thread_id)
 * @param {boolean} [options.silent=false] - Тихое уведомление
 * @param {string}  [options.priority="normal"] - "normal" | "high" | "critical"
 * @param {number}  [options.severity] - Числовой приоритет (>= 4 = bypass)
 * @param {string}  [options.parseMode="Markdown"] - Формат парсинга
 * @returns {Promise<{ok: boolean, action: string, messageId?: number, error?: string}>}
 */
async function sendThrottled(message, options = {}) {
  const {
    thread = 113,
    silent = false,
    priority = "normal",
    severity,
    parseMode = "Markdown",
  } = options;

  const state = loadState();
  const hash = hashMessage(message);
  const critical = isCritical(message, severity) || priority === "critical";

  // Сначала пробуем отправить отложенные
  await _flushQueueInternal(state);

  // 1. Дедупликация (кроме критических)
  if (!critical && isDuplicate(state, hash, thread)) {
    saveState(state);
    return { ok: true, action: "dedup_skipped" };
  }

  // 2. Тихие часы (кроме критических)
  if (!critical && isQuietHours()) {
    state.queued.push({
      message,
      thread,
      options: { silent, parseMode },
      scheduled_for: nextFlushTime(),
    });
    saveState(state);
    return { ok: true, action: "queued_quiet_hours" };
  }

  // 3. Rate limiting (кроме критических)
  const hourCount = messagesInLastHour(state, thread);
  if (!critical && hourCount >= MAX_PER_HOUR) {
    // Подсчитываем сколько уже в очереди на этот тред
    const queuedForThread = state.queued.filter(
      (/** @type {{ thread: number }} */ q) => q.thread === thread,
    ).length;

    state.queued.push({
      message,
      thread,
      options: { silent, parseMode },
      scheduled_for: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    saveState(state);
    return {
      ok: true,
      action: "rate_limited",
      error: `Лимит ${MAX_PER_HOUR}/час для треда ${thread} (в очереди: ${queuedForThread + 1})`,
    };
  }

  // 4. Отправка
  const result = await send(message, {
    silent,
    threadId: thread,
    parseMode,
  });

  if (result.ok) {
    state.sent.push({
      hash,
      thread,
      ts: Date.now(),
      priority: critical ? "critical" : priority,
    });
  }

  saveState(state);

  return {
    ok: result.ok,
    action: result.ok ? "sent" : "send_failed",
    messageId: result.messageId,
    error: result.error,
  };
}

/**
 * Внутренняя функция flush -- работает с уже загруженным state.
 * @param {{ sent: any[], queued: any[] }} state
 * @returns {Promise<number>} количество отправленных
 */
async function _flushQueueInternal(state) {
  if (state.queued.length === 0) return 0;

  const now = new Date();
  let flushed = 0;

  // Группируем готовые к отправке сообщения по тредам
  /** @type {Map<number, Array<{message: string, options: object, idx: number}>>} */
  const readyByThread = new Map();
  /** @type {number[]} */
  const processedIndices = [];

  for (let i = 0; i < state.queued.length; i++) {
    const entry = state.queued[i];
    const scheduledFor = new Date(entry.scheduled_for);
    if (scheduledFor <= now) {
      const thread = entry.thread;
      if (!readyByThread.has(thread)) {
        readyByThread.set(thread, []);
      }
      readyByThread.get(thread).push({ message: entry.message, options: entry.options, idx: i });
      processedIndices.push(i);
    }
  }

  // Отправляем по тредам
  for (const [thread, entries] of readyByThread) {
    const hourCount = messagesInLastHour(state, thread);
    const budget = Math.max(0, MAX_PER_HOUR - hourCount);

    if (budget === 0) continue; // Ждём следующего часа

    if (entries.length <= budget) {
      // Отправляем каждое сообщение отдельно
      for (const entry of entries) {
        const result = await send(entry.message, {
          silent: entry.options.silent || false,
          threadId: thread,
          parseMode: entry.options.parseMode || "Markdown",
        });
        if (result.ok) {
          state.sent.push({
            hash: hashMessage(entry.message),
            thread,
            ts: Date.now(),
            priority: "normal",
          });
          flushed++;
        }
      }
    } else {
      // Батчим: отправляем первые (budget - 1) штук отдельно, остальные -- сводкой
      const individual = entries.slice(0, Math.max(0, budget - 1));
      const batched = entries.slice(Math.max(0, budget - 1));

      for (const entry of individual) {
        const result = await send(entry.message, {
          silent: entry.options.silent || false,
          threadId: thread,
          parseMode: entry.options.parseMode || "Markdown",
        });
        if (result.ok) {
          state.sent.push({
            hash: hashMessage(entry.message),
            thread,
            ts: Date.now(),
            priority: "normal",
          });
          flushed++;
        }
      }

      // Сводное сообщение
      if (batched.length > 0) {
        const summary =
          `\u{1F4E6} *${batched.length} обновлений за тихие часы (сводка):*\n\n` +
          batched
            .map((e, i) => {
              // Первые 120 символов каждого сообщения
              const preview = e.message.replace(/[*_`[\]]/g, "").slice(0, 120);
              return `${i + 1}. ${preview}${e.message.length > 120 ? "..." : ""}`;
            })
            .join("\n");

        const result = await send(summary, {
          silent: true,
          threadId: thread,
          parseMode: "Markdown",
        });
        if (result.ok) {
          state.sent.push({
            hash: hashMessage(summary),
            thread,
            ts: Date.now(),
            priority: "batch",
          });
          flushed++;
        }
      }
    }
  }

  // Удаляем обработанные из очереди (в обратном порядке, чтобы не сбить индексы)
  processedIndices.sort((a, b) => b - a);
  for (const idx of processedIndices) {
    state.queued.splice(idx, 1);
  }

  return flushed;
}

/**
 * Отправить все отложенные сообщения, время которых пришло.
 * @returns {Promise<{flushed: number, remaining: number}>}
 */
async function flushQueue() {
  const state = loadState();
  const flushed = await _flushQueueInternal(state);
  saveState(state);
  return { flushed, remaining: state.queued.length };
}

/**
 * Получить текущую статистику throttling.
 * @returns {{ sent_24h: number, sent_1h: number, queued: number, by_thread: Record<string, number> }}
 */
function getStats() {
  const state = loadState();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  /** @type {Record<string, number>} */
  const byThread = {};
  for (const entry of state.sent) {
    const key = String(entry.thread);
    byThread[key] = (byThread[key] || 0) + 1;
  }

  return {
    sent_24h: state.sent.length,
    sent_1h: state.sent.filter((/** @type {{ ts: number }} */ e) => e.ts > oneHourAgo).length,
    queued: state.queued.length,
    by_thread: byThread,
  };
}

// ── Экспорт ─────────────────────────────────────────────────────────────────

module.exports = {
  sendThrottled,
  flushQueue,
  getStats,
  // Для тестирования
  _internal: {
    hashMessage,
    argentinaHour,
    isQuietHours,
    isCritical,
    isDuplicate,
    messagesInLastHour,
    loadState,
    saveState,
  },
};

// ── CLI режим ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === "flush") {
    flushQueue()
      .then((result) => {
        console.log(
          `[throttle] flush завершён: отправлено ${result.flushed}, в очереди ${result.remaining}`,
        );
        process.exit(0);
      })
      .catch((err) => {
        console.error("[throttle] flush ошибка:", err.message);
        process.exit(1);
      });
  } else if (cmd === "stats") {
    const stats = getStats();
    console.log("[throttle] Статистика:");
    console.log(`  Отправлено за 24ч: ${stats.sent_24h}`);
    console.log(`  Отправлено за 1ч:  ${stats.sent_1h}`);
    console.log(`  В очереди:         ${stats.queued}`);
    console.log(`  По тредам (24ч):   ${JSON.stringify(stats.by_thread)}`);
    console.log(
      `  Тихие часы:        ${isQuietHours() ? "ДА" : "НЕТ"} (${argentinaHour()}:xx ART)`,
    );
  } else {
    console.log("Использование:");
    console.log("  node notification-throttle.cjs flush   -- отправить отложенные");
    console.log("  node notification-throttle.cjs stats   -- статистика");
  }
}
