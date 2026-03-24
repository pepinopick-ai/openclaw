/**
 * land-scout.cjs -- Автоматический поиск и оценка земельных участков
 *
 * Логика:
 * 1. search: Ежедневный поиск участков (аренда/покупка) через HTTP-запросы
 *    к ZonaProp, Argenprop, Agroads, ML Inmuebles
 * 2. evaluate: Мультипараметрическая оценка по 17 критериям (scoring council)
 * 3. alert: Отправка топовых новых объявлений в Telegram thread 20
 * 4. zones: Показать одобренные/отклонённые зоны
 *
 * Использование:
 *   node land-scout.cjs search rent     -- поиск аренды
 *   node land-scout.cjs search buy      -- поиск покупки
 *   node land-scout.cjs search all      -- аренда + покупка
 *   node land-scout.cjs evaluate        -- все оценённые объявления
 *   node land-scout.cjs evaluate --top  -- топ 5
 *   node land-scout.cjs alert           -- отправить новые >60 баллов в TG
 *   node land-scout.cjs zones           -- показать зоны
 *   node land-scout.cjs zones --dry-run -- то же без Telegram
 *
 * Расписание:
 *   search all: ежедневно 10:00 ART (14:00 UTC)
 *   alert:      ежедневно 10:30 ART (14:30 UTC)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { trace } = require("./langfuse-trace.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");

// ── Конфигурация ─────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD = 20; // Director / Strategy

const STORAGE_DIR = path.join(process.env.HOME || "/root", ".openclaw/workspace/memory/investor");
const STORAGE_PATH = path.join(STORAGE_DIR, "land-listings.json");

// Минимальный балл для отправки алерта
const ALERT_THRESHOLD = 60;

// Таймаут HTTP-запросов (мс)
const HTTP_TIMEOUT_MS = 15000;

// ── Зоны: одобрено / отклонено ───────────────────────────────────────────────

const ZONES = {
  approved: {
    Cañuelas: { safety: 7, soil: 6, road: 8, local_market: 5 },
    Lobos: { safety: 8, soil: 6, road: 6, local_market: 4 },
    "San Vicente": { safety: 6, soil: 6, road: 7, local_market: 5 },
    Brandsen: { safety: 7, soil: 5, road: 6, local_market: 4 },
    Luján: { safety: 6, soil: 7, road: 7, local_market: 6 },
    Mercedes: { safety: 7, soil: 7, road: 5, local_market: 5 },
    Navarro: { safety: 7, soil: 6, road: 4, local_market: 3 },
    Suipacha: { safety: 8, soil: 7, road: 4, local_market: 3 },
  },
  rejected: {
    "General Rodriguez": {
      reason: "Homicidios 8.48/100K — #1 en conurbano",
    },
    "Marcos Paz": { reason: "Complejo Penitenciario Federal + narco" },
    Moreno: { reason: "Zona más peligrosa del conurbano" },
    "La Matanza": { reason: "Robos +59% en 2024" },
    Merlo: { reason: "Alta criminalidad" },
    Pilar: { reason: "Narco + caro + competencia hortícola" },
    Escobar: { reason: "Narco + caro" },
    "Florencio Varela": { reason: "Inseguridad + usurpación" },
  },
};

// Синонимы и вариации названий зон для авто-детектирования
const ZONE_ALIASES = {
  cañuelas: "Cañuelas",
  canuelas: "Cañuelas",
  lobos: "Lobos",
  "san vicente": "San Vicente",
  brandsen: "Brandsen",
  "coronel brandsen": "Brandsen",
  lujan: "Luján",
  luján: "Luján",
  mercedes: "Mercedes",
  navarro: "Navarro",
  suipacha: "Suipacha",
  "general rodriguez": "General Rodriguez",
  "gral rodriguez": "General Rodriguez",
  "gral. rodriguez": "General Rodriguez",
  "marcos paz": "Marcos Paz",
  moreno: "Moreno",
  "la matanza": "La Matanza",
  merlo: "Merlo",
  pilar: "Pilar",
  escobar: "Escobar",
  "florencio varela": "Florencio Varela",
};

// ── Scoring System ────────────────────────────────────────────────────────────

/**
 * Рассчитывает итоговый балл участка (0–100).
 * Возвращает null если хотя бы один критический параметр < 4 (auto-reject).
 *
 * @param {Object} p — объект со всеми 17 параметрами
 * @returns {{score: number, rejected: boolean, rejectReason: string|null}}
 */
