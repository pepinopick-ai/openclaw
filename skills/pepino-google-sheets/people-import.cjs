#!/usr/bin/env node
/**
 * people-import.cjs -- Bulk import клиентских профилей из Google Sheets в PPIS
 *
 * Читает лист "Продажи" из Pepino Sheets, извлекает уникальных клиентов,
 * создаёт базовые профили в ~/.openclaw/workspace/memory/people/clients/
 * и обновляет index.json.
 *
 * Идемпотентный: пропускает клиентов, для которых профиль уже существует.
 *
 * Зависимости: googleapis (уже установлен в проекте)
 *
 * Usage:  node people-import.cjs
 *         node people-import.cjs --dry-run
 *
 * Выход: JSON с отчётом { created, skipped, errors }
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// -- Константы ----------------------------------------------------------------

const PEPINO_SHEETS_ID = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";
const SALES_SHEET = "\u{1F6D2} Продажи"; // Лист "Продажи" (с эмодзи)
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "/home/roman/openclaw/google-credentials.json";

const PEOPLE_DIR = path.join(
  process.env.HOME || "/home/roman",
  ".openclaw/workspace/memory/people"
);
const CLIENTS_DIR = path.join(PEOPLE_DIR, "clients");
const INDEX_PATH = path.join(PEOPLE_DIR, "index.json");

const DRY_RUN = process.argv.includes("--dry-run");

// -- Google Sheets авторизация ------------------------------------------------

/** @returns {Promise<import('googleapis').google.auth.GoogleAuth>} */
async function getAuth() {
  // Динамический импорт для CJS-совместимости
  const { google } = require("googleapis");
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

/**
 * Читает данные из листа Google Sheets
 * @param {string} sheetName
 * @returns {Promise<string[][]>}
 */
async function readSheet(sheetName) {
  const { google } = require("googleapis");
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: PEPINO_SHEETS_ID,
    range: `'${sheetName}'`,
  });
  return response.data.values || [];
}

// -- Утилиты ------------------------------------------------------------------

/**
 * Генерирует стабильный 8-символьный ID из имени клиента
 * @param {string} name
 * @returns {string}
 */
function generateId(name) {
  return crypto
    .createHash("sha256")
    .update(name.trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
}

/**
 * Очищает имя клиента от лишних пробелов
 * @param {string} raw
 * @returns {string}
 */
function cleanName(raw) {
  return (raw || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Создаёт безопасное имя файла из имени клиента
 * @param {string} id
 * @param {string} name
 * @returns {string}
 */
function profileFileName(id, name) {
  const safeName = name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
  return `${id}_${safeName}.json`;
}

/**
 * Парсит число из строки (поддержка запятых и процентов)
 * @param {string} val
 * @returns {number}
 */
function parseNum(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/\./g, "").replace(",", ".").replace("%", "");
  return parseFloat(cleaned) || 0;
}

// -- Основная логика ----------------------------------------------------------

/**
 * Извлекает уникальных клиентов из данных продаж
 * @param {string[][]} rows -- сырые данные из Sheets (с заголовком)
 * @returns {Map<string, object>} -- Map<clientName, aggregatedData>
 */
function extractClients(rows) {
  if (rows.length < 2) return new Map();

  const headers = rows[0];
  // Определяем индексы колонок (гибко, по имени заголовка)
  // Реальный порядок: Дата | Клиент | Продукт | Кол-во кг | Цена ARS/кг | Сумма ARS |
  //                   Доставка ARS | Итого ARS | Курс USD | Сумма USD | Статус | Примечание
  const colIdx = {};
  headers.forEach((h, i) => {
    const hl = (h || "").toLowerCase().trim();
    if (hl.includes("дата") || hl === "fecha") colIdx.date = i;
    if (hl.includes("клиент") || hl === "cliente") colIdx.client = i;
    if (hl.includes("продукт") || hl === "producto") colIdx.product = i;
    if (hl.includes("кол") || hl.includes("qty") || hl.includes("cantidad")) colIdx.qty = i;
    if (hl === "сумма ars" || (hl.includes("сумма") && hl.includes("ars") && !hl.includes("usd") && !hl.includes("итого") && !hl.includes("доставка"))) colIdx.totalArs = i;
    if (hl.includes("итого")) colIdx.totalArsGross = i;
    if (hl.includes("сумма") && hl.includes("usd")) colIdx.totalUsd = i;
    if (hl.includes("статус") || hl === "status") colIdx.status = i;
  });

  // Fallback по позициям (если заголовки не распознаны)
  if (colIdx.client === undefined) colIdx.client = 1;
  if (colIdx.date === undefined) colIdx.date = 0;
  if (colIdx.product === undefined) colIdx.product = 2;
  if (colIdx.qty === undefined) colIdx.qty = 3;
  if (colIdx.totalArs === undefined) colIdx.totalArs = 5;
  if (colIdx.totalUsd === undefined) colIdx.totalUsd = 9;
  if (colIdx.status === undefined) colIdx.status = 10;

  /** @type {Map<string, {orders: number, revenue_ars: number, revenue_usd: number, products: Set<string>, first_order: string, last_order: string}>} */
  const clients = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const clientRaw = row[colIdx.client];
    if (!clientRaw || !clientRaw.trim()) continue;

    const name = cleanName(clientRaw);
    if (!name) continue;

    const date = (row[colIdx.date] || "").trim();
    const product = (row[colIdx.product] || "").trim();
    // Используем "Итого ARS" (с доставкой) если есть, иначе "Сумма ARS"
    const totalArs = parseNum(row[colIdx.totalArsGross] || row[colIdx.totalArs]);
    const totalUsd = parseNum(row[colIdx.totalUsd]);

    if (!clients.has(name)) {
      clients.set(name, {
        orders: 0,
        revenue_ars: 0,
        revenue_usd: 0,
        products: new Set(),
        first_order: date,
        last_order: date,
      });
    }

    const c = clients.get(name);
    c.orders++;
    c.revenue_ars += totalArs;
    c.revenue_usd += totalUsd;
    if (product) c.products.add(product);
    if (date && (!c.first_order || date < c.first_order)) c.first_order = date;
    if (date && date > c.last_order) c.last_order = date;
  }

  return clients;
}

/**
 * Определяет tier клиента по выручке
 * @param {number} revenueArs
 * @param {number} orders
 * @returns {string}
 */
function classifyTier(revenueArs, orders) {
  if (revenueArs > 500000 || orders > 20) return "A";
  if (revenueArs > 100000 || orders > 8) return "B";
  return "C";
}

/**
 * Определяет статус клиента по дате последнего заказа
 * @param {string} lastOrder -- формат YYYY-MM-DD или DD/MM/YYYY
 * @returns {string}
 */
function classifyStatus(lastOrder) {
  if (!lastOrder) return "unknown";
  // Нормализуем дату
  let dateStr = lastOrder;
  if (dateStr.includes("/")) {
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      dateStr = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
    }
  }
  const last = new Date(dateStr);
  if (isNaN(last.getTime())) return "unknown";

  const now = new Date();
  const daysSince = Math.floor((now - last) / (1000 * 60 * 60 * 24));

  if (daysSince <= 14) return "active";
  if (daysSince <= 30) return "recent";
  if (daysSince <= 60) return "at_risk";
  return "churned";
}

