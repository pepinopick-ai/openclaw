#!/usr/bin/env node
/**
 * AI Radar Report -- Проактивный отчёт с предложениями по улучшению системы.
 *
 * В отличие от trend-radar.cjs (сбор ссылок), этот скрипт:
 *   1. Ищет AI/automation сигналы через Google News RSS
 *   2. Оценивает каждый сигнал через призму текущей системы Pepino
 *   3. Генерирует конкретные предложения (proposal) с impact/effort
 *   4. Добавляет System Health Check (скрипты, cron, RAM)
 *   5. Добавляет Top 3 Improvements (без новых инструментов)
 *
 * Usage:
 *   node ai-radar-report.cjs              # Полный запуск
 *   node ai-radar-report.cjs --dry-run    # Без отправки в Telegram
 *
 * Cron: 0 16 * * 5 (пятница 16:00, перед weekly report)
 *
 * Выход:
 *   - HTML в Telegram (тред 20 -- Стратегия/Директор)
 *   - JSON в ~/.openclaw/workspace/memory/knowledge/reference/ai-radar-YYYY-MM-DD.json
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { trace } = require("./langfuse-trace.cjs");
const { sendReport } = require("./telegram-helper.cjs");

// Throttled sender с fallback на прямую отправку
let sendThrottled;
try {
  sendThrottled = require("./notification-throttle.cjs").sendThrottled;
} catch {
  sendThrottled = null;
}

// ── Конфигурация ────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const TG_THREAD_ID = 20; // Стратегия/Директор
const MAX_SIGNALS = 5;
const MIN_SIGNALS = 3;
const REPORT_DIR = path.join(
  process.env.HOME || "/home/roman",
  ".openclaw/workspace/memory/knowledge/reference",
);
const SCRIPTS_DIR = path.dirname(__filename);

// ── Карта системы Pepino ────────────────────────────────────────────────────

/**
 * Карта модулей системы: ключевые слова -> затрагиваемые файлы и описание.
 * Используется для автоматического сопоставления сигналов с модулями.
 *
 * @type {Array<{keywords: RegExp, modules: string[], domain: string, description: string}>}
 */
const SYSTEM_MAP = [
  {
    keywords: /claude|anthropic|sonnet|opus|context\s*window|1m\s*context/i,
    modules: [
      "ceo-weekly-digest.cjs",
      "digital-twin.cjs",
      "llm-router.cjs",
      "knowledge-distiller.cjs",
    ],
    domain: "LLM/AI",
    description: "LLM модели и маршрутизация запросов",
  },
  {
    keywords: /n8n|workflow\s*automation|zapier|make\.com/i,
    modules: ["n8n-client.cjs", "pipeline-runner.cjs", "self-healer.cjs"],
    domain: "Automation",
    description: "Автоматизация workflow и интеграции",
  },
  {
    keywords: /mcp|model\s*context\s*protocol|tool\s*use|function\s*call/i,
    modules: ["telegram-commands.cjs", "pepino-cli.cjs", "eval-runner.cjs"],
    domain: "Agent Tools",
    description: "Протоколы взаимодействия агентов",
  },
  {
    keywords: /langfuse|observability|tracing|monitoring|telemetry/i,
    modules: ["langfuse-trace.cjs", "sync-dashboard.cjs", "health-status.cjs", "status-page.cjs"],
    domain: "Observability",
    description: "Мониторинг и трейсинг операций",
  },
  {
    keywords: /google\s*sheets|spreadsheet|sheets\s*api/i,
    modules: ["sheets.js", "farm-state.cjs", "sheets-api.js"],
    domain: "Data Layer",
    description: "Google Sheets как хранилище данных",
  },
  {
    keywords: /telegram|bot\s*api|chat\s*bot|messaging/i,
    modules: [
      "telegram-helper.cjs",
      "telegram-commands.cjs",
      "notification-throttle.cjs",
      "alert-aggregator.cjs",
    ],
    domain: "Notifications",
    description: "Telegram-интеграция и уведомления",
  },
  {
    keywords: /pricing|margin|cost\s*optimi|dynamic\s*pric/i,
    modules: ["auto-pricing.cjs", "margin-optimizer.cjs", "daily-pnl.cjs", "cashflow-forecast.cjs"],
    domain: "Finance",
    description: "Ценообразование и финансовый анализ",
  },
  {
    keywords: /crm|customer|churn|retention|client/i,
    modules: [
      "churn-detector.cjs",
      "client-analytics.cjs",
      "client-scorer.cjs",
      "client-outreach.cjs",
    ],
    domain: "CRM",
    description: "Управление клиентской базой",
  },
  {
    keywords: /supply\s*chain|inventory|warehouse|stock|demand\s*forecast/i,
    modules: [
      "inventory-tracker.cjs",
      "demand-predictor.cjs",
      "supplier-monitor.cjs",
      "delivery-optimizer.cjs",
    ],
    domain: "Supply Chain",
    description: "Цепочка поставок и инвентаризация",
  },
  {
    keywords: /greenhouse|iot|sensor|climate|humidity|temperature/i,
    modules: ["digital-twin.cjs", "farm-state.cjs", "production-planner.cjs"],
    domain: "Greenhouse",
    description: "Управление теплицей и IoT",
  },
  {
    keywords: /knowledge\s*(graph|base|manage)|rag|vector|embedding/i,
    modules: [
      "knowledge-indexer.cjs",
      "knowledge-retriever.cjs",
      "knowledge-distiller.cjs",
      "knowledge-search.cjs",
    ],
    domain: "Knowledge",
    description: "Система управления знаниями",
  },
  {
    keywords: /cron|schedule|batch|pipeline|orchestrat/i,
    modules: ["pipeline-runner.cjs", "daily-ops-checklist.cjs", "alert-aggregator.cjs"],
    domain: "Orchestration",
    description: "Планирование и оркестрация задач",
  },
];

