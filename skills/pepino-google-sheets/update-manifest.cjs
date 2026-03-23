/**
 * update-manifest.cjs
 *
 * Сканирует pepino-graph/, считает .md-файлы по разделам,
 * обновляет MANIFEST.md с актуальными счётчиками и последними добавлениями.
 *
 * Запуск: node update-manifest.cjs
 * Без внешних зависимостей (только Node.js stdlib).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const GRAPH_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "pepino-graph"
);

const MANIFEST_PATH = path.join(GRAPH_DIR, "MANIFEST.md");

// Секции графа и их описания
const SECTIONS = [
  { dir: "00-inbox", label: "Сырые данные на обработку" },
  { dir: "01-entities", label: "Сущности (растения, клиенты, операции, финансы)" },
  { dir: "02-relations", label: "Связи между сущностями" },
  { dir: "03-insights", label: "Инсайты, паттерны, корреляции" },
  { dir: "04-decisions", label: "Принятые решения с датами" },
  { dir: "05-sources", label: "Внешние источники знаний" },
  { dir: "06-sop", label: "Стандартные операционные процедуры" },
  { dir: "99-reports", label: "Сгенерированные отчёты" },
];

/**
 * Рекурсивно собирает все .md-файлы из директории.
 * Возвращает массив { relativePath, mtimeMs }.
 */
function collectMdFiles(baseDir, currentDir) {
  /** @type {{ relativePath: string, mtimeMs: number }[]} */
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(baseDir, fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const stat = fs.statSync(fullPath);
      results.push({
        relativePath: path.relative(baseDir, fullPath),
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return results;
}

/**
 * Считает .md-файлы внутри конкретной секции (рекурсивно).
 * Исключает служебные файлы корня секции типа INDEX.md, если нужно --
 * пока считаем все .md без исключений.
 */
function countSection(sectionDir) {
  const dir = path.join(GRAPH_DIR, sectionDir);
  return collectMdFiles(dir, dir).length;
}

/**
 * Форматирует дату в ISO-строку YYYY-MM-DD.
 */
function formatDate(ms) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function main() {
  if (!fs.existsSync(GRAPH_DIR)) {
    console.error(`Директория не найдена: ${GRAPH_DIR}`);
    process.exit(1);
  }

  // Подсчёт файлов по секциям
  const counts = {};
  for (const s of SECTIONS) {
    counts[s.dir] = countSection(s.dir);
  }

  // Все .md-файлы из всех секций (без корневых файлов вроде MANIFEST.md)
  const allFiles = [];
  for (const s of SECTIONS) {
    const sectionPath = path.join(GRAPH_DIR, s.dir);
    const files = collectMdFiles(sectionPath, sectionPath);
    for (const f of files) {
      allFiles.push({
        // Путь относительно pepino-graph, включая секцию
        relativePath: path.join(s.dir, f.relativePath),
        mtimeMs: f.mtimeMs,
      });
    }
  }

  // Сортировка по дате модификации — новые первые
  allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recent = allFiles.slice(0, 5);

  const today = formatDate(Date.now());

  // Суммарные счётчики для шапки
  const totalEntities = counts["01-entities"] || 0;
  const totalRelations = counts["02-relations"] || 0;
  const totalInsights = counts["03-insights"] || 0;
  const totalSources = counts["05-sources"] || 0;
  const totalSop = counts["06-sop"] || 0;

  // Генерация MANIFEST.md
  const lines = [];
  lines.push("# Pepino Graph — MANIFEST");
  lines.push("");
  lines.push(`**Обновлён:** ${today}`);
  lines.push(
    `**Сущностей:** ${totalEntities} | **Связей:** ${totalRelations} | **Инсайтов:** ${totalInsights} | **Источников:** ${totalSources} | **SOP:** ${totalSop}`
  );
  lines.push("");
  lines.push("## Структура");
  lines.push("");
  lines.push("| Папка | Назначение | Файлов |");
  lines.push("|---|---|---|");
  for (const s of SECTIONS) {
    lines.push(`| \`${s.dir}/\` | ${s.label} | ${counts[s.dir]} |`);
  }

  lines.push("");
  lines.push("## Источники (05-sources/)");
  lines.push("");
  lines.push("| Тип | Папка | Описание |");
  lines.push("|---|---|---|");
  lines.push("| YouTube | `05-sources/youtube/` | Видео → NotebookLM → summary.md |");
  lines.push("| Статьи | `05-sources/articles/` | Веб-статьи, PDF, исследования |");
  lines.push("| Notebooks | `05-sources/notebooks/` | NotebookLM notebook summaries |");

  lines.push("");
  lines.push("## Быстрый поиск");
  lines.push("");
  lines.push("- Растения: `01-entities/plants/`");
  lines.push("- Клиенты: `01-entities/clients/`");
  lines.push("- Операции: `01-entities/operations/`");
  lines.push("- VPD/климат: `02-relations/climate-to-plants.md`, `03-insights/`");
  lines.push("- Финансы: `01-entities/finance/`");

  lines.push("");
  lines.push("## Последние добавления");
  lines.push("");
  if (recent.length === 0) {
    lines.push("_Нет файлов._");
  } else {
    for (const f of recent) {
      const date = formatDate(f.mtimeMs);
      // Извлекаем секцию из пути для контекста
      const sectionDir = f.relativePath.split(path.sep)[0];
      const fileName = path.basename(f.relativePath, ".md");
      lines.push(`- ${date}: ${fileName} (\`${sectionDir}/\`)`);
    }
  }
  lines.push("");

  fs.writeFileSync(MANIFEST_PATH, lines.join("\n"), "utf-8");

  // Вывод результата в консоль
  const totalAll = allFiles.length;
  console.log(`MANIFEST.md обновлён: ${MANIFEST_PATH}`);
  console.log(`Дата: ${today}`);
  console.log(`Всего .md-файлов в секциях: ${totalAll}`);
  for (const s of SECTIONS) {
    console.log(`  ${s.dir}: ${counts[s.dir]}`);
  }
  if (recent.length > 0) {
    console.log("Последние 5 добавлений:");
    for (const f of recent) {
      console.log(`  ${formatDate(f.mtimeMs)} ${f.relativePath}`);
    }
  }
}

main();
