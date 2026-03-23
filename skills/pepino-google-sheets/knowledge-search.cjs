/**
 * knowledge-search.cjs — Полнотекстовый поиск по всем репозиториям знаний Pepino Pick
 *
 * Источники:
 *   1. pepino-graph  — сущности, связи, инсайты, решения, источники, СОПы
 *   2. pepino-obsidian — decision memos, SOPs, lessons, postmortems, research
 *   3. Google Sheets (localhost:4000) — операционные данные (опционально)
 *
 * Использование:
 *   node knowledge-search.cjs "вешенка margin"
 *   node knowledge-search.cjs "поставщик субстрата" --include-sheets
 *
 * Вывод: JSON массив до 10 результатов, отсортированных по релевантности
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { apiHeaders } = require("./api-auth.cjs");

// ── Конфигурация путей ──────────────────────────────────────────────────────

const SOURCES = {
  "pepino-graph": {
    basePath: path.join(
      process.env.HOME || "/home/roman",
      ".openclaw/workspace/memory/pepino-graph"
    ),
    label: "pepino-graph",
  },
  "pepino-obsidian": {
    basePath: path.join(process.env.HOME || "/home/roman", "pepino-obsidian"),
    label: "pepino-obsidian",
  },
};

const SHEETS_API_URL = "http://localhost:4000";
const MAX_RESULTS = 10;
const CONTEXT_LINES = 2; // Строки контекста вокруг совпадения

// ── Утилиты ──────────────────────────────────────────────────────────────────

/**
 * Извлекает title из YAML frontmatter файла
 * @param {string} content - содержимое файла
 * @returns {string|null}
 */
function extractTitle(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const titleMatch = fmMatch[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return titleMatch ? titleMatch[1] : null;
}

/**
 * Извлекает тип заметки из frontmatter
 * @param {string} content
 * @returns {string|null}
 */
function extractType(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const typeMatch = fmMatch[1].match(/^type:\s*(.+?)\s*$/m);
  return typeMatch ? typeMatch[1] : null;
}

/**
 * Извлекает заголовок из markdown (первый # заголовок)
 * @param {string} content
 * @returns {string|null}
 */
function extractMarkdownTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1] : null;
}

/**
 * Рекурсивно собирает все .md файлы из директории
 * @param {string} dirPath
 * @param {string[]} result
 * @returns {string[]}
 */
function collectMarkdownFiles(dirPath, result = []) {
  if (!fs.existsSync(dirPath)) return result;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    // Пропускаем скрытые директории (.obsidian, .git и т.д.)
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(fullPath);
    }
  }

  return result;
}

/**
 * Ищет ключевые слова в файле и возвращает результат с контекстом
 * @param {string} filePath
 * @param {string[]} keywords - массив ключевых слов (lowercase)
 * @param {string} sourceLabel
 * @returns {Object|null} - результат поиска или null
 */
function searchFile(filePath, keywords, sourceLabel) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const contentLower = content.toLowerCase();
  const lines = content.split("\n");

  // Считаем совпадения по каждому ключевому слову
  let totalHits = 0;
  /** @type {Set<number>} */
  const matchingLineIndices = new Set();

  for (const kw of keywords) {
    // Считаем количество вхождений ключевого слова
    let idx = 0;
    let kwHits = 0;
    while (true) {
      idx = contentLower.indexOf(kw, idx);
      if (idx === -1) break;
      kwHits++;
      idx += kw.length;
    }
    totalHits += kwHits;

    // Находим строки с совпадениями
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(kw)) {
        matchingLineIndices.add(i);
      }
    }
  }

  if (totalHits === 0) return null;

  // Бонус за совпадение в заголовке/имени файла
  const fileName = path.basename(filePath, ".md").toLowerCase();
  let titleBonus = 0;
  for (const kw of keywords) {
    if (fileName.includes(kw)) titleBonus += 3;
  }

  // Формируем сниппет: первая совпавшая строка + контекст
  const sortedIndices = [...matchingLineIndices].sort((a, b) => a - b);
  const snippetLines = [];
  if (sortedIndices.length > 0) {
    const firstMatchIdx = sortedIndices[0];
    const start = Math.max(0, firstMatchIdx - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, firstMatchIdx + CONTEXT_LINES);
    for (let i = start; i <= end; i++) {
      const trimmed = lines[i].trim();
      if (trimmed) snippetLines.push(trimmed);
    }
  }

  // Определяем заголовок
  const title =
    extractTitle(content) || extractMarkdownTitle(content) || path.basename(filePath, ".md");

  // Определяем тип заметки
  const noteType = extractType(content) || inferTypeFromPath(filePath);

  // Относительный путь для читаемости
  const relativePath = filePath
    .replace(process.env.HOME || "/home/roman", "~")
    .replace(/\/+/g, "/");

  return {
    file: relativePath,
    title: title,
    type: noteType,
    source: sourceLabel,
    relevance: totalHits + titleBonus,
    snippet: snippetLines.join(" | ").substring(0, 300),
    keywords_matched: keywords.filter((kw) => contentLower.includes(kw)),
  };
}