// ── Предложения по улучшению (без новых инструментов) ────────────────────────

/**
 * Статический пул предложений, проверяемых при каждом запуске.
 * Каждое предложение содержит условие проверки (check) и рекомендацию.
 *
 * @type {Array<{id: string, check: () => boolean, priority: string, title: string, detail: string}>}
 */
const IMPROVEMENT_POOL = [
  {
    id: "shared-client-module",
    check: () => {
      // Проверяем, есть ли client-analytics.cjs и используется ли он
      const clientAnalytics = path.join(SCRIPTS_DIR, "client-analytics.cjs");
      if (!fs.existsSync(clientAnalytics)) return true;
      // Проверяем, импортируют ли его churn-detector и client-scorer
      try {
        const churn = fs.readFileSync(path.join(SCRIPTS_DIR, "churn-detector.cjs"), "utf-8");
        return !churn.includes("client-analytics");
      } catch {
        return false;
      }
    },
    priority: "HIGH",
    title: "Мигрировать клиентские скрипты на shared module client-analytics.cjs",
    detail:
      "churn-detector, client-scorer, client-outreach дублируют логику чтения клиентов. Консолидация снизит код на ~200 строк и упростит отладку.",
  },
  {
    id: "farm-state-morning",
    check: () => {
      try {
        const brief = fs.readFileSync(path.join(SCRIPTS_DIR, "morning-brief.js"), "utf-8");
        // Если morning-brief читает напрямую из sheets вместо farm-state
        return brief.includes("readSheet") && !brief.includes("farm-state");
      } catch {
        return false;
      }
    },
    priority: "MED",
    title: "Использовать farm-state.cjs как источник для morning-brief",
    detail:
      "morning-brief.js делает 3-5 прямых запросов к Sheets API. farm-state.cjs кеширует данные и снижает нагрузку на API + ускоряет генерацию на ~2 сек.",
  },
  {
    id: "consolidate-trend-cron",
    check: () => {
      // trend-radar имеет 5 отдельных cron записей
      try {
        const crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
        const trendEntries = crontab.split("\n").filter((l) => l.includes("trend-radar"));
        return trendEntries.length >= 3;
      } catch {
        return false;
      }
    },
    priority: "LOW",
    title: "Объединить cron-записи trend-radar в 1 с day-of-week логикой",
    detail:
      "5 cron entries для trend-radar можно заменить одним вызовом `node trend-radar.cjs auto`, который сам определяет потоки по дню недели.",
  },
  {
    id: "alert-fatigue",
    check: () => {
      try {
        const crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
        const entries = crontab.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        return entries.length > 35;
      } catch {
        return false;
      }
    },
    priority: "HIGH",
    title: "Снизить alert fatigue: мигрировать скрипты в pipeline-runner",
    detail:
      "Более 35 cron-записей = слишком много отдельных Telegram-сообщений. pipeline-runner.cjs может группировать 5-8 скриптов в один батч с единым отчётом.",
  },
  {
    id: "product-aliases-coverage",
    check: () => {
      try {
        const aliases = fs.readFileSync(path.join(SCRIPTS_DIR, "product-aliases.cjs"), "utf-8");
        // Если менее 10 alias определений -- нужно расширять
        const count = (aliases.match(/=>/g) || []).length;
        return count < 15;
      } catch {
        return false;
      }
    },
    priority: "MED",
    title: "Расширить product-aliases.cjs: добавить недостающие вариации",
    detail:
      "Неполное покрытие алиасов приводит к дублям в аналитике. Проверить отчёты daily-pnl и auto-pricing на нестандартные названия.",
  },
  {
    id: "notification-dedup",
    check: () => {
      // Проверяем, используют ли все скрипты notification-throttle
      const criticalScripts = ["daily-pnl.cjs", "inventory-tracker.cjs", "churn-detector.cjs"];
      for (const script of criticalScripts) {
        try {
          const content = fs.readFileSync(path.join(SCRIPTS_DIR, script), "utf-8");
          if (!content.includes("notification-throttle") && !content.includes("sendThrottled")) {
            return true;
          }
        } catch {
          // Скрипт не найден -- пропускаем
        }
      }
      return false;
    },
    priority: "MED",
    title: "Мигрировать оставшиеся скрипты на notification-throttle",
    detail:
      "Не все скрипты используют sendThrottled. Без throttle дублирующиеся алерты засоряют Telegram.",
  },
  {
    id: "eval-suite-coverage",
    check: () => {
      const evalRunner = path.join(SCRIPTS_DIR, "eval-runner.cjs");
      return !fs.existsSync(evalRunner);
    },
    priority: "LOW",
    title: "Запустить eval-runner.cjs в cron для регрессионного тестирования",
    detail:
      "eval-runner.cjs создан, но не запускается автоматически. Еженедельный запуск поймает деградацию скриптов до того, как они сломаются в проде.",
  },
];

