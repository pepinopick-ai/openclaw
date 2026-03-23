#!/usr/bin/env node

/**
 * Article / PDF -> Knowledge Pipeline
 *
 * Берёт URL статьи или PDF, создаёт source-заметку
 * в pepino-graph/05-sources/articles/ и обновляет MANIFEST.
 *
 * Использование:
 *   node article-knowledge.cjs add "URL" "Title"
 *   node article-knowledge.cjs auto "URL" "Title" --tags tag1,tag2
 *   node article-knowledge.cjs list
 *   node article-knowledge.cjs search <keyword>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SOURCES_DIR = path.join(
  process.env.HOME,
  ".openclaw/workspace/memory/pepino-graph/05-sources/articles"
);
const MANIFEST_PATH = path.join(
  process.env.HOME,
  ".openclaw/workspace/memory/pepino-graph/MANIFEST.md"
);

// Создать директорию если не существует
if (!fs.existsSync(SOURCES_DIR)) {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

/**
 * Извлечь <title> из HTML-страницы по URL.
 * Для PDF и других не-HTML ресурсов вернёт null.
 * @param {string} url
 * @returns {string | null}
 */
function fetchPageTitle(url) {
  try {
    const html = execSync(
      `curl -sL --max-time 15 "${url}" 2>/dev/null | head -c 80000`,
      { encoding: "utf8", timeout: 20000 }
    );

    // Проверяем, что это HTML (а не PDF binary)
    if (html.startsWith("%PDF")) return null;

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      return titleMatch[1]
        .replace(/\s*[-|]\s*$/, "")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();
    }
  } catch {
    // таймаут или ошибка сети -- игнорируем
  }
  return null;
}

/**
 * Определить тип источника по URL.
 * @param {string} url
 * @returns {"pdf" | "article"}
 */
function detectSourceType(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith(".pdf") || lower.includes("/pdf/") || lower.includes("type=pdf")) {
    return "pdf";
  }
  return "article";
}

/**
 * Извлечь домен из URL для метаданных.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Транслитерация и slugify текста (поддерживает кириллицу).
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => {
      const map = {
        а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo",
        ж: "zh", з: "z", и: "i", й: "j", к: "k", л: "l", м: "m",
        н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
        ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
        ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
      };
      return map[c] || c;
    })
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * ISO дата сегодня: YYYY-MM-DD.
 * @returns {string}
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Команда add -- создаёт базовую source-заметку.
 * @param {string} url
 * @param {string | null} titleArg
 * @param {string[]} tags
 * @returns {Promise<string>} путь к файлу
 */
async function addArticle(url, titleArg, tags = []) {
  const sourceType = detectSourceType(url);
  const domain = extractDomain(url);

  // Название: из аргумента, из HTML, или fallback
  const title = titleArg || fetchPageTitle(url) || `${sourceType}-${domain}-${Date.now()}`;
  const date = todayStr();
  const slug = slugify(title);
  const filename = `${date}__${sourceType}__${slug}.md`;
  const filepath = path.join(SOURCES_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`SKIP: Файл уже существует: ${filename}`);
    return filepath;
  }

  console.log(`Processing: ${title}`);
  console.log(`Source type: ${sourceType}`);
  console.log(`Domain: ${domain}`);
  console.log(`URL: ${url}`);

  const tagStr = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const content = `---
type: source
source_type: ${sourceType}
title: "${title.replace(/"/g, '\\"')}"
url: "${url}"
domain: ${domain}
date_added: ${date}
tags: ${tagStr}
status: pending_review
---

# ${title}

**Источник:** [${domain}](${url})
**Добавлен:** ${date}
**Тип:** ${sourceType}
**Теги:** ${tags.join(", ") || "без тегов"}

## Summary
<!-- Заполнить после прочтения -->

## Key Points
-

## Applicable to Pepino Pick
-

## Actions
- [ ]

## Related Entities
-
`;

  fs.writeFileSync(filepath, content);
  console.log(`CREATED: ${filepath}`);
  return filepath;
}

/**
 * Команда auto -- расширенный pipeline с шаблоном и обновлением MANIFEST.
 * @param {string} url
 * @param {string | null} titleArg
 * @param {string[]} tags
 * @returns {Promise<string>} путь к файлу
 */