function calculateScore(p) {
  // Критические параметры: автоотклонение если <4
  const criticalFields = ["safety", "water", "electricity"];
  for (const field of criticalFields) {
    const val = p[field] || 0;
    if (val < 4) {
      return {
        score: 0,
        rejected: true,
        rejectReason: `${field}=${val} < 4 (критический параметр)`,
      };
    }
  }

  const critical = (p.safety + p.water + p.electricity) * 3;
  const important = (p.road_ba + p.soil + p.price + p.housing + p.flat_terrain) * 2;
  const medium =
    (p.buildings || 0) + (p.gas || 0) + (p.trees_windbreak || 0) + (p.local_market || 0);
  const bonus =
    ((p.internet || 0) +
      (p.neighbors || 0) +
      (p.inta_proximity || 0) +
      (p.expansion_potential || 0) +
      (p.beauty || 0)) *
    0.5;

  const raw = critical + important + medium + bonus;
  // max = 3*30 + 2*50 + 40 + 0.5*50 = 90 + 100 + 40 + 25 = 255
  const max = 255;
  const score = Math.round((raw / max) * 100);

  return { score, rejected: false, rejectReason: null };
}

/**
 * Авто-назначение баллов по ключевым словам описания объявления.
 * Возвращает частичный объект scores на основе текста.
 *
 * @param {string} text — заголовок + описание объявления
 * @param {string} zone — распознанная зона
 * @returns {Object} partial scores
 */
function autoDetectScores(text, zone) {
  const t = text.toLowerCase();
  const scores = {};

  // Safety — из данных зоны
  const zoneData = ZONES.approved[zone];
  scores.safety = zoneData ? zoneData.safety : 5;

  // Soil — из данных зоны
  scores.soil = zoneData ? zoneData.soil : 5;

  // Road — из данных зоны
  scores.road_ba = zoneData ? zoneData.road : 5;

  // Local market — из данных зоны
  scores.local_market = zoneData ? zoneData.local_market : 4;

  // Water / Agua
  if (/perforaci[oó]n|pozo artesiano|agua corriente/.test(t)) {
    scores.water = 8;
  } else if (/pozo|perforaci/.test(t)) {
    scores.water = 6;
  } else if (/sin agua|no tiene agua/.test(t)) {
    scores.water = 2;
  } else {
    scores.water = 5;
  }

  // Electricity / Luz
  if (/trifásico|trifasico|luz trifas/.test(t)) {
    scores.electricity = 8;
  } else if (/luz|electricidad|monofásico|monofasico/.test(t)) {
    scores.electricity = 6;
  } else if (/sin luz|sin electricidad/.test(t)) {
    scores.electricity = 2;
  } else {
    scores.electricity = 4;
  }

  // House / Casa / Vivienda
  if (/casa en buen estado|vivienda completa|casa con/.test(t)) {
    scores.housing = 8;
  } else if (/casa|vivienda|habitaci[oó]n/.test(t)) {
    scores.housing = 6;
  } else if (/sin casa|sin vivienda/.test(t)) {
    scores.housing = 2;
  } else {
    scores.housing = 2;
  }

  // Buildings / Galpón
  if (/galp[oó]n|tinglado|dep[oó]sito|cobertizo/.test(t)) {
    scores.buildings = 6;
  } else {
    scores.buildings = 2;
  }

  // Gas
  if (/gas natural|gasoducto|gas conectado/.test(t)) {
    scores.gas = 9;
  } else if (/gas cerca|gasoducto cerca/.test(t)) {
    scores.gas = 6;
  } else {
    scores.gas = 3;
  }

  // Trees / Windbreak
  if (/cortina forestal|rompevientos|monte|forestaci[oó]n/.test(t)) {
    scores.trees_windbreak = 8;
  } else if (/[aá]rboles|arbolado/.test(t)) {
    scores.trees_windbreak = 6;
  } else {
    scores.trees_windbreak = 3;
  }

  // Flat terrain
  if (/terreno plano|lote plano|sin pendiente/.test(t)) {
    scores.flat_terrain = 8;
  } else if (/ondulado|leve pendiente/.test(t)) {
    scores.flat_terrain = 5;
  } else {
    scores.flat_terrain = 6; // default: assume acceptable
  }

  // Bonus defaults
  scores.internet = 4;
  scores.neighbors = 6;
  scores.inta_proximity = 4;
  scores.expansion_potential = 5;
  scores.beauty = 5;

  return scores;
}