// ── AI-специфичные поисковые запросы ────────────────────────────────────────

const AI_QUERIES = [
  "Claude Code new features 2026",
  "n8n AI agent workflow automation",
  "MCP model context protocol tools",
  "AI automation small business farming",
  "LLM cost optimization production",
  "Google Sheets API automation AI",
  "Langfuse observability LLM tracing",
  "Telegram bot AI integration",
];

// ── HTTP helpers (из trend-radar.cjs) ────────────────────────────────────────

/**
 * HTTP/HTTPS GET-запрос с поддержкой редиректов.
 * @param {string} url
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<string>}
 */
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP timeout: ${url}`));
    });
  });
}

// ── RSS-парсинг (из trend-radar.cjs) ─────────────────────────────────────────

/**
 * Извлекает содержимое XML-тега (с поддержкой CDATA).
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

/** Извлекает текстовое содержимое атрибута тега <source> */
function extractTagAttr(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

/** Извлекает домен из URL */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Форматирует дату RSS в YYYY-MM-DD */
function formatDate(rssDate) {
  try {
    return new Date(rssDate).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Убирает HTML-теги */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Декодирует основные HTML-сущности */
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Парсит RSS XML и возвращает массив элементов.
 * @param {string} xml
 * @returns {{title: string, url: string, source: string, date: string, snippet: string}[]}
 */
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTagAttr(block, "source") || extractDomain(link);
    const description = extractTag(block, "description");

    if (title && link) {
      items.push({
        title: decodeHtmlEntities(title),
        url: link.trim(),
        source: decodeHtmlEntities(source),
        date: pubDate ? formatDate(pubDate) : new Date().toISOString().slice(0, 10),
        snippet: decodeHtmlEntities(stripHtml(description || "")).slice(0, 400),
      });
    }
  }
  return items;
}

// ── Поиск сигналов ──────────────────────────────────────────────────────────

/**
 * Ищет сигналы по одному запросу через Google News RSS.
 * @param {string} query
 * @returns {Promise<{title: string, url: string, source: string, date: string, snippet: string}[]>}
 */
async function searchQuery(query) {
  const encodedQuery = encodeURIComponent(query);
  const googleUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en&gl=US&ceid=US:en`;

  try {
    const xml = await httpGet(googleUrl);
    const items = parseRssItems(xml);
    if (items.length > 0) {
      console.log(`  [Google News] "${query}" -> ${items.length} results`);
      return items;
    }
  } catch (err) {
    console.warn(`  [Google News] "${query}" failed: ${err.message}`);
  }

  return [];
}

