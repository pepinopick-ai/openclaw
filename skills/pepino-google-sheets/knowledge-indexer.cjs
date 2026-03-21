#!/usr/bin/env node
/**
 * Pepino Pick — Knowledge Indexer
 *
 * Строит поисковый индекс из Obsidian vault и memory-файлов.
 * Лёгкая реализация без внешних зависимостей: JSON-хранилище + TF-IDF скоринг.
 *
 * Источники:
 *   - ~/.openclaw/workspace/memory/knowledge/ (продукты, правила, поставщики, клиенты)
 *   - ~/.openclaw/workspace/memory/people/clients/*.json
 *   - ~/.openclaw/workspace/memory/episodes/*.md
 *   - ~/.openclaw/workspace/memory/procedures/*.md
 *   - /home/roman/openclaw/skills/pepino-core/*.md (governance docs)
 *   - ~/.openclaw/workspace/memory/*.md (daily notes)
 *
 * Хранилище: ~/.openclaw/workspace/memory/knowledge-index.json
 *
 * Cron: 0 4 * * * (ежедневно 04:00)
 * Usage:
 *   node knowledge-indexer.cjs index [--dry-run]
 *   node knowledge-indexer.cjs sync  [--dry-run]
 *   node knowledge-indexer.cjs search "запрос" [--domain agronomy] [--limit 5]
 *   node knowledge-indexer.cjs stats
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Пути ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/home/roman";
const WORKSPACE = path.join(HOME, ".openclaw", "workspace");
const INDEX_PATH = path.join(WORKSPACE, "memory", "knowledge-index.json");
const PEPINO_CORE = path.join(HOME, "openclaw", "skills", "pepino-core");

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Директории для индексации.
 * Каждая запись: { dir, extensions, domain, recursive }
 * @type {Array<{dir: string, extensions: string[], domain: string, docType: string, recursive: boolean}>}
 */
const SOURCES = [
  {
    dir: path.join(WORKSPACE, "memory", "knowledge", "products"),
    extensions: [".json", ".md"],
    domain: "agronomy",
    docType: "product",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "knowledge", "rules"),
    extensions: [".json", ".md"],
    domain: "sop",
    docType: "rule",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "knowledge", "suppliers"),
    extensions: [".json", ".md"],
    domain: "procurement",
    docType: "supplier",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "knowledge", "clients"),
    extensions: [".json", ".md"],
    domain: "sales",
    docType: "client_knowledge",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "people", "clients"),
    extensions: [".json"],
    domain: "sales",
    docType: "client_profile",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "episodes"),
    extensions: [".md", ".json"],
    domain: "episodes",
    docType: "episode",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory", "procedures"),
    extensions: [".md", ".json"],
    domain: "sop",
    docType: "procedure",
    recursive: false,
  },
  {
    dir: PEPINO_CORE,
    extensions: [".md"],
    domain: "governance",
    docType: "governance",
    recursive: false,
  },
  {
    dir: path.join(WORKSPACE, "memory"),
    extensions: [".md"],
    domain: "daily_notes",
    docType: "daily_note",
    recursive: false, // только верхний уровень — daily notes
  },
];

// ── Утилиты ─────────────────────────────────────────────────────────────────

/**
 * Вычисляет SHA-256 хеш содержимого файла.
 * @param {string} content
 * @returns {string}
 */
function contentHash(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Безопасно читает JSON-файл, возвращает null при ошибке.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Рекурсивно или плоско собирает файлы из директории.
 * @param {string} dir
 * @param {string[]} extensions
 * @param {boolean} recursive
 * @returns {string[]}
 */
function listFiles(dir, extensions, recursive) {
  if (!fs.existsSync(dir)) return [];

  /** @type {string[]} */
  const results = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      } else if (entry.isDirectory() && recursive) {
        results.push(...listFiles(fullPath, extensions, true));
      }
    }
  } catch {
    // Директория недоступна — пропускаем
  }

  return results;
}

// ── Парсинг документов ──────────────────────────────────────────────────────

