/**
 * Pepino Sheets JSON API
 * Serves Google Sheets data as JSON for Grafana + accepts POST writes from Telegram pipeline
 *
 * GET endpoints (read):
 *   /kpi, /products, /pnl, /alerts, /sales, /spend, /health
 *   /clients, /forecast, /waste, /dashboard
 *
 * POST endpoints (write):
 *   /log/production  → 🌿 Производство
 *   /log/sales       → 🛒 Продажи
 *   /log/expense     → 💰 Расходы
 *   /log/inventory   → 📦 Склад
 *   /log/task        → 📋 Задачи
 *   /log/alert       → ⚠️ Алерты
 *
 * Usage: node sheets-api.js
 * Port: 4000 (localhost only)
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { readSheet, appendToSheet, PEPINO_SHEETS_ID } from "./sheets.js";

const PORT = 4000;
const BIND_HOST = process.env.SHEETS_API_HOST || "127.0.0.1";

// ── Auth: Bearer token ───────────────────────────────────────────────────────
// Token loaded from env var or auto-generated on first run and saved to file.
const TOKEN_FILE = path.join(process.env.HOME || "/root", ".openclaw", ".sheets-api-token");

function loadOrCreateToken() {
  // 1) env var takes priority
  if (process.env.SHEETS_API_TOKEN) return process.env.SHEETS_API_TOKEN;
  // 2) file
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* not found — generate */
  }
  const t = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  console.log(`[auth] Generated new API token → ${TOKEN_FILE}`);
  return t;
}

const API_TOKEN = loadOrCreateToken();