// ── Сопоставление сигнала с системой ─────────────────────────────────────────

/**
 * Определяет, какие модули системы затрагивает сигнал.
 * Возвращает массив совпадений с описанием домена.
 *
 * @param {{title: string, snippet: string}} signal
 * @returns {{domain: string, modules: string[], description: string}[]}
 */
function matchSystemModules(signal) {
  const text = `${signal.title} ${signal.snippet}`;
  const matches = [];

  for (const entry of SYSTEM_MAP) {
    if (entry.keywords.test(text)) {
      matches.push({
        domain: entry.domain,
        modules: entry.modules,
        description: entry.description,
      });
    }
  }

  return matches;
}

/**
 * Генерирует предложение (proposal) на основе сигнала и затронутых модулей.
 *
 * @param {{title: string, snippet: string}} signal
 * @param {{domain: string, modules: string[], description: string}[]} matches
 * @returns {{proposal: string, impact: string, effort: string, action: string, affects: string[]}}
 */
function generateProposal(signal, matches) {
  const text = `${signal.title} ${signal.snippet}`.toLowerCase();
  const allModules = matches.flatMap((m) => m.modules);
  const uniqueModules = [...new Set(allModules)];
  const domains = matches.map((m) => m.domain);

  // Определяем impact на основе количества затронутых модулей
  let impact = "Low";
  if (uniqueModules.length >= 4) impact = "High";
  else if (uniqueModules.length >= 2) impact = "Medium";

  // Определяем effort по контексту
  let effort = "Medium";
  if (text.includes("update") || text.includes("upgrade") || text.includes("new version")) {
    effort = "Low";
  } else if (text.includes("migration") || text.includes("rewrite") || text.includes("replace")) {
    effort = "High";
  }

  // Определяем действие
  let action = "watch";
  if (impact === "High" && effort === "Low") action = "test";
  else if (impact === "Low" && effort === "High") action = "ignore";
  else if (impact === "High") action = "backlog";

  // Генерируем текст предложения на основе доменов
  let proposal = "";
  if (domains.includes("LLM/AI")) {
    proposal = `Проверить совместимость с llm-router.cjs и обновить конфигурацию моделей`;
  } else if (domains.includes("Automation")) {
    proposal = `Оценить интеграцию в pipeline-runner.cjs для автоматизации workflow`;
  } else if (domains.includes("Observability")) {
    proposal = `Улучшить трейсинг через langfuse-trace.cjs с новыми возможностями`;
  } else if (domains.includes("Notifications")) {
    proposal = `Расширить notification-throttle.cjs с учётом новых возможностей`;
  } else if (domains.includes("CRM")) {
    proposal = `Интегрировать в клиентскую аналитику (client-analytics.cjs)`;
  } else if (domains.includes("Supply Chain")) {
    proposal = `Применить для оптимизации inventory-tracker.cjs и demand-predictor.cjs`;
  } else if (domains.includes("Knowledge")) {
    proposal = `Усилить knowledge pipeline: knowledge-indexer + knowledge-retriever`;
  } else if (domains.includes("Finance")) {
    proposal = `Рассмотреть для auto-pricing.cjs и cashflow-forecast.cjs`;
  } else {
    proposal = `Оценить применимость к модулям: ${uniqueModules.slice(0, 3).join(", ")}`;
  }

  return {
    proposal,
    impact,
    effort,
    action,
    affects: uniqueModules.slice(0, 4),
  };
}

