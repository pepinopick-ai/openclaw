#!/usr/bin/env node
/**
 * Pepino Pick — Memory Maintenance (еженедельное обслуживание памяти)
 *
 * 1. Архивация старых эпизодов (>90 дней) из episodes/ в archive/
 * 2. Обогащение профилей клиентов из данных продаж (avg order, frequency, total spend)
 * 3. Обнаружение устаревших знаний (>30 дней без обновления) в knowledge/
 * 4. Отправка health-отчёта в Telegram
 *
 * Cron: 0 9 * * 0 (воскресенье, 09:00)
 * Usage: node memory-maintenance.cjs [--dry-run]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendReport } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_ID = 20;

const HOME = process.env.HOME || "/root";
const MEMORY_BASE = path.join(HOME, ".openclaw", "workspace", "memory");
const EPISODES_DIR = path.join(MEMORY_BASE, "episodes");
const ARCHIVE_DIR = path.join(MEMORY_BASE, "archive");
const KNOWLEDGE_DIR = path.join(MEMORY_BASE, "knowledge");
const CLIENTS_DIR = path.join(MEMORY_BASE, "people", "clients");

const ARCHIVE_THRESHOLD_DAYS = 90;
const STALE_THRESHOLD_DAYS = 30;

// ── Утилиты ─────────────────────────────────────────────────────────────────

/** Разница в днях между двумя датами */
function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

/** Рекурсивно получить все файлы в директории */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

/** Безопасное создание директории */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Генерация короткого ID для клиента */
function clientId(name) {
  return crypto.createHash("md5").update(name).digest("hex").slice(0, 8);
}

// ── 1. Архивация старых эпизодов ────────────────────────────────────────────

function archiveOldEpisodes() {
  const now = new Date();
  const files = listFiles(EPISODES_DIR);
  const archived = [];
  const errors = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const ageDays = daysBetween(stat.mtime, now);

      if (ageDays > ARCHIVE_THRESHOLD_DAYS) {
        // Сохраняем относительный путь для воссоздания структуры в archive/
        const relPath = path.relative(EPISODES_DIR, filePath);
        const destPath = path.join(ARCHIVE_DIR, "episodes", relPath);

        if (DRY_RUN) {
          console.log(`[DRY-RUN] Архивировать: ${relPath} (${ageDays} дней)`);
        } else {
          ensureDir(path.dirname(destPath));
          fs.renameSync(filePath, destPath);
        }
        archived.push({ file: relPath, ageDays });
      }
    } catch (err) {
      errors.push({ file: filePath, error: err.message });
    }
  }

  return { archived, errors, totalScanned: files.length };
}

// ── 2. Обогащение профилей клиентов ─────────────────────────────────────────

