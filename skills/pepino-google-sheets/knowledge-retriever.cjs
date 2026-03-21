#!/usr/bin/env node
/**
 * knowledge-retriever.cjs -- Поиск по индексу доменных знаний Pepino Pick
 *
 * Читает индекс, построенный knowledge-indexer.cjs, и выполняет
 * мультифакторный поиск с фильтрацией по домену и роли агента.
 *
 * Использование:
 *   node knowledge-retriever.cjs "query text" [options]
 *
 * Опции:
 *   --domain <name>   Фильтр по домену (agronomy|finance|sales|procurement|legal|risk|sop|governance)
 *   --agent <name>    Автовыбор доменов по роли агента
 *   --limit <n>       Максимум результатов (по умолчанию 5)
 *   --format <type>   Формат вывода: text (по умолчанию), json, compact
 *   --context         Включить окружающий контекст из исходного файла
 *
 * Экспортирует функцию search() для использования другими скриптами:
 *   const { search } = require("./knowledge-retriever.cjs");
 *   const results = search("pricing minimum margin", { domain: "finance", limit: 3 });
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// -- Конфигурация -----------------------------------------------------------

const INDEX_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "knowledge-index.json",
);

/** Максимальный возраст индекса (мс) до предупреждения */
const MAX_INDEX_AGE_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LIMIT = 5;

/** Допустимые домены */
const VALID_DOMAINS = new Set([
  "agronomy",
  "finance",
  "sales",
  "procurement",
  "legal",
  "risk",
  "sop",
  "governance",
]);

/** Маппинг ролей агентов на домены */
const AGENT_DOMAIN_MAP = {
  agronomist: ["agronomy", "sop"],
  finance: ["finance", "sop"],
  sales: ["sales", "sop"],
  procurement: ["procurement", "sop", "finance"],
  director: [...VALID_DOMAINS],
  dev: ["governance", "sop"],
};

// -- Стоп-слова (русский + испанский) ----------------------------------------

const STOPWORDS = new Set([
  // Русские
  "и",
  "в",
  "на",
  "с",
  "по",
  "для",
  "не",
  "из",
  "от",
  "за",
  "к",
  "до",
  "что",
  "как",
  "это",
  "все",
  "при",
  "так",
  "его",
  "но",
  "то",
  "а",
  "о",
  "же",
  "бы",
  "ли",
  "ещё",
  "еще",
  "уже",
  "да",
  "нет",
  "или",
  "он",
  "она",
  "они",
  "мы",
  "вы",
  "их",
  "ее",
  "её",
  "мне",
  "нас",
  "был",
  "была",
  "были",
  "быть",
  "будет",
  "есть",
  "этот",
  "эта",
  "эти",
  "тот",
  "та",
  "те",
  "который",
  "которая",
  "которые",
  "очень",
  "только",
  "тоже",
  "более",
  "нужно",
  "можно",
  // Испанские
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "en",
  "un",
  "una",
  "unos",
  "unas",
  "y",
  "o",
  "que",
  "es",
  "se",
  "no",
  "por",
  "con",
  "para",
  "al",
  "lo",
  "le",
  "me",
  "te",
  "su",
  "nos",
  "son",
  "si",
  "como",
  "pero",
  "mas",
  "fue",
  "ser",
  "ha",
  "muy",
  "ya",
  "todo",
  "esta",
  "hay",
  "sin",
  "sobre",
  "entre",
  "cuando",
  "donde",
  "cual",
]);

// -- Утилиты -----------------------------------------------------------------

/**
 * Извлекает ключевые слова из запроса, удаляя стоп-слова.
 * @param {string} query
 * @returns {string[]}
 */
