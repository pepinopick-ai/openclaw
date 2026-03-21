#!/usr/bin/env node
/**
 * Pepino Pick — Currency Updater (Blue Dollar Rate)
 *
 * Обновляет курс Blue Dollar из публичных API и сохраняет в общий файл,
 * который используют другие скрипты для конвертации ARS <-> USD.
 *
 * Источники:
 *   1. dolarapi.com/v1/dolares/blue (primary)
 *   2. api.bluelytics.com.ar/v2/latest (fallback)
 *
 * Файл курсов: ~/.openclaw/.exchange-rates.json
 *
 * Алерт в Telegram если курс изменился >3% от предыдущего.
 *
 * Cron: 0 9,15 * * 1-5 (будни, 09:00 и 15:00)
 * Usage: node currency-updater.cjs [--dry-run]
 */

"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { sendAlert } = require("./telegram-helper.cjs");
const { trace } = require("./langfuse-trace.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const RATES_FILE = path.join(os.homedir(), ".openclaw", ".exchange-rates.json");
const DRY_RUN = process.argv.includes("--dry-run");

/** Порог изменения курса для алерта (3%) */
const CHANGE_ALERT_PCT = 3;

/** Максимальный возраст курса для getBlueRate() — 24 часа */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Значение по умолчанию если файл курсов отсутствует или устарел */
const FALLBACK_RATE = 1435;

/** Топик Telegram для алертов по курсу */
const TG_THREAD_CURRENCY = 20;

// ── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Выполняет HTTPS GET запрос и возвращает распарсенный JSON.
 * @param {string} url — полный URL
 * @param {number} [timeoutMs=10000] — таймаут в мс
 * @returns {Promise<object>}
 */
function fetchJson(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} от ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err) {
          reject(new Error(`JSON parse error от ${url}: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs}ms) от ${url}`));
    });
  });
}

// ── Получение курсов ────────────────────────────────────────────────────────

/**
 * Получает курсы из dolarapi.com (primary).
 * Формат ответа: { compra: number, venta: number, ... }
 * @returns {Promise<{blue_buy: number, blue_sell: number, source: string}>}
 */
async function fetchFromDolarApi() {
  const data = await fetchJson("https://dolarapi.com/v1/dolares/blue");

  if (!data.compra || !data.venta) {
    throw new Error("dolarapi: поля compra/venta отсутствуют");
  }

  // Также пробуем получить oficial для полноты данных
  let officialBuy = 0;
  let officialSell = 0;
  try {
    const official = await fetchJson("https://dolarapi.com/v1/dolares/oficial");
    officialBuy = official.compra || 0;
    officialSell = official.venta || 0;
  } catch {
    // Официальный курс не критичен
  }

  return {
    blue_buy: data.compra,
    blue_sell: data.venta,
    official_buy: officialBuy,
    official_sell: officialSell,
    source: "dolarapi.com",
  };
}

/**
 * Получает курсы из bluelytics.com.ar (fallback).
 * Формат: { blue: { value_buy, value_sell }, oficial: { value_buy, value_sell }, ... }
 * @returns {Promise<{blue_buy: number, blue_sell: number, source: string}>}
 */
async function fetchFromBluelytics() {
  const data = await fetchJson("https://api.bluelytics.com.ar/v2/latest");

  if (!data.blue || !data.blue.value_sell) {
    throw new Error("bluelytics: поле blue.value_sell отсутствует");
  }

  return {
    blue_buy: data.blue.value_buy || 0,
    blue_sell: data.blue.value_sell,
    official_buy: data.oficial?.value_buy || 0,
    official_sell: data.oficial?.value_sell || 0,
    source: "bluelytics.com.ar",
  };
}

/**
 * Получает курс из primary API, при ошибке — из fallback.
 * @returns {Promise<{blue_buy: number, blue_sell: number, official_buy: number, official_sell: number, source: string}>}
 */
async function fetchRates() {
  try {
    const rates = await fetchFromDolarApi();
    console.log(
      `[OK] Курс получен из dolarapi.com: buy=${rates.blue_buy}, sell=${rates.blue_sell}`,
    );
    return rates;
  } catch (err) {
    console.warn(`[WARN] dolarapi.com недоступен: ${err.message}`);
    console.log("[INFO] Пробуем fallback: bluelytics.com.ar...");
  }

  const rates = await fetchFromBluelytics();
  console.log(
    `[OK] Курс получен из bluelytics (fallback): buy=${rates.blue_buy}, sell=${rates.blue_sell}`,
  );
  return rates;
}

// ── Работа с файлом курсов ──────────────────────────────────────────────────

/**
 * Читает предыдущие курсы из файла.
 * @returns {object|null}
 */
