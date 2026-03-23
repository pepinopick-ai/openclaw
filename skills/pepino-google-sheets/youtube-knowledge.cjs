#!/usr/bin/env node

/**
 * YouTube → Knowledge Pipeline
 *
 * Берёт YouTube URL, создаёт NotebookLM notebook,
 * извлекает summary и сохраняет в pepino-graph/05-sources/youtube/
 *
 * Использование:
 *   node youtube-knowledge.js add <URL> [--tags tag1,tag2]
 *   node youtube-knowledge.js list
 *   node youtube-knowledge.js search <keyword>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SOURCES_DIR = path.join(
  process.env.HOME,
  ".openclaw/workspace/memory/pepino-graph/05-sources/youtube"
);
const MANIFEST_PATH = path.join(
  process.env.HOME,
  ".openclaw/workspace/memory/pepino-graph/MANIFEST.md"
);

// Ensure directory exists
if (!fs.existsSync(SOURCES_DIR)) {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function getVideoTitle(url) {
  try {
    const html = execSync(
      `curl -sL --max-time 10 "${url}" 2>/dev/null | head -c 50000`,
      { encoding: "utf8", timeout: 15000 }
    );
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      return titleMatch[1]
        .replace(/ - YouTube$/, "")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .trim();
    }
  } catch {
    // ignore
  }
  return null;
}

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

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function addVideo(url, tags = []) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    console.error("ERROR: Не удалось извлечь video ID из URL:", url);
    process.exit(1);
  }

  const title = getVideoTitle(url) || `video-${videoId}`;
  const date = todayStr();
  const slug = slugify(title);
  const filename = `${date}-${slug}.md`;
  const filepath = path.join(SOURCES_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`SKIP: Файл уже существует: ${filename}`);
    return filepath;
  }

  console.log(`Processing: ${title}`);
  console.log(`Video ID: ${videoId}`);
  console.log(`URL: ${url}`);

  // Create markdown file with frontmatter
  const tagStr = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const content = `---
type: source
source_type: youtube
video_id: ${videoId}
url: ${url}
title: "${title.replace(/"/g, '\\"')}"
date_added: ${date}
tags: ${tagStr}
notebooklm_status: pending
summary_status: pending
---

# ${title}

**Источник:** [YouTube](${url})
**Добавлен:** ${date}
**Теги:** ${tags.join(", ") || "без тегов"}

## Краткое содержание

> _Ожидает обработки через NotebookLM..._
>
> Для получения summary используй:
> 1. NotebookLM MCP: nblm_create_notebook + nblm_add_source_url
> 2. nblm_get_summary → вставить сюда

## Ключевые тезисы

- [ ] _Ожидает анализа_

## Применение для Pepino Pick

- [ ] _Как это применить к нашему хозяйству?_

## Связанные сущности

- _Укажи связи с entities из pepino-graph_
`;

  fs.writeFileSync(filepath, content);
  console.log(`CREATED: ${filepath}`);
  return filepath;
}

/**
 * Автоматический pipeline: создаёт структурированный source-файл
 * с расширенным шаблоном (Actions, SOP Patches) и обновляет MANIFEST.
 *
 * Использование: node youtube-knowledge.cjs auto "URL" "title" [--tags t1,t2]
 */
