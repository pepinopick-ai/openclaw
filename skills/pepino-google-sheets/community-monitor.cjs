/**
 * community-monitor.cjs -- Мониторинг русскоязычного сообщества в Аргентине
 *
 * Две цели:
 *   SALES    -- люди упоминают наши продукты (огурцы, соления, квашеная, помидоры)
 *   BUSINESS -- партнёры, инвесторы, земля, смежные фермеры
 *
 * Источник данных: Google News RSS + DuckDuckGo Lite HTML (публичные индексы t.me)
 *
 * Использование:
 *   node community-monitor.cjs scan              -- сканировать всё
 *   node community-monitor.cjs scan --sales      -- только sales
 *   node community-monitor.cjs scan --business   -- только business
 *   node community-monitor.cjs channels          -- список каналов
 *   node community-monitor.cjs keywords          -- список ключевых слов
 *   node community-monitor.cjs report            -- недельная сводка
 *   node community-monitor.cjs --dry-run scan    -- без уведомлений
 *
 * Расписание:
 *   scan:   10:00 и 18:00 ART (14:00 и 22:00 UTC)
 *   report: воскресенье 15:00 ART (19:00 UTC)
 *
 * Cron:
 *   0 14,22 * * * node /home/roman/openclaw/skills/pepino-google-sheets/community-monitor.cjs scan
 *   0 19 * * 0   node /home/roman/openclaw/skills/pepino-google-sheets/community-monitor.cjs report
 */

"use strict";