/**
 * Извлекает заголовок из Markdown (первый # заголовок) или из имени файла.
 * @param {string} content
 * @param {string} filePath
 * @returns {string}
 */
function extractTitle(content, filePath) {
  const match = content.match(/^#{1,3}\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, " ");
}

/**
 * Разбивает Markdown на чанки по заголовкам (## или ###).
 * Если заголовков нет — возвращает весь контент как один чанк.
 * @param {string} content
 * @returns {Array<{heading: string, content: string}>}
 */
function splitMarkdownChunks(content) {
  const lines = content.split("\n");
  /** @type {Array<{heading: string, content: string}>} */
  const chunks = [];
  let currentHeading = "(intro)";
  /** @type {string[]} */
  let currentLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      // Сохраняем предыдущий чанк
      const text = currentLines.join("\n").trim();
      if (text.length > 0) {
        chunks.push({ heading: currentHeading, content: text });
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Последний чанк
  const text = currentLines.join("\n").trim();
  if (text.length > 0) {
    chunks.push({ heading: currentHeading, content: text });
  }

  // Если ничего не нашли — один чанк из всего контента
  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({ heading: "(full)", content: content.trim() });
  }

  return chunks;
}

/**
 * Разбивает JSON-документ на чанки по ключам верхнего уровня.
 * @param {object} data
 * @returns {Array<{heading: string, content: string}>}
 */
function splitJsonChunks(data) {
  /** @type {Array<{heading: string, content: string}>} */
  const chunks = [];

  for (const [key, value] of Object.entries(data)) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (text.length > 0) {
      chunks.push({ heading: key, content: text });
    }
  }

  if (chunks.length === 0) {
    chunks.push({ heading: "(full)", content: JSON.stringify(data, null, 2) });
  }

  return chunks;
}

/**
 * Примерный подсчёт токенов (слова / 0.75).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length / 0.75);
}

/**
 * Индексирует один файл.
 * @param {string} filePath
 * @param {string} domain
 * @param {string} docType
 * @returns {{filepath: string, title: string, domain: string, document_type: string, chunks: Array<{heading: string, content: string, tokens: number}>, hash: string, indexed_at: string} | null}
 */
