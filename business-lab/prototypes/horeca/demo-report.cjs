/**
 * RestoBot Demo Report Generator
 *
 * Генерирует демо-отчёты для презентации рестораторам.
 * Читает demo-data.json и формирует HTML-сообщения для Telegram.
 *
 * Использование:
 *   node demo-report.cjs daily     # Дневной отчёт
 *   node demo-report.cjs weekly    # Недельный отчёт
 *   node demo-report.cjs alerts    # Алерты
 *   node demo-report.cjs all       # Все три
 *   node demo-report.cjs --send    # Отправить всё в Telegram (thread 20)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── Конфигурация ─────────────────────────────────────────────────────────────

const TELEGRAM_THREAD_ID = 20;
const DATA_PATH = path.join(__dirname, "demo-data.json");
const TELEGRAM_HELPER_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "pepino-google-sheets",
  "telegram-helper.cjs",
);

// ── Утилиты ──────────────────────────────────────────────────────────────────

/**
 * Форматирование числа в аргентинском стиле: 1.735.000
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Форматирование процента: 63.2%
 * @param {number} n
 * @returns {string}
 */
function fmtPct(n) {
  return n.toFixed(1) + "%";
}

/**
 * Загрузка демо-данных
 * @returns {object}
 */
function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`[ERROR] Файл не найден: ${DATA_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

// ── Генераторы отчётов ───────────────────────────────────────────────────────

/**
 * Дневной отчёт — как будто за вчера (среда, данные из wednesday)
 * @param {object} data
 * @returns {string} HTML-сообщение
 */
function generateDaily(data) {
  const { restaurant, menu, weekly_sales, waste_report, alerts } = data;
  const day = weekly_sales.wednesday;

  // Сравнение со средним дня недели (демо: среда обычно приносит ~$185k)
  const typicalWednesday = 185000;
  const vsAvg = ((day.revenue - typicalWednesday) / typicalWednesday) * 100;
  const vsSign = vsAvg >= 0 ? "+" : "";

  // Top 3 по количеству заказов (симулированные данные на основе меню)
  const topDishes = [
    { dish: "Bife de chorizo 400g", orders: 18 },
    { dish: "Milanesa napolitana", orders: 12 },
    { dish: "Sorrentinos", orders: 9 },
  ];

  // Средний марген из меню
  const avgMargin = menu.reduce((s, m) => s + m.margin_pct, 0) / menu.length;

  // Merma дневная (демо: пропорция от недельной merma $27.150)
  const weeklyWaste = waste_report.worst_items.reduce((s, w) => s + w.value_ars, 0);
  const dailyWaste = Math.round((weeklyWaste / 7) * 3.98); // ~$15.400 для демо
  const dailyWastePct = "3.2";

  // Потенциальный ahorro mensual: коррекция merma по 3 категориям
  const savingsMonth = 27150;

  const topList = topDishes.map((t, i) => `  ${i + 1}. ${t.dish} — ${t.orders} pedidos`).join("\n");

  const alertList = alerts
    .map((a) => {
      if (a.type === "margin") {
        return `<b>Lomo al champignon:</b> margen 50% (min. 55%) → subir a $24.000`;
      }
      if (a.type === "waste") {
        return `<b>Lechuga:</b> 8.5kg desperdiciados → reducir pedido 30%`;
      }
      if (a.type === "demand") {
        return `<b>Milanesa:</b> demanda +23% → preparar 20 porciones (vs 15)`;
      }
      return a.message;
    })
    .join("\n• ");

  return [
    `<b>📊 RestoBot — ${restaurant.name}</b>`,
    `Resumen de ayer (21/03/2026):`,
    ``,
    `💰 Ventas: <b>$${fmtNum(day.revenue)}</b> (${vsSign}${fmtPct(vsAvg)} vs promedio)`,
    `🍽 Cubiertos: ${day.covers}`,
    `🏆 Top 3:`,
    topList,
    ``,
    `📈 Margen promedio: ${fmtPct(avgMargin)}`,
    `🗑 Merma estimada: $${fmtNum(dailyWaste)} (${dailyWastePct}%)`,
    ``,
    `⚠️ <b>Alertas:</b>`,
    `• ${alertList}`,
    ``,
    `💡 <i>Ahorro potencial: $${fmtNum(savingsMonth)}/mes si se corrige merma</i>`,
  ].join("\n");
}

/**
 * Недельный отчёт
 * @param {object} data
 * @returns {string} HTML-сообщение
 */
function generateWeekly(data) {
  const { restaurant, menu, weekly_sales, waste_report } = data;

  const dayNames = {
    monday: "Lunes",
    tuesday: "Martes",
    wednesday: "Miércoles",
    thursday: "Jueves",
    friday: "Viernes",
    saturday: "Sábado",
    sunday: "Domingo",
  };

  const entries = Object.entries(weekly_sales);
  const totalRevenue = entries.reduce((s, [, d]) => s + d.revenue, 0);

  // Semana anterior simulada: -8.2%
  const vsPrevWeek = 8.2;

  // Mejor y peor día
  const sorted = [...entries].toSorted((a, b) => b[1].revenue - a[1].revenue);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Top 5 platos por margen
  const menuByMargin = [...menu].toSorted((a, b) => b.margin_pct - a.margin_pct);
  const top5 = menuByMargin.slice(0, 5);

  // Platos a revisar (margen < 55%)
  const lowMargin = menu.filter((m) => m.margin_pct < 55);

  // Waste details
  const wasteItems = waste_report.worst_items;
  const totalWasteWeek = wasteItems.reduce((s, w) => s + w.value_ars, 0);

  const top5Lines = top5
    .map((m, i) => `${i + 1}. ${m.dish} — ${fmtPct(m.margin_pct)} margen ($${fmtNum(m.price)})`)
    .join("\n");

  const lowMarginLines = lowMargin
    .map((m) => `• <b>${m.dish}</b> — ${fmtPct(m.margin_pct)} (debajo mínimo)`)
    .join("\n");

  const wasteLines = wasteItems.map((w) => `• ${w.item}: $${fmtNum(w.value_ars)}`).join("\n");

  return [
    `<b>📊 RestoBot Semanal — ${restaurant.name}</b>`,
    `Semana 17-23 Marzo 2026`,
    ``,
    `💰 Ventas: <b>$${fmtNum(totalRevenue)}</b>`,
    `📈 vs semana anterior: <b>+${fmtPct(vsPrevWeek)}</b>`,
    `🏆 Mejor día: ${dayNames[best[0]]} ($${fmtNum(best[1].revenue)}, ${best[1].covers} cubiertos)`,
    `📉 Peor día: ${dayNames[worst[0]]} ($${fmtNum(worst[1].revenue)}, ${worst[1].covers} cubiertos)`,
    ``,
    `🍽 <b>Top 5 platos por margen:</b>`,
    top5Lines,
    ``,
    `⚠️ <b>Platos a revisar:</b>`,
    lowMarginLines,
    ``,
    `🗑 <b>Merma semanal:</b> $${fmtNum(totalWasteWeek)} (${fmtPct(waste_report.total_waste_pct)} del costo)`,
    wasteLines,
    ``,
    `💡 <i>Si corriges estas ${wasteItems.length} categorías, ahorras $${fmtNum(waste_report.monthly_waste_value)}/mes</i>`,
  ].join("\n");
}

/**
 * Отчёт по алертам
 * @param {object} data
 * @returns {string} HTML-сообщение
 */
function generateAlerts(data) {
  const { restaurant, alerts } = data;

  const icons = {
    margin: "💰",
    waste: "🗑",
    demand: "📈",
  };

  const severityLabels = {
    margin: "MARGEN BAJO",
    waste: "MERMA ALTA",
    demand: "DEMANDA ALTA",
  };

  const alertLines = alerts
    .map((a) => {
      const icon = icons[a.type] || "⚠️";
      const label = severityLabels[a.type] || "ALERTA";
      return [`${icon} <b>[${label}]</b>`, `${a.message}`, `→ <i>${a.action}</i>`].join("\n");
    })
    .join("\n\n");

  return [
    `<b>⚠️ RestoBot Alertas — ${restaurant.name}</b>`,
    `21/03/2026 — ${alerts.length} alertas activas`,
    ``,
    alertLines,
    ``,
    `<i>Estas alertas se generan automáticamente analizando ventas, márgenes y merma.</i>`,
    `<i>RestoBot revisa tus datos cada día para que no pierdas plata.</i>`,
  ].join("\n");
}

// ── Отправка в Telegram ──────────────────────────────────────────────────────

/**
 * Отправить сообщение в Telegram thread 20
 * @param {string} html - HTML-сообщение
 * @param {string} label - Метка для лога
 * @returns {Promise<void>}
 */
async function sendToTelegram(html, label) {
  let telegramHelper;
  try {
    telegramHelper = require(TELEGRAM_HELPER_PATH);
  } catch (err) {
    console.error(`[ERROR] Не удалось загрузить telegram-helper.cjs: ${err.message}`);
    process.exit(1);
  }

  const result = await telegramHelper.send(html, {
    silent: false,
    threadId: TELEGRAM_THREAD_ID,
    parseMode: "HTML",
  });

  if (result.ok) {
    console.log(`[OK] ${label} отправлен (msg #${result.messageId})`);
  } else {
    console.error(`[ERROR] ${label}: ${result.error}`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const shouldSend = args.includes("--send");
  const command = args.find((a) => !a.startsWith("-")) || (shouldSend ? "all" : null);

  if (!command) {
    console.log("Использование:");
    console.log("  node demo-report.cjs daily     # Дневной отчёт");
    console.log("  node demo-report.cjs weekly    # Недельный отчёт");
    console.log("  node demo-report.cjs alerts    # Алерты");
    console.log("  node demo-report.cjs all       # Все три");
    console.log("  node demo-report.cjs --send    # Отправить в Telegram (thread 20)");
    process.exit(0);
  }

  const data = loadData();

  /** @type {Array<{label: string, html: string}>} */
  const reports = [];

  if (command === "daily" || command === "all") {
    reports.push({ label: "Daily report", html: generateDaily(data) });
  }
  if (command === "weekly" || command === "all") {
    reports.push({ label: "Weekly report", html: generateWeekly(data) });
  }
  if (command === "alerts" || command === "all") {
    reports.push({ label: "Alerts report", html: generateAlerts(data) });
  }

  if (reports.length === 0) {
    console.error(`[ERROR] Неизвестная команда: ${command}`);
    console.error("Доступные: daily, weekly, alerts, all");
    process.exit(1);
  }

  // Вывод в консоль
  for (const r of reports) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${r.label}`);
    console.log(`${"=".repeat(60)}\n`);
    // Для консоли убираем HTML-теги для читаемости
    const plain = r.html
      .replace(/<b>/g, "")
      .replace(/<\/b>/g, "")
      .replace(/<i>/g, "")
      .replace(/<\/i>/g, "");
    console.log(plain);
  }

  // Отправка в Telegram
  if (shouldSend) {
    console.log(
      `\n--- Отправка ${reports.length} отчётов в Telegram (thread ${TELEGRAM_THREAD_ID}) ---\n`,
    );
    for (const r of reports) {
      await sendToTelegram(r.html, r.label);
    }
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