const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const { trace } = require("./langfuse-trace.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { fmtDate } = require("./helpers.cjs");

// ── Флаги CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_SALES = args.includes("--sales");
const ONLY_BUSINESS = args.includes("--business");
const CMD = args.find((a) => !a.startsWith("--")) || "scan";

// ── Конфигурация ──────────────────────────────────────────────────────────────

/** Тред для sales-сигналов (маркетинг) */
const TG_THREAD_SALES = 16;

/** Тред для business-сигналов (директор/стратегия) */
const TG_THREAD_BUSINESS = 20;

/** Минимальная оценка релевантности для отправки уведомления (0-10) */
const MIN_RELEVANCE = 6;

/** Путь к файлу состояния */
const STATE_PATH = path.join(
  process.env.HOME || "/root",
  ".openclaw/workspace/memory/community/monitor-state.json",
);

/** Задержка между HTTP-запросами (мс) — вежливый парсинг */
const REQUEST_DELAY_MS = 2500;

// ── Каналы для справки ────────────────────────────────────────────────────────

/** @type {Array<{name: string, url: string, members: string, activity: string}>} */
const MONITORED_CHANNELS = [
  {
    name: "Русские в Аргентине",
    url: "https://t.me/russkie_v_argentine",
    members: "5K+",
    activity: "высокая",
  },
  {
    name: "Экспаты Аргентина",
    url: "https://t.me/expats_argentina",
    members: "3K+",
    activity: "средняя",
  },
  {
    name: "Вкусная Аргентина",
    url: "https://t.me/vkusnaya_argentina",
    members: "1K+",
    activity: "низкая",
  },
  {
    name: "Фермеры Аргентины",
    url: "https://t.me/fermery_argentina",
    members: "500+",
    activity: "низкая",
  },
  {
    name: "БА Еда и Доставка",
    url: "https://t.me/ba_eda_dostavka",
    members: "2K+",
    activity: "средняя",
  },
];

// ── Поисковые запросы ─────────────────────────────────────────────────────────

/**
 * Google News RSS запросы по категориям.
 * @type {{ sales: string[], business: string[] }}
 */
const SEARCH_QUERIES = {
  sales: [
    // Огурцы
    'site:t.me "огурцы" OR "огурец" OR "огурчики" argentina',
    'site:t.me "pepino" "buenos aires" русский OR russian',
    '"огурцы свежие" аргентина telegram',
    '"соленые огурцы" аргентина OR "buenos aires"',
    // Квашеная
    'site:t.me "квашеная капуста" аргентина OR argentina',
    '"капуста квашеная" буэнос OR "buenos aires"',
    // Помидоры
    'site:t.me "помидоры" OR "томаты" аргентина свежие',
    '"вкусные помидоры" буэнос аргентина',
    // Зелень
    'site:t.me "укроп" OR "щавель" аргентина',
    // Общее
    '"фермерские продукты" аргентина telegram',
    '"домашние соленья" аргентина',
    '"где купить" огурцы OR помидоры OR "квашеная" буэнос',
    '"ферментация" OR "соления" OR "квашение" аргентина',
    'site:t.me "пелюстка" OR "пелустка"',
  ],
  business: [
    // Партнёры
    'site:t.me "ищу партнера" ферма OR "сельское хозяйство" аргентина',
    '"совместный бизнес" ферма аргентина telegram',
    '"теплица" аргентина партнер OR инвестор telegram',
    // Земля
    '"земля" OR "campo" "аренда" OR "alquiler" аргентина русский telegram',
    '"ферма" "продажа" OR "аренда" буэнос аргентина',
    // Смежные фермеры
    '"коровы" OR "овцы" OR "куры" ферма аргентина telegram',
    '"молочная продукция" OR "домашний сыр" аргентина',
    '"мёд" OR "яйца домашние" аргентина буэнос',
    // Инвестиции
    '"инвестиции" "сельское хозяйство" OR "агро" аргентина',
    '"ищу инвестора" OR "готов вложить" ферма аргентина',
    // Кооперация
    '"кооператив" OR "совместная доставка" фермер аргентина',
    '"фермерский рынок" OR "ярмарка" буэнос русский',
  ],
};

/**
 * DuckDuckGo Lite запросы (fallback).
 * @type {{ sales: string[], business: string[] }}
 */
const DDG_QUERIES = {
  sales: [
    "site:t.me огурцы аргентина",
    "site:t.me соленья аргентина",
    "site:t.me квашеная капуста buenos aires",
  ],
  business: ["site:t.me ферма партнер аргентина", "site:t.me теплица инвестор аргентина"],
};

// ── Шаблоны ответов ───────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
const RESPONSE_TEMPLATES = {
  cucumber_request: `Привет! 🥒 Мы Pepino Pick — выращиваем свежие огурцы в теплице под Буэнос-Айресом. Доставка вт/пт. Есть также соленые огурцы (натуральная ферментация, без уксуса!), квашеная капуста, пелюстка и острые соусы.
📱 Telegram: @PepinoPickShop
📷 Instagram: @pepinopick`,

  fermented_request: `Привет! У нас есть настоящие соленья — рецепты из России и Украины 🫙 Квашеная капуста (21 день ферментации), соленые огурцы (без уксуса!), пелюстка (единственная в Аргентине!), острые соусы. Доставка по BA.
📱 @PepinoPickShop`,

  tomato_request: `Привет! Выращиваем коллекционные томаты в теплице — 25+ сортов! Бифы, черри, херитэдж. Поставляем в рестораны BA. Свежесть гарантирована — от грядки до стола 24 часа 🍅
📱 @PepinoPickShop`,

  partner_request: `Здравствуйте! Мы Pepino Pick — действующее тепличное хозяйство. 16 постоянных клиентов, рестораны BA, 26М песо выручки за 5 месяцев. Ищем партнёра/площадку для масштабирования. Можем обсудить?
📱 @pepinopick`,

  complementary_farmer: `Привет! У нас тепличное хозяйство (огурцы, томаты, зелень). Если у вас молочка/мясо/яйца — можем объединить доставки и каталог. Наши клиенты просят полный ассортимент фермерских продуктов!
📱 @pepinopick`,
};

// ── Словари релевантности ─────────────────────────────────────────────────────

/** Ключевые слова для scoring (sales) */
const SALES_KEYWORDS = [
  "огурц",
  "огурец",
  "огурчик",
  "помидор",
  "томат",
  "квашен",
  "капуста",
  "соленье",
  "соления",
  "соленый",
  "пелюстка",
  "пелустка",
  "укроп",
  "щавель",
  "ферментац",
  "купить",
  "где найти",
  "ищу",
  "фермерск",
  "домашн",
  "натуральн",
  "без уксуса",
  "pepino",
  "pickles",
  "sauerkraut",
];

/** Ключевые слова для scoring (business) */
const BUSINESS_KEYWORDS = [
  "партнер",
  "партнёр",
  "инвестор",
  "вложить",
  "инвестиц",
  "ферма",
  "теплица",
  "земля",
  "campo",
  "аренда",
  "alquiler",
  "сельское хозяйство",
  "агро",
  "кооператив",
  "совместн",
  "коровы",
  "овцы",
  "куры",
  "молочн",
  "сыр",
  "мёд",
  "яйца",
  "фермерск",
  "рынок",
  "ярмарка",
];

// ── HTTP-утилиты ──────────────────────────────────────────────────────────────

/**
 * Выполняет HTTP/HTTPS GET-запрос, возвращает тело как строку.
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<string>}
 */
function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PepinoMonitor/1.0; +https://pepinopick.com.ar)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru,es;q=0.8,en;q=0.6",
        ...headers,
      },
      timeout: 20000,
    };

    const req = client.request(options, (res) => {
      // Следуем редиректам (один уровень)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchText(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} для ${url}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout запроса к ${url}`));
    });

    req.end();
  });
}