function indexFile(filePath, domain, docType) {
  let rawContent;
  try {
    rawContent = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  if (!rawContent.trim()) return null;

  const hash = contentHash(rawContent);
  const ext = path.extname(filePath).toLowerCase();
  let title;
  /** @type {Array<{heading: string, content: string}>} */
  let rawChunks;

  if (ext === ".json") {
    const parsed = readJsonSafe(filePath);
    if (!parsed) return null;
    title = parsed.name || parsed.title || path.basename(filePath, ".json").replace(/[-_]/g, " ");
    rawChunks = splitJsonChunks(parsed);
  } else {
    title = extractTitle(rawContent, filePath);
    rawChunks = splitMarkdownChunks(rawContent);
  }

  const chunks = rawChunks.map((c) => ({
    heading: c.heading,
    content: c.content,
    tokens: estimateTokens(c.content),
  }));

  return {
    filepath: filePath,
    title,
    domain,
    document_type: docType,
    chunks,
    hash,
    indexed_at: new Date().toISOString(),
  };
}

// ── Загрузка/сохранение индекса ─────────────────────────────────────────────

/**
 * @typedef {{
 *   version: number,
 *   created_at: string,
 *   updated_at: string,
 *   documents: Array<{filepath: string, title: string, domain: string, document_type: string, chunks: Array<{heading: string, content: string, tokens: number}>, hash: string, indexed_at: string}>
 * }} KnowledgeIndex
 */

/**
 * Загружает существующий индекс или возвращает пустой.
 * @returns {KnowledgeIndex}
 */
function loadIndex() {
  const existing = readJsonSafe(INDEX_PATH);
  if (existing && existing.version === 1) return existing;
  return {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    documents: [],
  };
}

/**
 * Сохраняет индекс на диск.
 * @param {KnowledgeIndex} index
 */
function saveIndex(index) {
  index.updated_at = new Date().toISOString();
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

// ── Команды ─────────────────────────────────────────────────────────────────

/**
 * Полная переиндексация всех источников.
 */
function cmdIndex() {
  console.log("=== Pepino Knowledge Indexer — Full Index ===\n");

  /** @type {Array<{filepath: string, title: string, domain: string, document_type: string, chunks: Array<{heading: string, content: string, tokens: number}>, hash: string, indexed_at: string}>} */
  const documents = [];
  let totalFiles = 0;
  let totalChunks = 0;
  let skipped = 0;

  for (const source of SOURCES) {
    const files = listFiles(source.dir, source.extensions, source.recursive);
    for (const filePath of files) {
      totalFiles++;
      const doc = indexFile(filePath, source.domain, source.docType);
      if (doc) {
        documents.push(doc);
        totalChunks += doc.chunks.length;
      } else {
        skipped++;
      }
    }
  }

  console.log(`Файлов просканировано: ${totalFiles}`);
  console.log(`Документов проиндексировано: ${documents.length}`);
  console.log(`Чанков создано: ${totalChunks}`);
  console.log(`Пропущено (пустые/ошибки): ${skipped}`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Индекс НЕ сохранён.");
    for (const doc of documents) {
      console.log(`  ${doc.domain.padEnd(14)} ${doc.document_type.padEnd(18)} ${doc.title}`);
    }
    return;
  }

  const index = {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    documents,
  };

  saveIndex(index);
  console.log(`\nИндекс сохранён: ${INDEX_PATH}`);
}

/**
 * Инкрементальная синхронизация: обновляет только изменённые/новые файлы,
 * удаляет записи для удалённых файлов.
 */
function cmdSync() {
  console.log("=== Pepino Knowledge Indexer — Incremental Sync ===\n");

  const index = loadIndex();

  // Построим карту filepath → document для быстрого доступа
  /** @type {Map<string, number>} */
  const existingMap = new Map();
  for (let i = 0; i < index.documents.length; i++) {
    existingMap.set(index.documents[i].filepath, i);
  }

  // Собираем все актуальные файлы
  /** @type {Set<string>} */
  const currentFiles = new Set();
  /** @type {Array<{filePath: string, domain: string, docType: string}>} */
  const allSourceFiles = [];

  for (const source of SOURCES) {
    const files = listFiles(source.dir, source.extensions, source.recursive);
    for (const filePath of files) {
      currentFiles.add(filePath);
      allSourceFiles.push({ filePath, domain: source.domain, docType: source.docType });
    }
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  let unchanged = 0;

  // Проверяем каждый файл
  for (const { filePath, domain, docType } of allSourceFiles) {
    let rawContent;
    try {
      rawContent = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (!rawContent.trim()) continue;

    const hash = contentHash(rawContent);
    const existingIdx = existingMap.get(filePath);

    if (existingIdx !== undefined) {
      // Файл уже в индексе — проверяем хеш
      if (index.documents[existingIdx].hash === hash) {
        unchanged++;
        continue;
      }
      // Хеш изменился — переиндексируем
      const doc = indexFile(filePath, domain, docType);
      if (doc) {
        if (!DRY_RUN) index.documents[existingIdx] = doc;
        updated++;
        console.log(`  [UPD] ${filePath}`);
      }
    } else {
      // Новый файл
      const doc = indexFile(filePath, domain, docType);
      if (doc) {
        if (!DRY_RUN) index.documents.push(doc);
        added++;
        console.log(`  [NEW] ${filePath}`);
      }
    }
  }

  // Удаляем записи для файлов, которых больше нет
  const before = index.documents.length;
  if (!DRY_RUN) {
    index.documents = index.documents.filter((doc) => {
      if (!currentFiles.has(doc.filepath)) {
        console.log(`  [DEL] ${doc.filepath}`);
        removed++;
        return false;
      }
      return true;
    });
  } else {
    for (const doc of index.documents) {
      if (!currentFiles.has(doc.filepath)) {
        console.log(`  [DEL] ${doc.filepath} (dry-run)`);
        removed++;
      }
    }
  }

  console.log(
    `\nДобавлено: ${added}, обновлено: ${updated}, удалено: ${removed}, без изменений: ${unchanged}`,
  );

  if (DRY_RUN) {
    console.log("[DRY RUN] Индекс НЕ сохранён.");
    return;
  }

  saveIndex(index);
  console.log(`Индекс сохранён: ${INDEX_PATH}`);
}

// ── Поиск (TF-IDF-lite) ────────────────────────────────────────────────────

/**
 * Токенизирует текст: lower + split по non-word.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Вычисляет TF-IDF-подобный score для чанка по запросу.
 *
 * Формула:
 *   - TF = (количество совпадений query-токенов в чанке) / (длина чанка в токенах)
 *   - IDF-бонус: уникальные query-токены, найденные в чанке (покрытие запроса)
 *   - Бонус за совпадение в heading
 *   - Бонус за точное вхождение фразы
 *
 * @param {string} query
 * @param {{heading: string, content: string}} chunk
 * @returns {number}
 */
function scoreChunk(query, chunk) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const chunkText = (chunk.heading + " " + chunk.content).toLowerCase();
  const chunkTokens = tokenize(chunkText);

  if (chunkTokens.length === 0) return 0;

  // Количество совпадений (TF)
  const querySet = new Set(queryTokens);
  let matchCount = 0;
  let uniqueMatched = new Set();

  for (const token of chunkTokens) {
    if (querySet.has(token)) {
      matchCount++;
      uniqueMatched.add(token);
    }
  }

  if (matchCount === 0) return 0;

  // TF: нормализованная частота совпадений
  const tf = matchCount / chunkTokens.length;

  // Покрытие запроса (IDF-proxy): какая доля query-токенов найдена
  const coverage = uniqueMatched.size / queryTokens.length;

  // Бонус за совпадение в заголовке
  const headingLower = chunk.heading.toLowerCase();
  let headingBonus = 0;
  for (const qt of queryTokens) {
    if (headingLower.includes(qt)) headingBonus += 0.15;
  }

  // Бонус за точное вхождение полной фразы
  const phraseBonus = chunkText.includes(query.toLowerCase()) ? 0.4 : 0;

  return tf * 10 + coverage * 5 + headingBonus + phraseBonus;
}

/**
 * Выполняет поиск по индексу.
 */
function cmdSearch() {
  // Парсим аргументы: search "query" [--domain X] [--limit N]
  const args = process.argv.slice(3); // после "search"
  let query = "";
  let domainFilter = "";
  let limit = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domainFilter = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10) || 5;
      i++;
    } else if (!args[i].startsWith("--")) {
      query = args[i];
    }
  }

  if (!query) {
    console.error(
      'Использование: node knowledge-indexer.cjs search "запрос" [--domain X] [--limit N]',
    );
    process.exit(1);
  }

  const index = loadIndex();
  if (index.documents.length === 0) {
    console.error("Индекс пуст. Сначала выполните: node knowledge-indexer.cjs index");
    process.exit(1);
  }

  /** @type {Array<{filepath: string, title: string, domain: string, heading: string, snippet: string, score: number}>} */
  const results = [];

  for (const doc of index.documents) {
    if (domainFilter && doc.domain !== domainFilter) continue;

    for (const chunk of doc.chunks) {
      const score = scoreChunk(query, chunk);
      if (score > 0) {
        results.push({
          filepath: doc.filepath,
          title: doc.title,
          domain: doc.domain,
          heading: chunk.heading,
          snippet: chunk.content.slice(0, 200).replace(/\n/g, " "),
          score: Math.round(score * 1000) / 1000,
        });
      }
    }
  }

  // Сортируем по score (desc) и берём top N
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  if (topResults.length === 0) {
    console.log(
      `Нет результатов по запросу: "${query}"${domainFilter ? ` (домен: ${domainFilter})` : ""}`,
    );
    return;
  }

  console.log(`\n=== Результаты поиска: "${query}" ===`);
  if (domainFilter) console.log(`Фильтр домена: ${domainFilter}`);
  console.log(`Найдено совпадений: ${results.length}, показано: ${topResults.length}\n`);

  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i];
    console.log(`${i + 1}. [${r.score}] ${r.domain}/${r.title}`);
    console.log(`   Раздел: ${r.heading}`);
    console.log(`   ${r.snippet}`);
    console.log(`   Файл: ${r.filepath}`);
    console.log();
  }
}