/**
 * Генерирует строку релевантности сигнала к системе Pepino.
 *
 * @param {{domain: string, description: string}[]} matches
 * @returns {string}
 */
function generateRelevance(matches) {
  if (matches.length === 0) {
    return "Косвенная связь с системой. Может быть полезно для общего развития.";
  }

  const domains = matches.map((m) => m.domain).join(", ");
  const desc = matches[0].description;
  return `Затрагивает ${domains}. ${desc}.`;
}

// ── System Health Check ─────────────────────────────────────────────────────

/**
 * Собирает информацию о текущем состоянии системы.
 * @returns {{cjsCount: number, jsCount: number, cronCount: number, ramUsedMb: number, ramTotalMb: number, ramPercent: number, risks: string[], recommendations: string[]}}
 */
function getSystemHealth() {
  /** @type {{cjsCount: number, jsCount: number, cronCount: number, ramUsedMb: number, ramTotalMb: number, ramPercent: number, risks: string[], recommendations: string[]}} */
  const health = {
    cjsCount: 0,
    jsCount: 0,
    cronCount: 0,
    ramUsedMb: 0,
    ramTotalMb: 0,
    ramPercent: 0,
    risks: [],
    recommendations: [],
  };

  // Считаем скрипты
  try {
    const files = fs.readdirSync(SCRIPTS_DIR);
    health.cjsCount = files.filter((f) => f.endsWith(".cjs")).length;
    health.jsCount = files.filter((f) => f.endsWith(".js")).length;
  } catch {
    // Не критично
  }

  // Считаем cron-записи
  try {
    const crontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
    health.cronCount = crontab.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
  } catch {
    health.cronCount = 0;
  }

  // RAM
  try {
    const memInfo = execSync("free -m 2>/dev/null", { encoding: "utf-8" });
    const memLine = memInfo.split("\n").find((l) => l.startsWith("Mem:"));
    if (memLine) {
      const parts = memLine.split(/\s+/);
      health.ramTotalMb = parseInt(parts[1], 10) || 0;
      health.ramUsedMb = parseInt(parts[2], 10) || 0;
      health.ramPercent =
        health.ramTotalMb > 0 ? Math.round((health.ramUsedMb / health.ramTotalMb) * 100) : 0;
    }
  } catch {
    // Не критично
  }

  // Анализ рисков
  if (health.cronCount > 35) {
    health.risks.push(
      `Alert fatigue: ${health.cronCount} cron -> слишком много Telegram-сообщений`,
    );
  }
  if (health.ramPercent > 80) {
    health.risks.push(
      `Высокое потребление RAM: ${health.ramPercent}% (${health.ramUsedMb}/${health.ramTotalMb} MB)`,
    );
  }
  if (health.cjsCount > 55) {
    health.risks.push(`Рост кодовой базы: ${health.cjsCount} CJS скриптов, поддержка усложняется`);
  }

  // Рекомендации
  if (health.cronCount > 30) {
    health.recommendations.push("Мигрировать 5+ скриптов в pipeline-runner для батчинга");
  }
  if (health.ramPercent > 75) {
    health.recommendations.push(
      "Проверить Docker-контейнеры: `docker stats --no-stream`, остановить неиспользуемые",
    );
  }

  return health;
}

// ── Top Improvements ─────────────────────────────────────────────────────────

/**
 * Проверяет пул предложений и возвращает актуальные (top 3).
 * @returns {{priority: string, title: string, detail: string}[]}
 */
function getTopImprovements() {
  const active = [];

  for (const item of IMPROVEMENT_POOL) {
    try {
      if (item.check()) {
        active.push({
          priority: item.priority,
          title: item.title,
          detail: item.detail,
        });
      }
    } catch {
      // check() упал -- пропускаем
    }
  }

  // Сортируем: HIGH > MED > LOW
  const priorityOrder = { HIGH: 0, MED: 1, LOW: 2 };
  active.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3));

  return active.slice(0, 3);
}

// ── Форматирование отчёта ────────────────────────────────────────────────────