/**
 * Задержка между запросами.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Парсинг RSS / HTML ────────────────────────────────────────────────────────

/**
 * Результат одного найденного упоминания.
 * @typedef {{ title: string, url: string, snippet: string, date: string }} SearchResult
 */

/**
 * Парсит Google News RSS XML — возвращает до 5 первых результатов.
 * @param {string} xml
 * @returns {SearchResult[]}
 */
function parseGoogleRss(xml) {
  const results = [];
  // Ищем <item> блоки
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractXmlTag(item, "title");
    const link = extractXmlTag(item, "link");
    const desc = extractXmlTag(item, "description");
    const pubDate = extractXmlTag(item, "pubDate");

    if (title && link) {
      results.push({
        title: decodeHtmlEntities(title),
        url: link.trim(),
        snippet: decodeHtmlEntities(desc || ""),
        date: pubDate ? parseRssDate(pubDate) : fmtDate(new Date()),
      });
    }
    if (results.length >= 5) break;
  }
  return results;
}

/**
 * Парсит DuckDuckGo Lite HTML — возвращает до 5 результатов.
 * @param {string} html
 * @returns {SearchResult[]}
 */
function parseDdgHtml(html) {
  const results = [];
  // DDG Lite: результаты в <a class="result__a" href="...">title</a>
  // и <a class="result__snippet">snippet</a>
  const linkRegex = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets = [];
  let sm;
  while ((sm = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(sm[1]).trim());
  }

  let lm;
  let idx = 0;
  while ((lm = linkRegex.exec(html)) !== null) {
    const rawUrl = lm[1];
    const rawTitle = stripHtml(lm[2]).trim();
    if (!rawUrl || !rawTitle) continue;

    // Фильтруем служебные ссылки DDG
    if (rawUrl.startsWith("/") && !rawUrl.startsWith("//")) {
      idx++;
      continue;
    }

    results.push({
      title: decodeHtmlEntities(rawTitle),
      url: rawUrl.startsWith("//") ? "https:" + rawUrl : rawUrl,
      snippet: snippets[idx] || "",
      date: fmtDate(new Date()),
    });
    idx++;
    if (results.length >= 5) break;
  }
  return results;
}

/**
 * Извлекает содержимое XML-тега (первое вхождение).
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  // Убираем CDATA
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
}

/**
 * Убирает HTML-теги.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Декодирует базовые HTML-сущности.
 * @param {string} s
 * @returns {string}
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Парсит дату из RSS формата (RFC 2822) → YYYY-MM-DD.
 * @param {string} dateStr
 * @returns {string}
 */
function parseRssDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return fmtDate(d);
  } catch {
    // ignore
  }
  return fmtDate(new Date());
}

// ── Поисковые запросы ─────────────────────────────────────────────────────────

/**
 * Выполняет запрос к Google News RSS.
 * @param {string} query
 * @returns {Promise<SearchResult[]>}
 */
