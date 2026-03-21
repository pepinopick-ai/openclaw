/**
 * HoReCa AI SaaS — Core Engine
 *
 * Мультитенантная платформа автоматизации ресторанов.
 * Каждый ресторан = 1 Google Sheet (из шаблона) + запись в tenants.json.
 *
 * Модули аналитики:
 *   waste   — процент потерь по продуктам (инвентарь vs продажи)
 *   demand  — прогноз спроса на неделю (day-of-week паттерны)
 *   margin  — маржа по блюдам, алерт если <30%
 *   alerts  — агрегация алертов всех модулей, отправка в Telegram
 *
 * CLI:
 *   node horeca-engine.cjs create "El Patio" "+5493516123456" pro
 *   node horeca-engine.cjs list
 *   node horeca-engine.cjs run <tenantId> <module>
 *   node horeca-engine.cjs run-all <module>
 *   node horeca-engine.cjs report <tenantId> week
 *   node horeca-engine.cjs --dry-run run <tenantId> demand
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Зависимости (переиспользуем инфраструктуру Pepino) ──────────────────────

const { trace } = require("/home/roman/openclaw/skills/pepino-google-sheets/langfuse-trace.cjs");
const { send } = require("/home/roman/openclaw/skills/pepino-google-sheets/telegram-helper.cjs");

// ── Константы ────────────────────────────────────────────────────────────────

const TENANTS_PATH = path.join(__dirname, "tenants.json");

/** Листы, создаваемые в каждом новом Sheet ресторана */
const TEMPLATE_SHEETS = ["📦 Inventario", "🍽 Ventas", "💰 Costos", "📊 Menu", "⚠️ Alertas"];

/** Заголовки шаблонов для каждого листа */
const SHEET_HEADERS = {
  "📦 Inventario": [
    ["Fecha", "Producto", "Cantidad_Inicio", "Cantidad_Fin", "Unidad", "Costo_Unitario"],
  ],
  "🍽 Ventas": [["Fecha", "Plato", "Cantidad", "Precio_Unitario", "Total", "Turno"]],
  "💰 Costos": [["Fecha", "Categoría", "Descripción", "Monto", "Proveedor"]],
  "📊 Menu": [["Plato", "Ingredientes", "Costo_Receta", "Precio_Venta", "Categoría", "Activo"]],
  "⚠️ Alertas": [["Fecha", "Módulo", "Severidad", "Mensaje", "Estado"]],
};

/** Пороги алертов */
const THRESHOLDS = {
  wastePercent: 15, // >15% потерь = алерт
  minMarginPercent: 30, // <30% маржи = алерт
};

/** Доступные планы и их модули */
const PLANS = {
  starter: ["waste", "alerts"],
  pro: ["waste", "demand", "margin", "alerts"],
  enterprise: ["waste", "demand", "margin", "alerts"],
};

// ── Флаг dry-run ─────────────────────────────────────────────────────────────

let DRY_RUN = false;

// ── Lazy-load ESM sheets.js (CJS -> ESM bridge) ─────────────────────────────

let _sheetsModule = null;

async function getSheetsModule() {
  if (!_sheetsModule) {
    _sheetsModule = await import("/home/roman/openclaw/skills/pepino-google-sheets/sheets.js");
  }
  return _sheetsModule;
}

// ── Tenant Registry ──────────────────────────────────────────────────────────

/**
 * Загрузить реестр тенантов из tenants.json.
 * @returns {{ tenants: Array<TenantConfig> }}
 */
function loadRegistry() {
  if (!fs.existsSync(TENANTS_PATH)) {
    const empty = { tenants: [] };
    fs.writeFileSync(TENANTS_PATH, JSON.stringify(empty, null, 2), "utf-8");
    return empty;
  }
  return JSON.parse(fs.readFileSync(TENANTS_PATH, "utf-8"));
}

/**
 * Сохранить реестр тенантов.
 * @param {{ tenants: Array<TenantConfig> }} registry
 */