/** Экранирует HTML-спецсимволы для Telegram */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Форматирует полный HTML-отчёт для Telegram.
 *
 * @param {object} data
 * @param {Array} data.signals - Обработанные сигналы
 * @param {object} data.health - System Health Check
 * @param {Array} data.improvements - Top Improvements
 * @param {string} data.date - Дата отчёта
 * @returns {string}
 */
function formatTelegramReport(data) {
  const lines = [];

  lines.push(`<b>AI RADAR -- Proactive Report</b>`);
  lines.push(`Date: ${data.date}\n`);

  // === SIGNALS ===
  lines.push(`<b>=== SIGNALS (${data.signals.length}) ===</b>\n`);

  for (let i = 0; i < data.signals.length; i++) {
    const s = data.signals[i];
    lines.push(`${i + 1}. <b>[SIGNAL]</b> ${escapeHtml(s.title)}`);
    lines.push(`   <b>RELEVANCE:</b> ${escapeHtml(s.relevance)}`);
    lines.push(`   <b>PROPOSAL:</b> "${escapeHtml(s.proposal)}"`);
    lines.push(`   <b>IMPACT:</b> ${s.impact} | <b>EFFORT:</b> ${s.effort}`);
    if (s.affects.length > 0) {
      lines.push(`   <b>AFFECTS:</b> ${s.affects.join(", ")}`);
    }
    lines.push(`   <b>ACTION:</b> ${s.action}`);
    if (i < data.signals.length - 1) lines.push("");
  }

  // === SYSTEM HEALTH CHECK ===
  lines.push(`\n<b>=== SYSTEM HEALTH CHECK ===</b>`);
  const h = data.health;
  lines.push(
    `Current: ${h.cjsCount} CJS, ${h.jsCount} JS, ${h.cronCount} cron, ${h.ramUsedMb}/${h.ramTotalMb}MB RAM (${h.ramPercent}%)`,
  );

  if (h.risks.length > 0) {
    for (const risk of h.risks) {
      lines.push(`Risk: ${escapeHtml(risk)}`);
    }
  } else {
    lines.push(`Risk: none detected`);
  }

  if (h.recommendations.length > 0) {
    for (const rec of h.recommendations) {
      lines.push(`Rec: ${escapeHtml(rec)}`);
    }
  }

  // === TOP IMPROVEMENTS ===
  if (data.improvements.length > 0) {
    lines.push(`\n<b>=== TOP ${data.improvements.length} IMPROVEMENTS ===</b>`);
    for (let i = 0; i < data.improvements.length; i++) {
      const imp = data.improvements[i];
      lines.push(`${i + 1}. [${imp.priority}] ${escapeHtml(imp.title)}`);
      lines.push(`   ${escapeHtml(imp.detail)}`);
    }
  }

  return lines.join("\n");
}

// ── Сохранение JSON-отчёта ──────────────────────────────────────────────────

/**
 * Сохраняет полный отчёт в JSON-файл.
 *
 * @param {object} report
 * @param {string} date - Дата в формате YYYY-MM-DD
 */