async function enrichClientProfiles() {
  let sales;
  try {
    const { readSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
    const rows = await readSheet(PEPINO_SHEETS_ID, "\u{1F6D2} Продажи");
    if (!rows || rows.length < 2) {
      console.log("[enrichment] Нет данных продаж в Sheets.");
      return { updated: 0, created: 0, errors: [] };
    }
    const headers = rows[0];
    sales = rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || "";
      });
      return obj;
    });
  } catch (err) {
    console.error(`[enrichment] Ошибка чтения Sheets: ${err.message}`);
    return { updated: 0, created: 0, errors: [err.message] };
  }

  console.log(`[enrichment] Загружено ${sales.length} записей продаж`);

  // Группируем по клиентам
  /** @type {Record<string, {orders: Array<{date: Date, total: number, product: string}>}>} */
  const clientMap = {};

  for (const sale of sales) {
    const client = sale["\u041A\u043B\u0438\u0435\u043D\u0442"] || sale["client"] || "";
    if (!client || client === "\u0422\u0435\u0441\u0442" || client === "test") continue;

    const dateStr = sale["\u0414\u0430\u0442\u0430"] || sale["date"] || "";
    if (!dateStr) continue;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    const total =
      parseFloat(
        sale["\u0418\u0442\u043E\u0433\u043E ARS"] ||
          sale["\u0421\u0443\u043C\u043C\u0430 ARS"] ||
          sale["\u0421\u0443\u043C\u043C\u0430"] ||
          sale["Total"] ||
          "0",
      ) || 0;

    const product =
      sale["\u041F\u0440\u043E\u0434\u0443\u043A\u0442"] ||
      sale["\u0422\u043E\u0432\u0430\u0440"] ||
      sale["product"] ||
      "";

    if (!clientMap[client]) {
      clientMap[client] = { orders: [] };
    }
    clientMap[client].orders.push({ date, total, product });
  }

  let updated = 0;
  let created = 0;
  const errors = [];

  ensureDir(CLIENTS_DIR);

  for (const [name, data] of Object.entries(clientMap)) {
    try {
      // Сортируем заказы по дате
      data.orders.sort((a, b) => a.date - b.date);

      const orderCount = data.orders.length;
      const totalSpend = data.orders.reduce((s, o) => s + o.total, 0);
      const avgOrderSize = orderCount > 0 ? Math.round(totalSpend / orderCount) : 0;
      const firstOrder = data.orders[0].date.toISOString().slice(0, 10);
      const lastOrder = data.orders[orderCount - 1].date.toISOString().slice(0, 10);

      // Частота: средний интервал между заказами (в днях)
      let avgFrequencyDays = null;
      if (orderCount >= 2) {
        const totalDays = daysBetween(data.orders[0].date, data.orders[orderCount - 1].date);
        avgFrequencyDays = Math.round(totalDays / (orderCount - 1));
      }

      // Уникальные продукты
      const products = [...new Set(data.orders.map((o) => o.product).filter(Boolean))];

      // Статус клиента
      const now = new Date();
      const daysSinceLast = daysBetween(data.orders[orderCount - 1].date, now);
      let status = "active";
      if (daysSinceLast > 30) status = "churned";
      else if (daysSinceLast > 14) status = "at_risk";

      // Определяем tier по выручке
      let tier = "C";
      if (totalSpend > 500000) tier = "A";
      else if (totalSpend > 100000) tier = "B";

      // Ищем существующий профиль
      const cid = clientId(name);
      // Проверяем оба варианта имени файла (с ID и без)
      const possibleFiles = fs
        .readdirSync(CLIENTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .filter((f) => f.includes(cid) || f.includes(name.replace(/\s+/g, "_")));

      let profilePath;
      let existingProfile = null;

      if (possibleFiles.length > 0) {
        profilePath = path.join(CLIENTS_DIR, possibleFiles[0]);
        try {
          existingProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        } catch {
          existingProfile = null;
        }
      } else {
        const safeName = name.replace(/[^a-zA-Z0-9\u0400-\u04FF_-]/g, "_");
        profilePath = path.join(CLIENTS_DIR, `${cid}_${safeName}.json`);
      }

      // Обновляем или создаём профиль
      const profile = existingProfile || {
        core_identity: {
          id: cid,
          full_name: name,
          aliases: [],
          date_of_birth: null,
          nationality: null,
          languages: [],
          current_location: null,
          photo_reference: null,
        },
        professional_identity: {
          current_role: "Cliente",
          organization: null,
          industry: "Food & Beverage",
          career_history: [],
          education: [],
          professional_network: [],
          reputation_markers: {
            industry_recognition: "low",
            thought_leader: false,
            controversial_figure: false,
          },
        },
        pepino_relationship: {},
        interaction_history: existingProfile?.interaction_history || [],
        metadata: {
          source: "memory-maintenance",
          created: new Date().toISOString(),
          ppis_version: "2.0",
        },
      };

      // Обновляем pepino_relationship с рассчитанными данными
      profile.pepino_relationship = {
        ...profile.pepino_relationship,
        type: "client",
        tier,
        status,
        first_order: firstOrder,
        last_order: lastOrder,
        total_orders: orderCount,
        total_revenue_ars: Math.round(totalSpend),
        avg_order_size_ars: avgOrderSize,
        avg_frequency_days: avgFrequencyDays,
        days_since_last_order: daysSinceLast,
        products_ordered: products,
      };

      profile.metadata.last_updated = new Date().toISOString();
      profile.metadata.last_enrichment = new Date().toISOString();

      if (DRY_RUN) {
        console.log(
          `[DRY-RUN] ${existingProfile ? "Обновить" : "Создать"}: ${name} — ${orderCount} заказов, ${Math.round(totalSpend)} ARS`,
        );
      } else {
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
      }

      if (existingProfile) updated++;
      else created++;
    } catch (err) {
      errors.push({ client: name, error: err.message });
    }
  }

  return { updated, created, errors, totalClients: Object.keys(clientMap).length };
}

// ── 3. Обнаружение устаревших знаний ────────────────────────────────────────