function extractKeywords(query) {
  const words = query
    .toLowerCase()
    .replace(/[.,;:!?(){}[\]"'`]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

  // Убираем дубликаты, сохраняя порядок
  return [...new Set(words)];
}

/**
 * Загружает и валидирует индекс знаний.
 * @returns {{ chunks: Object[], meta: Object, stale: boolean } | { error: string }}
 */
function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    return {
      error: `Индекс не найден: ${INDEX_PATH}\n` + "Запустите: node knowledge-indexer.cjs",
    };
  }

  /** @type {fs.Stats} */
  let stat;
  try {
    stat = fs.statSync(INDEX_PATH);
  } catch (err) {
    return { error: `Не удалось прочитать индекс: ${err.message}` };
  }

  const ageMs = Date.now() - stat.mtimeMs;
  const stale = ageMs > MAX_INDEX_AGE_MS;

  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(INDEX_PATH, "utf-8");
  } catch (err) {
    return { error: `Ошибка чтения индекса: ${err.message}` };
  }

  /** @type {any} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { error: `Битый JSON в индексе: ${err.message}` };
  }

  // Поддерживаем два формата: массив чанков напрямую или объект с полем chunks
  /** @type {Object[]} */
  let chunks;
  /** @type {Object} */
  let meta = {};

  if (Array.isArray(data)) {
    chunks = data;
  } else if (data && Array.isArray(data.chunks)) {
    chunks = data.chunks;
    meta = data.meta || {};
  } else if (data && Array.isArray(data.documents)) {
    // Format from knowledge-indexer: documents[].chunks[]
    chunks = [];
    for (const doc of data.documents) {
      if (!doc.chunks) continue;
      for (const chunk of doc.chunks) {
        chunks.push({
          ...chunk,
          filepath: doc.filepath,
          domain: doc.domain,
          document_type: doc.document_type,
          title: doc.title,
          indexed_at: doc.indexed_at,
        });
      }
    }
    meta = { version: data.version, created_at: data.created_at, updated_at: data.updated_at };
  } else {
    return { error: "Неверная структура индекса: ожидается массив, объект с chunks или documents" };
  }

  return { chunks, meta, stale };
}

/**
 * Читает контекст вокруг чанка из исходного файла.
 * @param {Object} chunk - чанк из индекса
 * @param {number} [contextLines=3] - количество строк контекста
 * @returns {string|null}
 */
function readSourceContext(chunk, contextLines = 3) {
  // Восстанавливаем абсолютный путь
  const filePath = (chunk.file || chunk.source_file || "").replace(/^~/, os.homedir());

  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Ищем начало чанка по его тексту (первые 80 символов)
    const snippetStart = (chunk.text || chunk.content || "").substring(0, 80).trim();
    if (!snippetStart) return null;

    let matchLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(snippetStart.substring(0, 40))) {
        matchLine = i;
        break;
      }
    }

    if (matchLine === -1) return null;

    const start = Math.max(0, matchLine - contextLines);
    const end = Math.min(lines.length, matchLine + contextLines + 1);
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}

// -- Скоринг -----------------------------------------------------------------

/**
 * Вычисляет релевантность чанка относительно запроса.
 * @param {Object} chunk - чанк из индекса
 * @param {string} queryLower - исходный запрос в нижнем регистре
 * @param {string[]} keywords - извлечённые ключевые слова
 * @returns {number} - итоговый балл
 */
function scoreChunk(chunk, queryLower, keywords) {
  if (keywords.length === 0) return 0;

  // Собираем весь текст чанка для поиска
  const chunkText = [
    chunk.text || "",
    chunk.content || "",
    chunk.heading || chunk.title || "",
    chunk.domain || "",
    chunk.tags ? (Array.isArray(chunk.tags) ? chunk.tags.join(" ") : String(chunk.tags)) : "",
  ]
    .join(" ")
    .toLowerCase();

  if (!chunkText.trim()) return 0;

  let score = 0;

  // 1. Точное совпадение фразы: 10 баллов
  if (chunkText.includes(queryLower)) {
    score += 10;
  }

  // 2. Все ключевые слова присутствуют: 5 баллов за каждое
  let allPresent = true;
  let presentCount = 0;
  for (const kw of keywords) {
    if (chunkText.includes(kw)) {
      presentCount++;
    } else {
      allPresent = false;
    }
  }

  if (allPresent && keywords.length > 1) {
    score += keywords.length * 5;
  } else {
    // 3. Частичное совпадение: 2 балла за каждое найденное слово
    score += presentCount * 2;
  }

  // 4. Совпадение в заголовке -- дополнительный бонус
  const heading = (chunk.heading || chunk.title || "").toLowerCase();
  for (const kw of keywords) {
    if (heading.includes(kw)) {
      score += 3;
    }
  }

  // 5. Бонус за свежесть: +1 если обновлено менее 7 дней назад
  const updatedAt = chunk.updated_at || chunk.date || chunk.indexed_at || "";
  if (updatedAt) {
    try {
      const updateDate = new Date(updatedAt);
      const daysSinceUpdate = (Date.now() - updateDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 7) {
        score += 1;
      }
    } catch {
      // Игнорируем ошибки парсинга даты
    }
  }

  return score;
}

// -- Основная функция поиска -------------------------------------------------