function saveRegistry(registry) {
  if (DRY_RUN) {
    console.log("[dry-run] Пропуск записи tenants.json");
    return;
  }
  fs.writeFileSync(TENANTS_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Получить конфигурацию тенанта по ID.
 * @param {string} tenantId
 * @returns {TenantConfig | null}
 */
function getTenant(tenantId) {
  const registry = loadRegistry();
  return registry.tenants.find((t) => t.id === tenantId && t.status === "active") || null;
}

/**
 * Список всех активных тенантов.
 * @returns {Array<TenantConfig>}
 */
function listTenants() {
  const registry = loadRegistry();
  return registry.tenants.filter((t) => t.status === "active");
}

// ── Tenant Creation ──────────────────────────────────────────────────────────

/**
 * Создать нового тенанта: Google Sheet + запись в реестр.
 *
 * @param {string} name — Название ресторана
 * @param {string} ownerPhone — Телефон владельца
 * @param {string} plan — План (starter|pro|enterprise)
 * @returns {Promise<{ tenantId: string, spreadsheetId: string }>}
 */
async function createTenant(name, ownerPhone, plan) {
  const startMs = Date.now();

  // Валидация плана
  if (!PLANS[plan]) {
    throw new Error(`Неизвестный план: "${plan}". Доступные: ${Object.keys(PLANS).join(", ")}`);
  }

  // Валидация телефона (базовая)
  if (!ownerPhone || !ownerPhone.startsWith("+")) {
    throw new Error("Телефон должен начинаться с + (международный формат)");
  }

  const tenantId = `restaurant-${crypto.randomUUID().slice(0, 8)}`;

  console.log(`[horeca] Создание тенанта "${name}" (${plan})...`);

  let spreadsheetId = "PLACEHOLDER_NO_SHEET_CREATED";

  if (DRY_RUN) {
    console.log("[dry-run] Пропуск создания Google Sheet");
    console.log(`[dry-run] Шаблонные листы: ${TEMPLATE_SHEETS.join(", ")}`);
  } else {
    spreadsheetId = await createTenantSpreadsheet(name);
  }

  const tenant = {
    id: tenantId,
    name,
    owner: name, // владелец = название по умолчанию, можно переопределить позже
    phone: ownerPhone,
    spreadsheetId,
    telegramChatId: null, // настраивается отдельно
    plan,
    modules: PLANS[plan],
    createdAt: new Date().toISOString().slice(0, 10),
    status: "active",
  };

  const registry = loadRegistry();
  registry.tenants.push(tenant);
  saveRegistry(registry);

  const durationMs = Date.now() - startMs;
  console.log(`[horeca] Тенант создан: ${tenantId} (${durationMs}ms)`);
  console.log(`[horeca] Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

  await trace({
    name: "horeca/create-tenant",
    input: { name, plan, phone: ownerPhone.slice(0, 6) + "***" },
    output: { tenantId, spreadsheetId },
    duration_ms: durationMs,
    metadata: { module: "horeca-engine" },
  });

  return { tenantId, spreadsheetId };
}

/**
 * Создать Google Sheet для тенанта с шаблонными листами и заголовками.
 *
 * @param {string} restaurantName
 * @returns {Promise<string>} spreadsheetId
 */
async function createTenantSpreadsheet(restaurantName) {
  const { readFileSync } = require("fs");
  const { google } = await import("googleapis");

  const CREDENTIALS_PATH =
    process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Создаём новый Spreadsheet с нужными листами
  const createRes = await sheets.spreadsheets.create({
    resource: {
      properties: {
        title: `HoReCa — ${restaurantName}`,
      },
      sheets: TEMPLATE_SHEETS.map((title, idx) => ({
        properties: {
          title,
          index: idx,
        },
      })),
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;

  // Записываем заголовки в каждый лист
  const { writeToSheet } = await getSheetsModule();
  for (const sheetName of TEMPLATE_SHEETS) {
    const headers = SHEET_HEADERS[sheetName];
    if (headers) {
      await writeToSheet(spreadsheetId, headers, sheetName);
    }
  }

  return spreadsheetId;
}

// ── Аналитические модули ─────────────────────────────────────────────────────

/**
 * Запустить модуль аналитики для одного тенанта.
 *
 * @param {string} tenantId
 * @param {string} moduleName — waste|demand|margin|alerts
 * @returns {Promise<ModuleResult>}
 */
async function runModule(tenantId, moduleName) {
  const startMs = Date.now();

  const tenant = getTenant(tenantId);
  if (!tenant) {
    throw new Error(`Тенант не найден или неактивен: ${tenantId}`);
  }

  if (!tenant.modules.includes(moduleName)) {
    throw new Error(
      `Модуль "${moduleName}" недоступен для плана "${tenant.plan}". ` +
        `Доступные: ${tenant.modules.join(", ")}`,
    );
  }

  console.log(`[horeca] Запуск модуля "${moduleName}" для "${tenant.name}" (${tenantId})...`);

  /** @type {ModuleResult} */
  let result;

  switch (moduleName) {
    case "waste":
      result = await moduleWaste(tenant);
      break;
    case "demand":
      result = await moduleDemand(tenant);
      break;
    case "margin":
      result = await moduleMargin(tenant);
      break;
    case "alerts":
      result = await moduleAlerts(tenant);
      break;
    default:
      throw new Error(`Неизвестный модуль: "${moduleName}"`);
  }

  const durationMs = Date.now() - startMs;

  await trace({
    name: `horeca/module/${moduleName}`,
    input: { tenantId, tenantName: tenant.name },
    output: { alertCount: result.alerts.length, summary: result.summary },
    duration_ms: durationMs,
    metadata: { module: "horeca-engine", plan: tenant.plan },
  });

  console.log(`[horeca] Модуль "${moduleName}" завершён (${durationMs}ms): ${result.summary}`);
  return result;
}

/**
 * Запустить модуль для ВСЕХ активных тенантов (для cron).
 *
 * @param {string} moduleName
 * @returns {Promise<Array<{ tenantId: string, result: ModuleResult | null, error: string | null }>>}
 */
async function runAllTenants(moduleName) {
  const tenants = listTenants();

  if (tenants.length === 0) {
    console.log("[horeca] Нет активных тенантов");
    return [];
  }

  console.log(`[horeca] Запуск "${moduleName}" для ${tenants.length} тенантов...`);

  const results = [];

  for (const tenant of tenants) {
    try {
      // Проверяем доступность модуля для плана тенанта
      if (!tenant.modules.includes(moduleName)) {
        console.log(
          `[horeca] Пропуск "${tenant.name}" — модуль "${moduleName}" не в плане "${tenant.plan}"`,
        );
        results.push({ tenantId: tenant.id, result: null, error: null });
        continue;
      }
      const result = await runModule(tenant.id, moduleName);
      results.push({ tenantId: tenant.id, result, error: null });
    } catch (err) {
      console.error(`[horeca] Ошибка для "${tenant.name}": ${err.message}`);
      results.push({ tenantId: tenant.id, result: null, error: err.message });
    }
  }

  return results;
}

// ── Модуль: Waste (потери) ───────────────────────────────────────────────────

/**
 * Рассчитать процент потерь по продуктам.
 * Потери = (Cantidad_Inicio - Cantidad_Fin) - использованное_в_продажах.
 * Если waste% > 15% — алерт.
 *
 * @param {TenantConfig} tenant
 * @returns {Promise<ModuleResult>}
 */
async function moduleWaste(tenant) {
  const { readSheet } = await getSheetsModule();

  const inventoryRows = await readSheet(tenant.spreadsheetId, "📦 Inventario");
  const salesRows = await readSheet(tenant.spreadsheetId, "🍽 Ventas");

  // Пропускаем заголовки
  const inventory = inventoryRows.slice(1);
  const _salesData = salesRows.slice(1);

  // Агрегируем использование продуктов по продажам (приблизительно)
  // Поскольку Ventas = блюда, а Inventario = ингредиенты, считаем общие потери
  // по разнице начального и конечного количества инвентаря

  /** @type {Map<string, { inicio: number, fin: number, costoUnit: number }>} */
  const productMap = new Map();

  for (const row of inventory) {
    const producto = (row[1] || "").trim();
    if (!producto) {
      continue;
    }

    const inicio = parseFloat(row[2]) || 0;
    const fin = parseFloat(row[3]) || 0;
    const costoUnit = parseFloat(row[5]) || 0;

    const existing = productMap.get(producto);
    if (existing) {
      existing.inicio += inicio;
      existing.fin += fin;
    } else {
      productMap.set(producto, { inicio, fin, costoUnit });
    }
  }

  const alerts = [];
  const details = [];

  for (const [producto, data] of productMap) {
    const consumed = data.inicio - data.fin;
    if (data.inicio === 0) {
      continue;
    }

    // Потери как % от начального запаса
    // Упрощённая формула: waste = 100 - (fin / inicio * 100) учитывает все расходы
    // Более точная: нужно вычесть продажи, но без связки продукт<->блюдо считаем общий waste
    const wastePercent = consumed > 0 ? (consumed / data.inicio) * 100 : 0;
    const wasteCost = consumed * data.costoUnit;

    details.push({
      producto,
      inicio: data.inicio,
      fin: data.fin,
      consumed,
      wastePercent: Math.round(wastePercent * 10) / 10,
      wasteCost: Math.round(wasteCost * 100) / 100,
    });

    if (wastePercent > THRESHOLDS.wastePercent) {
      alerts.push({
        severity: wastePercent > 30 ? "high" : "medium",
        message: `${producto}: потери ${wastePercent.toFixed(1)}% (${consumed} единиц, $${wasteCost.toFixed(0)})`,
      });
    }
  }

  const totalWaste = details.reduce((sum, d) => sum + d.wasteCost, 0);
  const summary = `Продуктов: ${details.length}, алертов: ${alerts.length}, потери: $${totalWaste.toFixed(0)}`;

  // Записываем алерты в лист ⚠️ Alertas
  if (alerts.length > 0 && !DRY_RUN) {
    await writeAlerts(tenant, "waste", alerts);
  }

  return { module: "waste", summary, details, alerts };
}

// ── Модуль: Demand (прогноз спроса) ──────────────────────────────────────────

/**
 * Прогноз спроса на следующую неделю.
 * Считаем средние продажи по дням недели за последние 30 дней,
 * применяем тренд-коэффициент.
 *
 * @param {TenantConfig} tenant
 * @returns {Promise<ModuleResult>}
 */
async function moduleDemand(tenant) {
  const { readSheet } = await getSheetsModule();

  const salesRows = await readSheet(tenant.spreadsheetId, "🍽 Ventas");
  const sales = salesRows.slice(1);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Агрегация: plato -> dayOfWeek -> [cantidades]
  /** @type {Map<string, Map<number, number[]>>} */
  const demandMap = new Map();

  for (const row of sales) {
    const fechaStr = (row[0] || "").trim();
    const plato = (row[1] || "").trim();
    const cantidad = parseFloat(row[2]) || 0;

    if (!fechaStr || !plato) {
      continue;
    }

    const fecha = new Date(fechaStr);
    if (isNaN(fecha.getTime()) || fecha < thirtyDaysAgo) {
      continue;
    }

    if (!demandMap.has(plato)) {
      demandMap.set(plato, new Map());
    }

    const dayOfWeek = fecha.getDay(); // 0=dom, 6=sab
    const dayMap = demandMap.get(plato);
    if (!dayMap.has(dayOfWeek)) {
      dayMap.set(dayOfWeek, []);
    }
    dayMap.get(dayOfWeek).push(cantidad);
  }

  const dayNames = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const details = [];
  const alerts = [];

  for (const [plato, dayMap] of demandMap) {
    const forecast = {};
    let totalWeekly = 0;

    for (let d = 0; d < 7; d++) {
      const quantities = dayMap.get(d) || [];
      const avg =
        quantities.length > 0 ? quantities.reduce((s, v) => s + v, 0) / quantities.length : 0;
      // Взвешенное среднее: последние данные весят больше (простой тренд-коэффициент 1.05)
      const predicted = Math.round(avg * 1.05);
      forecast[dayNames[d]] = predicted;
      totalWeekly += predicted;
    }

    details.push({ plato, forecast, totalWeekly });
  }

  // Сортируем по общему спросу
  details.sort((a, b) => b.totalWeekly - a.totalWeekly);

  const summary = `Блюд: ${details.length}, прогноз на неделю готов`;

  return { module: "demand", summary, details, alerts };
}

// ── Модуль: Margin (маржа по блюдам) ─────────────────────────────────────────

/**
 * Рассчитать маржу по каждому блюду из меню.
 * Маржа = (Precio_Venta - Costo_Receta) / Precio_Venta * 100.
 * Алерт если <30%.
 *
 * @param {TenantConfig} tenant
 * @returns {Promise<ModuleResult>}
 */
async function moduleMargin(tenant) {
  const { readSheet } = await getSheetsModule();

  const menuRows = await readSheet(tenant.spreadsheetId, "📊 Menu");
  const menu = menuRows.slice(1);

  const details = [];
  const alerts = [];

  for (const row of menu) {
    const plato = (row[0] || "").trim();
    const costoReceta = parseFloat(row[2]) || 0;
    const precioVenta = parseFloat(row[3]) || 0;
    const activo = (row[5] || "").toLowerCase();

    if (!plato || precioVenta === 0) {
      continue;
    }
    if (activo === "no" || activo === "false" || activo === "0") {
      continue;
    }

    const marginAbs = precioVenta - costoReceta;
    const marginPercent = (marginAbs / precioVenta) * 100;

    details.push({
      plato,
      costoReceta,
      precioVenta,
      marginAbs: Math.round(marginAbs * 100) / 100,
      marginPercent: Math.round(marginPercent * 10) / 10,
    });

    if (marginPercent < THRESHOLDS.minMarginPercent) {
      alerts.push({
        severity: marginPercent < 15 ? "high" : "medium",
        message: `${plato}: маржа ${marginPercent.toFixed(1)}% (цена $${precioVenta}, себестоимость $${costoReceta})`,
      });
    }
  }

  // Сортируем по марже (худшие вверху)
  details.sort((a, b) => a.marginPercent - b.marginPercent);

  const avgMargin =
    details.length > 0 ? details.reduce((s, d) => s + d.marginPercent, 0) / details.length : 0;

  const summary = `Блюд: ${details.length}, средняя маржа: ${avgMargin.toFixed(1)}%, алертов: ${alerts.length}`;

  if (alerts.length > 0 && !DRY_RUN) {
    await writeAlerts(tenant, "margin", alerts);
  }

  return { module: "margin", summary, details, alerts };
}

// ── Модуль: Alerts (агрегация и отправка) ────────────────────────────────────

/**
 * Собрать алерты со всех модулей и отправить в Telegram.
 *
 * @param {TenantConfig} tenant
 * @returns {Promise<ModuleResult>}
 */
async function moduleAlerts(tenant) {
  const allAlerts = [];

  // Запускаем остальные модули для сбора алертов
  const modulesToCheck = tenant.modules.filter((m) => m !== "alerts");

  for (const mod of modulesToCheck) {
    try {
      const result = await runModuleInternal(tenant, mod);
      for (const alert of result.alerts) {
        allAlerts.push({ ...alert, module: mod });
      }
    } catch (err) {
      allAlerts.push({
        severity: "high",
        module: mod,
        message: `Ошибка модуля "${mod}": ${err.message}`,
      });
    }
  }

  // Отправляем в Telegram если есть алерты и настроен chatId
  if (allAlerts.length > 0 && tenant.telegramChatId && !DRY_RUN) {
    const text = formatAlertsForTelegram(tenant.name, allAlerts);
    await send(text, {
      silent: false,
      threadId: undefined,
      parseMode: "Markdown",
    });
  }

  if (DRY_RUN && allAlerts.length > 0) {
    console.log("[dry-run] Алерты для Telegram:");
    console.log(formatAlertsForTelegram(tenant.name, allAlerts));
  }

  const summary = `Всего алертов: ${allAlerts.length} (high: ${allAlerts.filter((a) => a.severity === "high").length})`;

  return { module: "alerts", summary, details: allAlerts, alerts: allAlerts };
}

/**
 * Внутренний запуск модуля (без трейсинга, для избежания рекурсии в alerts).
 *
 * @param {TenantConfig} tenant
 * @param {string} moduleName
 * @returns {Promise<ModuleResult>}
 */
async function runModuleInternal(tenant, moduleName) {
  switch (moduleName) {
    case "waste":
      return moduleWaste(tenant);
    case "demand":
      return moduleDemand(tenant);
    case "margin":
      return moduleMargin(tenant);
    default:
      throw new Error(`Неизвестный модуль: "${moduleName}"`);
  }
}

// ── Отчёт ────────────────────────────────────────────────────────────────────

/**
 * Генерация еженедельного отчёта для одного ресторана.
 *
 * @param {string} tenantId
 * @param {string} period — "week" (пока единственный)
 * @returns {Promise<string>} Текст отчёта
 */
async function generateReport(tenantId, period) {
  const startMs = Date.now();

  if (period !== "week") {
    throw new Error(`Неподдерживаемый период: "${period}". Доступный: week`);
  }

  const tenant = getTenant(tenantId);
  if (!tenant) {
    throw new Error(`Тенант не найден или неактивен: ${tenantId}`);
  }

  console.log(`[horeca] Генерация отчёта для "${tenant.name}"...`);

  const { readSheet } = await getSheetsModule();

  // 1. Revenue trend
  const salesRows = await readSheet(tenant.spreadsheetId, "🍽 Ventas");
  const sales = salesRows.slice(1);
  const revenueTrend = calculateRevenueTrend(sales);

  // 2. Margin analysis (top 5)
  let topMarginDishes = [];
  if (tenant.modules.includes("margin")) {
    const marginResult = await runModuleInternal(tenant, "margin");
    // Топ-5 по марже (лучшие)
    topMarginDishes = marginResult.details
      .toSorted((a, b) => b.marginPercent - a.marginPercent)
      .slice(0, 5);
  }

  // 3. Waste hotspots
  let wasteHotspots = [];
  if (tenant.modules.includes("waste")) {
    const wasteResult = await runModuleInternal(tenant, "waste");
    wasteHotspots = wasteResult.details
      .filter((d) => d.wastePercent > 10)
      .toSorted((a, b) => b.wastePercent - a.wastePercent)
      .slice(0, 5);
  }

  // 4. Demand forecast
  let forecast = [];
  if (tenant.modules.includes("demand")) {
    const demandResult = await runModuleInternal(tenant, "demand");
    forecast = demandResult.details.slice(0, 10);
  }

  // 5. Alerts summary
  const alertsResult = await moduleAlerts(tenant);

  // Формируем отчёт
  const report = formatWeeklyReport(tenant, {
    revenueTrend,
    topMarginDishes,
    wasteHotspots,
    forecast,
    alerts: alertsResult.details,
  });

  const durationMs = Date.now() - startMs;

  await trace({
    name: "horeca/weekly-report",
    input: { tenantId, tenantName: tenant.name, period },
    output: { reportLength: report.length, alertCount: alertsResult.details.length },
    duration_ms: durationMs,
    metadata: { module: "horeca-engine" },
  });

  console.log(`[horeca] Отчёт готов (${durationMs}ms, ${report.length} символов)`);

  return report;
}

// ── Вспомогательные функции ──────────────────────────────────────────────────

/**
 * Рассчитать тренд выручки за последние 4 недели.
 *
 * @param {Array<string[]>} sales — строки из "🍽 Ventas" (без заголовка)
 * @returns {Array<{ week: string, revenue: number }>}
 */
function calculateRevenueTrend(sales) {
  const now = new Date();
  const weeks = [];

  for (let w = 3; w >= 0; w--) {
    const weekStart = new Date(now.getTime() - (w + 1) * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = new Date(now.getTime() - w * 7 * 24 * 60 * 60 * 1000);

    let revenue = 0;
    for (const row of sales) {
      const fecha = new Date((row[0] || "").trim());
      if (isNaN(fecha.getTime())) {
        continue;
      }
      if (fecha >= weekStart && fecha < weekEnd) {
        revenue += parseFloat(row[4]) || 0; // Total column
      }
    }

    weeks.push({
      week: `${weekStart.toISOString().slice(5, 10)} — ${weekEnd.toISOString().slice(5, 10)}`,
      revenue: Math.round(revenue),
    });
  }

  return weeks;
}

/**
 * Записать алерты в лист ⚠️ Alertas тенанта.
 *
 * @param {TenantConfig} tenant
 * @param {string} moduleName
 * @param {Array<{ severity: string, message: string }>} alerts
 */
async function writeAlerts(tenant, moduleName, alerts) {
  const { appendToSheet } = await getSheetsModule();

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const rows = alerts.map((a) => [now, moduleName, a.severity, a.message, "open"]);

  await appendToSheet(tenant.spreadsheetId, rows, "⚠️ Alertas");
}

/**
 * Форматировать алерты для отправки в Telegram.
 *
 * @param {string} restaurantName
 * @param {Array<{ severity: string, module: string, message: string }>} alerts
 * @returns {string}
 */
function formatAlertsForTelegram(restaurantName, alerts) {
  const severityIcon = { high: "!!!", medium: "!!", low: "!" };
  const lines = [`*HoReCa Alert: ${restaurantName}*`, ""];

  for (const alert of alerts) {
    const icon = severityIcon[alert.severity] || "!";
    lines.push(`[${icon}] [${alert.module}] ${alert.message}`);
  }

  lines.push("");
  lines.push(`_${new Date().toISOString().slice(0, 16)}_`);

  return lines.join("\n");
}

/**
 * Форматировать еженедельный отчёт.
 *
 * @param {TenantConfig} tenant
 * @param {object} data
 * @returns {string}
 */
function formatWeeklyReport(tenant, data) {
  const lines = [];

  lines.push(`=== HoReCa Weekly Report: ${tenant.name} ===`);
  lines.push(`Fecha: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Plan: ${tenant.plan}`);
  lines.push("");

  // Revenue trend
  lines.push("--- REVENUE TREND (4 semanas) ---");
  if (data.revenueTrend.length === 0) {
    lines.push("  Sin datos de ventas");
  } else {
    for (const w of data.revenueTrend) {
      const bar = "#".repeat(Math.min(Math.round(w.revenue / 1000), 30));
      lines.push(`  ${w.week}: $${w.revenue.toLocaleString()} ${bar}`);
    }
  }
  lines.push("");

  // Top margin dishes
  if (data.topMarginDishes.length > 0) {
    lines.push("--- TOP 5 PLATOS POR MARGEN ---");
    for (const d of data.topMarginDishes) {
      lines.push(
        `  ${d.plato}: ${d.marginPercent}% ($${d.precioVenta} - $${d.costoReceta} = $${d.marginAbs})`,
      );
    }
    lines.push("");
  }

  // Waste hotspots
  if (data.wasteHotspots.length > 0) {
    lines.push("--- WASTE HOTSPOTS ---");
    for (const w of data.wasteHotspots) {
      lines.push(`  ${w.producto}: ${w.wastePercent}% ($${w.wasteCost})`);
    }
    lines.push("");
  }

  // Demand forecast
  if (data.forecast.length > 0) {
    lines.push("--- FORECAST PROXIMA SEMANA ---");
    for (const f of data.forecast) {
      const days = Object.entries(f.forecast)
        .map(([day, qty]) => `${day}:${String(qty)}`)
        .join(" ");
      lines.push(`  ${f.plato}: ${days} (total: ${f.totalWeekly})`);
    }
    lines.push("");
  }

  // Alerts
  lines.push("--- ALERTAS ---");
  if (data.alerts.length === 0) {
    lines.push("  Sin alertas activas");
  } else {
    for (const a of data.alerts) {
      lines.push(`  [${a.severity}] [${a.module}] ${a.message}`);
    }
  }

  lines.push("");
  lines.push("=== Fin del reporte ===");

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Обработка глобального флага --dry-run
  const dryRunIdx = args.indexOf("--dry-run");
  if (dryRunIdx !== -1) {
    DRY_RUN = true;
    args.splice(dryRunIdx, 1);
    console.log("[horeca] Режим dry-run: запись отключена");
  }

  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    switch (command) {
      case "create": {
        const name = args[1];
        const phone = args[2];
        const plan = args[3] || "starter";

        if (!name || !phone) {
          console.error("Использование: node horeca-engine.cjs create <name> <phone> [plan]");
          process.exit(1);
        }

        const result = await createTenant(name, phone, plan);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "list": {
        const tenants = listTenants();
        if (tenants.length === 0) {
          console.log("[horeca] Нет активных тенантов");
        } else {
          console.log(
            `\n${"ID".padEnd(25)} ${"Nombre".padEnd(20)} ${"Plan".padEnd(12)} ${"Módulos".padEnd(30)} Creado`,
          );
          console.log("-".repeat(100));
          for (const t of tenants) {
            console.log(
              `${t.id.padEnd(25)} ${t.name.padEnd(20)} ${t.plan.padEnd(12)} ${t.modules.join(",").padEnd(30)} ${t.createdAt}`,
            );
          }
          console.log(`\nTotal: ${tenants.length} тенантов`);
        }
        break;
      }

      case "run": {
        const tenantId = args[1];
        const moduleName = args[2];

        if (!tenantId || !moduleName) {
          console.error("Использование: node horeca-engine.cjs run <tenantId> <module>");
          process.exit(1);
        }

        const result = await runModule(tenantId, moduleName);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "run-all": {
        const moduleName = args[1];
        if (!moduleName) {
          console.error("Использование: node horeca-engine.cjs run-all <module>");
          process.exit(1);
        }

        const results = await runAllTenants(moduleName);
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case "report": {
        const tenantId = args[1];
        const period = args[2] || "week";

        if (!tenantId) {
          console.error("Использование: node horeca-engine.cjs report <tenantId> [period]");
          process.exit(1);
        }

        const report = await generateReport(tenantId, period);
        console.log(report);
        break;
      }

      default:
        console.error(`Неизвестная команда: "${command}"`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[horeca] ОШИБКА: ${err.message}`);
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
HoReCa AI SaaS Engine

Команды:
  create <name> <phone> [plan]   Создать тенанта (starter|pro|enterprise)
  list                           Список активных тенантов
  run <tenantId> <module>        Запустить модуль (waste|demand|margin|alerts)
  run-all <module>               Запустить модуль для всех тенантов
  report <tenantId> [period]     Сгенерировать отчёт (week)

Флаги:
  --dry-run                      Без записи в Sheets/Telegram

Примеры:
  node horeca-engine.cjs create "El Patio" "+5493516123456" pro
  node horeca-engine.cjs list
  node horeca-engine.cjs run restaurant-001 waste
  node horeca-engine.cjs --dry-run run restaurant-001 demand
  node horeca-engine.cjs run-all waste
  node horeca-engine.cjs report restaurant-001 week
`);
}

// Запуск CLI если вызван напрямую
if (require.main === module) {
  main().catch(console.error);
}

// ── Экспорт (для использования как модуль) ───────────────────────────────────

module.exports = {
  createTenant,
  getTenant,
  listTenants,
  runModule,
  runAllTenants,
  generateReport,
  // Для тестирования
  TEMPLATE_SHEETS,
  THRESHOLDS,
  PLANS,
};

// ── Типы (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} TenantConfig
 * @property {string} id
 * @property {string} name
 * @property {string} owner
 * @property {string} phone
 * @property {string} spreadsheetId
 * @property {string|null} telegramChatId
 * @property {string} plan
 * @property {string[]} modules
 * @property {string} createdAt
 * @property {string} status
 */

/**
 * @typedef {object} ModuleResult
 * @property {string} module
 * @property {string} summary
 * @property {Array<object>} details
 * @property {Array<{ severity: string, message: string }>} alerts
 */