/**
 * Определяет тип заметки по пути к файлу
 * @param {string} filePath
 * @returns {string}
 */
function inferTypeFromPath(filePath) {
  const pathLower = filePath.toLowerCase();
  if (pathLower.includes("decision")) return "decision";
  if (pathLower.includes("sop")) return "sop";
  if (pathLower.includes("lesson")) return "lesson";
  if (pathLower.includes("postmortem")) return "postmortem";
  if (pathLower.includes("insight")) return "insight";
  if (pathLower.includes("entities") || pathLower.includes("entity")) return "entity";
  if (pathLower.includes("relations")) return "relation";
  if (pathLower.includes("source")) return "source";
  if (pathLower.includes("market_intel") || pathLower.includes("research")) return "research";
  if (pathLower.includes("playbook")) return "playbook";
  if (pathLower.includes("training")) return "training";
  if (pathLower.includes("project")) return "project";
  if (pathLower.includes("report")) return "report";
  return "note";
}

/**
 * Запрашивает операционные данные из Sheets API (листы "Решения", "Кейсы")
 * @param {string[]} keywords
 * @returns {Promise<Object[]>}
 */
async function searchSheets(keywords) {
  const results = [];
  const endpoints = [
    { path: "/kpi", label: "KPI" },
    { path: "/alerts", label: "Alerts" },
    { path: "/sales", label: "Sales" },
  ];

  for (const ep of endpoints) {
    try {
      const data = await fetchJson(`${SHEETS_API_URL}${ep.path}`);
      if (!Array.isArray(data)) continue;

      for (const row of data) {
        const rowStr = JSON.stringify(row).toLowerCase();
        let hits = 0;
        /** @type {string[]} */
        const matched = [];
        for (const kw of keywords) {
          if (rowStr.includes(kw)) {
            hits++;
            matched.push(kw);
          }
        }
        if (hits > 0) {
          // Берем первые 3 значимых поля для сниппета
          const snippetParts = Object.entries(row)
            .filter(([, v]) => v !== "" && v !== null && v !== undefined)
            .slice(0, 4)
            .map(([k, v]) => `${k}: ${v}`);

          results.push({
            file: `sheets://${ep.path}`,
            title: `${ep.label} row`,
            type: "operational_data",
            source: "google-sheets",
            relevance: hits,
            snippet: snippetParts.join(" | ").substring(0, 300),
            keywords_matched: matched,
          });
        }
      }
    } catch {
      // Sheets API недоступен — пропускаем молча
    }
  }

  return results;
}

/**
 * HTTP GET с таймаутом, возвращает распарсенный JSON
 * @param {string} url
 * @returns {Promise<any>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000, headers: apiHeaders() }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

// ── Основная логика ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const includeSheets = args.includes("--include-sheets");
  const queryArgs = args.filter((a) => !a.startsWith("--"));

  if (queryArgs.length === 0) {
    console.error(JSON.stringify({
      error: "Usage: node knowledge-search.cjs \"<search query>\" [--include-sheets]",
    }));
    process.exit(1);
  }

  const query = queryArgs.join(" ");

  // Разбиваем запрос на ключевые слова (нормализуем)
  const keywords = query
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2); // Минимум 2 символа

  if (keywords.length === 0) {
    console.error(JSON.stringify({ error: "No valid keywords extracted from query" }));
    process.exit(1);
  }

  /** @type {Object[]} */
  let allResults = [];

  // 1. Поиск по файловым источникам (pepino-graph + pepino-obsidian)
  for (const [sourceKey, sourceConfig] of Object.entries(SOURCES)) {
    const files = collectMarkdownFiles(sourceConfig.basePath);
    for (const file of files) {
      const result = searchFile(file, keywords, sourceConfig.label);
      if (result) {
        allResults.push(result);
      }
    }
  }

  // 2. Поиск по Google Sheets (опционально)
  if (includeSheets) {
    try {
      const sheetsResults = await searchSheets(keywords);
      allResults = allResults.concat(sheetsResults);
    } catch {
      // Sheets недоступен — продолжаем с файловыми результатами
    }
  }

  // 3. Сортировка по релевантности (убывание) и лимит
  allResults.sort((a, b) => b.relevance - a.relevance);
  const topResults = allResults.slice(0, MAX_RESULTS);

  // 4. Вывод
  const output = {
    query: query,
    keywords: keywords,
    total_found: allResults.length,
    results_returned: topResults.length,
    sources_searched: Object.keys(SOURCES).concat(includeSheets ? ["google-sheets"] : []),
    results: topResults,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
