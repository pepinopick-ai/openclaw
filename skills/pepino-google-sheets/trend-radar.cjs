#!/usr/bin/env node
/**
 * Pepino Pick -- Trend Radar
 *
 * Структурированная система внешней разведки: собирает сигналы из веба
 * и доставляет их нужным бизнес-ролям.
 *
 * 5 потоков:
 *   1. ai-agents      -- AI/автоматизация (пн/ср/пт)
 *   2. agro-tech      -- агротехнологии (вт/чт)
 *   3. sales          -- продажи/CRM (пн/чт)
 *   4. marketing      -- маркетинг/бренд (пн/ср/пт)
 *   5. supplier-risk  -- поставщики/риски (ежедневно)
 *
 * Usage:
 *   node trend-radar.cjs all              # Все 5 потоков
 *   node trend-radar.cjs ai-agents        # Только AI/автоматизация
 *   node trend-radar.cjs agro-tech        # Только агротехнологии
 *   node trend-radar.cjs sales            # Только продажи
 *   node trend-radar.cjs marketing        # Только маркетинг
 *   node trend-radar.cjs supplier-risk    # Только поставщики/риски
 *   node trend-radar.cjs --dry-run all    # Dry run, без записей
 *
 * Cron:
 *   ai-agents:     0 9 * * 1,3,5
 *   agro-tech:     0 9 * * 2,4
 *   sales:         0 9 * * 1,4
 *   marketing:     0 9 * * 1,3,5
 *   supplier-risk: 0 9 * * *
 */

"use strict";

const https = require("https");
const http = require("http");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport, send } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// ── Конфигурация ────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_ID = 20; // Стратегия/Директор
const SHEET_NAME = "\u{1F4E1} Trend Radar";
const MAX_SIGNALS_PER_RADAR = 3;
const MIN_RELEVANCE = 5;

// ── Определения потоков ─────────────────────────────────────────────────────

/** @type {Record<string, {name: string, queries: string[], owner: string, topic: number, schedule: string}>} */
const RADARS = {
  "ai-agents": {
    name: "AI & Automation",
    queries: [
      "Claude Code updates",
      "n8n new features",
      "MCP servers 2026",
      "AI agent automation farming",
    ],
    owner: "dev",
    topic: 18,
    schedule: "Mon/Wed/Fri",
  },
  "agro-tech": {
    name: "Agro Technology",
    queries: [
      "greenhouse technology 2026",
      "oyster mushroom cultivation tips",
      "cucumber hydroponic pest control",
      "postharvest fresh vegetables",
    ],
    owner: "agro",
    topic: 14,
    schedule: "Tue/Thu",
  },
  sales: {
    name: "Sales & CRM",
    queries: [
      "B2B fresh produce sales strategy",
      "restaurant supplier retention",
      "food delivery pricing Argentina",
    ],
    owner: "sales",
    topic: 16,
    schedule: "Mon/Thu",
  },
  marketing: {
    name: "Marketing & Brand",
    queries: [
      "Instagram food brand growth",
      "restaurant chef collaboration",
      "organic produce marketing",
      "food photography reels",
    ],
    owner: "marketing",
    topic: 16,
    schedule: "Mon/Wed/Fri",
  },
  "supplier-risk": {
    name: "Supplier & Risk",
    queries: [
      "Argentina supply chain disruption",
      "sustrato hongos precio",
      "packaging costs Argentina 2026",
      "agricultural input prices",
    ],
    owner: "procurement",
    topic: 176,
    schedule: "daily",
  },
};

// ── Ключевые слова для оценки релевантности ─────────────────────────────────

