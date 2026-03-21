#!/usr/bin/env node
// vault-organizer.cjs — Организация Obsidian vault и memory в доменную структуру
// Не удаляет и не перемещает файлы. Только создаёт структуру и симлинки.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Конфигурация ───────────────────────────────────────────────────────────

const MEMORY_ROOT = path.join(os.homedir(), ".openclaw", "workspace", "memory");
const KNOWLEDGE_ROOT = path.join(MEMORY_ROOT, "knowledge");
const PEPINO_CORE = path.join(__dirname, "..", "pepino-core");

/** Доменные директории с описаниями */
const DOMAINS = {
  agronomy: "growing guides, crop data, pest management",
  finance: "pricing rules, margin analysis, P&L templates",
  sales: "client profiles, sales strategies, CRM data",
  procurement: "supplier profiles, material specs, sourcing",
  sop: "standard operating procedures",
  incidents: "past incidents and lessons learned",
  decisions: "business decisions with rationale",
  reference: "formulas, regulations, specs",
};

/** Правила категоризации: источник -> домен + подпапка */
const CATEGORIZATION_RULES = [
  {
    name: "client-profiles",
    description: "Профили клиентов -> sales/",
    sourceGlob: path.join(MEMORY_ROOT, "people", "clients"),
    targetDomain: "sales",
    targetSubdir: "clients",
    extensions: [".json", ".md"],
  },
  {
    name: "partner-profiles",
    description: "Профили партнёров -> procurement/",
    sourceGlob: path.join(MEMORY_ROOT, "people", "partners"),
    targetDomain: "procurement",
    targetSubdir: "partners",
    extensions: [".json", ".md"],
  },
  {
    name: "product-knowledge",
    description: "Данные о продуктах -> agronomy/",
    sourceGlob: path.join(KNOWLEDGE_ROOT, "products"),
    targetDomain: "agronomy",
    targetSubdir: "products",
    extensions: [".json", ".md"],
  },
  {
    name: "business-rules",
    description: "Бизнес-правила -> sop/",
    sourceGlob: path.join(KNOWLEDGE_ROOT, "rules"),
    targetDomain: "sop",
    targetSubdir: "rules",
    extensions: [".json", ".md"],
  },
  {
    name: "pepino-core-governance",
    description: "pepino-core документы -> reference/governance/",
    sourceGlob: PEPINO_CORE,
    targetDomain: "reference",
    targetSubdir: "governance",
    extensions: [".md"],
  },
  {
    name: "knowledge-graph-entities",
    description: "Сущности knowledge graph -> agronomy/graph-entities/",
    sourceGlob: path.join(MEMORY_ROOT, "pepino-graph", "01-entities"),
    targetDomain: "agronomy",
    targetSubdir: "graph-entities",
    extensions: [".md"],
    recursive: true,
  },
  {
    name: "knowledge-graph-capex",
    description: "Capex из knowledge graph -> finance/capex/",
    sourceGlob: path.join(MEMORY_ROOT, "pepino-graph", "01-entities", "capex"),
    targetDomain: "finance",
    targetSubdir: "capex",
    extensions: [".md"],
  },
  {
    name: "graph-clients",
    description: "Клиенты из knowledge graph -> sales/graph-clients/",
    sourceGlob: path.join(MEMORY_ROOT, "pepino-graph", "01-entities", "clients"),
    targetDomain: "sales",
    targetSubdir: "graph-clients",
    extensions: [".md"],
  },
  {
    name: "financial-model",
    description: "Финансовые модели -> finance/",
    sourceGlob: MEMORY_ROOT,
    targetDomain: "finance",
    targetSubdir: "",
    extensions: [".md"],
    filePattern: /financial_model/i,
  },
  {
    name: "pricing-updates",
    description: "Обновления цен -> finance/pricing/",
    sourceGlob: MEMORY_ROOT,
    targetDomain: "finance",
    targetSubdir: "pricing",
    extensions: [".md"],
    filePattern: /price_update/i,
  },
  {
    name: "knowledge-sources",
    description: "Источники знаний -> reference/sources/",
    sourceGlob: path.join(MEMORY_ROOT, "pepino-graph", "05-sources"),
    targetDomain: "reference",
    targetSubdir: "sources",
    extensions: [".md"],
    recursive: true,
  },
  {
    name: "greenhouse-graphs",
    description: "Графы теплицы -> agronomy/graphs/",
    sourceGlob: path.join(MEMORY_ROOT, "graphs"),
    targetDomain: "agronomy",
    targetSubdir: "graphs",
    extensions: [".md"],
  },
  {
    name: "logistics-data",
    description: "Логистика -> procurement/logistics/",
    sourceGlob: path.join(MEMORY_ROOT, "logistics"),
    targetDomain: "procurement",
    targetSubdir: "logistics",
    extensions: [".md", ".json"],
  },
  {
    name: "delivery-checklists",
    description: "Чеклисты доставки -> sop/delivery/",
    sourceGlob: MEMORY_ROOT,
    targetDomain: "sop",
    targetSubdir: "delivery",
    extensions: [".md"],
    filePattern: /delivery.*checklist/i,
  },
];