async function searchGoogleNews(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=ru&gl=AR&ceid=AR:ru`;
  try {
    const xml = await fetchText(url);
    return parseGoogleRss(xml);
  } catch (err) {
    console.error(`[monitor] Google News ошибка для "${query}": ${err.message}`);
    return [];
  }
}

/**
 * Выполняет запрос к DuckDuckGo Lite (fallback).
 * @param {string} query
 * @returns {Promise<SearchResult[]>}
 */
async function searchDdg(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${encoded}&kl=ar-es`;
  try {
    const html = await fetchText(url);
    return parseDdgHtml(html);
  } catch (err) {
    console.error(`[monitor] DDG ошибка для "${query}": ${err.message}`);
    return [];
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Оценивает релевантность результата (0-10).
 * @param {SearchResult} result
 * @param {"sales"|"business"} type
 * @returns {number}
 */
function scoreRelevance(result, type) {
  const text = (result.title + " " + result.snippet).toLowerCase();
  const keywords = type === "sales" ? SALES_KEYWORDS : BUSINESS_KEYWORDS;

  let score = 0;

  // +1 за каждое ключевое слово (максимум 6)
  for (const kw of keywords) {
    if (text.includes(kw.toLowerCase())) {
      score += 1;
      if (score >= 6) break;
    }
  }

  // +2 если URL содержит t.me (прямое упоминание)
  if (result.url.includes("t.me")) score += 2;

  // +1 если дата сегодня или вчера
  const daysDiff = daysSince(result.date);
  if (daysDiff <= 1) score += 1;

  // Нормализуем до 10
  return Math.min(10, score);
}

/**
 * Количество дней с указанной даты YYYY-MM-DD до сегодня.
 * @param {string} dateStr
 * @returns {number}
 */
function daysSince(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    return Math.abs(Math.floor((now - d) / (1000 * 60 * 60 * 24)));
  } catch {
    return 999;
  }
}

// ── Классификация ─────────────────────────────────────────────────────────────

/**
 * Определяет тип сигнала (sales / business / null) по тексту.
 * @param {SearchResult} result
 * @returns {"sales"|"business"|null}
 */
function classifyResult(result) {
  const text = (result.title + " " + result.snippet).toLowerCase();

  const salesScore = SALES_KEYWORDS.filter((kw) => text.includes(kw.toLowerCase())).length;
  const businessScore = BUSINESS_KEYWORDS.filter((kw) => text.includes(kw.toLowerCase())).length;

  if (salesScore === 0 && businessScore === 0) return null;
  return salesScore >= businessScore ? "sales" : "business";
}

/**
 * Выбирает шаблон ответа по типу и тексту.
 * @param {SearchResult} result
 * @param {"sales"|"business"} type
 * @returns {string}
 */
function pickTemplate(result, type) {
  if (type === "business") {
    const text = (result.title + " " + result.snippet).toLowerCase();
    if (text.includes("партнер") || text.includes("партнёр") || text.includes("инвестор")) {
      return RESPONSE_TEMPLATES.partner_request;
    }
    return RESPONSE_TEMPLATES.complementary_farmer;
  }

  // sales
  const text = (result.title + " " + result.snippet).toLowerCase();
  if (text.includes("помидор") || text.includes("томат")) {
    return RESPONSE_TEMPLATES.tomato_request;
  }
  if (
    text.includes("квашен") ||
    text.includes("соления") ||
    text.includes("пелюстка") ||
    text.includes("ферментац")
  ) {
    return RESPONSE_TEMPLATES.fermented_request;
  }
  return RESPONSE_TEMPLATES.cucumber_request;
}

// ── Управление состоянием ────────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string,
 *   date: string,
 *   type: "sales"|"business",
 *   title: string,
 *   url: string,
 *   snippet: string,
 *   relevance: number,
 *   status: "new"|"notified"|"processed",
 *   action_taken: string|null
 * }} FoundItem
 *
 * @typedef {{
 *   last_scan: string,
 *   found: FoundItem[],
 *   seen_urls: string[]
 * }} MonitorState
 */

/**
 * Загружает состояние из файла. Создаёт пустое если не существует.
 * @returns {MonitorState}
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      // Нормализуем структуру
      return {
        last_scan: parsed.last_scan || new Date(0).toISOString(),
        found: Array.isArray(parsed.found) ? parsed.found : [],
        seen_urls: Array.isArray(parsed.seen_urls) ? parsed.seen_urls : [],
      };
    }
  } catch (err) {
    console.error(`[monitor] Не удалось загрузить state: ${err.message}`);
  }
  return { last_scan: new Date(0).toISOString(), found: [], seen_urls: [] };
}

/**
 * Сохраняет состояние (атомарно через rename).
 * @param {MonitorState} state
 */
function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = STATE_PATH + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      console.error(`[monitor] Не удалось сохранить state: ${err.message}`);
    }
  }
}

/**
 * Генерирует уникальный ID для найденного элемента.
 * @returns {string}
 */
function newId() {
  return "cm-" + crypto.randomBytes(3).toString("hex");
}

// ── Формирование уведомлений ─────────────────────────────────────────────────

/**
 * Формирует Telegram-сообщение для SALES-сигнала.
 * @param {FoundItem} item
 * @returns {string}
 */
