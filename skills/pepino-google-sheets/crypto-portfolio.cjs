#!/usr/bin/env node
/**
 * Pepino Pick — Crypto Portfolio Tracker & DCA Helper
 *
 * READ-ONLY модуль для мониторинга крипто-портфеля.
 * НЕ выполняет торговых операций — только отслеживание, планирование DCA, алерты.
 *
 * Команды:
 *   prices    — обновить цены BTC/ETH/DOGE с CoinGecko
 *   portfolio — показать портфель: холдинги, P&L, аллокация
 *   dca <usd> — рассчитать DCA-план (60% BTC, 40% ETH) + запись в Sheets
 *   risk      — проверка рисков: аллокация, просадка, 200DMA
 *   report    — месячный отчёт: DCA вклады, swing P&L, хеджирование от инфляции
 *
 * Биржи: Binance + Bybit (read-only, без execution)
 * Стратегия: 60% BTC / 40% ETH (HODL), 20-30% портфеля для swing (DOGE)
 *
 * Cron:
 *   30 9 * * *   — prices (ежедневно)
 *   0 10 * * 0   — report (воскресенье)
 *
 * Usage:
 *   node crypto-portfolio.cjs prices [--dry-run]
 *   node crypto-portfolio.cjs portfolio [--dry-run]
 *   node crypto-portfolio.cjs dca 200 [--dry-run]
 *   node crypto-portfolio.cjs risk [--dry-run]
 *   node crypto-portfolio.cjs report [--dry-run]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { trace } = require("./langfuse-trace.cjs");
const { send } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// ── Конфигурация ──────────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/root";
const MEMORY_DIR = path.join(HOME, ".openclaw", "workspace", "memory");
const PRICES_FILE = path.join(MEMORY_DIR, "crypto_prices.json");
const PORTFOLIO_FILE = path.join(MEMORY_DIR, "crypto_portfolio.json");
const RATES_FILE = path.join(HOME, ".openclaw", ".exchange-rates.json");

const TG_THREAD_CRYPTO = 58; // Крипто-топик
const DRY_RUN = process.argv.includes("--dry-run");

// DCA стратегия: 60% BTC, 40% ETH (для HODL-части)
const DCA_SPLIT = { BTC: 0.6, ETH: 0.4 };

// Целевая аллокация HODL (от общего портфеля)
const TARGET_ALLOCATION = { BTC: 0.6, ETH: 0.4 };
const ALLOCATION_DRIFT_THRESHOLD = 5; // алерт если дрифт >5%

// Риск-параметры
const MAX_SWING_ALLOCATION_PCT = 30; // swing не >30% портфеля
const MAX_SINGLE_POSITION_PCT = 10; // одна позиция не >10% trading capital
const DRAWDOWN_ALERT_PCT = 5; // алерт если портфель -5% от пика
const ATH_DIP_THRESHOLD = 20; // "дип" = -20% от ATH

// Известные ATH (обновлять вручную при новых максимумах)
const KNOWN_ATH = {
  BTC: 109000,
  ETH: 4890,
  DOGE: 0.74,
};

// ── Утилиты ───────────────────────────────────────────────────────────────────

/** HTTP GET JSON через https */
function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.get(
      {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        timeout: timeoutMs,
        headers: { "User-Agent": "PepinoPick/1.0", Accept: "application/json" },
      },
      (res) => {
        if (res.statusCode === 429) {
          reject(new Error("CoinGecko rate limit (429). Попробуйте позже."));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} от ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error(`JSON parse error от ${url}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout ${timeoutMs}ms от ${url}`));
    });
  });
}

/** Безопасное чтение JSON-файла */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Запись JSON-файла с mkdir -p */
function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Курс Blue Dollar (ARS/USD) */
function getBlueRate() {
  const rates = readJsonFile(RATES_FILE);
  if (rates && rates.blue_sell > 0) return rates.blue_sell;
  return 1425; // fallback
}

/** Дата в ISO (YYYY-MM-DD) */
function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