// ── Хранилище ────────────────────────────────────────────────────────────────

/**
 * Загружает хранилище объявлений. Создаёт файл если не существует.
 * @returns {Object}
 */
function loadStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORAGE_PATH)) {
    const empty = {
      listings: [],
      last_search: null,
      rejected_urls: [],
    };
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf-8"));
  } catch {
    return { listings: [], last_search: null, rejected_urls: [] };
  }
}

/**
 * Сохраняет хранилище на диск.
 * @param {Object} storage
 */
function saveStorage(storage) {
  if (DRY_RUN) {
    console.log("[dry-run] Сохранение пропущено");
    return;
  }
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(storage, null, 2));
}

/**
 * Генерирует уникальный ID для объявления на основе URL.
 * @param {string} url
 * @returns {string}
 */
function makeId(url) {
  return "ls-" + crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
}

// ── HTTP-утилиты ─────────────────────────────────────────────────────────────

/**
 * Выполняет GET-запрос и возвращает тело ответа.
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
      },
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Парсинг объявлений ────────────────────────────────────────────────────────

/**
 * Распознаёт зону из текста объявления.
 * @param {string} text
 * @returns {string|null}
 */
function detectZone(text) {
  const t = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(ZONE_ALIASES)) {
    if (t.includes(alias)) return canonical;
  }
  return null;
}

/**
 * Распознаёт площадь (га) из текста.
 * @param {string} text
 * @returns {number|null}
 */
function detectArea(text) {
  const patterns = [
    /(\d+[\.,]?\d*)\s*hect[aá]reas?/i,
    /(\d+[\.,]?\d*)\s*ha\b/i,
    /(\d+[\.,]?\d*)\s*hás?\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(",", "."));
      if (!isNaN(n) && n > 0 && n < 10000) return n;
    }
  }
  return null;
}

/**
 * Распознаёт цену (USD) из текста.
 * @param {string} text
 * @param {string} type — "buy" | "rent"
 * @returns {{price_usd: number|null, price_ars: number|null, currency: string}}
 */
function detectPrice(text, type) {
  // USD: $1.000 o u$s1.000 o USD 70,000
  const usdRe = /(?:u\$[sd]|usd|us\$|\$\s*u)\s*([0-9][0-9.,]*)/i;
  const arsRe = /\$\s*([0-9][0-9.,]*)/;

  const usdMatch = text.match(usdRe);
  if (usdMatch) {
    const raw = usdMatch[1].replace(/\./g, "").replace(",", ".");
    const n = parseFloat(raw);
    return { price_usd: isNaN(n) ? null : n, price_ars: null, currency: "USD" };
  }

  const arsMatch = text.match(arsRe);
  if (arsMatch) {
    const raw = arsMatch[1].replace(/\./g, "").replace(",", ".");
    const n = parseFloat(raw);
    // Asumir tasa ~1250 ARS/USD para conversión aproximada
    const usd = n / 1250;
    return {
      price_usd: isNaN(n) ? null : Math.round(usd),
      price_ars: isNaN(n) ? null : n,
      currency: "ARS",
    };
  }

  return { price_usd: null, price_ars: null, currency: "?" };
}

/**
 * Оценивает цену относительно рынка (score 1-10).
 * Только примерная оценка по цене/га.
 * @param {number|null} priceUsd
 * @param {number|null} areaHa
 * @param {string} type
 * @returns {number}
 */
function scorePrice(priceUsd, areaHa, type) {
  if (!priceUsd || !areaHa) return 5;

  if (type === "rent") {
    // Рыночная аренда: ~$30-60 USD/ha/mes
    const perHa = priceUsd / areaHa;
    if (perHa < 20) return 9;
    if (perHa < 30) return 8;
    if (perHa < 45) return 6;
    if (perHa < 60) return 5;
    if (perHa < 80) return 4;
    return 2;
  } else {
    // Рыночная покупка: ~$3000-8000 USD/ha (zona pamp. húmeda)
    const perHa = priceUsd / areaHa;
    if (perHa < 2000) return 10;
    if (perHa < 3000) return 9;
    if (perHa < 5000) return 7;
    if (perHa < 7000) return 5;
    if (perHa < 10000) return 4;
    return 2;
  }
}