function detectStaleKnowledge() {
  const now = new Date();
  const staleFiles = [];
  const allFiles = [];

  // Проходим по всем поддиректориям knowledge/
  const subdirs = ["clients", "products", "rules", "suppliers"];
  for (const sub of subdirs) {
    const dir = path.join(KNOWLEDGE_DIR, sub);
    const files = listFiles(dir);
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        const ageDays = daysBetween(stat.mtime, now);
        const relPath = path.relative(KNOWLEDGE_DIR, filePath);
        allFiles.push({ file: relPath, ageDays });

        if (ageDays > STALE_THRESHOLD_DAYS) {
          staleFiles.push({
            file: relPath,
            ageDays,
            lastModified: stat.mtime.toISOString().slice(0, 10),
          });
        }
      } catch {
        // Пропускаем проблемные файлы
      }
    }
  }

  // Также проверяем файлы в корне knowledge/
  if (fs.existsSync(KNOWLEDGE_DIR)) {
    for (const entry of fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })) {
      if (entry.isFile()) {
        const filePath = path.join(KNOWLEDGE_DIR, entry.name);
        try {
          const stat = fs.statSync(filePath);
          const ageDays = daysBetween(stat.mtime, now);
          allFiles.push({ file: entry.name, ageDays });

          if (ageDays > STALE_THRESHOLD_DAYS) {
            staleFiles.push({
              file: entry.name,
              ageDays,
              lastModified: stat.mtime.toISOString().slice(0, 10),
            });
          }
        } catch {
          // Пропускаем
        }
      }
    }
  }

  // Сортируем по возрасту (самые старые первые)
  staleFiles.sort((a, b) => b.ageDays - a.ageDays);

  return { staleFiles, totalFiles: allFiles.length };
}

// ── 4. Метрики здоровья памяти ──────────────────────────────────────────────

function calculateMemoryHealth() {
  const stats = {
    totalFiles: 0,
    totalSizeMb: 0,
    directories: {},
  };

  if (!fs.existsSync(MEMORY_BASE)) {
    return stats;
  }

  const topDirs = fs
    .readdirSync(MEMORY_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const dir of topDirs) {
    const dirPath = path.join(MEMORY_BASE, dir);
    const files = listFiles(dirPath);
    let dirSize = 0;
    for (const f of files) {
      try {
        dirSize += fs.statSync(f).size;
      } catch {
        // Пропускаем
      }
    }
    stats.directories[dir] = {
      files: files.length,
      sizeMb: +(dirSize / 1024 / 1024).toFixed(2),
    };
    stats.totalFiles += files.length;
    stats.totalSizeMb += dirSize / 1024 / 1024;
  }

  // Считаем файлы в корне memory/
  const rootFiles = fs.readdirSync(MEMORY_BASE, { withFileTypes: true }).filter((e) => e.isFile());
  let rootSize = 0;
  for (const f of rootFiles) {
    try {
      rootSize += fs.statSync(path.join(MEMORY_BASE, f.name)).size;
    } catch {
      // Пропускаем
    }
  }
  stats.directories["(root)"] = {
    files: rootFiles.length,
    sizeMb: +(rootSize / 1024 / 1024).toFixed(2),
  };
  stats.totalFiles += rootFiles.length;
  stats.totalSizeMb += rootSize / 1024 / 1024;
  stats.totalSizeMb = +stats.totalSizeMb.toFixed(2);

  return stats;
}

// ── Форматирование отчёта ───────────────────────────────────────────────────