async function autoVideo(url, titleArg, tags = []) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    console.error("ERROR: Не удалось извлечь video ID из URL:", url);
    process.exit(1);
  }

  // Название: из аргумента, из HTML <title>, или fallback
  const title = titleArg || getVideoTitle(url) || `video-${videoId}`;
  const date = todayStr();
  const slug = slugify(title);
  // Формат файла по конвенции pepino-graph: YYYY-MM-DD__youtube__slug.md
  const filename = `${date}__youtube__${slug}.md`;
  const filepath = path.join(SOURCES_DIR, filename);

  if (fs.existsSync(filepath)) {
    console.log(`SKIP: Файл уже существует: ${filename}`);
    console.log(`PATH: ${filepath}`);
    return filepath;
  }

  console.log(`[auto] Processing: ${title}`);
  console.log(`[auto] Video ID: ${videoId}`);
  console.log(`[auto] URL: ${url}`);

  const tagStr = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  const content = `---
type: source
source_type: youtube
video_id: ${videoId}
url: ${url}
title: "${title.replace(/"/g, '\\"')}"
date_added: ${date}
tags: ${tagStr}
notebooklm_status: pending
summary_status: pending
pipeline: auto
---

# ${title}

**Источник:** [YouTube](${url})
**Дата добавления:** ${date}
**Video ID:** \`${videoId}\`
**Теги:** ${tags.join(", ") || "без тегов"}
**Pipeline:** auto

---

## Summary

> _Заполняется автоматически через NotebookLM или вручную._
>
> **Следующий шаг:**
> 1. \`nblm_create_notebook("${title.slice(0, 50)}")\` или \`nblm_use_notebook("pepino-agronomy-research")\`
> 2. \`nblm_add_source_url("${url}")\`
> 3. \`nblm_get_summary()\` -- вставить результат сюда

---

## Key Points

- [ ] _Ожидает анализа -- ключевые тезисы видео_

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

- [ ] _Какие СОПы нужно обновить или создать на основе этого видео?_
- [ ] _Ссылки на существующие СОПы: SOP-AGR-xxx, SOP-FER-xxx, ..._

---

## Related Entities

- _Связи с entities из pepino-graph (растения, поставщики, зоны)_
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

function listVideos() {
  const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("Нет добавленных видео.");
    return;
  }

  console.log(`\nYouTube источники (${files.length}):\n`);
  for (const f of files.sort().reverse()) {
    const content = fs.readFileSync(path.join(SOURCES_DIR, f), "utf8");
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
    const statusMatch = content.match(/^summary_status:\s*(\S+)/m);
    const title = titleMatch ? titleMatch[1] : f;
    const status = statusMatch ? statusMatch[1] : "unknown";
    const icon = status === "done" ? "✅" : status === "pending" ? "⏳" : "❓";
    console.log(`  ${icon} ${f.slice(0, 10)} | ${title}`);
  }
}

function searchVideos(keyword) {
  const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md"));
  const kw = keyword.toLowerCase();
  const results = [];

  for (const f of files) {
    const content = fs.readFileSync(path.join(SOURCES_DIR, f), "utf8");
    if (content.toLowerCase().includes(kw)) {
      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      results.push({
        file: f,
        title: titleMatch ? titleMatch[1] : f,
      });
    }
  }

  if (results.length === 0) {
    console.log(`Ничего не найдено по запросу: "${keyword}"`);
    return;
  }

  console.log(`\nНайдено ${results.length} видео по "${keyword}":\n`);
  for (const r of results) {
    console.log(`  📹 ${r.file} — ${r.title}`);
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "add": {
    const url = args[1];
    if (!url) {
      console.error("Использование: node youtube-knowledge.cjs add <URL> [--tags tag1,tag2]");
      process.exit(1);
    }
    const tagsIdx = args.indexOf("--tags");
    const tags = tagsIdx !== -1 && args[tagsIdx + 1]
      ? args[tagsIdx + 1].split(",").map((t) => t.trim())
      : [];
    addVideo(url, tags).catch(console.error);
    break;
  }
  case "auto": {
    const url = args[1];
    if (!url) {
      console.error(
        'Использование: node youtube-knowledge.cjs auto <URL> [title] [--tags tag1,tag2]'
      );
      process.exit(1);
    }
    // Второй аргумент -- title (опциональный, может начинаться с --tags)
    const tagsIdx = args.indexOf("--tags");
    const titleArg =
      args[2] && !args[2].startsWith("--") ? args[2] : null;
    const tags =
      tagsIdx !== -1 && args[tagsIdx + 1]
        ? args[tagsIdx + 1].split(",").map((t) => t.trim())
        : [];
    autoVideo(url, titleArg, tags).catch(console.error);
    break;
  }
  case "list":
    listVideos();
    break;
  case "search": {
    const keyword = args.slice(1).join(" ");
    if (!keyword) {
      console.error("Использование: node youtube-knowledge.cjs search <keyword>");
      process.exit(1);
    }
    searchVideos(keyword);
    break;
  }
  default:
    console.log(`YouTube Knowledge Pipeline

Команды:
  add <URL> [--tags t1,t2]            — Добавить видео (базовый шаблон)
  auto <URL> [title] [--tags t1,t2]   — Автоматический pipeline (расширенный шаблон + MANIFEST)
  list                                — Список всех видео
  search <keyword>                    — Поиск по видео

Автоматический pipeline (auto):
  1. Создаёт .md файл с расширенным шаблоном (Summary, Key Points, Actions, SOP Patches)
  2. Обновляет MANIFEST.md
  3. Готов к NotebookLM анализу

Полный pipeline (через агента):
  1. auto <URL> "title"     — Создаёт структурированный .md файл
  2. NotebookLM MCP         — nblm_add_source_url + nblm_get_summary
  3. Агент заполняет        — Summary + Key Points + Actions + SOP Patches
`);
}
