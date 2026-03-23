/**
 * knowledge-import.cjs
 *
 * Массовый импорт операционных данных из Sheets API (localhost:4000)
 * в knowledge graph Pepino Pick.
 *
 * Создаёт: entities (products, clients, capex-categories),
 *          relations (client->product), insights (финансовый обзор).
 *
 * Запуск: node knowledge-import.cjs
 * Без внешних зависимостей (только Node.js stdlib).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { apiHeaders } = require("./api-auth.cjs");

const API_BASE = "http://localhost:4000";
const GRAPH_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "pepino-graph"
);
const TODAY = new Date().toISOString().slice(0, 10);

// Счётчики для финального отчёта
const stats = {
  entities: 0,
  relations: 0,
  insights: 0,
  skipped: 0,
  errors: [],
};

// ---------- Утилиты ----------

/**
 * Санитизация имени файла: нижний регистр, пробелы -> дефисы, спецсимволы удалены.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zа-яё0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * HTTP GET запрос к API. Возвращает Promise<object[]>.
 * @param {string} endpoint - путь вида "/products"
 * @returns {Promise<any>}
 */
function fetchApi(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    http.get(url, { headers: apiHeaders() }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Ошибка парсинга ${endpoint}: ${err.message}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Создаёт директорию рекурсивно, если не существует.
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Записывает файл, если его нет (или force=true). Увеличивает счётчик.
 * @param {string} filePath
 * @param {string} content
 * @param {"entities"|"relations"|"insights"} counterKey
 * @param {boolean} [force=false]
 */
function writeGraphFile(filePath, content, counterKey, force = false) {
  if (!force && fs.existsSync(filePath)) {
    stats.skipped++;
    console.log(`  [SKIP] ${path.relative(GRAPH_DIR, filePath)} (уже существует)`);
    return;
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
  stats[counterKey]++;
  console.log(`  [NEW]  ${path.relative(GRAPH_DIR, filePath)}`);
}

/**
 * Форматирует число с разделителями тысяч.
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  if (n == null || isNaN(n)) return "N/A";
  return Math.round(n).toLocaleString("ru-RU");
}

// ---------- Импорт Products ----------

/**
 * @param {Array<{product: string, profit_per_m2_usd: number, margin_pct: number, area_m2: number, annual_profit_usd: number, priority: string, cycles_per_year: number, yield_kg_per_m2_cycle: number}>} products
 */
function importProducts(products) {
  console.log("\n--- Импорт продуктов ---");
  const productsDir = path.join(GRAPH_DIR, "01-entities", "products");

  for (const p of products) {
    const slug = sanitizeFilename(p.product);
    if (!slug) continue;

    const marginPct = Math.round((p.margin_pct || 0) * 100);
    const content = [
      "---",
      "type: entity",
      "entity_type: product",
      `name: ${p.product}`,
      `created: ${TODAY}`,
      `source: sheets-api`,
      "---",
      "",
      `# ${p.product}`,
      "",
      `- Площадь: ${p.area_m2} m2`,
      `- Циклов/год: ${p.cycles_per_year}`,
      `- Урожай: ${p.yield_kg_per_m2_cycle} кг/м2/цикл`,
      `- Маржа: ${marginPct}%`,
      `- Прибыль: $${p.profit_per_m2_usd}/м2/год`,
      `- Годовая прибыль: $${fmtNum(p.annual_profit_usd)}`,
      `- Приоритет: ${p.priority}`,
      "",
    ].join("\n");

    writeGraphFile(path.join(productsDir, `${slug}.md`), content, "entities");
  }
}

// ---------- Импорт Clients ----------

/**
 * @param {Array<{Клиент: string, Продукт: string, "Итого ARS": number, "Кол-во кг": number, Статус: string}>} sales
 */
function importClients(sales) {
  console.log("\n--- Импорт клиентов ---");
  const clientsDir = path.join(GRAPH_DIR, "01-entities", "clients");

  // Агрегация данных по клиентам
  /** @type {Record<string, {products: Set<string>, totalArs: number, orderCount: number, totalKg: number, statuses: Set<string>}>} */
  const clientMap = {};

  for (const s of sales) {
    const clientName = (s["Клиент"] || "").trim();
    if (!clientName) continue;

    if (!clientMap[clientName]) {
      clientMap[clientName] = {
        products: new Set(),
        totalArs: 0,
        orderCount: 0,
        totalKg: 0,
        statuses: new Set(),
      };
    }

    const c = clientMap[clientName];
    if (s["Продукт"]) c.products.add(s["Продукт"]);
    c.totalArs += Number(s["Итого ARS"]) || 0;
    c.totalKg += Number(s["Кол-во кг"]) || 0;
    c.orderCount++;
    if (s["Статус"]) c.statuses.add(s["Статус"]);
  }

  for (const [name, data] of Object.entries(clientMap)) {
    const slug = sanitizeFilename(name);
    if (!slug) continue;

    const productsList = [...data.products].join(", ") || "N/A";
    const statusList = [...data.statuses];
    const isActive = statusList.some((s) =>
      s.toLowerCase().includes("оплачен") || s.toLowerCase().includes("доставлен")
    );

    const content = [
      "---",
      "type: entity",
      "entity_type: client",
      `name: ${name}`,
      `created: ${TODAY}`,
      `source: sheets-api`,
      "---",
      "",
      `# ${name}`,
      "",
      `- Продукты: ${productsList}`,
      `- Общая сумма: ${fmtNum(data.totalArs)} ARS`,
      `- Всего кг: ${fmtNum(data.totalKg)}`,
      `- Количество заказов: ${data.orderCount}`,
      `- Статус: ${isActive ? "активный" : "неизвестный"}`,
      "",
    ].join("\n");

    writeGraphFile(path.join(clientsDir, `${slug}.md`), content, "entities");
  }

  return clientMap;
}

// ---------- Импорт CAPEX Categories ----------

/**
 * @param {Array<{Категория: string, Наименование: string, "Стоимость ARS": number, "Кол-во": number, "Цена шт ARS": number, Примечание: string}>} capex
 */
function importCapexCategories(capex) {
  console.log("\n--- Импорт CAPEX категорий ---");
  const capexDir = path.join(GRAPH_DIR, "01-entities", "capex");

  // Агрегация по категориям
  /** @type {Record<string, {items: string[], totalArs: number, count: number}>} */
  const catMap = {};

  for (const c of capex) {
    const cat = (c["Категория"] || "").trim();
    if (!cat) continue;

    if (!catMap[cat]) {
      catMap[cat] = { items: [], totalArs: 0, count: 0 };
    }

    const m = catMap[cat];
    if (c["Наименование"]) m.items.push(c["Наименование"]);
    m.totalArs += Number(c["Стоимость ARS"]) || 0;
    m.count += Number(c["Кол-во"]) || 0;
  }

  for (const [cat, data] of Object.entries(catMap)) {
    const slug = sanitizeFilename(cat);
    if (!slug) continue;

    const itemsList = data.items.length > 0
      ? data.items.map((i) => `  - ${i}`).join("\n")
      : "  - N/A";

    const content = [
      "---",
      "type: entity",
      "entity_type: capex-category",
      `name: ${cat}`,
      `created: ${TODAY}`,
      `source: sheets-api`,
      "---",
      "",
      `# CAPEX: ${cat}`,
      "",
      `- Общая стоимость: ${fmtNum(data.totalArs)} ARS`,
      `- Позиций: ${data.items.length}`,
      `- Единиц: ${data.count}`,
      "",
      "## Наименования",
      itemsList,
      "",
    ].join("\n");

    writeGraphFile(path.join(capexDir, `${slug}.md`), content, "entities");
  }
}

// ---------- Импорт Relations (client -> product) ----------

/**
 * @param {Array<{Клиент: string, Продукт: string, "Итого ARS": number, "Кол-во кг": number}>} sales
 */
function importRelations(sales) {
  console.log("\n--- Импорт связей ---");
  const relDir = path.join(GRAPH_DIR, "02-relations");

  // Уникальные пары клиент-продукт с агрегацией
  /** @type {Record<string, {client: string, product: string, totalArs: number, totalKg: number, count: number}>} */
  const pairMap = {};

  for (const s of sales) {
    const client = (s["Клиент"] || "").trim();
    const product = (s["Продукт"] || "").trim();
    if (!client || !product) continue;

    const key = `${client}::${product}`;
    if (!pairMap[key]) {
      pairMap[key] = { client, product, totalArs: 0, totalKg: 0, count: 0 };
    }
    pairMap[key].totalArs += Number(s["Итого ARS"]) || 0;
    pairMap[key].totalKg += Number(s["Кол-во кг"]) || 0;
    pairMap[key].count++;
  }

  for (const data of Object.values(pairMap)) {
    const clientSlug = sanitizeFilename(data.client);
    const productSlug = sanitizeFilename(data.product);
    if (!clientSlug || !productSlug) continue;

    const filename = `${clientSlug}--purchases--${productSlug}.md`;

    const content = [
      "---",
      "type: relation",
      `from: client/${clientSlug}`,
      `to: product/${productSlug}`,
      "relation: purchases",
      `created: ${TODAY}`,
      `source: sheets-api`,
      "---",
      "",
      `# ${data.client} -> ${data.product}`,
      "",
      `- Сумма: ${fmtNum(data.totalArs)} ARS`,
      `- Объём: ${fmtNum(data.totalKg)} кг`,
      `- Заказов: ${data.count}`,
      "",
    ].join("\n");

    writeGraphFile(path.join(relDir, filename), content, "relations");
  }
}

// ---------- Импорт Financial Insight ----------

/**
 * @param {Array<{month: string, revenue_ars: number, ebitda_ars: number, ebitda_pct: number, active_clients: number, revenue_usd: number, gross_margin_pct: number, harvest_mushroom_kg: number, harvest_microgreens_kg: number}>} kpi
 * @param {Array<{month: string, revenue: number, cogs: number, gross_margin: number, opex: number, ebitda: number, ebitda_pct: number}>} pnl
 */
function importFinancialInsight(kpi, pnl) {
  console.log("\n--- Импорт финансового инсайта ---");
  const insightsDir = path.join(GRAPH_DIR, "03-insights");

  // Берём последний месяц из KPI
  if (!kpi || kpi.length === 0) {
    console.log("  [WARN] Нет KPI данных, пропускаем финансовый инсайт");
    return;
  }

  const latestKpi = kpi[kpi.length - 1];
  const latestPnl = pnl && pnl.length > 0 ? pnl[pnl.length - 1] : null;

  const monthLabel = latestKpi.month || "Unknown";
  const ebitdaPct = latestKpi.ebitda_pct != null
    ? Math.round(latestKpi.ebitda_pct * 100)
    : (latestPnl && latestPnl.ebitda_pct != null ? Math.round(latestPnl.ebitda_pct * 100) : "N/A");
  const grossMarginPct = latestKpi.gross_margin_pct != null
    ? Math.round(latestKpi.gross_margin_pct * 100)
    : "N/A";

  // Рассчитываем ROI если есть данные за все месяцы
  const totalEbitda = kpi.reduce((sum, k) => sum + (Number(k.ebitda_ars) || 0), 0);

  // Сводка по всем месяцам для тренда
  const trendLines = kpi.map((k) => {
    const ePct = k.ebitda_pct != null ? Math.round(k.ebitda_pct * 100) : "?";
    return `| ${k.month} | ${fmtNum(k.revenue_ars)} | ${fmtNum(k.ebitda_ars)} | ${ePct}% | ${k.active_clients || "?"} |`;
  });

  const content = [
    "---",
    "type: insight",
    "category: financial",
    `date: ${TODAY}`,
    `source: sheets-api`,
    "---",
    "",
    `# Финансовый обзор (${monthLabel})`,
    "",
    "## Последний месяц",
    "",
    `- Выручка: ${fmtNum(latestKpi.revenue_ars)} ARS ($${fmtNum(latestKpi.revenue_usd)} USD)`,
    `- EBITDA: ${fmtNum(latestKpi.ebitda_ars)} ARS`,
    `- EBITDA маржа: ${ebitdaPct}%`,
    `- Валовая маржа: ${grossMarginPct}%`,
    `- Клиентов: ${latestKpi.active_clients || "N/A"}`,
    `- Грибы: ${fmtNum(latestKpi.harvest_mushroom_kg)} кг`,
    `- Микрозелень: ${fmtNum(latestKpi.harvest_microgreens_kg)} кг`,
    "",
    "## Тренд по месяцам",
    "",
    "| Месяц | Выручка ARS | EBITDA ARS | EBITDA % | Клиенты |",
    "|---|---|---|---|---|",
    ...trendLines,
    "",
    "## P&L (последний месяц)",
    "",
    ...(latestPnl
      ? [
          `- Выручка: ${fmtNum(latestPnl.revenue)} ARS`,
          `- COGS: ${fmtNum(latestPnl.cogs)} ARS`,
          `- Валовая маржа: ${fmtNum(latestPnl.gross_margin)} ARS`,
          `- OPEX: ${fmtNum(latestPnl.opex)} ARS`,
          `- EBITDA: ${fmtNum(latestPnl.ebitda)} ARS`,
        ]
      : ["- Нет данных P&L"]),
    "",
    "## Накопленные показатели",
    "",
    `- Суммарный EBITDA: ${fmtNum(totalEbitda)} ARS`,
    `- Месяцев данных: ${kpi.length}`,
    "",
  ].join("\n");

  const filename = `${TODAY}-financial-overview.md`;
  writeGraphFile(path.join(insightsDir, filename), content, "insights");
}

// ---------- Main ----------

async function main() {
  console.log(`=== Knowledge Import: ${TODAY} ===`);
  console.log(`Graph: ${GRAPH_DIR}`);

  if (!fs.existsSync(GRAPH_DIR)) {
    console.error(`Директория графа не найдена: ${GRAPH_DIR}`);
    process.exit(1);
  }

  // Параллельный запрос всех эндпоинтов
  let products, sales, kpi, pnl, capex;
  try {
    [products, sales, kpi, pnl, capex] = await Promise.all([
      fetchApi("/products"),
      fetchApi("/sales"),
      fetchApi("/kpi"),
      fetchApi("/pnl"),
      fetchApi("/capex"),
    ]);
  } catch (err) {
    console.error(`Ошибка при запросе API: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nПолучено из API:`);
  console.log(`  products: ${Array.isArray(products) ? products.length : "error"}`);
  console.log(`  sales:    ${Array.isArray(sales) ? sales.length : "error"}`);
  console.log(`  kpi:      ${Array.isArray(kpi) ? kpi.length : "error"}`);
  console.log(`  pnl:      ${Array.isArray(pnl) ? pnl.length : "error"}`);
  console.log(`  capex:    ${Array.isArray(capex) ? capex.length : "error"}`);

  // 1. Products -> Entities
  if (Array.isArray(products)) {
    importProducts(products);
  }

  // 2. Sales -> Client Entities
  if (Array.isArray(sales)) {
    importClients(sales);
  }

  // 3. CAPEX -> Category Entities
  if (Array.isArray(capex)) {
    importCapexCategories(capex);
  }

  // 4. Sales -> Relations (client->product)
  if (Array.isArray(sales)) {
    importRelations(sales);
  }

  // 5. KPI + PnL -> Financial Insight
  importFinancialInsight(
    Array.isArray(kpi) ? kpi : [],
    Array.isArray(pnl) ? pnl : []
  );

  // 6. Обновление MANIFEST
  const manifestScript = path.join(
    __dirname,
    "update-manifest.cjs"
  );
  if (fs.existsSync(manifestScript)) {
    console.log("\n--- Обновление MANIFEST ---");
    try {
      require(manifestScript);
    } catch (err) {
      console.log(`  [WARN] Ошибка обновления MANIFEST: ${err.message}`);
    }
  }

  // Итог
  console.log("\n=== Результат импорта ===");
  console.log(`  Entities создано:  ${stats.entities}`);
  console.log(`  Relations создано: ${stats.relations}`);
  console.log(`  Insights создано:  ${stats.insights}`);
  console.log(`  Пропущено (уже есть): ${stats.skipped}`);
  if (stats.errors.length > 0) {
    console.log(`  Ошибки: ${stats.errors.length}`);
    for (const e of stats.errors) {
      console.log(`    - ${e}`);
    }
  }
  console.log("=== Готово ===");
}

main().catch((err) => {
  console.error(`Фатальная ошибка: ${err.message}`);
  process.exit(1);
});