/**
 * Ищет по индексу знаний.
 *
 * @param {string} query - поисковый запрос
 * @param {Object} [options] - параметры поиска
 * @param {string} [options.domain] - фильтр по домену
 * @param {string} [options.agent] - роль агента для автовыбора доменов
 * @param {number} [options.limit] - максимум результатов
 * @param {boolean} [options.includeContext] - включить контекст из файла
 * @returns {{ results: Object[], query: string, keywords: string[], total_matched: number, stale: boolean, warning?: string }}
 */
function search(query, options = {}) {
  const { domain = null, agent = null, limit = DEFAULT_LIMIT, includeContext = false } = options;

  // Загружаем индекс
  const indexResult = loadIndex();
  if ("error" in indexResult) {
    return {
      results: [],
      query,
      keywords: [],
      total_matched: 0,
      stale: false,
      warning: indexResult.error,
    };
  }

  const { chunks, stale } = indexResult;

  // Определяем допустимые домены
  /** @type {Set<string>|null} */
  let allowedDomains = null;

  if (agent) {
    const agentKey = agent.toLowerCase();
    const agentDomains = AGENT_DOMAIN_MAP[agentKey];
    if (agentDomains) {
      allowedDomains = new Set(agentDomains);
    } else {
      // Неизвестный агент -- ищем по всем доменам, но предупреждаем
    }
  }

  if (domain) {
    const domainKey = domain.toLowerCase();
    if (VALID_DOMAINS.has(domainKey)) {
      // Если задан и --agent, и --domain, --domain сужает выборку
      if (allowedDomains) {
        allowedDomains = new Set([...allowedDomains].filter((d) => d === domainKey));
        if (allowedDomains.size === 0) {
          allowedDomains = new Set([domainKey]);
        }
      } else {
        allowedDomains = new Set([domainKey]);
      }
    }
  }

  // Извлекаем ключевые слова
  const keywords = extractKeywords(query);
  const queryLower = query.toLowerCase().trim();

  if (keywords.length === 0) {
    return {
      results: [],
      query,
      keywords: [],
      total_matched: 0,
      stale,
      warning: "Не удалось извлечь ключевые слова из запроса",
    };
  }

  // Скорим и фильтруем чанки
  /** @type {{ chunk: Object, score: number }[]} */
  const scored = [];

  for (const chunk of chunks) {
    // Фильтр по домену
    if (allowedDomains) {
      const chunkDomain = (chunk.domain || "").toLowerCase();
      if (chunkDomain && !allowedDomains.has(chunkDomain)) continue;
    }

    let score = scoreChunk(chunk, queryLower, keywords);

    // Бонус за совпадение домена с запрошенным
    if (allowedDomains && chunk.domain) {
      const chunkDomain = chunk.domain.toLowerCase();
      if (allowedDomains.has(chunkDomain)) {
        score += 3;
      }
    }

    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  // Сортируем по убыванию score
  scored.sort((a, b) => b.score - a.score);

  // Ограничиваем результаты
  const topScored = scored.slice(0, Math.max(1, Math.min(limit, 50)));

  // Формируем результаты
  const results = topScored.map((item) => {
    /** @type {Object} */
    const result = {
      score: item.score,
      domain: item.chunk.domain || "unknown",
      file: item.chunk.file || item.chunk.source_file || "unknown",
      heading: item.chunk.heading || item.chunk.title || "",
      snippet: (item.chunk.text || item.chunk.content || "").substring(0, 300),
    };

    if (includeContext) {
      const ctx = readSourceContext(item.chunk);
      if (ctx) {
        result.context = ctx;
      }
    }

    return result;
  });

  /** @type {string|undefined} */
  let warning;
  if (stale) {
    warning = "Индекс устарел (>24ч). Рекомендуется запустить: node knowledge-indexer.cjs";
  }

  return {
    results,
    query,
    keywords,
    total_matched: scored.length,
    stale,
    ...(warning ? { warning } : {}),
  };
}

// -- Форматирование вывода ---------------------------------------------------

/**
 * Форматирует результаты в текстовый вид (по умолчанию).
 * @param {{ results: Object[], query: string, keywords: string[], total_matched: number, stale: boolean, warning?: string }} data
 * @returns {string}
 */
function formatText(data) {
  /** @type {string[]} */
  const lines = [];

  if (data.warning) {
    lines.push(`WARNING: ${data.warning}`);
    lines.push("");
  }

  lines.push(`Query: "${data.query}"`);
  lines.push(`Keywords: ${data.keywords.join(", ")}`);
  lines.push(`Found: ${data.total_matched} matches, showing ${data.results.length}`);
  if (data.stale) {
    lines.push("Index status: STALE (>24h old)");
  }
  lines.push("");

  if (data.results.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    lines.push(`[${i + 1}] (score: ${r.score}) domain: ${r.domain} | file: ${r.file}`);
    if (r.heading) {
      lines.push(`Heading: ${r.heading}`);
    }
    lines.push(`Snippet: ${r.snippet}`);
    if (r.context) {
      lines.push("Context:");
      lines.push(r.context);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Форматирует результаты в компактный вид (одна строка на результат).
 * @param {{ results: Object[], query: string, keywords: string[], total_matched: number }} data
 * @returns {string}
 */
function formatCompact(data) {
  if (data.results.length === 0) return "No results.";

  return data.results
    .map(
      (r, i) =>
        `[${i + 1}] s:${r.score} d:${r.domain} | ${r.heading || path.basename(r.file)} | ${r.snippet.substring(0, 80)}...`,
    )
    .join("\n");
}

// -- CLI ---------------------------------------------------------------------

/**
 * Парсит аргументы командной строки.
 * @param {string[]} argv
 * @returns {{ query: string, domain: string|null, agent: string|null, limit: number, format: string, includeContext: boolean } | { error: string }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  /** @type {string|null} */
  let domain = null;
  /** @type {string|null} */
  let agent = null;
  let limit = DEFAULT_LIMIT;
  let format = "text";
  let includeContext = false;

  /** @type {string[]} */
  const queryParts = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--domain" && i + 1 < args.length) {
      domain = args[i + 1];
      if (!VALID_DOMAINS.has(domain.toLowerCase())) {
        return {
          error: `Неизвестный домен: ${domain}. Допустимые: ${[...VALID_DOMAINS].join(", ")}`,
        };
      }
      i += 2;
    } else if (arg === "--agent" && i + 1 < args.length) {
      agent = args[i + 1];
      const agentKey = agent.toLowerCase();
      if (!AGENT_DOMAIN_MAP[agentKey]) {
        return {
          error: `Неизвестный агент: ${agent}. Допустимые: ${Object.keys(AGENT_DOMAIN_MAP).join(", ")}`,
        };
      }
      i += 2;
    } else if (arg === "--limit" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed < 1) {
        return { error: `Невалидный --limit: ${args[i + 1]}` };
      }
      limit = Math.min(parsed, 50);
      i += 2;
    } else if (arg === "--format" && i + 1 < args.length) {
      format = args[i + 1].toLowerCase();
      if (!["text", "json", "compact"].includes(format)) {
        return { error: `Неизвестный формат: ${format}. Допустимые: text, json, compact` };
      }
      i += 2;
    } else if (arg === "--context") {
      includeContext = true;
      i += 1;
    } else if (arg.startsWith("--")) {
      return { error: `Неизвестная опция: ${arg}` };
    } else {
      queryParts.push(arg);
      i += 1;
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    return {
      error: [
        'Usage: node knowledge-retriever.cjs "query text" [options]',
        "",
        "Options:",
        "  --domain <name>   Filter by domain (agronomy|finance|sales|procurement|legal|risk|sop|governance)",
        "  --agent <name>    Auto-select domains by agent role (agronomist|finance|sales|procurement|director|dev)",
        "  --limit <n>       Max results (default: 5)",
        "  --format <type>   Output format: text (default), json, compact",
        "  --context         Include surrounding context from source file",
      ].join("\n"),
    };
  }

  return { query, domain, agent, limit, format, includeContext };
}

/**
 * Точка входа CLI.
 */
function main() {
  const parsed = parseArgs(process.argv);

  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }

  const { query, domain, agent, limit, format, includeContext } = parsed;

  const result = search(query, { domain, agent, limit, includeContext });

  switch (format) {
    case "json":
      console.log(JSON.stringify(result, null, 2));
      break;
    case "compact":
      if (result.warning) {
        console.error(`WARNING: ${result.warning}`);
      }
      console.log(formatCompact(result));
      break;
    case "text":
    default:
      console.log(formatText(result));
      break;
  }

  // Код выхода 0 даже при пустых результатах (это не ошибка)
  process.exit(0);
}

// -- Экспорт для использования другими скриптами -----------------------------

module.exports = { search, extractKeywords, loadIndex };

// Запуск CLI только при прямом вызове
if (require.main === module) {
  main();
}