function formatReport(archiveResult, enrichResult, staleResult, healthStats) {
  const lines = [];
  const d = new Date().toISOString().slice(0, 10);
  lines.push(`<b>🧠 Memory Maintenance Report — ${d}</b>`);
  if (DRY_RUN) lines.push("<i>(DRY RUN — изменения не применены)</i>");
  lines.push("");

  // Архивация
  lines.push("<b>1. Архивация эпизодов</b>");
  if (archiveResult.archived.length > 0) {
    lines.push(
      `  Архивировано: ${archiveResult.archived.length} файлов (из ${archiveResult.totalScanned})`,
    );
    for (const f of archiveResult.archived.slice(0, 5)) {
      lines.push(`  • ${f.file} (${f.ageDays}д)`);
    }
    if (archiveResult.archived.length > 5) {
      lines.push(`  ... и ещё ${archiveResult.archived.length - 5}`);
    }
  } else {
    lines.push(
      `  Нет файлов старше ${ARCHIVE_THRESHOLD_DAYS} дней (проверено: ${archiveResult.totalScanned})`,
    );
  }
  if (archiveResult.errors.length > 0) {
    lines.push(`  Ошибки: ${archiveResult.errors.length}`);
  }
  lines.push("");

  // Обогащение клиентов
  lines.push("<b>2. Профили клиентов</b>");
  if (enrichResult) {
    lines.push(`  Всего клиентов: ${enrichResult.totalClients || 0}`);
    lines.push(`  Обновлено: ${enrichResult.updated}, Создано: ${enrichResult.created}`);
    if (enrichResult.errors && enrichResult.errors.length > 0) {
      lines.push(`  Ошибки: ${enrichResult.errors.length}`);
    }
  } else {
    lines.push("  Пропущено (ошибка чтения данных)");
  }
  lines.push("");

  // Устаревшие знания
  lines.push("<b>3. Устаревшие знания</b>");
  if (staleResult.staleFiles.length > 0) {
    lines.push(`  Устарело: ${staleResult.staleFiles.length} из ${staleResult.totalFiles} файлов`);
    for (const f of staleResult.staleFiles.slice(0, 5)) {
      lines.push(`  • ${f.file} (${f.ageDays}д, ${f.lastModified})`);
    }
    if (staleResult.staleFiles.length > 5) {
      lines.push(`  ... и ещё ${staleResult.staleFiles.length - 5}`);
    }
  } else {
    lines.push(`  Все ${staleResult.totalFiles} файлов актуальны`);
  }
  lines.push("");

  // Здоровье памяти
  lines.push("<b>4. Здоровье памяти</b>");
  lines.push(`  Файлов: ${healthStats.totalFiles}, Размер: ${healthStats.totalSizeMb} MB`);
  const topDirs = Object.entries(healthStats.directories)
    .sort((a, b) => b[1].sizeMb - a[1].sizeMb)
    .slice(0, 5);
  for (const [dir, info] of topDirs) {
    lines.push(`  • ${dir}: ${info.files} файлов, ${info.sizeMb} MB`);
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const prefix = DRY_RUN ? "[DRY-RUN] " : "";
  console.log(`[${new Date().toISOString()}] ${prefix}Memory maintenance starting...`);

  // 1. Архивация старых эпизодов
  console.log("\n--- 1. Архивация эпизодов ---");
  const archiveResult = archiveOldEpisodes();
  console.log(
    `Проверено: ${archiveResult.totalScanned}, архивировано: ${archiveResult.archived.length}`,
  );

  // 2. Обогащение профилей клиентов
  console.log("\n--- 2. Обогащение профилей клиентов ---");
  let enrichResult;
  try {
    enrichResult = await enrichClientProfiles();
    console.log(`Обновлено: ${enrichResult.updated}, создано: ${enrichResult.created}`);
  } catch (err) {
    console.error(`[ERROR] enrichment: ${err.message}`);
    enrichResult = { updated: 0, created: 0, errors: [err.message], totalClients: 0 };
  }

  // 3. Обнаружение устаревших знаний
  console.log("\n--- 3. Устаревшие знания ---");
  const staleResult = detectStaleKnowledge();
  console.log(`Устарело: ${staleResult.staleFiles.length} из ${staleResult.totalFiles}`);

  // 4. Здоровье памяти
  console.log("\n--- 4. Здоровье памяти ---");
  const healthStats = calculateMemoryHealth();
  console.log(`Файлов: ${healthStats.totalFiles}, размер: ${healthStats.totalSizeMb} MB`);

  // Формируем и отправляем отчёт
  const report = formatReport(archiveResult, enrichResult, staleResult, healthStats);
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  if (!DRY_RUN) {
    try {
      const tgResult = await sendReport(report, TG_THREAD_ID, "HTML");
      if (tgResult.ok) {
        console.log("[OK] Отчёт отправлен в Telegram");
      } else {
        console.error(`[ERROR] Telegram: ${tgResult.error}`);
      }
    } catch (err) {
      console.error(`[ERROR] Telegram: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Отчёт НЕ отправлен в Telegram");
  }

  // Langfuse trace
  await trace({
    name: "memory-maintenance",
    input: {
      dry_run: DRY_RUN,
      episodes_scanned: archiveResult.totalScanned,
      knowledge_scanned: staleResult.totalFiles,
    },
    output: {
      archived: archiveResult.archived.length,
      clients_updated: enrichResult.updated,
      clients_created: enrichResult.created,
      stale_knowledge: staleResult.staleFiles.length,
      total_memory_files: healthStats.totalFiles,
      total_memory_mb: healthStats.totalSizeMb,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "memory-maintenance" },
  }).catch(() => {});

  console.log(`\nDone in ${Date.now() - startMs}ms`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