/** Паттерн для daily log файлов (пропускаем их) */
const DAILY_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}([-_].+)?\.md$/;

// ─── Утилиты ────────────────────────────────────────────────────────────────

/**
 * Рекурсивный сбор файлов из директории
 * @param {string} dirPath - путь к директории
 * @param {string[]} extensions - допустимые расширения
 * @param {boolean} recursive - рекурсивный обход
 * @returns {string[]} массив абсолютных путей
 */
function collectFiles(dirPath, extensions, recursive = false) {
  /** @type {string[]} */
  const result = [];

  if (!fs.existsSync(dirPath)) {
    return result;
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return result;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
      result.push(fullPath);
    } else if (entry.isDirectory() && recursive) {
      result.push(...collectFiles(fullPath, extensions, true));
    }
  }

  return result;
}

/**
 * Сканирует все файлы .md, .json, .yaml в memory root
 * @returns {{ filePath: string, size: number, ext: string, relative: string }[]}
 */
function scanMemoryFiles() {
  /** @type {{ filePath: string, size: number, ext: string, relative: string }[]} */
  const results = [];
  const validExts = [".md", ".json", ".yaml", ".yml"];

  /**
   * @param {string} dir
   */
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (validExts.includes(ext)) {
          const stat = fs.statSync(fullPath);
          results.push({
            filePath: fullPath,
            size: stat.size,
            ext,
            relative: path.relative(MEMORY_ROOT, fullPath),
          });
        }
      }
    }
  }

  walk(MEMORY_ROOT);
  return results;
}

/**
 * Безопасное создание директории
 * @param {string} dirPath
 * @param {boolean} dryRun
 * @returns {boolean} true если создана или существует
 */
function ensureDir(dirPath, dryRun) {
  if (fs.existsSync(dirPath)) {
    return false; // уже существует
  }
  if (!dryRun) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return true;
}

/**
 * Создание симлинка (относительный путь)
 * @param {string} sourcePath - реальный файл
 * @param {string} linkPath - где создать симлинк
 * @param {boolean} dryRun
 * @returns {{ created: boolean, skipped: string | null }}
 */
function createSymlink(sourcePath, linkPath, dryRun) {
  // Проверяем, существует ли уже симлинк
  if (fs.existsSync(linkPath)) {
    try {
      const existing = fs.readlinkSync(linkPath);
      const resolvedExisting = path.resolve(path.dirname(linkPath), existing);
      if (resolvedExisting === path.resolve(sourcePath)) {
        return { created: false, skipped: "already-linked" };
      }
    } catch {
      // Не симлинк, а обычный файл
      return { created: false, skipped: "file-exists" };
    }
    return { created: false, skipped: "different-link-exists" };
  }

  // Вычисляем относительный путь для симлинка
  const relTarget = path.relative(path.dirname(linkPath), sourcePath);

  if (!dryRun) {
    fs.symlinkSync(relTarget, linkPath);
  }

  return { created: true, skipped: null };
}

// ─── Основная логика ────────────────────────────────────────────────────────

/**
 * @param {{ dryRun: boolean }} options
 */