/**
 * Выводит статистику по индексу.
 */
function cmdStats() {
  const index = loadIndex();

  if (index.documents.length === 0) {
    console.log("Индекс пуст. Выполните: node knowledge-indexer.cjs index");
    return;
  }

  const totalDocs = index.documents.length;
  const totalChunks = index.documents.reduce((sum, d) => sum + d.chunks.length, 0);
  const totalTokens = index.documents.reduce(
    (sum, d) => sum + d.chunks.reduce((cs, c) => cs + c.tokens, 0),
    0,
  );

  // По доменам
  /** @type {Record<string, {docs: number, chunks: number, tokens: number}>} */
  const byDomain = {};
  for (const doc of index.documents) {
    if (!byDomain[doc.domain]) byDomain[doc.domain] = { docs: 0, chunks: 0, tokens: 0 };
    byDomain[doc.domain].docs++;
    byDomain[doc.domain].chunks += doc.chunks.length;
    byDomain[doc.domain].tokens += doc.chunks.reduce((s, c) => s + c.tokens, 0);
  }

  // Устаревшие документы (>30 дней)
  const now = Date.now();
  const STALE_MS = 30 * 24 * 60 * 60 * 1000;
  const staleDocs = index.documents.filter((d) => {
    const indexedAt = new Date(d.indexed_at).getTime();
    return now - indexedAt > STALE_MS;
  });

  console.log("=== Pepino Knowledge Index — Stats ===\n");
  console.log(`Создан:       ${index.created_at}`);
  console.log(`Обновлён:     ${index.updated_at}`);
  console.log(`Документов:   ${totalDocs}`);
  console.log(`Чанков:       ${totalChunks}`);
  console.log(`Токенов (~):  ${totalTokens}`);
  console.log();

  console.log("По доменам:");
  console.log(
    "  " + "Домен".padEnd(16) + "Документов".padEnd(12) + "Чанков".padEnd(10) + "Токенов",
  );
  console.log("  " + "-".repeat(48));
  for (const [domain, stats] of Object.entries(byDomain).sort((a, b) => b[1].docs - a[1].docs)) {
    console.log(
      "  " +
        domain.padEnd(16) +
        String(stats.docs).padEnd(12) +
        String(stats.chunks).padEnd(10) +
        String(stats.tokens),
    );
  }

  if (staleDocs.length > 0) {
    console.log(`\nУстаревшие (>30 дней): ${staleDocs.length}`);
    for (const doc of staleDocs.slice(0, 10)) {
      console.log(`  ${doc.indexed_at.slice(0, 10)} ${doc.domain.padEnd(14)} ${doc.title}`);
    }
    if (staleDocs.length > 10) {
      console.log(`  ... и ещё ${staleDocs.length - 10}`);
    }
  } else {
    console.log("\nУстаревших документов нет.");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const command = process.argv[2];

  switch (command) {
    case "index":
      cmdIndex();
      break;
    case "sync":
      cmdSync();
      break;
    case "search":
      cmdSearch();
      break;
    case "stats":
      cmdStats();
      break;
    default:
      console.log("Pepino Pick — Knowledge Indexer");
      console.log();
      console.log("Команды:");
      console.log("  index  [--dry-run]                         Полная переиндексация");
      console.log("  sync   [--dry-run]                         Инкрементальная синхронизация");
      console.log('  search "запрос" [--domain X] [--limit N]   Поиск по индексу');
      console.log("  stats                                      Статистика индекса");
      console.log();
      console.log("Домены: agronomy, sop, sales, procurement, episodes, governance, daily_notes");
      process.exit(command ? 1 : 0);
  }
}

main();