/** Слова и веса, отражающие близость к бизнесу Pepino Pick */
const RELEVANCE_KEYWORDS = [
  // Ядро бизнеса (высокий вес)
  { re: /pepino|cucumber|pepino\s*pick/i, weight: 3 },
  { re: /mushroom|hongo|oyster\s*mushroom|seta/i, weight: 3 },
  { re: /greenhouse|invernadero|теплиц/i, weight: 3 },
  { re: /hydroponic|hidropon/i, weight: 2 },
  { re: /fresh\s*produce|verdura|hortaliza/i, weight: 2 },

  // Бизнес-контекст (средний вес)
  { re: /argentin|buenos\s*aires/i, weight: 2 },
  { re: /restaurant|chef|gastronom/i, weight: 2 },
  { re: /supply\s*chain|cadena\s*de\s*suministro/i, weight: 2 },
  { re: /pricing|precio|margen|margin/i, weight: 1 },
  { re: /B2B|wholesale|mayorist/i, weight: 1 },

  // Технологии (средний вес)
  { re: /automation|automat|n8n|agent/i, weight: 1 },
  { re: /claude|openai|llm|ai\s*tool/i, weight: 1 },
  { re: /MCP|model\s*context/i, weight: 1 },

  // Операции (низкий вес)
  { re: /packaging|envase|embalaje/i, weight: 1 },
  { re: /pest\s*control|plaga|disease|enfermedad/i, weight: 1 },
  { re: /postharvest|postcosecha|storage|almacen/i, weight: 1 },
  { re: /organic|organi[ck]|agroecolog/i, weight: 1 },
  { re: /instagram|reel|marketing|brand/i, weight: 1 },
  { re: /delivery|entrega|logistic/i, weight: 1 },
  { re: /sustrato|substrate|compost/i, weight: 1 },
];

// ── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Выполняет HTTPS/HTTP GET-запрос и возвращает тело ответа как строку.
 * @param {string} url
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<string>}
 */
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      // Следуем редиректам (3xx)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP timeout: ${url}`));
    });
  });
}

// ── Парсинг Google News RSS ─────────────────────────────────────────────────

/**
 * Извлекает элементы из RSS XML без внешних зависимостей.
 * @param {string} xml
 * @returns {{title: string, url: string, source: string, date: string, snippet: string}[]}
 */
function parseRssItems(xml) {
  const items = [];
  // Разбираем <item>...</item> блоки
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTagAttr(block, "source") || extractDomain(link);
    const description = extractTag(block, "description");

    if (title && link) {
      items.push({
        title: decodeHtmlEntities(title),
        url: link.trim(),
        source: decodeHtmlEntities(source),
        date: pubDate ? formatDate(pubDate) : new Date().toISOString().slice(0, 10),
        snippet: decodeHtmlEntities(stripHtml(description || "")).slice(0, 300),
      });
    }
  }
  return items;
}

/**
 * Извлекает содержимое XML-тега.
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function extractTag(xml, tag) {
  // Поддерживаем CDATA: <tag><![CDATA[...]]></tag>
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

/**
 * Извлекает текстовое содержимое атрибута или body тега <source>.
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function extractTagAttr(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

/** Извлекает домен из URL */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Форматирует дату RSS в YYYY-MM-DD */
function formatDate(rssDate) {
  try {
    return new Date(rssDate).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Убирает HTML-теги */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Декодирует основные HTML-сущности */
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ── Парсинг DuckDuckGo API ─────────────────────────────────────────────────

/**
 * Парсит ответ DuckDuckGo Instant Answer API.
 * @param {object} data
 * @param {string} query
 * @returns {{title: string, url: string, source: string, date: string, snippet: string}[]}
 */
function parseDdgResults(data, query) {
  const items = [];
  const today = new Date().toISOString().slice(0, 10);

  // RelatedTopics может содержать результаты
  const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of topics) {
    if (topic.FirstURL && topic.Text) {
      items.push({
        title: topic.Text.slice(0, 120),
        url: topic.FirstURL,
        source: "DuckDuckGo",
        date: today,
        snippet: topic.Text.slice(0, 300),
      });
    }
    // Вложенные темы
    if (Array.isArray(topic.Topics)) {
      for (const sub of topic.Topics) {
        if (sub.FirstURL && sub.Text) {
          items.push({
            title: sub.Text.slice(0, 120),
            url: sub.FirstURL,
            source: "DuckDuckGo",
            date: today,
            snippet: sub.Text.slice(0, 300),
          });
        }
      }
    }
  }

  // AbstractURL как fallback
  if (items.length === 0 && data.AbstractURL && data.AbstractText) {
    items.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      source: data.AbstractSource || "DuckDuckGo",
      date: today,
      snippet: data.AbstractText.slice(0, 300),
    });
  }

  return items;
}