function organize(options) {
  const { dryRun } = options;
  const prefix = dryRun ? "[DRY-RUN] " : "";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Pepino Pick Vault Organizer`);
  console.log(`  Mode: ${dryRun ? "DRY RUN (ничего не будет изменено)" : "LIVE"}`);
  console.log(`${"=".repeat(60)}\n`);

  // ─── Шаг 1: Сканирование ─────────────────────────────────────────────

  console.log("--- Шаг 1: Сканирование memory/ ---\n");

  if (!fs.existsSync(MEMORY_ROOT)) {
    console.error(`ОШИБКА: Директория не найдена: ${MEMORY_ROOT}`);
    process.exit(1);
  }

  const allFiles = scanMemoryFiles();

  // Группировка по расширению
  /** @type {Record<string, number>} */
  const byExt = {};
  let totalSize = 0;
  for (const f of allFiles) {
    byExt[f.ext] = (byExt[f.ext] || 0) + 1;
    totalSize += f.size;
  }

  console.log(`  Найдено файлов: ${allFiles.length}`);
  console.log(`  Общий размер: ${(totalSize / 1024).toFixed(1)} KB`);
  for (const [ext, count] of Object.entries(byExt).sort()) {
    console.log(`    ${ext}: ${count} файлов`);
  }

  // Daily logs (пропускаем)
  const dailyLogs = allFiles.filter((f) => {
    const basename = path.basename(f.filePath);
    const dir = path.dirname(f.filePath);
    return dir === MEMORY_ROOT && DAILY_LOG_PATTERN.test(basename);
  });
  console.log(`\n  Daily logs (пропускаются): ${dailyLogs.length}`);
  for (const dl of dailyLogs) {
    console.log(`    - ${path.basename(dl.filePath)} (${(dl.size / 1024).toFixed(1)} KB)`);
  }

  // ─── Шаг 2: Создание доменных директорий ──────────────────────────────

  console.log("\n--- Шаг 2: Создание доменных директорий ---\n");

  let dirsCreated = 0;
  for (const [domain, description] of Object.entries(DOMAINS)) {
    const domainPath = path.join(KNOWLEDGE_ROOT, domain);
    const created = ensureDir(domainPath, dryRun);
    const status = created ? `${prefix}СОЗДАНА` : "существует";
    console.log(`  [${status}] ${domain}/ - ${description}`);
    if (created) dirsCreated++;
  }
  console.log(`\n  Итого: ${dirsCreated} новых директорий`);

  // ─── Шаг 3: Категоризация и создание симлинков ────────────────────────

  console.log("\n--- Шаг 3: Категоризация файлов ---\n");

  let linksCreated = 0;
  let linksSkipped = 0;
  /** @type {Record<string, { files: number, size: number, lastModified: Date }>} */
  const domainStats = {};

  // Инициализация статистики
  for (const domain of Object.keys(DOMAINS)) {
    domainStats[domain] = { files: 0, size: 0, lastModified: new Date(0) };
  }

  for (const rule of CATEGORIZATION_RULES) {
    const sourceDir = rule.sourceGlob;
    if (!fs.existsSync(sourceDir)) {
      console.log(`  [ПРОПУСК] ${rule.name}: источник не найден (${sourceDir})`);
      continue;
    }

    // Определяем целевую папку
    const targetDir = rule.targetSubdir
      ? path.join(KNOWLEDGE_ROOT, rule.targetDomain, rule.targetSubdir)
      : path.join(KNOWLEDGE_ROOT, rule.targetDomain);

    ensureDir(targetDir, dryRun);

    // Собираем файлы
    let files;
    if (rule.filePattern) {
      // Файлы по паттерну имени в конкретной директории (не рекурсивно)
      files = collectFiles(sourceDir, rule.extensions, false).filter((f) =>
        rule.filePattern.test(path.basename(f)),
      );
    } else {
      files = collectFiles(sourceDir, rule.extensions, rule.recursive || false);
    }

    if (files.length === 0) {
      continue;
    }

    console.log(`  ${rule.description}:`);

    for (const srcFile of files) {
      const basename = path.basename(srcFile);

      // Для рекурсивных правил сохраняем поддиректорию
      let linkName = basename;
      if (rule.recursive) {
        const relInSource = path.relative(sourceDir, srcFile);
        // Заменяем разделители на __ для плоской структуры
        linkName = relInSource.replace(/[/\\]/g, "__");
      }

      const linkPath = path.join(targetDir, linkName);
      const { created, skipped } = createSymlink(srcFile, linkPath, dryRun);

      if (created) {
        console.log(`    ${prefix}+ ${linkName} -> ${path.relative(MEMORY_ROOT, srcFile)}`);
        linksCreated++;
      } else {
        linksSkipped++;
      }

      // Обновляем статистику домена
      const stat = fs.statSync(srcFile);
      domainStats[rule.targetDomain].files++;
      domainStats[rule.targetDomain].size += stat.size;
      if (stat.mtime > domainStats[rule.targetDomain].lastModified) {
        domainStats[rule.targetDomain].lastModified = stat.mtime;
      }
    }
  }

  console.log(`\n  Итого: ${linksCreated} симлинков создано, ${linksSkipped} пропущено`);

  // ─── Шаг 4: Дополнительно сканируем уже имеющиеся файлы в knowledge/ ──

  // Считаем файлы, которые уже лежат в доменных папках (не симлинки)
  for (const domain of Object.keys(DOMAINS)) {
    const domainPath = path.join(KNOWLEDGE_ROOT, domain);
    if (!fs.existsSync(domainPath)) continue;

    const existing = collectFiles(domainPath, [".md", ".json", ".yaml", ".yml"], true);
    for (const f of existing) {
      try {
        // Не считаем симлинки повторно, только реальные файлы
        const lstats = fs.lstatSync(f);
        if (!lstats.isSymbolicLink()) {
          domainStats[domain].files++;
          domainStats[domain].size += lstats.size;
          if (lstats.mtime > domainStats[domain].lastModified) {
            domainStats[domain].lastModified = lstats.mtime;
          }
        }
      } catch {
        // Игнорируем битые симлинки
      }
    }
  }

  // ─── Шаг 5: Генерация MANIFEST.json ──────────────────────────────────

  console.log("\n--- Шаг 4: Генерация MANIFEST.json ---\n");

  /** @type {Record<string, { files: number, total_kb: number, last_updated: string }>} */
  const manifestDomains = {};
  let manifestTotalFiles = 0;
  let manifestTotalKb = 0;

  for (const [domain, stats] of Object.entries(domainStats)) {
    const totalKb = Math.round(stats.size / 1024);
    manifestDomains[domain] = {
      files: stats.files,
      total_kb: totalKb,
      last_updated: stats.lastModified.getTime() > 0 ? stats.lastModified.toISOString() : null,
    };
    manifestTotalFiles += stats.files;
    manifestTotalKb += totalKb;
  }

  const manifest = {
    domains: manifestDomains,
    total_files: manifestTotalFiles,
    total_kb: manifestTotalKb,
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
  };

  const manifestPath = path.join(KNOWLEDGE_ROOT, "MANIFEST.json");

  if (!dryRun) {
    ensureDir(KNOWLEDGE_ROOT, false);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  console.log(`  ${prefix}Записан: ${manifestPath}`);
  console.log(`  Содержимое:`);
  console.log(
    JSON.stringify(manifest, null, 2)
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  );

  // ─── Шаг 5: Итоговая сводка ──────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log("  ИТОГО");
  console.log(`${"=".repeat(60)}`);
  console.log(`  Директорий создано:   ${dirsCreated}`);
  console.log(`  Симлинков создано:    ${linksCreated}`);
  console.log(`  Симлинков пропущено:  ${linksSkipped}`);
  console.log(`  Всего файлов в vault: ${manifestTotalFiles}`);
  console.log(`  Общий размер:         ${manifestTotalKb} KB`);
  console.log(`  Daily logs:           ${dailyLogs.length} (не тронуты)`);

  console.log("\n  По доменам:");
  for (const [domain, stats] of Object.entries(domainStats).sort(
    (a, b) => b[1].files - a[1].files,
  )) {
    if (stats.files > 0) {
      console.log(
        `    ${domain.padEnd(14)} ${String(stats.files).padStart(3)} файлов, ${Math.round(stats.size / 1024)} KB`,
      );
    } else {
      console.log(`    ${domain.padEnd(14)}   0 файлов (пока пусто)`);
    }
  }

  if (dryRun) {
    console.log(`\n  Запустите без --dry-run для применения изменений:`);
    console.log(`  node ${path.basename(__filename)}`);
  }

  console.log("");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Использование: node vault-organizer.cjs [--dry-run] [--help]

Организует Obsidian vault и memory файлы в доменную структуру.
НЕ удаляет и не перемещает существующие файлы.

Опции:
  --dry-run    Показать план без внесения изменений
  --help, -h   Показать эту справку
`);
  process.exit(0);
}

organize({ dryRun });