function isAuthenticated(req) {
  // /health is public (for monitoring)
  if (req.url === "/health") return true;
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${API_TOKEN}`) return true;
  // Also accept X-API-Token header
  if (req.headers["x-api-token"] === API_TOKEN) return true;
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sheetToJson(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      let val = row[i] || "";
      if (val !== "" && !isNaN(val.toString().replace(",", ".").replace("%", ""))) {
        const cleaned = val.toString().replace(",", ".").replace("%", "");
        obj[h] = parseFloat(cleaned);
        if (val.toString().includes("%") && obj[h] > 1) obj[h] = obj[h] / 100;
      } else {
        obj[h] = val;
      }
    });
    return obj;
  });
}

const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

async function getCached(sheetName) {
  const now = Date.now();
  if (cache[sheetName] && now - cache[sheetName].ts < CACHE_TTL) {
    return cache[sheetName].data;
  }
  const rows = await readSheet(PEPINO_SHEETS_ID, sheetName);
  const data = sheetToJson(rows);
  cache[sheetName] = { data, ts: now };
  return data;
}

function now() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Read full POST body as JSON */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── GET routes (read) ────────────────────────────────────────────────────────

const getRoutes = {
  "/kpi": () => getCached("LK_KPI"),
  "/products": () => getCached("LK_Products"),
  "/pnl": () => getCached("LK_PnL"),
  "/alerts": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "⚠️ Алерты");
    return sheetToJson(rows).filter((r) => r["статус"] === "открыт");
  },
  "/sales": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    return sheetToJson(rows);
  },
  "/spend": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "AI Spend");
    const t = today();
    return sheetToJson(rows).filter((r) => r["Дата"] && r["Дата"].toString().startsWith(t));
  },
  "/production": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "🌿 Производство");
    return sheetToJson(rows);
  },
  "/expenses": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "💰 Расходы");
    return sheetToJson(rows);
  },
  "/inventory": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "📦 Склад");
    return sheetToJson(rows);
  },
  "/tasks": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "📋 Задачи");
    return sheetToJson(rows).filter((r) => r["Статус"] !== "закрыт");
  },
  "/gaps": async () => {
    // Check what data is missing today
    const t = today();
    const gaps = [];

    const prod = await readSheet(PEPINO_SHEETS_ID, "🌿 Производство");
    const prodToday = prod.filter((r) => r[0] && r[0].startsWith(t));
    if (prodToday.length === 0)
      gaps.push({ sheet: "Производство", issue: "Нет записей сбора за сегодня" });

    const sales = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    const salesToday = sales.filter((r) => r[0] && r[0].startsWith(t));
    if (salesToday.length === 0)
      gaps.push({ sheet: "Продажи", issue: "Нет продаж за сегодня (если были — нужно записать)" });

    const tasks = await readSheet(PEPINO_SHEETS_ID, "📋 Задачи");
    const overdue = sheetToJson(tasks).filter(
      (r) => r["Статус"] === "открыт" && r["Срок"] && r["Срок"] < t,
    );
    if (overdue.length > 0)
      gaps.push({
        sheet: "Задачи",
        issue: `${overdue.length} просроченных задач`,
        items: overdue.map((r) => r["Задача"]),
      });

    return { date: t, gaps, complete: gaps.length === 0 };
  },
  "/health": async () => ({
    status: "ok",
    sheets: 24,
    ts: new Date().toISOString(),
    uptime: process.uptime(),
  }),
  "/capex": async () => {
    const rows = await readSheet(PEPINO_SHEETS_ID, "🏗️ CAPEX");
    return sheetToJson(rows);
  },
  "/weather": async () => {
    const https = await import("https");
    return new Promise((resolve) => {
      https.default
        .get("https://wttr.in/Cordoba,Argentina?format=j1", (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const w = JSON.parse(data);
              const c = w.current_condition[0];
              const today = w.weather[0];
              const tomorrow = w.weather[1];
              resolve({
                current: {
                  temp_c: +c.temp_C,
                  humidity: +c.humidity,
                  wind_kmh: +c.windspeedKmph,
                  description: c.lang_ru?.[0]?.value || c.weatherDesc[0].value,
                  uv: +c.uvIndex,
                },
                today: {
                  max_c: +today.maxtempC,
                  min_c: +today.mintempC,
                  avg_humidity: +today.hourly[4]?.humidity || 0,
                },
                tomorrow: {
                  max_c: +tomorrow.maxtempC,
                  min_c: +tomorrow.mintempC,
                  avg_humidity: +tomorrow.hourly[4]?.humidity || 0,
                },
                greenhouse_alerts: [
                  ...(+c.temp_C > 35 ? ["🔴 Жара >35°C — усилить вентиляцию"] : []),
                  ...(+c.temp_C < 5 ? ["🔴 Заморозки <5°C — включить обогрев"] : []),
                  ...(+c.humidity > 90 ? ["🟡 Влажность >90% — риск грибка"] : []),
                  ...(+c.humidity < 40 ? ["🟡 Влажность <40% — усилить полив"] : []),
                  ...(+c.uvIndex > 8 ? ["🟡 UV>8 — затенение"] : []),
                ],
              });
            } catch {
              resolve({ error: "Ошибка парсинга погоды" });
            }
          });
        })
        .on("error", () => resolve({ error: "Погода недоступна" }));
    });
  },
  // ── API v2 endpoints ──────────────────────────────────────────────────────

  "/clients": async () => {
    // Обзор здоровья клиентской базы: заказы, выручка, статус активности
    const sales = await getCached("🛒 Продажи");
    const todayStr = today();
    /** @type {Record<string, {order_count: number, total_ars: number, last_order_date: string}>} */
    const byClient = {};

    for (const row of sales) {
      const client = (row["Клиент"] || row["клиент"] || "").toString().trim();
      if (!client) continue;
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      const total =
        parseFloat(
          (row["Итого ARS"] || row["Сумма ARS"] || row["итого ARS"] || 0)
            .toString()
            .replace(/\./g, "")
            .replace(",", "."),
        ) || 0;

      if (!byClient[client]) {
        byClient[client] = { order_count: 0, total_ars: 0, last_order_date: "" };
      }
      byClient[client].order_count += 1;
      byClient[client].total_ars += total;
      if (dateVal > byClient[client].last_order_date) {
        byClient[client].last_order_date = dateVal;
      }
    }

    const result = Object.entries(byClient).map(([client, data]) => {
      const lastDate = data.last_order_date;
      const daysSince = lastDate
        ? Math.floor((new Date(todayStr) - new Date(lastDate)) / 86_400_000)
        : 999;
      let status = "active";
      if (daysSince > 30) status = "churned";
      else if (daysSince > 14) status = "at_risk";

      return {
        client,
        order_count: data.order_count,
        total_ars: Math.round(data.total_ars),
        last_order_date: lastDate,
        days_since_last: daysSince,
        status,
      };
    });

    // Сортируем по выручке (убывание)
    result.sort((a, b) => b.total_ars - a.total_ars);
    return result;
  },

  "/forecast": async () => {
    // Прогноз выручки на 7 и 30 дней на основе истории продаж за последние 30 дней
    const sales = await getCached("🛒 Продажи");
    const todayDate = new Date(today());
    const thirtyDaysAgo = new Date(todayDate);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    // Суммируем выручку по дням (только последние 30 дней)
    /** @type {Record<string, number>} */
    const dailyRevenue = {};
    /** @type {Record<number, number[]>} день недели → массив сумм */
    const dowRevenue = {};

    for (const row of sales) {
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      if (!dateVal || dateVal < cutoff) continue;
      const total =
        parseFloat(
          (row["Итого ARS"] || row["Сумма ARS"] || row["итого ARS"] || 0)
            .toString()
            .replace(/\./g, "")
            .replace(",", "."),
        ) || 0;

      dailyRevenue[dateVal] = (dailyRevenue[dateVal] || 0) + total;
      const dow = new Date(dateVal).getDay();
      if (!dowRevenue[dow]) dowRevenue[dow] = [];
      dowRevenue[dow].push(total);
    }

    const days = Object.keys(dailyRevenue).sort();
    const values = days.map((d) => dailyRevenue[d]);
    const totalRevenue = values.reduce((s, v) => s + v, 0);
    const activeDays = values.length || 1;
    const avgDaily = totalRevenue / activeDays;

    // Средняя выручка по дню недели
    /** @type {Record<number, number>} */
    const dowAvg = {};
    const dayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    let bestDay = { name: "-", avg: 0 };
    let worstDay = { name: "-", avg: Infinity };

    for (const [dow, vals] of Object.entries(dowRevenue)) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      dowAvg[dow] = Math.round(avg);
      const name = dayNames[+dow];
      if (avg > bestDay.avg) bestDay = { name, avg: Math.round(avg) };
      if (avg < worstDay.avg) worstDay = { name, avg: Math.round(avg) };
    }
    if (worstDay.avg === Infinity) worstDay = { name: "-", avg: 0 };

    return {
      period_days: activeDays,
      avg_daily: Math.round(avgDaily),
      forecast_7d: Math.round(avgDaily * 7),
      forecast_30d: Math.round(avgDaily * 30),
      best_day: bestDay,
      worst_day: worstDay,
      dow_avg: Object.fromEntries(Object.entries(dowAvg).map(([k, v]) => [dayNames[+k], v])),
    };
  },

  "/waste": async () => {
    // Анализ потерь: произведено vs продано за последние 30 дней
    const { normalize } = await import("./product-aliases.cjs");
    const [production, sales] = await Promise.all([
      getCached("🌿 Производство"),
      getCached("🛒 Продажи"),
    ]);

    const todayDate = new Date(today());
    const thirtyDaysAgo = new Date(todayDate);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    // Произведено по продуктам
    /** @type {Record<string, number>} */
    const produced = {};
    for (const row of production) {
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      if (!dateVal || dateVal < cutoff) continue;
      const product = normalize
        ? normalize((row["Продукт"] || row["продукт"] || "").toString())
        : (row["Продукт"] || row["продукт"] || "").toString().trim();
      if (!product) continue;
      const kg =
        parseFloat(
          (row["Кол-во кг"] || row["кг"] || row["Вес"] || 0).toString().replace(",", "."),
        ) || 0;
      produced[product] = (produced[product] || 0) + kg;
    }

    // Продано по продуктам
    /** @type {Record<string, number>} */
    const sold = {};
    for (const row of sales) {
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      if (!dateVal || dateVal < cutoff) continue;
      const product = normalize
        ? normalize((row["Продукт"] || row["продукт"] || "").toString())
        : (row["Продукт"] || row["продукт"] || "").toString().trim();
      if (!product) continue;
      const kg =
        parseFloat(
          (row["Кол-во кг"] || row["кг"] || row["Кол-во"] || 0).toString().replace(",", "."),
        ) || 0;
      sold[product] = (sold[product] || 0) + kg;
    }

    // Объединяем все продукты
    const allProducts = new Set([...Object.keys(produced), ...Object.keys(sold)]);
    const result = [];
    for (const product of allProducts) {
      const producedKg = produced[product] || 0;
      const soldKg = sold[product] || 0;
      const wasteKg = Math.max(0, producedKg - soldKg);
      const wastePct = producedKg > 0 ? (wasteKg / producedKg) * 100 : 0;
      result.push({
        product,
        produced_kg: Math.round(producedKg * 100) / 100,
        sold_kg: Math.round(soldKg * 100) / 100,
        waste_kg: Math.round(wasteKg * 100) / 100,
        waste_pct: Math.round(wastePct * 10) / 10,
      });
    }

    // Сортируем по потерям (убывание)
    result.sort((a, b) => b.waste_kg - a.waste_kg);
    return { period: "30d", cutoff, products: result };
  },

  "/dashboard": async () => {
    // Компактная сводка для мобильного виджета / single-call dashboard
    const todayStr = today();

    const [salesData, alertsData, tasksData, inventoryData, expensesData] = await Promise.all([
      getCached("🛒 Продажи"),
      (async () => {
        const rows = await readSheet(PEPINO_SHEETS_ID, "⚠️ Алерты");
        return sheetToJson(rows);
      })(),
      (async () => {
        const rows = await readSheet(PEPINO_SHEETS_ID, "📋 Задачи");
        return sheetToJson(rows);
      })(),
      getCached("📦 Склад"),
      getCached("💰 Расходы"),
    ]);

    // Продажи сегодня
    let salesToday = 0;
    let salesCount = 0;
    for (const row of salesData) {
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      if (dateVal !== todayStr) continue;
      salesCount += 1;
      salesToday +=
        parseFloat(
          (row["Итого ARS"] || row["Сумма ARS"] || row["итого ARS"] || 0)
            .toString()
            .replace(/\./g, "")
            .replace(",", "."),
        ) || 0;
    }

    // Расходы сегодня (для расчёта маржи)
    let expensesToday = 0;
    for (const row of expensesData) {
      const dateVal = (row["Дата"] || row["дата"] || "").toString().slice(0, 10);
      if (dateVal !== todayStr) continue;
      expensesToday +=
        parseFloat(
          (row["Сумма"] || row["amount_ars"] || 0).toString().replace(/\./g, "").replace(",", "."),
        ) || 0;
    }

    // Открытые алерты
    const openAlerts = alertsData.filter((r) => r["статус"] === "открыт").length;

    // Открытые задачи
    const openTasks = tasksData.filter((r) => r["Статус"] !== "закрыт").length;

    // Критический склад (остаток <= 0 или помеченные как critical)
    const stockCritical = inventoryData.filter((r) => {
      const remaining = parseFloat(
        (r["Остаток"] || r["остаток"] || r["remaining"] || "0").toString().replace(",", "."),
      );
      return remaining <= 0;
    }).length;

    const margin =
      salesToday > 0 ? Math.round(((salesToday - expensesToday) / salesToday) * 100) : 0;

    return {
      date: todayStr,
      sales_today_ars: Math.round(salesToday),
      sales_today_count: salesCount,
      expenses_today_ars: Math.round(expensesToday),
      margin_pct: margin,
      open_alerts: openAlerts,
      open_tasks: openTasks,
      stock_critical: stockCritical,
    };
  },

  "/roi": async () => {
    // CAPEX total
    const capex = await readSheet(PEPINO_SHEETS_ID, "🏗️ CAPEX");
    let totalCapex = 0;
    for (const r of capex.slice(1)) {
      const v = String(r[3] || "")
        .replace(/\./g, "")
        .replace(",", ".");
      totalCapex += parseFloat(v) || 0;
    }

    // Monthly EBITDA from P&L
    const pnl = await readSheet(PEPINO_SHEETS_ID, "📊 P&L");
    let totalEbitda = 0;
    let months = 0;
    for (const r of pnl.slice(1)) {
      const v = String(r[7] || "")
        .replace(/\./g, "")
        .replace(",", ".");
      const e = parseFloat(v) || 0;
      if (e > 0) {
        totalEbitda += e;
        months++;
      }
    }
    const avgMonthlyEbitda = months > 0 ? totalEbitda / months : 0;
    const paybackMonths = avgMonthlyEbitda > 0 ? totalCapex / avgMonthlyEbitda : 0;

    // Revenue total
    const sales = await readSheet(PEPINO_SHEETS_ID, "🛒 Продажи");
    let totalRevenue = 0;
    for (const r of sales.slice(1)) {
      const v = String(r[5] || "")
        .replace(/\./g, "")
        .replace(",", ".");
      totalRevenue += parseFloat(v) || 0;
    }

    // Expenses total
    const exp = await readSheet(PEPINO_SHEETS_ID, "💰 Расходы");
    let totalExpenses = 0;
    for (const r of exp.slice(1)) {
      const v = String(r[4] || "")
        .replace(/\./g, "")
        .replace(",", ".");
      totalExpenses += parseFloat(v) || 0;
    }

    const blueRate = 1430;
    const profit = totalRevenue - totalExpenses;

    return [
      { metric: "CAPEX на теплицу", value: Math.round(totalCapex), unit: "ARS" },
      { metric: "CAPEX в USD", value: Math.round(totalCapex / blueRate), unit: "USD" },
      { metric: "Выручка факт", value: Math.round(totalRevenue), unit: "ARS" },
      { metric: "Расходы факт", value: Math.round(totalExpenses), unit: "ARS" },
      { metric: "Прибыль факт", value: Math.round(profit), unit: "ARS" },
      { metric: "EBITDA средн/мес", value: Math.round(avgMonthlyEbitda), unit: "ARS" },
      { metric: "Окупаемость", value: +paybackMonths.toFixed(1), unit: "мес" },
      {
        metric: "ROI годовой",
        value:
          avgMonthlyEbitda > 0 ? +(((avgMonthlyEbitda * 12) / totalCapex) * 100).toFixed(0) : 0,
        unit: "%",
      },
    ];
  },
};

// ── POST routes (write) ──────────────────────────────────────────────────────

const postRoutes = {
  /**
   * POST /log/production
   * Body: { product, zone, weight_kg, status?, note? }
   */
  "/log/production": async (body) => {
    // Headers: Дата | Продукт | Сорта/детали | Урожай кг | Отход кг | % отхода | Продано кг | Засолка кг | Остаток кг | Бронь кг | Теплица
    const row = [
      body.date || today(),
      body.product || "",
      body.variety || body.sort || "",
      body.weight_kg || body.harvest_kg || "",
      body.waste_kg || "",
      body.waste_pct || "",
      body.sold_kg || "",
      body.pickled_kg || "",
      body.remaining_kg || "",
      body.reserved_kg || "",
      body.greenhouse || body.zone || "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "🌿 Производство");
    // Invalidate cache
    delete cache["🌿 Производство"];
    return {
      ok: true,
      sheet: "🌿 Производство",
      summary: `${body.product} ${body.weight_kg}кг ${body.zone || ""}`.trim(),
    };
  },

  /**
   * POST /log/sales
   * Body: { client, product, qty_kg, price_per_kg, total_ars, channel?, payment?, note? }
   */
  "/log/sales": async (body) => {
    // Headers: Дата | Клиент | Продукт | Кол-во кг | Цена ARS/кг | Сумма ARS | Доставка ARS | Итого ARS | Курс USD | Сумма USD | Статус | Примечание
    const total = body.total_ars || (body.qty_kg || 0) * (body.price_per_kg || 0);
    const delivery = body.delivery_cost || body.delivery_ars || "";
    const itogo = delivery ? (Number(total) + Number(delivery)) : total;
    const row = [
      body.date || today(),
      body.client || "",
      body.product || "",
      body.qty_kg || "",
      body.price_per_kg || "",
      total,
      delivery,
      itogo,
      body.exchange_rate || "",
      body.total_usd || "",
      body.status || "entregado",
      body.note || "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "🛒 Продажи");
    delete cache["🛒 Продажи"];
    return {
      ok: true,
      sheet: "🛒 Продажи",
      summary: `${body.client}: ${body.product} ${body.qty_kg}кг = ${total} ARS`,
    };
  },

  /**
   * POST /log/expense
   * Body: { category, description, amount_ars, payment_method?, note? }
   */
  "/log/expense": async (body) => {
    // Headers: Дата | Наименование | Кол-во | Единицы | Сумма ARS | Курс USD | Сумма USD
    const description = body.item || body.description || body.category || "";
    const row = [
      body.date || today(),
      description,
      body.qty || body.quantity || "",
      body.unit || body.units || "",
      body.amount_ars || "",
      body.exchange_rate || "",
      body.amount_usd || "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "💰 Расходы");
    delete cache["💰 Расходы"];
    return {
      ok: true,
      sheet: "💰 Расходы",
      summary: `${body.category}: ${body.description} ${body.amount_ars} ARS`,
    };
  },

  /**
   * POST /log/inventory
   * Body: { item, category, operation (приход/расход), qty, unit, supplier?, price?, note? }
   */
  "/log/inventory": async (body) => {
    const row = [
      body.date || today(),
      body.item || "",
      body.category || "",
      body.operation || "приход",
      body.qty || "",
      body.unit || "кг",
      body.remaining || "",
      body.supplier || "",
      body.price || "",
      body.note || "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "📦 Склад");
    delete cache["📦 Склад"];
    return {
      ok: true,
      sheet: "📦 Склад",
      summary: `${body.operation}: ${body.item} ${body.qty} ${body.unit}`,
    };
  },

  /**
   * POST /log/task
   * Body: { task, category, assignee?, priority?, deadline?, note? }
   */
  "/log/task": async (body) => {
    const row = [
      body.date || today(),
      body.task || "",
      body.category || "",
      body.assignee || "Роман",
      body.priority || "P3",
      body.deadline || "",
      body.status || "открыт",
      "",
      body.agent || "",
      body.note || "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "📋 Задачи");
    delete cache["📋 Задачи"];
    return { ok: true, sheet: "📋 Задачи", summary: `[${body.priority || "P3"}] ${body.task}` };
  },

  /**
   * POST /log/alert
   * Body: { type, zone, description, severity (1-5), source? }
   */
  "/log/alert": async (body) => {
    const row = [
      body.date || today(),
      body.type || "",
      body.source || "telegram",
      body.zone || "",
      body.description || "",
      body.severity || "3",
      "открыт",
      body.assignee || "Роман",
      "",
    ];
    await appendToSheet(PEPINO_SHEETS_ID, [row], "⚠️ Алерты");
    delete cache["⚠️ Алерты"];
    return {
      ok: true,
      sheet: "⚠️ Алерты",
      summary: `[${body.severity}/5] ${body.type}: ${body.description}`,
    };
  },
};

// ── HTTP Server ──────────────────────────────────────────────────────────────

// IP whitelist: localhost + all Docker subnets (172.16-31.x.x)
const ALLOWED_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isAllowed(ip) {
  if (ALLOWED_IPS.has(ip)) return true;
  // Allow all Docker subnets (172.16.0.0/12)
  const match = ip.replace("::ffff:", "");
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(match)) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const clientIP = req.socket.remoteAddress;
  if (!isAllowed(clientIP)) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  // Parse URL and query params
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const params = parsedUrl.searchParams;

  // Bearer token check (except /health which is public for monitoring)
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized. Provide: Authorization: Bearer <token>" }));
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Token");
  res.setHeader("Content-Type", "application/json");

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "GET") {
      const handler = getRoutes[pathname];
      if (!handler) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Not found",
            get: Object.keys(getRoutes),
            post: Object.keys(postRoutes),
          }),
        );
        return;
      }
      let data = await handler();
      // Query params: ?limit=N (default 20), ?all=true (no limit)
      if (Array.isArray(data) && !params.has("all")) {
        const limit = parseInt(params.get("limit")) || 0;
        if (limit > 0) data = data.slice(-limit);
      }
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } else if (req.method === "POST") {
      const handler = postRoutes[pathname];
      if (!handler) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Unknown POST route",
            available: Object.keys(postRoutes),
          }),
        );
        return;
      }
      const body = await readBody(req);
      const result = await handler(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  } catch (err) {
    console.error(`[${req.method} ${req.url}] Error:`, err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Pepino Sheets API running on http://${BIND_HOST}:${PORT}`);
  console.log(`[auth] Token auth ENABLED (token in ${TOKEN_FILE})`);
  console.log(`[auth] /health endpoint is public (no token required)`);
  console.log("GET:", Object.keys(getRoutes).join(", "));
  console.log("POST:", Object.keys(postRoutes).join(", "));
});