function formatSalesAlert(item) {
  const template = pickTemplate(
    { title: item.title, url: item.url, snippet: item.snippet, date: item.date },
    "sales",
  );
  const snippetPreview = item.snippet.slice(0, 200) || item.title;

  return (
    `\u{1F6D2} *SALES SIGNAL найден!*\n\n` +
    `Дата: ${item.date}\n` +
    `Оценка: ${item.relevance}/10\n\n` +
    `\u{1F4AC} "${snippetPreview}${item.snippet.length > 200 ? "..." : ""}"\n\n` +
    `\u{1F3AF} *ДЕЙСТВИЕ: Ответить!*\n` +
    `_${template.slice(0, 300)}_\n\n` +
    `\u{1F517} [Открыть](${item.url})`
  );
}

/**
 * Формирует Telegram-сообщение для BUSINESS-сигнала.
 * @param {FoundItem} item
 * @returns {string}
 */
function formatBusinessAlert(item) {
  const template = pickTemplate(
    { title: item.title, url: item.url, snippet: item.snippet, date: item.date },
    "business",
  );
  const snippetPreview = item.snippet.slice(0, 200) || item.title;

  return (
    `\u{1F91D} *BUSINESS OPPORTUNITY найдена!*\n\n` +
    `Дата: ${item.date}\n` +
    `Оценка: ${item.relevance}/10\n\n` +
    `\u{1F4AC} "${snippetPreview}${item.snippet.length > 200 ? "..." : ""}"\n\n` +
    `\u{1F3AF} *ДЕЙСТВИЕ: Написать!*\n` +
    `_${template.slice(0, 300)}_\n\n` +
    `\u{1F517} [Открыть](${item.url})`
  );
}

// ── Команда: scan ────────────────────────────────────────────────────────────

/**
 * Сканирует запросы одной категории, возвращает новые элементы.
 * @param {"sales"|"business"} category
 * @param {MonitorState} state
 * @returns {Promise<FoundItem[]>}
 */