function readPreviousRates() {
  try {
    if (!fs.existsSync(RATES_FILE)) return null;
    const raw = fs.readFileSync(RATES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Сохраняет курсы в JSON файл.
 * @param {object} rates
 */
function saveRates(rates) {
  const dir = path.dirname(RATES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2) + "\n", "utf-8");
}

// ── Helper для внешних скриптов ─────────────────────────────────────────────

/**
 * Возвращает текущий курс Blue Dollar (sell) из файла.
 * Если файл отсутствует или курс старше 24 часов — возвращает fallback.
 *
 * @param {number} [fallback=1435] — значение по умолчанию
 * @returns {number}
 */
function getBlueRate(fallback = FALLBACK_RATE) {
  try {
    if (!fs.existsSync(RATES_FILE)) return fallback;
    const raw = fs.readFileSync(RATES_FILE, "utf-8");
    const data = JSON.parse(raw);

    if (!data.blue_sell || !data.updated_at) return fallback;

    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > MAX_AGE_MS) return fallback;

    return data.blue_sell;
  } catch {
    return fallback;
  }
}

/**
 * Возвращает все курсы из файла или null если данных нет / устарели.
 * @returns {{blue_buy: number, blue_sell: number, official_buy: number, official_sell: number, updated_at: string, source: string}|null}
 */
function getAllRates() {
  try {
    if (!fs.existsSync(RATES_FILE)) return null;
    const raw = fs.readFileSync(RATES_FILE, "utf-8");
    const data = JSON.parse(raw);

    if (!data.blue_sell || !data.updated_at) return null;

    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > MAX_AGE_MS) return null;

    return data;
  } catch {
    return null;
  }
}

// ── Анализ изменения курса ──────────────────────────────────────────────────

/**
 * Рассчитывает процент изменения курса.
 * @param {number} oldRate
 * @param {number} newRate
 * @returns {number} — процент изменения (может быть отрицательным)
 */
function calcChangePct(oldRate, newRate) {
  if (!oldRate || oldRate === 0) return 0;
  return ((newRate - oldRate) / oldRate) * 100;
}

/**
 * Формирует текст алерта об изменении курса.
 * @param {object} newRates
 * @param {object} prevRates
 * @param {number} changePct
 * @returns {string}
 */
function formatChangeAlert(newRates, prevRates, changePct) {
  const direction = changePct > 0 ? "ВЫРОС" : "УПАЛ";
  const arrow = changePct > 0 ? "↑" : "↓";
  const lines = [
    `${arrow} *Blue Dollar ${direction} на ${Math.abs(changePct).toFixed(1)}%*`,
    "",
    `Продажа: ${prevRates.blue_sell} -> ${newRates.blue_sell} ARS`,
    `Покупка: ${prevRates.blue_buy} -> ${newRates.blue_buy} ARS`,
    "",
    `Источник: ${newRates.source}`,
  ];

  if (newRates.official_sell > 0) {
    const spread = ((newRates.blue_sell / newRates.official_sell - 1) * 100).toFixed(1);
    lines.push(`Brecha: ${spread}% (oficial sell: ${newRates.official_sell})`);
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(`[${new Date().toISOString()}] Currency updater starting...`);

  if (DRY_RUN) {
    console.log("[DRY-RUN] Режим без записи и отправки");
  }

  // Получаем текущие курсы
  const newRates = await fetchRates();

  // Читаем предыдущие
  const prevRates = readPreviousRates();

  // Формируем объект для сохранения
  const ratesRecord = {
    blue_buy: newRates.blue_buy,
    blue_sell: newRates.blue_sell,
    official_buy: newRates.official_buy,
    official_sell: newRates.official_sell,
    updated_at: new Date().toISOString(),
    source: newRates.source,
  };

  // Проверяем изменение курса
  let changePct = 0;
  let alertSent = false;
  if (prevRates && prevRates.blue_sell > 0) {
    changePct = calcChangePct(prevRates.blue_sell, newRates.blue_sell);
    console.log(
      `[INFO] Изменение sell: ${changePct.toFixed(2)}% (${prevRates.blue_sell} -> ${newRates.blue_sell})`,
    );

    if (Math.abs(changePct) >= CHANGE_ALERT_PCT) {
      const alertText = formatChangeAlert(newRates, prevRates, changePct);
      console.log(
        `[ALERT] Курс изменился на ${Math.abs(changePct).toFixed(1)}% — отправляем алерт`,
      );

      if (!DRY_RUN) {
        try {
          await sendAlert(alertText, TG_THREAD_CURRENCY);
          alertSent = true;
          console.log("[OK] Алерт отправлен в Telegram");
        } catch (err) {
          console.error(`[ERROR] Telegram алерт: ${err.message}`);
        }
      } else {
        console.log("[DRY-RUN] Алерт (не отправлен):\n" + alertText);
      }
    }
  } else {
    console.log("[INFO] Предыдущих курсов нет — первый запуск");
  }

  // Сохраняем
  if (!DRY_RUN) {
    saveRates(ratesRecord);
    console.log(`[OK] Курсы сохранены в ${RATES_FILE}`);
  } else {
    console.log("[DRY-RUN] Курсы (не сохранены):");
    console.log(JSON.stringify(ratesRecord, null, 2));
  }

  // Langfuse
  await trace({
    name: "currency-updater",
    input: { source: newRates.source, dry_run: DRY_RUN },
    output: {
      blue_buy: newRates.blue_buy,
      blue_sell: newRates.blue_sell,
      official_sell: newRates.official_sell,
      change_pct: Number(changePct.toFixed(2)),
      alert_sent: alertSent,
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "currency-updater" },
  }).catch(() => {});

  console.log(`Done in ${Date.now() - startMs}ms`);
}

// Запуск только при прямом вызове (не при require)
if (require.main === module) {
  main().catch((err) => {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  });
}

// ── Экспорт ─────────────────────────────────────────────────────────────────

module.exports = {
  getBlueRate,
  getAllRates,
  RATES_FILE,
  FALLBACK_RATE,
};