/**
 * Парсит HTML ZonaProp и извлекает объявления.
 * @param {string} html
 * @param {string} type
 * @param {string} sourceUrl
 * @returns {Array<Object>}
 */
function parseZonaProp(html, type, sourceUrl) {
  const listings = [];
  // ZonaProp: объявления в data-id или article/div с классом listing-item
  const itemRe = /<article[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const id = m[1];
    const block = m[2];

    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ").trim() : "";

    const descMatch = block.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, " ").trim() : "";

    const priceMatch = block.match(/<span[^>]*class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const priceText = priceMatch ? priceMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const url = `https://www.zonaprop.com.ar/propiedades/${id}.html`;
    const text = `${title} ${desc} ${priceText}`;

    if (!title && !desc) continue;

    listings.push({ url, title, text, type, source: "zonaprop" });
  }
  return listings;
}

/**
 * Парсит HTML Argenprop.
 * @param {string} html
 * @param {string} type
 * @returns {Array<Object>}
 */
function parseArgenprop(html, type) {
  const listings = [];
  // Argenprop: listing cards
  const cardRe = /<div[^>]*class="[^"]*listing__item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const hrefRe = /href="(\/propiedad[^"]+)"/i;
  const titleRe = /<h2[^>]*>([\s\S]*?)<\/h2>/i;

  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];
    const hrefMatch = block.match(hrefRe);
    const titleMatch = block.match(titleRe);
    if (!hrefMatch) continue;

    const url = `https://www.argenprop.com${hrefMatch[1]}`;
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ").trim() : "";
    const text = block.replace(/<[^>]+>/g, " ").trim();

    listings.push({ url, title, text, type, source: "argenprop" });
  }
  return listings;
}

/**
 * Парсит RSS-ленту Google и извлекает ссылки на объявления.
 * @param {string} xml
 * @param {string} type
 * @returns {Array<Object>}
 */
function parseGoogleRSS(xml, type) {
  const listings = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
      block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const descMatch =
      block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
      block.match(/<description>([\s\S]*?)<\/description>/i);

    if (!linkMatch) continue;
    const url = linkMatch[1].trim();
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, " ").trim() : "";
    const text = `${title} ${desc}`;

    // Только результаты с признаками поля / campo
    if (!/campo|hect[aá]rea|chacra|quinta|rural/.test(text.toLowerCase())) continue;

    listings.push({ url, title, text, type, source: "google" });
  }
  return listings;
}

// ── Источники поиска ──────────────────────────────────────────────────────────

const SEARCH_SOURCES = {
  rent: [
    {
      name: "ZonaProp Cañuelas alquiler",
      url: "https://www.zonaprop.com.ar/campos-alquiler-canuelas.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Lobos alquiler",
      url: "https://www.zonaprop.com.ar/campos-alquiler-lobos.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp San Vicente alquiler",
      url: "https://www.zonaprop.com.ar/campos-alquiler-san-vicente.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Brandsen alquiler",
      url: "https://www.zonaprop.com.ar/campos-alquiler-brandsen.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Luján alquiler",
      url: "https://www.zonaprop.com.ar/campos-alquiler-lujan.html",
      parser: "zonaprop",
    },
    {
      name: "Argenprop campos alquiler",
      url: "https://www.argenprop.com/campos/alquiler/buenos-aires",
      parser: "argenprop",
    },
    {
      name: "Google RSS campo alquiler Cañuelas",
      url: "https://news.google.com/rss/search?q=campo+alquiler+canuelas+hectarea&hl=es-419&gl=AR&ceid=AR:es-419",
      parser: "rss",
    },
    {
      name: "Google RSS campo alquiler Lobos",
      url: "https://news.google.com/rss/search?q=campo+alquiler+lobos+hectarea&hl=es-419&gl=AR&ceid=AR:es-419",
      parser: "rss",
    },
  ],
  buy: [
    {
      name: "ZonaProp Cañuelas venta",
      url: "https://www.zonaprop.com.ar/campos-venta-canuelas.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Lobos venta",
      url: "https://www.zonaprop.com.ar/campos-venta-lobos.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp San Vicente venta",
      url: "https://www.zonaprop.com.ar/campos-venta-san-vicente.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Brandsen venta",
      url: "https://www.zonaprop.com.ar/campos-venta-brandsen.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Luján venta",
      url: "https://www.zonaprop.com.ar/campos-venta-lujan.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Suipacha venta",
      url: "https://www.zonaprop.com.ar/campos-venta-suipacha.html",
      parser: "zonaprop",
    },
    {
      name: "ZonaProp Navarro venta",
      url: "https://www.zonaprop.com.ar/campos-venta-navarro.html",
      parser: "zonaprop",
    },
    {
      name: "Argenprop campos venta",
      url: "https://www.argenprop.com/campos/venta/buenos-aires",
      parser: "argenprop",
    },
    {
      name: "Google RSS campo venta Lobos",
      url: "https://news.google.com/rss/search?q=campo+venta+lobos+hectarea&hl=es-419&gl=AR&ceid=AR:es-419",
      parser: "rss",
    },
    {
      name: "Google RSS campo venta Cañuelas",
      url: "https://news.google.com/rss/search?q=campo+venta+canuelas+hectarea&hl=es-419&gl=AR&ceid=AR:es-419",
      parser: "rss",
    },
    {
      name: "Google RSS campo venta Mercedes",
      url: "https://news.google.com/rss/search?q=campo+venta+mercedes+buenos+aires+hectarea&hl=es-419&gl=AR&ceid=AR:es-419",
      parser: "rss",
    },
  ],
};