function saveReportJson(report, date) {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    const filePath = path.join(REPORT_DIR, `ai-radar-${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`[JSON] Report saved to ${filePath}`);
  } catch (err) {
    console.error(`[JSON] Save failed: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  console.log(
    `[${new Date().toISOString()}] AI Radar Report starting...${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  // 1. Собираем сигналы
  console.log("\n--- Collecting signals ---");

  /** @type {{title: string, url: string, source: string, date: string, snippet: string}[]} */
  let allResults = [];
  for (const query of AI_QUERIES) {
    try {
      const results = await searchQuery(query);
      allResults = allResults.concat(results);
    } catch (err) {
      console.warn(`  Query failed: ${err.message}`);
    }
  }

  // Дедупликация по URL
  const urlSet = new Set();
  allResults = allResults.filter((r) => {
    if (urlSet.has(r.url)) return false;
    urlSet.add(r.url);
    return true;
  });

  console.log(`Total unique signals: ${allResults.length}`);

  // 2. Оцениваем каждый сигнал через призму системы
  /** @type {Array<{title: string, url: string, source: string, date: string, snippet: string, systemMatches: Array, relevance: string, proposal: string, impact: string, effort: string, action: string, affects: string[]}>} */
  const evaluated = [];

  for (const signal of allResults) {
    const matches = matchSystemModules(signal);
    if (matches.length === 0) continue; // Пропускаем нерелевантные

    const relevanceText = generateRelevance(matches);
    const proposalData = generateProposal(signal, matches);

    evaluated.push({
      title: signal.title,
      url: signal.url,
      source: signal.source,
      date: signal.date,
      snippet: signal.snippet,
      systemMatches: matches,
      relevance: relevanceText,
      ...proposalData,
    });
  }

  // Сортируем: test > backlog > watch > ignore
  const actionOrder = { test: 0, backlog: 1, watch: 2, ignore: 3 };
  evaluated.sort((a, b) => (actionOrder[a.action] ?? 4) - (actionOrder[b.action] ?? 4));

  // Берём top N сигналов (MIN_SIGNALS..MAX_SIGNALS)
  const topSignals = evaluated.slice(0, MAX_SIGNALS);
  console.log(`Evaluated: ${evaluated.length} relevant, showing top ${topSignals.length}`);

  // Если сигналов меньше минимума -- добавляем заглушку
  if (topSignals.length < MIN_SIGNALS) {
    console.log(`Warning: only ${topSignals.length} signals found (min: ${MIN_SIGNALS})`);
  }

  // 3. System Health Check
  console.log("\n--- System Health Check ---");
  const health = getSystemHealth();
  console.log(
    `  Scripts: ${health.cjsCount} CJS, ${health.jsCount} JS | Cron: ${health.cronCount} | RAM: ${health.ramPercent}%`,
  );

  // 4. Top Improvements
  console.log("\n--- Top Improvements ---");
  const improvements = getTopImprovements();
  for (const imp of improvements) {
    console.log(`  [${imp.priority}] ${imp.title}`);
  }

  // 5. Формируем отчёт
  const report = {
    date: today,
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    signals: topSignals,
    health,
    improvements,
    stats: {
      totalQueried: AI_QUERIES.length,
      totalRaw: allResults.length,
      totalRelevant: evaluated.length,
      totalShown: topSignals.length,
    },
  };

  // 6. Отправляем в Telegram
  if (topSignals.length > 0 || improvements.length > 0) {
    const telegramHtml = formatTelegramReport({
      signals: topSignals,
      health,
      improvements,
      date: today,
    });

    if (!DRY_RUN) {
      try {
        let result;
        if (sendThrottled) {
          result = await sendThrottled(telegramHtml, {
            thread: TG_THREAD_ID,
            silent: false,
            priority: "normal",
            parseMode: "HTML",
          });
        } else {
          result = await sendReport(telegramHtml, TG_THREAD_ID, "HTML");
        }

        if (result.ok) {
          console.log(`\n[Telegram] Report sent to thread ${TG_THREAD_ID}`);
        } else {
          console.error(`[Telegram] Send failed: ${result.error}`);
        }
      } catch (err) {
        console.error(`[Telegram] Error: ${err.message}`);
      }
    } else {
      console.log(`\n[DRY RUN] Would send to Telegram (thread ${TG_THREAD_ID}):`);
      console.log(telegramHtml.replace(/<[^>]+>/g, ""));
    }
  } else {
    console.log("\nNo signals or improvements to report.");
  }

  // 7. Сохраняем JSON
  const durationMs = Date.now() - startMs;
  report.durationMs = durationMs;

  if (!DRY_RUN) {
    saveReportJson(report, today);
  } else {
    console.log(`\n[DRY RUN] Would save JSON to ${REPORT_DIR}/ai-radar-${today}.json`);
  }

  // 8. Langfuse trace
  await trace({
    name: "ai-radar-report",
    input: { queries: AI_QUERIES.length, dry_run: DRY_RUN },
    output: report.stats,
    duration_ms: durationMs,
    metadata: { skill: "pepino-google-sheets", cron: "ai-radar-report" },
  }).catch(() => {});

  // Итог
  console.log(`\n=== AI Radar Report Complete ===`);
  console.log(
    `Signals: ${topSignals.length}/${evaluated.length} | Improvements: ${improvements.length} | Duration: ${durationMs}ms`,
  );
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