/** Форматирование USD */
function fmtUsd(n) {
  return (
    "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** Форматирование процента */
function fmtPct(n) {
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(1) + "%";
}

/** Отправка сообщения в Telegram (крипто-тред) */
async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log("[DRY-RUN] Telegram не отправлен");
    return;
  }
  try {
    if (sendThrottled) {
      await sendThrottled(text, {
        thread: TG_THREAD_CRYPTO,
        silent: false,
        priority: "normal",
        parseMode: "HTML",
      });
    } else {
      await send(text, {
        silent: false,
        threadId: TG_THREAD_CRYPTO,
        parseMode: "HTML",
      });
    }
    console.log("[OK] Telegram отправлен");
  } catch (err) {
    console.error(`[ERROR] Telegram: ${err.message}`);
  }
}

/** Загрузка текущего портфеля (создаёт пустой если не существует) */
function loadPortfolio() {
  const existing = readJsonFile(PORTFOLIO_FILE);
  if (existing) return existing;

  // Шаблон пустого портфеля — пользователь заполнит вручную
  const template = {
    _comment: "Заполните holdings реальными данными. type: hodl | swing",
    hodl: [
      { coin: "BTC", amount: 0, avg_buy_price_usd: 0, exchange: "binance" },
      { coin: "ETH", amount: 0, avg_buy_price_usd: 0, exchange: "binance" },
    ],
    swing: [{ coin: "DOGE", amount: 0, avg_buy_price_usd: 0, exchange: "bybit" }],
    peak_value_usd: 0,
    dca_history: [],
    updated_at: new Date().toISOString(),
  };

  writeJsonFile(PORTFOLIO_FILE, template);
  console.log(`[INFO] Создан шаблон портфеля: ${PORTFOLIO_FILE}`);
  console.log("[INFO] Заполните holdings реальными данными и запустите снова.");
  return template;
}

/** Загрузка цен */
function loadPrices() {
  return readJsonFile(PRICES_FILE) || {};
}

// ── Команда: prices ───────────────────────────────────────────────────────────

async function cmdPrices() {
  const startMs = Date.now();
  console.log("Загрузка цен с CoinGecko...");

  const url =
    "https://api.coingecko.com/api/v3/simple/price" +
    "?ids=bitcoin,ethereum,dogecoin" +
    "&vs_currencies=usd" +
    "&include_24hr_change=true" +
    "&include_24hr_vol=true";

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    console.error(`[ERROR] CoinGecko: ${err.message}`);
    console.log("Используем кэшированные цены.");
    return;
  }

  const COIN_MAP = {
    bitcoin: "BTC",
    ethereum: "ETH",
    dogecoin: "DOGE",
  };

  const now = new Date().toISOString();
  const existing = loadPrices();

  for (const [geckoId, ticker] of Object.entries(COIN_MAP)) {
    const info = data[geckoId];
    if (!info) continue;

    existing[ticker] = {
      price: info.usd,
      timestamp: now,
      change_24h: info.usd_24h_change || 0,
      change_7d: existing[ticker]?.change_7d || 0,
      avg_vol_7d: info.usd_24h_vol || existing[ticker]?.avg_vol_7d || 0,
    };
  }

  writeJsonFile(PRICES_FILE, existing);

  // Вывод
  const lines = [`<b>Crypto Prices — ${dateStr(new Date())}</b>\n`];
  for (const ticker of ["BTC", "ETH", "DOGE"]) {
    const p = existing[ticker];
    if (!p) continue;

    const chg24 = p.change_24h || 0;
    const emoji = chg24 > 2 ? "🟢" : chg24 < -2 ? "🔴" : "⚪";
    const athPct = KNOWN_ATH[ticker] ? ((p.price / KNOWN_ATH[ticker] - 1) * 100).toFixed(1) : "n/a";

    lines.push(
      `${emoji} <b>${ticker}</b>: ${fmtUsd(p.price)}  ` +
        `24h: ${fmtPct(chg24)}  ` +
        `ATH: ${athPct}%`,
    );
  }

  const blueRate = getBlueRate();
  lines.push(`\nBlue Dollar: ${blueRate} ARS/USD`);

  const report = lines.join("\n");
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  await sendTelegram(report);

  await trace({
    name: "crypto-prices",
    input: { source: "coingecko" },
    output: Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, v.price])),
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "crypto-prices" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// ── Команда: portfolio ────────────────────────────────────────────────────────