async function autoArticle(url, titleArg, tags = []) {
  const sourceType = detectSourceType(url);
  const domain = extractDomain(url);

  // Название: из аргумента, из HTML, или fallback
  const title = titleArg || fetchPageTitle(url) || `${sourceType}-${domain}-${Date.now()}`;
  const date = todayStr();
  const slug = slugify(title);
  // Конвенция pepino-graph: YYYY-MM-DD__article__slug.md
  const filename = `${date}__${sourceType}__${slug}.md`;
  const filepath = path.join(SOURCES_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`SKIP: Файл уже существует: ${filename}`);
    console.log(`PATH: ${filepath}`);
    return filepath;
  }

  console.log(`[auto] Processing: ${title}`);
  console.log(`[auto] Source type: ${sourceType}`);
  console.log(`[auto] Domain: ${domain}`);
  console.log(`[auto] URL: ${url}`);

  const tagStr = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const content = `---
type: source
source_type: ${sourceType}
title: "${title.replace(/"/g, '\\"')}"
url: "${url}"
domain: ${domain}
date_added: ${date}
tags: ${tagStr}
status: pending_review
pipeline: auto
---

# ${title}

**Источник:** [${domain}](${url})
**Дата добавления:** ${date}
**Тип:** ${sourceType}
**Домен:** \`${domain}\`
**Теги:** ${tags.join(", ") || "без тегов"}
**Pipeline:** auto

---

## Summary

> _Заполняется автоматически через NotebookLM или вручную._
>
> **Следующий шаг:**
> 1. \`nblm_use_notebook("<notebook-id>")\` или \`nblm_create_notebook("${title.slice(0, 50)}")\`
> 2. \`nblm_add_source_url("${url}")\`
> 3. \`nblm_get_summary()\` -- вставить результат сюда

---

## Key Points

- [ ] _Ожидает анализа -- ключевые тезисы статьи_

---

## Applicable to Pepino Pick

- [ ] _Какие конкретные практики можно внедрить?_
- [ ] _Какие условия совпадают с нашей теплицей (зоны, культуры, климат)?_
- [ ] _Какие метрики стоит начать отслеживать?_

---

## Actions

- [ ] _Конкретные действия для внедрения (кто, когда, что)_

---

## SOP Patches

- [ ] _Какие СОПы нужно обновить или создать на основе этой статьи?_
- [ ] _Ссылки на существующие СОПы: SOP-AGR-xxx, SOP-FER-xxx, ..._

---

## Related Entities

- _Связи с entities из pepino-graph (растения, поставщики, зоны)_

---

## Route

- pepino-graph: 03-insights/ (если есть actionable insight)
- pepino-obsidian: по теме (11_market_intel/, 06_lessons_learned/, etc.)
`;

  fs.writeFileSync(filepath, content);
  console.log(`CREATED: ${filepath}`);

  // Обновить MANIFEST если update-manifest.cjs существует рядом
  const manifestScript = path.join(__dirname, "update-manifest.cjs");
  if (fs.existsSync(manifestScript)) {
    try {
      console.log("[auto] Обновляю MANIFEST...");
      execSync(`node "${manifestScript}"`, {
        encoding: "utf8",
        timeout: 10000,
        cwd: __dirname,
      });
      console.log("[auto] MANIFEST обновлён.");
    } catch (err) {
      console.error("[auto] Ошибка обновления MANIFEST:", err.message);
    }
  }

  console.log(`[auto] Pipeline завершён.`);
  console.log(`[auto] Файл: ${filepath}`);
  console.log(`[auto] Следующий шаг: NotebookLM анализ (если тема релевантна).`);
  return filepath;
}

/**
 * Список всех статей в articles/.
 */