/**
 * Создаёт PPIS-совместимый профиль клиента
 * @param {string} name
 * @param {object} data -- агрегированные данные
 * @returns {object}
 */
function buildProfile(name, data) {
  const id = generateId(name);
  const tier = classifyTier(data.revenue_ars, data.orders);
  const status = classifyStatus(data.last_order);

  return {
    core_identity: {
      id,
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
    pepino_relationship: {
      type: "client",
      tier,
      status,
      first_order: data.first_order || null,
      last_order: data.last_order || null,
      total_orders: data.orders,
      total_revenue_ars: Math.round(data.revenue_ars),
      total_revenue_usd: Math.round(data.revenue_usd * 100) / 100,
      products_ordered: Array.from(data.products).sort(),
      notes: [],
    },
    interaction_history: [],
    metadata: {
      source: "sheets-import",
      created: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      ppis_version: "2.0",
    },
  };
}

/**
 * Ищет существующий профиль по ID клиента
 * @param {string} id
 * @returns {string|null} -- путь к файлу или null
 */
function findExistingProfile(id) {
  if (!fs.existsSync(CLIENTS_DIR)) return null;
  const files = fs.readdirSync(CLIENTS_DIR);
  const match = files.find((f) => f.startsWith(id + "_") && f.endsWith(".json"));
  return match ? path.join(CLIENTS_DIR, match) : null;
}

/**
 * Обновляет index.json с новыми профилями
 * @param {Array<{id: string, name: string, organization: string|null, file_path: string}>} newEntries
 */
function updateIndex(newEntries) {
  /** @type {{people: Array, relationships: Array, last_updated: string}} */
  let index = { people: [], relationships: [], last_updated: "" };

  if (fs.existsSync(INDEX_PATH)) {
    try {
      index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    } catch {
      // Повреждённый index -- пересоздаём
      console.error("[WARN] index.json повреждён, пересоздаю");
    }
  }

  const existingIds = new Set(index.people.map((p) => p.id));

  for (const entry of newEntries) {
    if (existingIds.has(entry.id)) continue;
    index.people.push({
      id: entry.id,
      name: entry.name,
      category: "clients",
      organization: entry.organization || null,
      role: "Cliente",
      file_path: entry.file_path,
      created: new Date().toISOString(),
    });
  }

  index.last_updated = new Date().toISOString();

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log("=== Pepino People Import ===");
  console.log(`Sheets ID: ${PEPINO_SHEETS_ID}`);
  console.log(`Target dir: ${CLIENTS_DIR}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log("");

  // Убедиться, что директория существует
  if (!DRY_RUN) {
    fs.mkdirSync(CLIENTS_DIR, { recursive: true });
  }

  // Читаем данные продаж из Sheets
  console.log(`Читаю лист "${SALES_SHEET}"...`);
  const salesRows = await readSheet(SALES_SHEET);
  console.log(`  Получено строк: ${salesRows.length} (включая заголовок)`);

  if (salesRows.length < 2) {
    console.log("Нет данных продаж. Выход.");
    process.exit(0);
  }

  // Извлекаем уникальных клиентов
  const clients = extractClients(salesRows);
  console.log(`  Уникальных клиентов: ${clients.size}`);
  console.log("");

  let created = 0;
  let skipped = 0;
  let updated = 0;
  const errors = [];
  const newIndexEntries = [];

  for (const [name, data] of clients) {
    const id = generateId(name);
    const existing = findExistingProfile(id);

    if (existing) {
      // Обновляем pepino_relationship в существующем профиле
      try {
        const existingProfile = JSON.parse(fs.readFileSync(existing, "utf-8"));
        const hasRelationship = existingProfile.pepino_relationship;

        if (hasRelationship) {
          // Обновляем только метрики продаж, не трогаем другие данные
          existingProfile.pepino_relationship.total_orders = data.orders;
          existingProfile.pepino_relationship.total_revenue_ars = Math.round(data.revenue_ars);
          existingProfile.pepino_relationship.total_revenue_usd =
            Math.round(data.revenue_usd * 100) / 100;
          existingProfile.pepino_relationship.last_order = data.last_order || null;
          existingProfile.pepino_relationship.products_ordered = Array.from(data.products).sort();
          existingProfile.pepino_relationship.status = classifyStatus(data.last_order);
          existingProfile.pepino_relationship.tier = classifyTier(data.revenue_ars, data.orders);
          // Удаляем устаревшее поле preferred_channels (было ошибочно заполнено числами)
          delete existingProfile.pepino_relationship.preferred_channels;
          existingProfile.metadata = existingProfile.metadata || {};
          existingProfile.metadata.last_updated = new Date().toISOString();

          if (!DRY_RUN) {
            fs.writeFileSync(existing, JSON.stringify(existingProfile, null, 2), "utf-8");
          }
          updated++;
          console.log(`  [UPDATE] ${name} (${id}) -- ${data.orders} orders, ${Math.round(data.revenue_ars)} ARS`);
        } else {
          skipped++;
          console.log(`  [SKIP] ${name} (${id}) -- профиль без pepino_relationship`);
        }
      } catch (err) {
        skipped++;
        console.log(`  [SKIP] ${name} (${id}) -- ошибка чтения: ${err.message}`);
      }
      continue;
    }

    // Создаём новый профиль
    const profile = buildProfile(name, data);
    const fileName = profileFileName(id, name);
    const filePath = path.join(CLIENTS_DIR, fileName);

    if (DRY_RUN) {
      console.log(`  [DRY] Создал бы: ${fileName} (tier ${profile.pepino_relationship.tier}, ${data.orders} orders)`);
    } else {
      try {
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
        console.log(`  [NEW] ${name} -> ${fileName} (tier ${profile.pepino_relationship.tier})`);
      } catch (err) {
        errors.push({ name, error: err.message });
        console.error(`  [ERR] ${name}: ${err.message}`);
        continue;
      }
    }

    created++;
    newIndexEntries.push({
      id,
      name,
      organization: null,
      file_path: filePath,
    });
  }

  // Обновляем index.json
  if (!DRY_RUN && newIndexEntries.length > 0) {
    updateIndex(newIndexEntries);
    console.log(`\nindex.json обновлён (+${newIndexEntries.length} записей)`);
  }

  // Финальный отчёт
  const report = {
    timestamp: new Date().toISOString(),
    dry_run: DRY_RUN,
    total_clients_in_sheets: clients.size,
    created,
    updated,
    skipped,
    errors: errors.length,
    error_details: errors,
  };

  console.log("\n=== ИТОГ ===");
  console.log(`Всего клиентов в Sheets: ${clients.size}`);
  console.log(`Создано новых профилей: ${created}`);
  console.log(`Обновлено существующих: ${updated}`);
  console.log(`Пропущено: ${skipped}`);
  if (errors.length > 0) {
    console.log(`Ошибки: ${errors.length}`);
    errors.forEach((e) => console.log(`  - ${e.name}: ${e.error}`));
  }

  // Записываем отчёт в файл
  if (!DRY_RUN) {
    const reportPath = path.join(PEOPLE_DIR, "last-import-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nОтчёт сохранён: ${reportPath}`);
  }

  return report;
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