async function cmdPortfolio() {
  const startMs = Date.now();
  const portfolio = loadPortfolio();
  const prices = loadPrices();

  if (!prices.BTC) {
    console.error(
      "[ERROR] Нет данных о ценах. Запустите сначала: node crypto-portfolio.cjs prices",
    );
    return;
  }

  const allHoldings = [
    ...(portfolio.hodl || []).map((h) => ({ ...h, type: "hodl" })),
    ...(portfolio.swing || []).map((h) => ({ ...h, type: "swing" })),
  ];

  // Расчёт P&L и аллокации
  let totalValue = 0;
  let hodlValue = 0;
  let swingValue = 0;
  const rows = [];

  for (const h of allHoldings) {
    const currentPrice = prices[h.coin]?.price || 0;
    const value = h.amount * currentPrice;
    const costBasis = h.amount * h.avg_buy_price_usd;
    const pnl = costBasis > 0 ? ((value - costBasis) / costBasis) * 100 : 0;

    totalValue += value;
    if (h.type === "hodl") hodlValue += value;
    else swingValue += value;

    rows.push({
      coin: h.coin,
      type: h.type,
      amount: h.amount,
      avgBuy: h.avg_buy_price_usd,
      currentPrice,
      value,
      pnl,
      exchange: h.exchange || "?",
    });
  }

  // Обновляем peak value
  if (totalValue > (portfolio.peak_value_usd || 0)) {
    portfolio.peak_value_usd = totalValue;
    if (!DRY_RUN) writeJsonFile(PORTFOLIO_FILE, portfolio);
  }

  // Форматирование
  const blueRate = getBlueRate();
  const totalArs = totalValue * blueRate;
  const lines = [`<b>Crypto Portfolio — ${dateStr(new Date())}</b>\n`];

  if (totalValue === 0) {
    lines.push("Портфель пуст. Заполните данные в:");
    lines.push(`<code>${PORTFOLIO_FILE}</code>`);
  } else {
    lines.push(
      `<b>Всего:</b> ${fmtUsd(totalValue)} (${Math.round(totalArs).toLocaleString()} ARS)`,
    );
    lines.push(`HODL: ${fmtUsd(hodlValue)} | Swing: ${fmtUsd(swingValue)}`);
    lines.push(`Swing доля: ${((swingValue / totalValue) * 100).toFixed(1)}%\n`);

    // Таблица холдингов
    for (const r of rows) {
      if (r.amount === 0) continue;

      const pnlEmoji = r.pnl > 5 ? "🟢" : r.pnl < -5 ? "🔴" : "⚪";
      const allocPct = totalValue > 0 ? ((r.value / totalValue) * 100).toFixed(1) : "0.0";
      lines.push(
        `${pnlEmoji} <b>${r.coin}</b> (${r.type}): ` +
          `${r.amount} @ ${fmtUsd(r.currentPrice)} = ${fmtUsd(r.value)} ` +
          `[P&L: ${fmtPct(r.pnl)}, ${allocPct}%]`,
      );
    }

    // Проверка дрифта аллокации HODL
    if (hodlValue > 0) {
      lines.push(`\n<b>Аллокация HODL (цель: 60/40):</b>`);
      for (const h of portfolio.hodl || []) {
        const currentPrice = prices[h.coin]?.price || 0;
        const value = h.amount * currentPrice;
        const actualPct = (value / hodlValue) * 100;
        const targetPct = (TARGET_ALLOCATION[h.coin] || 0) * 100;
        const drift = Math.abs(actualPct - targetPct);
        const driftEmoji = drift > ALLOCATION_DRIFT_THRESHOLD ? "⚠️" : "✅";
        lines.push(
          `  ${driftEmoji} ${h.coin}: ${actualPct.toFixed(1)}% (цель: ${targetPct}%, дрифт: ${drift.toFixed(1)}%)`,
        );
      }
    }
  }

  const report = lines.join("\n");
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  await sendTelegram(report);

  await trace({
    name: "crypto-portfolio",
    input: { holdings_count: allHoldings.length },
    output: { total_usd: totalValue, hodl_usd: hodlValue, swing_usd: swingValue },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "crypto-portfolio" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// ── Команда: dca ──────────────────────────────────────────────────────────────

async function cmdDca(amountUsd) {
  const startMs = Date.now();

  if (!amountUsd || amountUsd <= 0) {
    console.error("Usage: node crypto-portfolio.cjs dca <amount_usd>");
    console.error("Пример: node crypto-portfolio.cjs dca 200");
    process.exit(1);
  }

  const prices = loadPrices();
  if (!prices.BTC || !prices.ETH) {
    console.error("[ERROR] Нет данных о ценах. Запустите: node crypto-portfolio.cjs prices");
    return;
  }

  const portfolio = loadPortfolio();
  const blueRate = getBlueRate();

  // Расчёт DCA-сплита
  const btcAmount = amountUsd * DCA_SPLIT.BTC;
  const ethAmount = amountUsd * DCA_SPLIT.ETH;

  const btcPrice = prices.BTC.price;
  const ethPrice = prices.ETH.price;

  const btcQty = btcAmount / btcPrice;
  const ethQty = ethAmount / ethPrice;
  const btcSats = Math.round(btcQty * 1e8);

  // Проверка на дип (>20% ниже ATH)
  const btcDip = (btcPrice / KNOWN_ATH.BTC - 1) * 100;
  const ethDip = (ethPrice / KNOWN_ATH.ETH - 1) * 100;
  const isInDip = btcDip < -ATH_DIP_THRESHOLD || ethDip < -ATH_DIP_THRESHOLD;

  const lines = [`<b>DCA Plan — ${dateStr(new Date())}</b>\n`];
  lines.push(
    `<b>Инвестиция:</b> ${fmtUsd(amountUsd)} (${Math.round(amountUsd * blueRate).toLocaleString()} ARS)`,
  );
  lines.push("");

  lines.push(`<b>Распределение (60/40):</b>`);
  lines.push(
    `  BTC: ${fmtUsd(btcAmount)} = ${btcSats.toLocaleString()} sats (${btcQty.toFixed(8)} BTC)`,
  );
  lines.push(`  ETH: ${fmtUsd(ethAmount)} = ${ethQty.toFixed(6)} ETH`);
  lines.push("");

  lines.push(`<b>Текущие цены:</b>`);
  lines.push(`  BTC: ${fmtUsd(btcPrice)} (ATH: ${btcDip.toFixed(1)}%)`);
  lines.push(`  ETH: ${fmtUsd(ethPrice)} (ATH: ${ethDip.toFixed(1)}%)`);

  if (isInDip) {
    lines.push("");
    lines.push(`<b>DIP ALERT: Рынок >20% ниже ATH</b>`);
    lines.push(`Рекомендация: удвоить DCA до ${fmtUsd(amountUsd * 2)}`);
    lines.push(`  BTC: ${Math.round(btcSats * 2).toLocaleString()} sats`);
    lines.push(`  ETH: ${(ethQty * 2).toFixed(6)} ETH`);
  }

  lines.push("");
  lines.push(`<i>Выполните покупку вручную на бирже.</i>`);

  const report = lines.join("\n");
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  // Записать DCA-план в Google Sheets
  if (!DRY_RUN) {
    try {
      const { appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
      const today = dateStr(new Date());
      const row = [
        today,
        "DCA",
        fmtUsd(amountUsd),
        `BTC: ${btcSats} sats`,
        `ETH: ${ethQty.toFixed(6)}`,
        fmtUsd(btcPrice),
        fmtUsd(ethPrice),
        isInDip ? "DIP — рекомендовано x2" : "Обычный",
        "Запланировано",
      ];
      await appendToSheet(PEPINO_SHEETS_ID, [row], "📊 Крипто");
      console.log("[OK] DCA-план записан в Sheets (📊 Крипто)");
    } catch (err) {
      console.error(`[WARN] Sheets запись не удалась: ${err.message}`);
      console.log("[INFO] Лист '📊 Крипто' может не существовать — создайте вручную.");
    }

    // Сохраняем в историю портфеля
    if (!portfolio.dca_history) portfolio.dca_history = [];
    portfolio.dca_history.push({
      date: dateStr(new Date()),
      amount_usd: amountUsd,
      btc_sats: btcSats,
      eth_qty: ethQty,
      btc_price: btcPrice,
      eth_price: ethPrice,
      is_dip: isInDip,
    });
    writeJsonFile(PORTFOLIO_FILE, portfolio);
  }

  await sendTelegram(report);

  await trace({
    name: "crypto-dca",
    input: { amount_usd: amountUsd },
    output: { btc_sats: btcSats, eth_qty: ethQty, is_dip: isInDip },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "crypto-dca" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// ── Команда: risk ─────────────────────────────────────────────────────────────

async function cmdRisk() {
  const startMs = Date.now();
  const portfolio = loadPortfolio();
  const prices = loadPrices();

  if (!prices.BTC) {
    console.error("[ERROR] Нет данных о ценах. Запустите: node crypto-portfolio.cjs prices");
    return;
  }

  const allHoldings = [
    ...(portfolio.hodl || []).map((h) => ({ ...h, type: "hodl" })),
    ...(portfolio.swing || []).map((h) => ({ ...h, type: "swing" })),
  ];

  // Значения
  let totalValue = 0;
  let swingValue = 0;
  const positionValues = [];

  for (const h of allHoldings) {
    const currentPrice = prices[h.coin]?.price || 0;
    const value = h.amount * currentPrice;
    totalValue += value;
    if (h.type === "swing") swingValue += value;
    positionValues.push({ coin: h.coin, type: h.type, value });
  }

  const alerts = [];
  const checks = [];

  // 1. Swing аллокация >30%
  const swingPct = totalValue > 0 ? (swingValue / totalValue) * 100 : 0;
  if (swingPct > MAX_SWING_ALLOCATION_PCT) {
    alerts.push(`Swing аллокация ${swingPct.toFixed(1)}% > лимит ${MAX_SWING_ALLOCATION_PCT}%`);
    checks.push(`🔴 Swing: ${swingPct.toFixed(1)}% (макс ${MAX_SWING_ALLOCATION_PCT}%)`);
  } else {
    checks.push(`🟢 Swing: ${swingPct.toFixed(1)}% (макс ${MAX_SWING_ALLOCATION_PCT}%)`);
  }

  // 2. Одна позиция >10% trading capital (swing)
  if (swingValue > 0) {
    for (const p of positionValues.filter((x) => x.type === "swing")) {
      const pct = (p.value / swingValue) * 100;
      if (
        pct > MAX_SINGLE_POSITION_PCT &&
        positionValues.filter((x) => x.type === "swing").length > 1
      ) {
        alerts.push(`${p.coin} = ${pct.toFixed(1)}% от swing (макс ${MAX_SINGLE_POSITION_PCT}%)`);
      }
    }
  }

  // 3. Просадка от пика
  const peakValue = portfolio.peak_value_usd || totalValue;
  const drawdown = peakValue > 0 ? ((totalValue - peakValue) / peakValue) * 100 : 0;
  if (drawdown < -DRAWDOWN_ALERT_PCT) {
    alerts.push(`Портфель ${drawdown.toFixed(1)}% от пика (${fmtUsd(peakValue)})`);
    checks.push(`🔴 Просадка: ${drawdown.toFixed(1)}% от пика ${fmtUsd(peakValue)}`);
  } else {
    checks.push(`🟢 Просадка: ${drawdown.toFixed(1)}% от пика ${fmtUsd(peakValue)}`);
  }

  // 4. BTC ниже 200DMA — упрощённая проверка через ATH
  // Без полных исторических данных используем proxy: если BTC >35% ниже ATH = risk-off
  const btcPrice = prices.BTC?.price || 0;
  const btcVsAth = (btcPrice / KNOWN_ATH.BTC - 1) * 100;
  if (btcVsAth < -35) {
    alerts.push(`BTC ${btcVsAth.toFixed(1)}% от ATH — возможный risk-off сигнал`);
    checks.push(`🔴 BTC vs ATH: ${btcVsAth.toFixed(1)}% (risk-off зона <-35%)`);
  } else if (btcVsAth < -20) {
    checks.push(`🟡 BTC vs ATH: ${btcVsAth.toFixed(1)}% (зона дипа)`);
  } else {
    checks.push(`🟢 BTC vs ATH: ${btcVsAth.toFixed(1)}%`);
  }

  // Макс. потери если все swing обнулятся (worst case)
  const maxSwingLoss = swingValue;
  checks.push(`\nМакс. потеря swing (worst case): ${fmtUsd(maxSwingLoss)}`);
  checks.push(`Portfolio heat (swing/total): ${swingPct.toFixed(1)}%`);

  // Формат
  const lines = [`<b>Risk Monitor — ${dateStr(new Date())}</b>\n`];
  lines.push(`<b>Портфель:</b> ${fmtUsd(totalValue)}`);
  lines.push("");

  for (const c of checks) {
    lines.push(c);
  }

  if (alerts.length > 0) {
    lines.push(`\n<b>ALERTS (${alerts.length}):</b>`);
    for (const a of alerts) {
      lines.push(`  ⚠️ ${a}`);
    }
    lines.push(`\n<i>Рекомендация: пересмотрите аллокацию и стоп-лоссы.</i>`);
  } else {
    lines.push(`\n✅ <b>Все проверки в норме.</b>`);
  }

  const report = lines.join("\n");
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  await sendTelegram(report);

  await trace({
    name: "crypto-risk",
    input: { total_value: totalValue },
    output: {
      swing_pct: swingPct,
      drawdown,
      btc_vs_ath: btcVsAth,
      alerts_count: alerts.length,
      alerts,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "crypto-risk" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// ── Команда: report ───────────────────────────────────────────────────────────

async function cmdReport() {
  const startMs = Date.now();
  const portfolio = loadPortfolio();
  const prices = loadPrices();

  if (!prices.BTC) {
    console.error("[ERROR] Нет данных о ценах. Запустите: node crypto-portfolio.cjs prices");
    return;
  }

  const blueRate = getBlueRate();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthName = now.toLocaleString("ru-RU", { month: "long", year: "numeric" });

  // DCA за текущий месяц
  const dcaThisMonth = (portfolio.dca_history || []).filter((d) => {
    return new Date(d.date) >= monthStart;
  });
  const totalDcaUsd = dcaThisMonth.reduce((s, d) => s + d.amount_usd, 0);
  const totalDcaSats = dcaThisMonth.reduce((s, d) => s + (d.btc_sats || 0), 0);
  const totalDcaEth = dcaThisMonth.reduce((s, d) => s + (d.eth_qty || 0), 0);

  // Портфель HODL
  let hodlValue = 0;
  let hodlCost = 0;
  for (const h of portfolio.hodl || []) {
    const cp = prices[h.coin]?.price || 0;
    hodlValue += h.amount * cp;
    hodlCost += h.amount * h.avg_buy_price_usd;
  }
  const hodlPnl = hodlCost > 0 ? ((hodlValue - hodlCost) / hodlCost) * 100 : 0;

  // Портфель swing
  let swingValue = 0;
  let swingCost = 0;
  for (const h of portfolio.swing || []) {
    const cp = prices[h.coin]?.price || 0;
    swingValue += h.amount * cp;
    swingCost += h.amount * h.avg_buy_price_usd;
  }
  const swingPnl = swingCost > 0 ? ((swingValue - swingCost) / swingCost) * 100 : 0;

  const totalValue = hodlValue + swingValue;
  const totalArs = totalValue * blueRate;

  // Хеджирование: насколько крипта защищает от инфляции ARS
  // Аргентинская инфляция ~5-8%/мес (используем 6% как оценку)
  const monthlyInflation = 6;
  const inflationLoss = totalArs * (monthlyInflation / 100);

  const lines = [`<b>Crypto Report — ${monthName}</b>\n`];

  // Общие показатели
  lines.push(
    `<b>Портфель:</b> ${fmtUsd(totalValue)} (${Math.round(totalArs).toLocaleString()} ARS)`,
  );
  lines.push("");

  // HODL
  lines.push(`<b>HODL:</b> ${fmtUsd(hodlValue)} [P&L: ${fmtPct(hodlPnl)}]`);
  for (const h of portfolio.hodl || []) {
    if (h.amount === 0) continue;
    const cp = prices[h.coin]?.price || 0;
    lines.push(`  ${h.coin}: ${h.amount} x ${fmtUsd(cp)} = ${fmtUsd(h.amount * cp)}`);
  }

  // Swing
  lines.push(`\n<b>Swing:</b> ${fmtUsd(swingValue)} [P&L: ${fmtPct(swingPnl)}]`);
  for (const h of portfolio.swing || []) {
    if (h.amount === 0) continue;
    const cp = prices[h.coin]?.price || 0;
    lines.push(`  ${h.coin}: ${h.amount} x ${fmtUsd(cp)} = ${fmtUsd(h.amount * cp)}`);
  }

  // DCA этого месяца
  lines.push(`\n<b>DCA за ${monthName}:</b>`);
  if (dcaThisMonth.length === 0) {
    lines.push("  Нет DCA-закупок в этом месяце.");
  } else {
    lines.push(`  Вкладов: ${dcaThisMonth.length}, всего: ${fmtUsd(totalDcaUsd)}`);
    lines.push(`  BTC: ${totalDcaSats.toLocaleString()} sats`);
    lines.push(`  ETH: ${totalDcaEth.toFixed(6)} ETH`);
  }

  // Хеджирование от инфляции
  lines.push(`\n<b>Хеджирование от инфляции:</b>`);
  lines.push(
    `  Инфляция ARS (~${monthlyInflation}%/мес): потеря ${Math.round(inflationLoss).toLocaleString()} ARS`,
  );
  if (hodlPnl > 0) {
    lines.push(`  Крипто P&L: ${fmtPct(hodlPnl)} — компенсирует инфляцию ✅`);
  } else {
    lines.push(`  Крипто P&L: ${fmtPct(hodlPnl)} — инфляция НЕ компенсирована ⚠️`);
  }
  lines.push(`  Blue Dollar: ${blueRate} ARS/USD`);

  const report = lines.join("\n");
  console.log("\n" + report.replace(/<[^>]+>/g, ""));

  await sendTelegram(report);

  await trace({
    name: "crypto-report",
    input: { month: monthName },
    output: {
      total_usd: totalValue,
      hodl_pnl: hodlPnl,
      swing_pnl: swingPnl,
      dca_count: dcaThisMonth.length,
      dca_total_usd: totalDcaUsd,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "crypto-report" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// ── Main router ───────────────────────────────────────────────────────────────

async function main() {
  // Извлекаем команду (пропуская флаги --dry-run и т.д.)
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const command = args[0] || "help";

  console.log(
    `[${new Date().toISOString()}] crypto-portfolio: ${command}${DRY_RUN ? " (dry-run)" : ""}`,
  );

  switch (command) {
    case "prices":
      await cmdPrices();
      break;
    case "portfolio":
      await cmdPortfolio();
      break;
    case "dca": {
      const amount = parseFloat(args[1]);
      if (isNaN(amount) || amount <= 0) {
        console.error("Usage: node crypto-portfolio.cjs dca <amount_usd>");
        process.exit(1);
      }
      await cmdDca(amount);
      break;
    }
    case "risk":
      await cmdRisk();
      break;
    case "report":
      await cmdReport();
      break;
    default:
      console.log("Pepino Pick — Crypto Portfolio Tracker\n");
      console.log("Команды:");
      console.log("  prices              Обновить цены BTC/ETH/DOGE");
      console.log("  portfolio           Показать портфель и P&L");
      console.log("  dca <amount_usd>    DCA-план (60% BTC, 40% ETH)");
      console.log("  risk                Проверка рисков");
      console.log("  report              Месячный отчёт");
      console.log("\nФлаги:");
      console.log("  --dry-run           Без отправки в Telegram / записи в Sheets");
      break;
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