// ── Основные команды ──────────────────────────────────────────────────────────

/**
 * Обрабатывает одно «сырое» объявление: определяет зону, площадь, цену,
 * авто-выставляет баллы, рассчитывает total_score.
 * Возвращает null если зона отклонена или не распознана.
 *
 * @param {Object} raw — {url, title, text, type, source}
 * @returns {Object|null}
 */
function processListing(raw) {
  const { url, title, text, type } = raw;
  const zone = detectZone(`${title} ${text}`);

  // Отфильтровать отклонённые зоны
  if (zone && ZONES.rejected[zone]) return null;

  // Только известные одобренные зоны — отклонять неизвестные
  if (!zone || !ZONES.approved[zone]) return null;

  const area = detectArea(`${title} ${text}`);
  const { price_usd, price_ars, currency } = detectPrice(`${title} ${text}`, type);

  const autoScores = autoDetectScores(`${title} ${text}`, zone);
  const priceScore = scorePrice(price_usd, area, type);
  const scores = { ...autoScores, price: priceScore };

  const { score, rejected, rejectReason } = calculateScore(scores);
  if (rejected) return null;

  const id = makeId(url);
  const pricePerHa = price_usd && area ? Math.round(price_usd / area) : null;

  return {
    id,
    found_date: new Date().toISOString().slice(0, 10),
    type,
    source: raw.source,
    url,
    title: title.slice(0, 200),
    zone,
    area_ha: area,
    price_usd,
    price_ars,
    price_currency: currency,
    price_per_ha: pricePerHa,
    features: {
      house: /casa|vivienda/.test(text.toLowerCase()),
      buildings: /galp[oó]n|tinglado|dep[oó]sito/.test(text.toLowerCase()),
      water: /perforaci[oó]n|pozo|agua corriente/.test(text.toLowerCase()),
      electricity: /luz|electricidad/.test(text.toLowerCase()),
      gas: /gas natural|gasoducto/.test(text.toLowerCase()),
      trees: /[aá]rboles|cortina forestal|rompevientos/.test(text.toLowerCase()),
    },
    scores,
    total_score: score,
    status: "new",
    alerted: false,
    notes: "",
  };
}

/**
 * Команда search: загружает объявления из источников, обрабатывает и сохраняет.
 * @param {"rent"|"buy"|"all"} mode
 */