function listArticles() {
  const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("Нет добавленных статей.");
    return;
  }

  console.log(`\nArticle источники (${files.length}):\n`);
  for (const f of files.sort().reverse()) {
    const content = fs.readFileSync(path.join(SOURCES_DIR, f), "utf8");
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
    const statusMatch = content.match(/^status:\s*(\S+)/m);
    const sourceTypeMatch = content.match(/^source_type:\s*(\S+)/m);
    const title = titleMatch ? titleMatch[1] : f;
    const status = statusMatch ? statusMatch[1] : "unknown";
    const sType = sourceTypeMatch ? sourceTypeMatch[1] : "article";
    const statusIcon = status === "reviewed" ? "[OK]" : status === "pending_review" ? "[--]" : "[??]";
    const typeIcon = sType === "pdf" ? "[PDF]" : "[WEB]";
    console.log(`  ${statusIcon} ${typeIcon} ${f.slice(0, 10)} | ${title}`);
  }
}

/**
 * Поиск по содержимому статей.
 * @param {string} keyword
 */
function searchArticles(keyword) {
  const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md"));
  const kw = keyword.toLowerCase();
  /** @type {{ file: string, title: string, sourceType: string }[]} */
  const results = [];

  for (const f of files) {
    const content = fs.readFileSync(path.join(SOURCES_DIR, f), "utf8");
    if (content.toLowerCase().includes(kw)) {
      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      const sourceTypeMatch = content.match(/^source_type:\s*(\S+)/m);
      results.push({
        file: f,
        title: titleMatch ? titleMatch[1] : f,
        sourceType: sourceTypeMatch ? sourceTypeMatch[1] : "article",
      });
    }
  }

  if (results.length === 0) {
    console.log(`Ничего не найдено по запросу: "${keyword}"`);
    return;
  }

  console.log(`\nНайдено ${results.length} статей по "${keyword}":\n`);
  for (const r of results) {
    const icon = r.sourceType === "pdf" ? "[PDF]" : "[WEB]";
    console.log(`  ${icon} ${r.file} -- ${r.title}`);
  }
}

// --- CLI ---
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "add": {
    const url = args[1];
    const titleArg = args[2] && !args[2].startsWith("--") ? args[2] : null;
    if (!url) {
      console.error('Использование: node article-knowledge.cjs add "URL" ["Title"] [--tags tag1,tag2]');
      process.exit(1);
    }
    const tagsIdx = args.indexOf("--tags");
    const tags =
      tagsIdx !== -1 && args[tagsIdx + 1]
        ? args[tagsIdx + 1].split(",").map((t) => t.trim())
        : [];
    addArticle(url, titleArg, tags).catch(console.error);
    break;
  }
  case "auto": {
    const url = args[1];
    if (!url) {
      console.error(
        'Использование: node article-knowledge.cjs auto "URL" ["Title"] [--tags tag1,tag2]'
      );
      process.exit(1);
    }
    const tagsIdx = args.indexOf("--tags");
    const titleArg =
      args[2] && !args[2].startsWith("--") ? args[2] : null;
    const tags =
      tagsIdx !== -1 && args[tagsIdx + 1]
        ? args[tagsIdx + 1].split(",").map((t) => t.trim())
        : [];
    autoArticle(url, titleArg, tags).catch(console.error);
    break;
  }
  case "list":
    listArticles();
    break;
  case "search": {
    const keyword = args.slice(1).join(" ");
    if (!keyword) {
      console.error("Использование: node article-knowledge.cjs search <keyword>");
      process.exit(1);
    }
    searchArticles(keyword);
    break;
  }
  default:
    console.log(`Article Knowledge Pipeline

Команды:
  add "URL" ["Title"] [--tags t1,t2]            -- Добавить статью (базовый шаблон)
  auto "URL" ["Title"] [--tags t1,t2]            -- Автоматический pipeline (расширенный шаблон + MANIFEST)
  list                                           -- Список всех статей
  search <keyword>                               -- Поиск по статьям

Автоматический pipeline (auto):
  1. Создаёт .md файл с расширенным шаблоном (Summary, Key Points, Actions, SOP Patches, Route)
  2. Обновляет MANIFEST.md
  3. Готов к NotebookLM анализу

Полный pipeline (через агента):
  1. auto "URL" "title"     -- Создаёт структурированный .md файл
  2. NotebookLM MCP         -- nblm_add_source_url + nblm_get_summary
  3. Агент заполняет        -- Summary + Key Points + Actions + SOP Patches

Поддерживаемые типы:
  - Веб-статьи (HTML) -- title извлекается автоматически
  - PDF документы     -- title из аргумента (PDF не имеют HTML title)
`);
}