async function runCategoryScan(category, state) {
  const queries = SEARCH_QUERIES[category];
  const ddgQueries = DDG_QUERIES[category];
  const newItems = [];

  console.log(
    `[monitor] Сканирование категории: ${category} (${queries.length} запросов Google News + ${ddgQueries.length} DDG)`,
  );

  // Google News RSS
  for (const query of queries) {
    if (DRY_RUN) {
      console.log(`  [dry-run] Google News: "${query.slice(0, 60)}..."`);
      await sleep(50);
      continue;
    }

    const results = await searchGoogleNews(query);
    console.log(`  Google News "${query.slice(0, 50)}..." → ${results.length} результатов`);

    for (const r of results) {
      if (state.seen_urls.includes(r.url)) continue;

      const classified = classifyResult(r);
      const effectiveType = classified || category;
      const relevance = scoreRelevance(r, effectiveType);

      const item = {
        id: newId(),
        date: r.date,
        type: effectiveType,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        relevance,
        status: "new",
        action_taken: null,
      };

      newItems.push(item);
      state.seen_urls.push(r.url);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // DuckDuckGo fallback
  for (const query of ddgQueries) {
    if (DRY_RUN) {
      console.log(`  [dry-run] DDG: "${query}"`);
      await sleep(50);
      continue;
    }

    const results = await searchDdg(query);
    console.log(`  DDG "${query}" → ${results.length} результатов`);

    for (const r of results) {
      if (state.seen_urls.includes(r.url)) continue;

      const classified = classifyResult(r);
      const effectiveType = classified || category;
      const relevance = scoreRelevance(r, effectiveType);

      const item = {
        id: newId(),
        date: r.date,
        type: effectiveType,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        relevance,
        status: "new",
        action_taken: null,
      };

      newItems.push(item);
      state.seen_urls.push(r.url);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return newItems;
}

/**
 * Основная функция сканирования.
 */
async function cmdScan() {
  const t0 = Date.now();
  const state = loadState();

  console.log(`[monitor] Начало сканирования ${DRY_RUN ? "(dry-run)" : ""}`);
  console.log(`[monitor] Последнее сканирование: ${state.last_scan}`);

  const allNewItems = [];

  if (!ONLY_BUSINESS) {
    const salesItems = await runCategoryScan("sales", state);
    allNewItems.push(...salesItems);
  }

  if (!ONLY_SALES) {
    const businessItems = await runCategoryScan("business", state);
    allNewItems.push(...businessItems);
  }

  // Добавляем в state
  state.found.push(...allNewItems);
  // Ограничиваем историю (последние 500 записей)
  if (state.found.length > 500) {
    state.found = state.found.slice(-500);
  }
  // Ограничиваем seen_urls (последние 2000)
  if (state.seen_urls.length > 2000) {
    state.seen_urls = state.seen_urls.slice(-2000);
  }
  state.last_scan = new Date().toISOString();

  // Фильтруем достаточно релевантные для уведомлений
  const toNotify = allNewItems.filter((it) => it.relevance >= MIN_RELEVANCE);

  console.log(
    `\n[monitor] Найдено новых: ${allNewItems.length}, к уведомлению: ${toNotify.length}`,
  );

  // Уведомления
  let notifiedCount = 0;
  for (const item of toNotify) {
    const msg = item.type === "sales" ? formatSalesAlert(item) : formatBusinessAlert(item);
    const thread = item.type === "sales" ? TG_THREAD_SALES : TG_THREAD_BUSINESS;

    if (DRY_RUN) {
      console.log(`\n--- [dry-run] ${item.type.toUpperCase()} (score ${item.relevance}) ---`);
      console.log(`  Заголовок: ${item.title}`);
      console.log(`  URL: ${item.url}`);
      console.log(`  Сниппет: ${item.snippet.slice(0, 100)}`);
      console.log(`  Тред: ${thread}`);
    } else {
      const result = await sendThrottled(msg, {
        thread,
        priority: item.relevance >= 8 ? "high" : "normal",
      });
      if (result.ok) {
        item.status = "notified";
        notifiedCount++;
        console.log(
          `  [monitor] Уведомление отправлено: ${item.id} (${item.type}, score ${item.relevance})`,
        );
      } else {
        console.error(`  [monitor] Ошибка уведомления: ${result.error}`);
      }
    }
  }

  if (!DRY_RUN) {
    saveState(state);
  }

  const duration = Date.now() - t0;

  // Langfuse tracing
  await trace({
    name: "community-monitor/scan",
    input: {
      only_sales: ONLY_SALES,
      only_business: ONLY_BUSINESS,
      dry_run: DRY_RUN,
    },
    output: {
      new_items: allNewItems.length,
      to_notify: toNotify.length,
      notified: notifiedCount,
    },
    duration_ms: duration,
    metadata: { skill: "pepino-google-sheets", script: "community-monitor" },
  });

  console.log(`\n[monitor] Готово за ${(duration / 1000).toFixed(1)}с`);
  console.log(`  Новых сигналов: ${allNewItems.length}`);
  console.log(`  Уведомлений: ${DRY_RUN ? toNotify.length + " (dry-run)" : notifiedCount}`);
}

// ── Команда: report ──────────────────────────────────────────────────────────

/**
 * Формирует и отправляет еженедельный отчёт.
 */
async function cmdReport() {
  const state = loadState();

  // Записи за последние 7 дней
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffStr = fmtDate(cutoffDate);

  const weekItems = state.found.filter((it) => it.date >= cutoffStr);
  const salesItems = weekItems.filter((it) => it.type === "sales");
  const businessItems = weekItems.filter((it) => it.type === "business");

  // Группировка sales по продуктам
  const salesGroups = {
    "огурцы/соленья": salesItems.filter((it) =>
      (it.title + it.snippet).toLowerCase().match(/огурц|соления|соленый|pickle/),
    ).length,
    "квашеная капуста": salesItems.filter((it) =>
      (it.title + it.snippet).toLowerCase().includes("квашен"),
    ).length,
    помидоры: salesItems.filter((it) =>
      (it.title + it.snippet).toLowerCase().match(/помидор|томат/),
    ).length,
    другое: 0,
  };
  salesGroups["другое"] = salesItems.length - Object.values(salesGroups).reduce((a, b) => a + b, 0);
  if (salesGroups["другое"] < 0) salesGroups["другое"] = 0;

  // Подсчёт обработанных
  const salesProcessed = salesItems.filter(
    (it) => it.status === "notified" || it.status === "processed",
  ).length;
  const businessProcessed = businessItems.filter(
    (it) => it.status === "notified" || it.status === "processed",
  ).length;

  const weekNum = getWeekNumber(new Date());

  // Строки по продуктам
  const salesLines = Object.entries(salesGroups)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `  \u{1F4CC} "${name}" — ${count} упомин.`)
    .join("\n");

  const businessLines = businessItems
    .slice(0, 3)
    .map((it) => `  \u{1F517} ${it.title.slice(0, 60)}`)
    .join("\n");

  const report =
    `\u{1F4CA} *COMMUNITY MONITOR — неделя ${weekNum}*\n\n` +
    `*SALES SIGNALS: ${salesItems.length}*\n` +
    (salesLines || "  нет упоминаний") +
    "\n\n" +
    `  Уведомлено: ${salesProcessed}/${salesItems.length}\n\n` +
    `*BUSINESS SIGNALS: ${businessItems.length}*\n` +
    (businessLines || "  нет сигналов") +
    "\n\n" +
    `  Обработано: ${businessProcessed}/${businessItems.length}\n\n` +
    `*АКТИВНОСТЬ КАНАЛОВ:*\n` +
    MONITORED_CHANNELS.slice(0, 3)
      .map((ch) => `  ${ch.name}: активность ${ch.activity}`)
      .join("\n") +
    `\n\n_Данные за 7 дней. Всего в истории: ${state.found.length}_`;

  console.log("[monitor] Еженедельный отчёт:");
  console.log(report);

  if (!DRY_RUN) {
    const result = await sendThrottled(report, { thread: TG_THREAD_BUSINESS });
    if (result.ok) {
      console.log("[monitor] Отчёт отправлен в Telegram");
    } else {
      console.error("[monitor] Ошибка отправки отчёта:", result.error);
    }
  } else {
    console.log("\n[dry-run] Отчёт НЕ отправлен");
  }

  await trace({
    name: "community-monitor/report",
    input: { week: weekNum, dry_run: DRY_RUN },
    output: {
      sales_signals: salesItems.length,
      business_signals: businessItems.length,
      total_history: state.found.length,
    },
    metadata: { skill: "pepino-google-sheets", script: "community-monitor" },
  });
}

/**
 * Номер недели ISO (1-53).
 * @param {Date} d
 * @returns {number}
 */
function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

// ── Команда: channels ────────────────────────────────────────────────────────

function cmdChannels() {
  console.log("\n=== MONITORED CHANNELS ===\n");
  for (const ch of MONITORED_CHANNELS) {
    console.log(`  ${ch.name}`);
    console.log(`    URL:        ${ch.url}`);
    console.log(`    Участники:  ${ch.members}`);
    console.log(`    Активность: ${ch.activity}`);
    console.log();
  }
  console.log(`Всего каналов: ${MONITORED_CHANNELS.length}`);
}

// ── Команда: keywords ────────────────────────────────────────────────────────

function cmdKeywords() {
  console.log("\n=== KEYWORDS ===\n");

  console.log("SALES ключевые слова:");
  console.log("  " + SALES_KEYWORDS.join(", "));

  console.log("\nBUSINESS ключевые слова:");
  console.log("  " + BUSINESS_KEYWORDS.join(", "));

  console.log(`\n\nSALES поисковые запросы Google News (${SEARCH_QUERIES.sales.length}):`);
  SEARCH_QUERIES.sales.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  console.log(`\nBUSINESS поисковые запросы Google News (${SEARCH_QUERIES.business.length}):`);
  SEARCH_QUERIES.business.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  console.log(`\nSALES DDG fallback (${DDG_QUERIES.sales.length}):`);
  DDG_QUERIES.sales.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  console.log(`\nBUSINESS DDG fallback (${DDG_QUERIES.business.length}):`);
  DDG_QUERIES.business.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
}

// ── Точка входа ───────────────────────────────────────────────────────────────

(async () => {
  try {
    switch (CMD) {
      case "scan":
        await cmdScan();
        break;
      case "report":
        await cmdReport();
        break;
      case "channels":
        cmdChannels();
        break;
      case "keywords":
        cmdKeywords();
        break;
      default:
        console.log("Использование:");
        console.log("  node community-monitor.cjs scan              -- сканировать всё");
        console.log("  node community-monitor.cjs scan --sales      -- только sales");
        console.log("  node community-monitor.cjs scan --business   -- только business");
        console.log("  node community-monitor.cjs channels          -- список каналов");
        console.log("  node community-monitor.cjs keywords          -- все ключевые слова");
        console.log("  node community-monitor.cjs report            -- недельная сводка");
        console.log("  node community-monitor.cjs --dry-run scan    -- без уведомлений");
        process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error("[monitor] Критическая ошибка:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