async function commandSearch(mode) {
  const startTs = Date.now();
  console.log(`\nLand Scout -- поиск (${mode}) ${DRY_RUN ? "[dry-run]" : ""}`);

  const storage = loadStorage();
  const knownUrls = new Set([
    ...storage.listings.map((l) => l.url),
    ...(storage.rejected_urls || []),
  ]);

  const typesToSearch = mode === "all" ? ["rent", "buy"] : [mode];

  let totalFetched = 0;
  let totalNew = 0;
  let totalRejected = 0;
  const newListings = [];

  for (const type of typesToSearch) {
    const sources = SEARCH_SOURCES[type] || [];

    for (const source of sources) {
      console.log(`  Запрос: ${source.name}`);

      let rawItems = [];
      try {
        const html = await fetchUrl(source.url);

        if (source.parser === "zonaprop") {
          rawItems = parseZonaProp(html, type, source.url);
        } else if (source.parser === "argenprop") {
          rawItems = parseArgenprop(html, type);
        } else if (source.parser === "rss") {
          rawItems = parseGoogleRSS(html, type);
        }

        console.log(`    Найдено: ${rawItems.length} объявлений`);
        totalFetched += rawItems.length;
      } catch (err) {
        console.warn(`    Ошибка запроса: ${err.message}`);
        continue;
      }

      for (const raw of rawItems) {
        if (knownUrls.has(raw.url)) continue;
        knownUrls.add(raw.url);

        const listing = processListing(raw);
        if (!listing) {
          totalRejected++;
          if (!DRY_RUN) {
            storage.rejected_urls = storage.rejected_urls || [];
            storage.rejected_urls.push(raw.url);
          }
          continue;
        }

        newListings.push(listing);
        totalNew++;
        console.log(
          `    [+] ${listing.zone} ${listing.area_ha || "?"}га` +
            ` $${listing.price_usd || "?"} → ${listing.total_score}/100`,
        );
      }
    }
  }

  if (!DRY_RUN) {
    storage.listings = [...storage.listings, ...newListings];
    storage.last_search = new Date().toISOString().slice(0, 10);
    saveStorage(storage);
  }

  const duration = Date.now() - startTs;
  console.log(`\nИтого: получено=${totalFetched}, новых=${totalNew}, отклонено=${totalRejected}`);

  await trace({
    name: "land-scout-search",
    input: { mode, dry_run: DRY_RUN },
    output: { fetched: totalFetched, new: totalNew, rejected: totalRejected },
    duration_ms: duration,
    metadata: { skill: "pepino-google-sheets", script: "land-scout" },
  });
}

/**
 * Форматирует строку рейтинга для одного объявления.
 * @param {Object} listing
 * @param {number} rank
 * @returns {string}
 */
function formatListing(listing, rank) {
  const s = listing.scores;
  const type = listing.type === "buy" ? "COMPRA" : "ALQUILER";
  const area = listing.area_ha ? `${listing.area_ha} га` : "? га";
  const price = listing.price_usd
    ? `$${listing.price_usd.toLocaleString("es-AR")} USD`
    : "precio ?";

  const lines = [
    `#${rank} * ${listing.total_score}/100 — ${listing.zone}, ${area}, ${price} (${type})`,
    `   Safety: ${s.safety}  Water: ${s.water}  Electr: ${s.electricity}`,
    `   Road BA: ${s.road_ba}  Soil: ${s.soil}  Price: ${s.price}`,
    `   House: ${s.housing}  Flat: ${s.flat_terrain}`,
    `   Galpón: ${s.buildings}  Gas: ${s.gas}  Trees: ${s.trees_windbreak}  Market: ${s.local_market}`,
    `   ${listing.url}`,
  ];
  return lines.join("\n");
}

/**
 * Команда evaluate: выводит все объявления, отсортированные по баллу.
 * @param {boolean} topOnly — только топ 5
 */
async function commandEvaluate(topOnly) {
  const storage = loadStorage();
  let listings = [...storage.listings];

  // Сортировка по убыванию total_score
  listings.sort((a, b) => b.total_score - a.total_score);

  if (topOnly) listings = listings.slice(0, 5);

  if (listings.length === 0) {
    console.log("Нет объявлений. Запустите: node land-scout.cjs search all");
    return;
  }

  const title = topOnly
    ? `LAND SCOUT — Топ ${listings.length} объявлений`
    : `LAND SCOUT — Все объявления (${listings.length})`;

  console.log(`\n${title}\n${"=".repeat(60)}`);
  listings.forEach((l, i) => {
    console.log(formatListing(l, i + 1));
    console.log("");
  });

  if (storage.last_search) {
    console.log(`Последний поиск: ${storage.last_search}`);
  }
}

/**
 * Команда alert: отправляет новые объявления с баллом >ALERT_THRESHOLD в TG.
 */