// ── Поиск сигналов ──────────────────────────────────────────────────────────

/**
 * Ищет сигналы по одному запросу через Google News RSS, с fallback на DuckDuckGo.
 * @param {string} query
 * @returns {Promise<{title: string, url: string, source: string, date: string, snippet: string}[]>}
 */
async function searchQuery(query) {
  // Google News RSS (основной источник)
  const encodedQuery = encodeURIComponent(query);
  const googleUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=es-419&gl=AR&ceid=AR:es-419`;

  try {
    const xml = await httpGet(googleUrl);
    const items = parseRssItems(xml);
    if (items.length > 0) {
      console.log(`  [Google News] "${query}" -> ${items.length} results`);
      return items;
    }
  } catch (err) {
    console.warn(`  [Google News] "${query}" failed: ${err.message}`);
  }

  // DuckDuckGo API (fallback)
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
  try {
    const raw = await httpGet(ddgUrl);
    const data = JSON.parse(raw);
    const items = parseDdgResults(data, query);
    console.log(`  [DuckDuckGo] "${query}" -> ${items.length} results`);
    return items;
  } catch (err) {
    console.warn(`  [DuckDuckGo] "${query}" failed: ${err.message}`);
  }

  return [];
}

// ── Оценка релевантности ────────────────────────────────────────────────────

/**
 * Оценивает релевантность сигнала для Pepino Pick (0-10).
 * @param {{title: string, snippet: string}} signal
 * @returns {number}
 */
function scoreRelevance(signal) {
  const text = `${signal.title} ${signal.snippet}`.toLowerCase();
  let score = 0;

  for (const kw of RELEVANCE_KEYWORDS) {
    if (kw.re.test(text)) {
      score += kw.weight;
    }
  }

  // Ограничиваем 0-10
  return Math.min(10, Math.max(0, score));
}

/**
 * Определяет рекомендуемое действие на основе relevance score.
 * @param {number} score
 * @returns {string}
 */
function suggestAction(score) {
  if (score >= 8) return "test";
  if (score >= 6) return "watch";
  if (score >= 4) return "backlog";
  return "ignore";
}

// ── Фильтр новизны (дедупликация по URL) ────────────────────────────────────

/**
 * Загружает ранее сохраненные URL из листа Trend Radar.
 * @returns {Promise<Set<string>>}
 */
async function loadSeenUrls() {
  const seen = new Set();
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(PEPINO_SHEETS_ID, SHEET_NAME);
    if (rows && rows.length > 1) {
      // URL в колонке E (индекс 4)
      const headers = rows[0];
      const urlIdx = headers.indexOf("URL");
      const idx = urlIdx >= 0 ? urlIdx : 4;
      for (let i = 1; i < rows.length; i++) {
        const url = rows[i][idx];
        if (url) seen.add(url.trim());
      }
    }
    console.log(`[Novelty] Loaded ${seen.size} previously seen URLs`);
  } catch (err) {
    console.warn(`[Novelty] Could not load seen URLs: ${err.message}`);
  }
  return seen;
}

// ── Запись в Sheets ─────────────────────────────────────────────────────────

/**
 * Сохраняет результаты (все, включая низко-релевантные) в лист "Trend Radar".
 * Создает заголовки при первом запуске.
 * @param {{date: string, stream: string, title: string, source: string, url: string, relevance: number, action: string, owner: string, snippet: string}[]} signals
 */
async function saveToSheets(signals) {
  if (signals.length === 0) return;

  try {
    const { readSheet, appendToSheet, writeToSheet, PEPINO_SHEETS_ID } =
      await import("./sheets.js");

    // Проверяем, есть ли заголовки
    let existing;
    try {
      existing = await readSheet(PEPINO_SHEETS_ID, SHEET_NAME);
    } catch {
      existing = [];
    }

    const headers = [
      "Дата",
      "Поток",
      "Заголовок",
      "Источник",
      "URL",
      "Relevance",
      "Действие",
      "Owner",
      "Сниппет",
    ];

    // Если лист пуст -- записываем заголовки
    if (!existing || existing.length === 0) {
      await writeToSheet(PEPINO_SHEETS_ID, [headers], SHEET_NAME);
    }

    // Добавляем строки
    const rows = signals.map((s) => [
      s.date,
      s.stream,
      s.title,
      s.source,
      s.url,
      s.relevance,
      s.action,
      s.owner,
      s.snippet,
    ]);

    await appendToSheet(PEPINO_SHEETS_ID, rows, SHEET_NAME);
    console.log(`[Sheets] Saved ${rows.length} signals to "${SHEET_NAME}"`);
  } catch (err) {
    console.error(`[Sheets] Save failed: ${err.message}`);
  }
}

// ── Форматирование Telegram-отчета ──────────────────────────────────────────

/**
 * Форматирует HTML-сообщение для Telegram (макс. 3 сигнала на поток).
 * @param {string} streamName
 * @param {{title: string, source: string, date: string, relevance: number, action: string, owner: string, url: string}[]} signals
 * @returns {string}
 */
function formatTelegramMessage(streamName, signals) {
  const lines = [];
  lines.push(`<b>\u{1F4E1} TREND RADAR: ${streamName}</b>\n`);

  const topSignals = signals.slice(0, MAX_SIGNALS_PER_RADAR);

  for (let i = 0; i < topSignals.length; i++) {
    const s = topSignals[i];
    lines.push(`${i + 1}. <b>${escapeHtml(s.title)}</b> (${escapeHtml(s.source)}, ${s.date})`);
    lines.push(`   Relevance: ${s.relevance}/10 | Action: ${s.action} | Owner: ${s.owner}`);
    lines.push(`   ${escapeHtml(s.url)}`);
    if (i < topSignals.length - 1) lines.push("");
  }

  if (signals.length > MAX_SIGNALS_PER_RADAR) {
    lines.push(`\n+${signals.length - MAX_SIGNALS_PER_RADAR} more in Sheets`);
  }

  return lines.join("\n");
}

/** Экранирует HTML-спецсимволы для Telegram */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Обработка одного потока ─────────────────────────────────────────────────

/**
 * Выполняет полный цикл для одного потока радара.
 * @param {string} streamId
 * @param {Set<string>} seenUrls
 * @returns {Promise<{total: number, new: number, relevant: number, saved: number}>}
 */
async function processStream(streamId, seenUrls) {
  const radar = RADARS[streamId];
  if (!radar) {
    console.error(`Unknown stream: ${streamId}`);
    return { total: 0, new: 0, relevant: 0, saved: 0 };
  }

  console.log(`\n--- ${radar.name} (${streamId}) ---`);

  // Собираем результаты по всем запросам
  /** @type {{title: string, url: string, source: string, date: string, snippet: string}[]} */
  let allResults = [];
  for (const query of radar.queries) {
    const results = await searchQuery(query);
    allResults = allResults.concat(results);
  }

  const totalFound = allResults.length;
  console.log(`Total raw results: ${totalFound}`);

  // Дедупликация по URL внутри текущего запуска
  const urlSet = new Set();
  allResults = allResults.filter((r) => {
    if (urlSet.has(r.url)) return false;
    urlSet.add(r.url);
    return true;
  });

  // Фильтр новизны -- убираем уже виденные
  const newResults = allResults.filter((r) => !seenUrls.has(r.url));
  console.log(`New (not seen before): ${newResults.length}`);

  // Оценка релевантности
  const today = new Date().toISOString().slice(0, 10);
  const scored = newResults.map((r) => {
    const relevance = scoreRelevance(r);
    return {
      ...r,
      date: r.date || today,
      stream: streamId,
      relevance,
      action: suggestAction(relevance),
      owner: radar.owner,
    };
  });

  // Сортируем по relevance (наиболее важные первыми)
  scored.sort((a, b) => b.relevance - a.relevance);

  // Фильтруем для Telegram (только relevance >= MIN_RELEVANCE)
  const relevant = scored.filter((s) => s.relevance >= MIN_RELEVANCE);
  console.log(`Relevant (score >= ${MIN_RELEVANCE}): ${relevant.length}`);

  // Сохраняем ВСЕ результаты в Sheets (включая низко-релевантные)
  if (!DRY_RUN && scored.length > 0) {
    await saveToSheets(scored);
  } else if (DRY_RUN && scored.length > 0) {
    console.log(`[DRY RUN] Would save ${scored.length} signals to Sheets`);
  }

  // Отправляем в Telegram только значимые сигналы
  if (!DRY_RUN && relevant.length > 0) {
    const message = formatTelegramMessage(radar.name, relevant);
    try {
      let result;
      if (sendThrottled) {
        result = await sendThrottled(message, {
          thread: TG_THREAD_ID,
          silent: true,
          priority: "low",
          parseMode: "HTML",
        });
      } else {
        result = await sendReport(message, TG_THREAD_ID, "HTML");
      }
      if (result.ok) {
        console.log(`[Telegram] Sent ${Math.min(relevant.length, MAX_SIGNALS_PER_RADAR)} signals`);
      } else {
        console.error(`[Telegram] Send failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[Telegram] Error: ${err.message}`);
    }
  } else if (DRY_RUN && relevant.length > 0) {
    const message = formatTelegramMessage(radar.name, relevant);
    console.log(`[DRY RUN] Would send to Telegram:\n${message.replace(/<[^>]+>/g, "")}`);
  } else if (relevant.length === 0) {
    console.log(`No relevant signals for ${radar.name}`);
  }

  // Добавляем URL в seenUrls для дедупликации между потоками
  for (const s of scored) {
    seenUrls.add(s.url);
  }

  return {
    total: totalFound,
    new: newResults.length,
    relevant: relevant.length,
    saved: scored.length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const streamArg = args[0] || "all";

  const validStreams = Object.keys(RADARS);
  const streamsToRun = streamArg === "all" ? validStreams : [streamArg];

  // Валидация аргументов
  for (const s of streamsToRun) {
    if (!RADARS[s]) {
      console.error(`Unknown stream: "${s}". Valid: ${validStreams.join(", ")}, all`);
      process.exit(1);
    }
  }

  console.log(
    `[${new Date().toISOString()}] Trend Radar starting...` + `${DRY_RUN ? " (DRY RUN)" : ""}`,
  );
  console.log(`Streams: ${streamsToRun.join(", ")}`);

  // Загружаем уже виденные URL
  const seenUrls = await loadSeenUrls();

  // Обрабатываем потоки последовательно (чтобы не перегружать источники)
  const stats = {};
  let totalRelevant = 0;
  let totalSaved = 0;

  for (const streamId of streamsToRun) {
    try {
      const result = await processStream(streamId, seenUrls);
      stats[streamId] = result;
      totalRelevant += result.relevant;
      totalSaved += result.saved;
    } catch (err) {
      console.error(`[ERROR] Stream "${streamId}" failed: ${err.message}`);
      stats[streamId] = { total: 0, new: 0, relevant: 0, saved: 0, error: err.message };
    }
  }

  // Итоговая сводка
  const durationMs = Date.now() - startMs;
  console.log(`\n=== Trend Radar Summary ===`);
  for (const [stream, s] of Object.entries(stats)) {
    console.log(
      `  ${stream}: ${s.total} found, ${s.new} new, ${s.relevant} relevant, ${s.saved} saved` +
        (s.error ? ` [ERROR: ${s.error}]` : ""),
    );
  }
  console.log(`Total: ${totalRelevant} relevant, ${totalSaved} saved`);
  console.log(`Done in ${durationMs}ms`);

  // Langfuse trace
  await trace({
    name: "trend-radar",
    input: { streams: streamsToRun, dry_run: DRY_RUN },
    output: stats,
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", cron: "trend-radar" },
  }).catch(() => {});
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