async function commandAlert() {
  const storage = loadStorage();
  const toAlert = storage.listings.filter((l) => !l.alerted && l.total_score >= ALERT_THRESHOLD);

  if (toAlert.length === 0) {
    console.log("Нет новых объявлений для алерта (score >= " + ALERT_THRESHOLD + ")");
    return;
  }

  // Сортировка по баллу
  toAlert.sort((a, b) => b.total_score - a.total_score);

  const lines = [`LAND SCOUT — ${toAlert.length} нов. объявлений >= ${ALERT_THRESHOLD} баллов`, ""];

  toAlert.forEach((l, i) => {
    const type = l.type === "buy" ? "COMPRA" : "ALQUILER";
    const area = l.area_ha ? `${l.area_ha}га` : "?га";
    const price = l.price_usd ? `$${l.price_usd.toLocaleString("es-AR")}` : "?";
    lines.push(`${i + 1}. [${l.total_score}/100] ${l.zone} | ${area} | ${price} | ${type}`);
    lines.push(
      `   Safety:${l.scores.safety} Water:${l.scores.water} El:${l.scores.electricity} Road:${l.scores.road_ba}`,
    );
    lines.push(`   ${l.url}`);
    lines.push("");
  });

  const message = lines.join("\n");
  console.log(message);

  if (!DRY_RUN) {
    await sendThrottled(message, { thread: TG_THREAD, priority: "normal" });

    // Помечаем как отправленные
    const alertedIds = new Set(toAlert.map((l) => l.id));
    storage.listings = storage.listings.map((l) =>
      alertedIds.has(l.id) ? { ...l, alerted: true, status: "alerted" } : l,
    );
    saveStorage(storage);
  }

  await trace({
    name: "land-scout-alert",
    input: { count: toAlert.length, threshold: ALERT_THRESHOLD, dry_run: DRY_RUN },
    output: { sent: !DRY_RUN },
    metadata: { skill: "pepino-google-sheets", script: "land-scout" },
  });
}

/**
 * Команда zones: показывает одобренные и отклонённые зоны.
 */
async function commandZones() {
  console.log("\nLAND SCOUT — Зоны\n" + "=".repeat(60));

  console.log("\nОДОБРЕНЫЕ ЗОНЫ:\n");
  for (const [name, data] of Object.entries(ZONES.approved)) {
    console.log(
      `  ${name.padEnd(16)} safety=${data.safety} soil=${data.soil} road=${data.road} market=${data.local_market}`,
    );
  }

  console.log("\nОТКЛОНЁНЫЕ ЗОНЫ:\n");
  for (const [name, data] of Object.entries(ZONES.rejected)) {
    console.log(`  ${name.padEnd(20)} — ${data.reason}`);
  }

  console.log("\nПримечание: объявления из отклонённых зон авто-отклоняются при поиске.");
}

// ── Cron registration helper ─────────────────────────────────────────────────

/**
 * Выводит cron-строки для регистрации.
 * Вызывается при запуске с аргументом --show-cron.
 */
function showCron() {
  const dir = path.dirname(path.resolve(__filename));
  console.log("# Land Scout cron (добавить в crontab -e):");
  console.log(`# search all: ежедневно 10:00 ART (14:00 UTC)`);
  console.log(
    `0 14 * * * node ${dir}/land-scout.cjs search all >> /tmp/land-scout-search.log 2>&1`,
  );
  console.log(`# alert: ежедневно 10:30 ART (14:30 UTC)`);
  console.log(`30 14 * * * node ${dir}/land-scout.cjs alert >> /tmp/land-scout-alert.log 2>&1`);
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const cmd = args[0];
  const sub = args[1];

  if (DRY_RUN) console.log("[dry-run] Режим симуляции — данные не сохраняются, TG не отправляется");

  if (cmd === "search") {
    const mode = ["rent", "buy", "all"].includes(sub) ? sub : "all";
    await commandSearch(mode);
  } else if (cmd === "evaluate") {
    const topOnly = args.includes("--top");
    await commandEvaluate(topOnly);
  } else if (cmd === "alert") {
    await commandAlert();
  } else if (cmd === "zones") {
    await commandZones();
  } else if (cmd === "--show-cron") {
    showCron();
  } else {
    console.log(`
Land Scout — Поиск и оценка земельных участков

Использование:
  node land-scout.cjs search rent        Поиск аренды
  node land-scout.cjs search buy         Поиск покупки
  node land-scout.cjs search all         Аренда + покупка
  node land-scout.cjs evaluate           Все оценённые объявления
  node land-scout.cjs evaluate --top     Топ 5
  node land-scout.cjs alert              Отправить новые >60 баллов в TG
  node land-scout.cjs zones              Показать одобренные/отклонённые зоны
  node land-scout.cjs --show-cron        Показать cron-строки

Флаги:
  --dry-run    Симуляция без записи и TG
    `);
  }
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
