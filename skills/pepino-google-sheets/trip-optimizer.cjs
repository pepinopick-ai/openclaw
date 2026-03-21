#!/usr/bin/env node
/**
 * trip-optimizer.cjs — Умный планировщик поездок в Buenos Aires
 *
 * Максимизирует каждую поездку, объединяя доставки с попутными задачами:
 * закупки у поставщиков, возврат тары, визиты к at-risk клиентам,
 * маркетинг, банковские дела, разведка конкурентов.
 *
 * CLI:
 *   node trip-optimizer.cjs plan                    # План на сегодня
 *   node trip-optimizer.cjs plan --date 2026-03-24  # На конкретную дату
 *   node trip-optimizer.cjs plan --zone Palermo     # Для конкретной зоны
 *   node trip-optimizer.cjs plan --max-extra 5      # Макс. допзадач (по умолчанию 3)
 *   node trip-optimizer.cjs suggest                  # Все ожидающие задачи для объединения
 *   node trip-optimizer.cjs --dry-run plan           # Без отправки в Telegram
 *
 * Cron: 45 5 * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/trip-optimizer.cjs plan
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getState } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { parseNum, parseDate, fmtDate, fmtNum, daysBetween } = require("./helpers.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Константы ----------------------------------------------------------------

/** Директория с профилями клиентов */
const CLIENTS_DIR = path.join(
  process.env.HOME || "/root",
  ".openclaw",
  "workspace",
  "memory",
  "people",
  "clients",
);

/** Максимальное время поездки (часы), после которого показываем предупреждение */
const MAX_TRIP_HOURS = 6;

/** Время на одну доставку (минуты) */
const DELIVERY_TIME_MIN = 20;

/** Базовое время на дорогу Cordoba -> Buenos Aires (часы, туда) */
const BASE_TRAVEL_HOURS = 2.5;

/** Тема Telegram для отправки плана (Director/Strategy) */
const TG_THREAD_TRIP = 20;

/** Дней без заказа для "вероятно есть тара" */
const CONTAINER_RETURN_DAYS = 7;

// -- Зоны Buenos Aires -------------------------------------------------------

/** @type {Record<string, string[]>} */
const ZONE_CLUSTERS = {
  centro: ["Microcentro", "San Nicolás", "Montserrat", "San Telmo"],
  norte: ["Palermo", "Belgrano", "Recoleta", "Colegiales", "Núñez"],
  oeste: ["Almagro", "Caballito", "Villa Crespo", "Flores"],
  sur: ["La Boca", "Barracas", "Constitución"],
  gba_norte: ["Vicente López", "Olivos", "San Isidro"],
  gba_oeste: ["Morón", "Ramos Mejía", "Haedo"],
};

/** Обратный маппинг: barrio -> cluster */
const BARRIO_TO_CLUSTER = {};
for (const [cluster, barrios] of Object.entries(ZONE_CLUSTERS)) {
  for (const b of barrios) {
    BARRIO_TO_CLUSTER[b.toLowerCase()] = cluster;
  }
}

/** Расстояние между кластерами: 0 = тот же, 1 = соседний, 2 = далеко */
const CLUSTER_DISTANCE = {
  "centro-norte": 1,
  "centro-oeste": 1,
  "centro-sur": 1,
  "norte-oeste": 1,
  "norte-gba_norte": 1,
  "oeste-sur": 1,
  "oeste-gba_oeste": 1,
  "sur-gba_norte": 2,
  "sur-gba_oeste": 2,
  "norte-sur": 2,
  "norte-gba_oeste": 2,
  "centro-gba_norte": 1,
  "centro-gba_oeste": 2,
  "gba_norte-gba_oeste": 2,
};

/**
 * Расстояние между двумя кластерами (0, 1 или 2).
 * @param {string} c1
 * @param {string} c2
 * @returns {number}
 */
function clusterDistance(c1, c2) {
  if (c1 === c2) return 0;
  const key1 = `${c1}-${c2}`;
  const key2 = `${c2}-${c1}`;
  return CLUSTER_DISTANCE[key1] ?? CLUSTER_DISTANCE[key2] ?? 2;
}

/**
 * Определяет кластер по строке адреса или зоне.
 * @param {string} location
 * @returns {string|null}
 */
function detectCluster(location) {
  if (!location) return null;
  const lower = location.toLowerCase();
  for (const [barrio, cluster] of Object.entries(BARRIO_TO_CLUSTER)) {
    if (lower.includes(barrio)) return cluster;
  }
  return null;
}

// -- Приоритеты задач ---------------------------------------------------------

/** @enum {number} */
const TASK_PRIORITY = {
  supplier_pickup: 5, // Экономит отдельную поездку
  at_risk_visit: 4, // Спасает выручку
  container_collect: 3, // Экономит деньги на таре
  marketing_photo: 2, // Рост бренда
  banking_admin: 1, // Удобство
  market_research: 1, // Разведка
};

/** Оценка времени по типу задачи (минуты) */
const TASK_TIME_MIN = {
  supplier_pickup: 15,
  at_risk_visit: 20,
  container_collect: 10,
  marketing_photo: 15,
  banking_admin: 20,
  market_research: 30,
};

// -- Загрузка профилей клиентов -----------------------------------------------

/**
 * Читает все JSON-профили клиентов из директории.
 * @returns {Array<{name: string, location: string|null, cluster: string|null, type: string}>}
 */
function loadClientProfiles() {
  /** @type {Array<{name: string, location: string|null, cluster: string|null, type: string}>} */
  const profiles = [];
  try {
    const files = fs.readdirSync(CLIENTS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CLIENTS_DIR, file), "utf-8");
        const data = JSON.parse(raw);
        const name =
          data.core_identity?.full_name ||
          data.business_identity?.name ||
          file.replace(/\.json$/, "");
        const location =
          data.core_identity?.current_location || data.business_identity?.address || null;
        const type = data.core_identity?.type || "unknown";
        profiles.push({
          name,
          location,
          cluster: detectCluster(location),
          type,
        });
      } catch {
        // Пропускаем битые файлы
      }
    }
  } catch {
    // Директория не существует — работаем без профилей
  }
  return profiles;
}

// -- Основная логика ----------------------------------------------------------

/**
 * Находит доставки на указанную дату.
 * @param {Record<string,string>[]} sales — строки продаж
 * @param {Record<string,string>[]} tasks — строки задач
 * @param {Date} targetDate
 * @returns {Array<{client: string, product: string, kg: number, zone: string|null, cluster: string|null}>}
 */
function findDeliveries(sales, tasks, targetDate, clientProfiles) {
  const target = fmtDate(targetDate);
  /** @type {Array<{client: string, product: string, kg: number, zone: string|null, cluster: string|null}>} */
  const deliveries = [];

  // Ищем в продажах с датой доставки на целевую дату
  for (const row of sales) {
    const deliveryDate = row["Дата доставки"] || row["Дата"] || row["дата"] || "";
    const parsed = parseDate(deliveryDate);
    if (!parsed) continue;
    if (fmtDate(parsed) !== target) continue;

    const client = (row["Клиент"] || row["клиент"] || "").trim();
    if (!client) continue;

    const product = (row["Продукт"] || row["продукт"] || "").trim();
    const kg = parseNum(row["Кол-во кг"] || row["кг"] || 0);

    // Определяем зону клиента из профиля
    const profile = clientProfiles.find((p) => p.name.toLowerCase() === client.toLowerCase());
    const zone = profile?.location || null;
    const cluster = profile?.cluster || detectCluster(zone);

    deliveries.push({ client, product, kg, zone, cluster });
  }

  // Ищем в задачах с типом "Доставка"
  for (const row of tasks) {
    const taskDate = row["Дата"] || row["дата"] || "";
    const parsed = parseDate(taskDate);
    if (!parsed) continue;
    if (fmtDate(parsed) !== target) continue;

    const taskType = (row["Тип"] || row["тип"] || "").toLowerCase();
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    if (status === "done" || status === "выполнено") continue;
    if (!taskType.includes("доставк") && !taskType.includes("deliver")) continue;

    const desc = row["Описание"] || row["описание"] || row["Задача"] || "";
    const client = (row["Клиент"] || row["клиент"] || desc).trim();

    const profile = clientProfiles.find((p) => p.name.toLowerCase() === client.toLowerCase());
    deliveries.push({
      client,
      product: "",
      kg: 0,
      zone: profile?.location || null,
      cluster: profile?.cluster || null,
    });
  }

  return deliveries;
}

/**
 * Сканирует все источники и формирует список допзадач.
 * @param {object} state — состояние фермы
 * @param {object} clientAnalysis — результат analyzeClients()
 * @param {Array} clientProfiles — профили клиентов
 * @param {string[]} deliveryClusters — кластеры основных доставок
 * @returns {Array<BundleTask>}
 *
 * @typedef {{
 *   type: string,
 *   description: string,
 *   location: string|null,
 *   cluster: string|null,
 *   priority: number,
 *   timeMin: number,
 *   savingsArs: number,
 *   savingsDesc: string,
 *   client?: string,
 * }} BundleTask
 */
function scanBundleTasks(state, clientAnalysis, clientProfiles, deliveryClusters) {
  /** @type {BundleTask[]} */
  const tasks = [];
  const pendingTasks = state.tasks || [];
  const sales = state.sales || [];

  // a) Закупки у поставщиков — из "Задачи" где dept = "Закупки"
  for (const row of pendingTasks) {
    const dept = (row["Отдел"] || row["отдел"] || row["Dept"] || "").toLowerCase();
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    const taskType = (row["Тип"] || row["тип"] || "").toLowerCase();
    if (status === "done" || status === "выполнено") continue;

    const isSupplier =
      dept.includes("закупк") ||
      taskType.includes("закупк") ||
      taskType.includes("compra") ||
      taskType.includes("recoger");

    if (isSupplier) {
      const desc = row["Описание"] || row["описание"] || row["Задача"] || row["задача"] || "";
      const location = row["Место"] || row["место"] || row["Адрес"] || null;
      const cluster = detectCluster(location) || detectCluster(desc);
      tasks.push({
        type: "supplier_pickup",
        description: desc || "Закупка у поставщика",
        location,
        cluster,
        priority: TASK_PRIORITY.supplier_pickup,
        timeMin: TASK_TIME_MIN.supplier_pickup,
        savingsArs: 3000, // Экономия на отдельной поездке
        savingsDesc: "отдельная поездка ~3 000 ARS",
      });
    }
  }

  // b) Сбор тары — клиенты с доставкой >7 дней назад
  if (clientAnalysis?.clients) {
    for (const client of clientAnalysis.clients) {
      if (client.daysSinceLast >= CONTAINER_RETURN_DAYS && client.daysSinceLast < 60) {
        const profile = clientProfiles.find(
          (p) => p.name.toLowerCase() === client.name.toLowerCase(),
        );
        if (!profile) continue;
        // Оцениваем количество контейнеров по среднему заказу
        const estimatedContainers = Math.max(1, Math.ceil(client.avgOrderKg / 5));
        tasks.push({
          type: "container_collect",
          description: `Забрать тару у "${client.name}"`,
          location: profile.location,
          cluster: profile.cluster,
          priority: TASK_PRIORITY.container_collect,
          timeMin: TASK_TIME_MIN.container_collect,
          savingsArs: estimatedContainers * 500,
          savingsDesc: `${estimatedContainers} контейнеров x 500 ARS = ${fmtNum(estimatedContainers * 500)} ARS`,
          client: client.name,
        });
      }
    }
  }

  // c) Визиты к at-risk клиентам
  if (clientAnalysis?.clients) {
    for (const client of clientAnalysis.clients) {
      if (client.status !== "at_risk") continue;
      const profile = clientProfiles.find(
        (p) => p.name.toLowerCase() === client.name.toLowerCase(),
      );
      if (!profile) continue;

      const monthlyRevenue = client.avgOrderArs * (30 / Math.max(1, client.avgFrequencyDays));
      tasks.push({
        type: "at_risk_visit",
        description: `Визит к "${client.name}" — ${client.daysSinceLast} дней без заказа`,
        location: profile.location,
        cluster: profile.cluster,
        priority: TASK_PRIORITY.at_risk_visit,
        timeMin: TASK_TIME_MIN.at_risk_visit,
        savingsArs: 0,
        savingsDesc: `возврат клиента ~${fmtNum(Math.round(monthlyRevenue))} ARS/мес`,
        client: client.name,
      });
    }
  }

  // d) Маркетинг — фото для Instagram у клиентов-ресторанов в зоне доставки
  if (clientAnalysis?.clients) {
    for (const client of clientAnalysis.clients) {
      if (client.status !== "active") continue;
      const profile = clientProfiles.find(
        (p) => p.name.toLowerCase() === client.name.toLowerCase(),
      );
      if (!profile || profile.type !== "business") continue;
      // Только если в одном из кластеров доставки
      if (!profile.cluster || !deliveryClusters.includes(profile.cluster)) continue;

      tasks.push({
        type: "marketing_photo",
        description: `Фото в "${client.name}" для Instagram`,
        location: profile.location,
        cluster: profile.cluster,
        priority: TASK_PRIORITY.marketing_photo,
        timeMin: TASK_TIME_MIN.marketing_photo,
        savingsArs: 0,
        savingsDesc: "рост бренда",
        client: client.name,
      });
    }
  }

  // e) Банковские/административные задачи
  for (const row of pendingTasks) {
    const dept = (row["Отдел"] || row["отдел"] || row["Dept"] || "").toLowerCase();
    const taskType = (row["Тип"] || row["тип"] || "").toLowerCase();
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    if (status === "done" || status === "выполнено") continue;

    const isBanking =
      dept.includes("админ") ||
      dept.includes("финанс") ||
      taskType.includes("банк") ||
      taskType.includes("bank") ||
      taskType.includes("документ") ||
      taskType.includes("admin");

    if (isBanking) {
      const desc = row["Описание"] || row["описание"] || row["Задача"] || row["задача"] || "";
      const location = row["Место"] || row["место"] || null;
      tasks.push({
        type: "banking_admin",
        description: desc || "Банковские/административные дела",
        location,
        cluster: detectCluster(location) || detectCluster(desc),
        priority: TASK_PRIORITY.banking_admin,
        timeMin: TASK_TIME_MIN.banking_admin,
        savingsArs: 0,
        savingsDesc: "удобство",
      });
    }
  }

  // f) Разведка рынка — задачи с типом "исследование"/"research"
  for (const row of pendingTasks) {
    const taskType = (row["Тип"] || row["тип"] || "").toLowerCase();
    const status = (row["Статус"] || row["статус"] || "").toLowerCase();
    if (status === "done" || status === "выполнено") continue;

    const isResearch =
      taskType.includes("исследован") ||
      taskType.includes("research") ||
      taskType.includes("конкурент") ||
      taskType.includes("рынок");

    if (isResearch) {
      const desc = row["Описание"] || row["описание"] || row["Задача"] || row["задача"] || "";
      const location = row["Место"] || row["место"] || null;
      tasks.push({
        type: "market_research",
        description: desc || "Исследование рынка / конкурентов",
        location,
        cluster: detectCluster(location) || detectCluster(desc),
        priority: TASK_PRIORITY.market_research,
        timeMin: TASK_TIME_MIN.market_research,
        savingsArs: 0,
        savingsDesc: "разведка",
      });
    }
  }

  return tasks;
}

/**
 * Ранжирует и отбирает допзадачи по приоритету и близости к маршруту.
 * @param {BundleTask[]} tasks
 * @param {string[]} deliveryClusters — кластеры основных доставок
 * @param {number} maxExtra — макс. количество допзадач
 * @returns {{selected: BundleTask[], excluded: BundleTask[]}}
 */
function rankAndSelect(tasks, deliveryClusters, maxExtra) {
  // Считаем финальный score: priority + бонус за близость
  /** @type {Array<BundleTask & {score: number, proximityBonus: number}>} */
  const scored = tasks.map((t) => {
    let proximityBonus = 0;
    if (t.cluster) {
      // Если задача в одном из кластеров доставки — максимальный бонус
      if (deliveryClusters.includes(t.cluster)) {
        proximityBonus = 3;
      } else {
        // Минимальное расстояние до любого кластера доставки
        const minDist = Math.min(...deliveryClusters.map((dc) => clusterDistance(dc, t.cluster)));
        if (minDist === 1) proximityBonus = 1;
        // minDist === 2 -> proximityBonus = 0
      }
    }
    return { ...t, score: t.priority + proximityBonus, proximityBonus };
  });

  // Сортируем по score (убывание), при равенстве — по priority
  scored.sort((a, b) => b.score - a.score || b.priority - a.priority);

  // Дедупликация по клиенту: один клиент — одна задача (самая приоритетная)
  const seenClients = new Set();
  /** @type {typeof scored} */
  const deduped = [];
  for (const t of scored) {
    if (t.client) {
      const key = t.client.toLowerCase();
      if (seenClients.has(key)) continue;
      seenClients.add(key);
    }
    deduped.push(t);
  }

  // Лимит на маркетинг: не больше 1, если много других задач
  let marketingCount = 0;
  /** @type {typeof scored} */
  const filtered = [];
  for (const t of deduped) {
    if (t.type === "marketing_photo") {
      marketingCount++;
      // Маркетинг только если <3 других задач уже выбрано
      if (filtered.length >= 3 || marketingCount > 1) {
        continue; // Уйдёт в excluded
      }
    }
    filtered.push(t);
  }

  const selected = filtered.slice(0, maxExtra);
  const excluded = filtered.slice(maxExtra).concat(deduped.filter((t) => !filtered.includes(t)));

  return { selected, excluded };
}

/**
 * Формирует HTML-сообщение для Telegram.
 * @param {object} params
 * @param {Date} params.date
 * @param {Array} params.deliveries
 * @param {BundleTask[]} params.selected
 * @param {BundleTask[]} params.excluded
 * @param {string[]} params.clusters
 * @returns {string}
 */
function formatTelegramMessage({ date, deliveries, selected, excluded, clusters }) {
  const dateStr = fmtDate(date).split("-").reverse().join(".");
  const clusterNames = [...new Set(clusters)].map((c) => {
    const barrios = ZONE_CLUSTERS[c];
    return barrios ? barrios[0] : c;
  });

  // Время расчёта
  const deliveryTimeH = (deliveries.length * DELIVERY_TIME_MIN) / 60;
  const extraTimeH = selected.reduce((s, t) => s + t.timeMin, 0) / 60;
  const totalTimeH = BASE_TRAVEL_HOURS * 2 + deliveryTimeH + extraTimeH;

  const lines = [];

  // Заголовок
  lines.push(`<b>\u{1F69B} ПЛАН ПОЕЗДКИ: ${dateStr}</b>`);
  lines.push("");

  // Маршрут
  const zones = clusterNames.length > 0 ? clusterNames.join(" + ") : "Buenos Aires";
  lines.push(`\u{1F4CD} <b>Маршрут:</b> Córdoba \u{2192} Buenos Aires (${zones})`);
  lines.push(
    `\u23F1 <b>Расч. время:</b> ${deliveryTimeH.toFixed(1)}ч (доставка) + ${extraTimeH.toFixed(1)}ч (допзадачи) + ${(BASE_TRAVEL_HOURS * 2).toFixed(0)}ч (дорога)`,
  );

  if (totalTimeH > MAX_TRIP_HOURS) {
    lines.push(
      `\u26A0\uFE0F <b>ВНИМАНИЕ:</b> общее время ~${totalTimeH.toFixed(1)}ч превышает ${MAX_TRIP_HOURS}ч!`,
    );
  }
  lines.push("");

  // Доставки
  lines.push(`<b>\u{1F4E6} ДОСТАВКИ (основные):</b>`);
  if (deliveries.length === 0) {
    lines.push("  Нет запланированных доставок");
  } else {
    deliveries.forEach((d, i) => {
      const kgStr = d.kg > 0 ? ` \u2014 ${d.kg}кг ${d.product}` : "";
      const zoneStr = d.cluster ? ` (${ZONE_CLUSTERS[d.cluster]?.[0] || d.cluster})` : "";
      lines.push(`${i + 1}. ${d.client}${kgStr}${zoneStr}`);
    });
  }
  lines.push("");

  // Допзадачи
  if (selected.length > 0) {
    lines.push(`<b>\u26A1 МУЛЬТИПЛИКАТОР (допзадачи по пути):</b>`);
    selected.forEach((t, i) => {
      const stars = "\u2605".repeat(t.priority) + "\u2606".repeat(5 - t.priority);
      const zoneStr = t.cluster ? `, ${ZONE_CLUSTERS[t.cluster]?.[0] || t.cluster}` : "";
      lines.push(`${i + 1}. [${stars}] ${t.description} (${t.timeMin} мин${zoneStr})`);
      if (t.savingsArs > 0) {
        lines.push(`   \u2192 Экономия: ${t.savingsDesc}`);
      } else if (t.savingsDesc) {
        lines.push(`   \u2192 Потенциал: ${t.savingsDesc}`);
      }
    });
    lines.push("");
  }

  // Не включённые задачи
  if (excluded.length > 0) {
    lines.push(`<b>\u{1F4A1} НЕ включено (можно добавить):</b>`);
    for (const t of excluded.slice(0, 5)) {
      const reason =
        t.cluster && !deliveries.some((d) => d.cluster === t.cluster)
          ? "не по маршруту"
          : "низкий приоритет";
      lines.push(`- ${t.description} (${reason})`);
    }
    if (excluded.length > 5) {
      lines.push(`  ...и ещё ${excluded.length - 5}`);
    }
    lines.push("");
  }

  // Итого
  const totalSavings = selected.reduce((s, t) => s + t.savingsArs, 0);
  const potentialItems = selected.filter((t) => t.savingsArs === 0 && t.savingsDesc);
  let summaryParts = [];
  if (totalSavings > 0) {
    summaryParts.push(`~${fmtNum(totalSavings)} ARS прямая экономия`);
  }
  for (const t of potentialItems) {
    summaryParts.push(t.savingsDesc);
  }
  if (summaryParts.length > 0) {
    lines.push(`<b>\u{1F4CA} Итого:</b> ${summaryParts.join(" + ")}`);
  }

  return lines.join("\n");
}

/**
 * Формирует текст для команды "suggest" — все ожидающие задачи.
 * @param {BundleTask[]} tasks
 * @returns {string}
 */
function formatSuggestMessage(tasks) {
  if (tasks.length === 0) {
    return "\u{1F4CB} Нет ожидающих задач для объединения с поездкой.";
  }

  const lines = [];
  lines.push(`<b>\u{1F4CB} ОЖИДАЮЩИЕ ЗАДАЧИ (${tasks.length}):</b>`);
  lines.push("Можно объединить с ближайшей поездкой:\n");

  // Группируем по типу
  const byType = {};
  for (const t of tasks) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  const typeLabels = {
    supplier_pickup: "\u{1F4E6} Закупки",
    at_risk_visit: "\u26A0\uFE0F At-risk клиенты",
    container_collect: "\u{1F4E4} Сбор тары",
    marketing_photo: "\u{1F4F8} Маркетинг",
    banking_admin: "\u{1F3E6} Банк/Админ",
    market_research: "\u{1F50D} Исследование рынка",
  };

  for (const [type, items] of Object.entries(byType)) {
    lines.push(`<b>${typeLabels[type] || type}:</b>`);
    for (const t of items) {
      const zoneStr = t.cluster ? ` [${ZONE_CLUSTERS[t.cluster]?.[0] || t.cluster}]` : "";
      lines.push(`  - ${t.description}${zoneStr}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// -- CLI ----------------------------------------------------------------------

/**
 * Парсит аргументы командной строки.
 * @returns {{command: string, date: Date, zone: string|null, maxExtra: number, dryRun: boolean}}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let command = "plan";
  let date = new Date();
  let zone = null;
  let maxExtra = 3;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--date" && args[i + 1]) {
      const parsed = parseDate(args[++i]);
      if (parsed) date = parsed;
    } else if (arg === "--zone" && args[i + 1]) {
      zone = args[++i];
    } else if (arg === "--max-extra" && args[i + 1]) {
      maxExtra = Math.max(1, parseInt(args[++i], 10) || 3);
    } else if (arg === "plan" || arg === "suggest") {
      command = arg;
    }
  }

  return { command, date, zone, maxExtra, dryRun };
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  const { command, date, zone, maxExtra, dryRun } = parseArgs();

  // Загрузка данных
  const state = await getState();
  if (!state) {
    console.error(
      "[trip-optimizer] Не удалось загрузить farm-state. Запустите: node farm-state.cjs refresh",
    );
    process.exit(1);
  }

  const clientAnalysis = await analyzeClients(state.sales);
  const clientProfiles = loadClientProfiles();

  if (command === "suggest") {
    // Показать все ожидающие задачи без привязки к дате
    const allTasks = scanBundleTasks(state, clientAnalysis, clientProfiles, []);
    const message = formatSuggestMessage(allTasks);

    if (dryRun) {
      console.log("[DRY RUN] suggest\n");
      console.log(message.replace(/<\/?b>/g, ""));
    } else {
      await sendThrottled(message, {
        thread: TG_THREAD_TRIP,
        silent: true,
        priority: "normal",
        parseMode: "HTML",
      });
      console.log(`[trip-optimizer] Отправлено ${allTasks.length} задач в Telegram`);
    }

    await trace({
      name: "trip-optimizer-suggest",
      input: { command: "suggest" },
      output: { taskCount: allTasks.length },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets", dryRun },
    }).catch(() => {});

    return;
  }

  // command === "plan"
  const deliveries = findDeliveries(state.sales || [], state.tasks || [], date, clientProfiles);

  // Фильтр по зоне, если указана
  let filteredDeliveries = deliveries;
  if (zone) {
    const zoneCluster = detectCluster(zone);
    if (zoneCluster) {
      filteredDeliveries = deliveries.filter((d) => d.cluster === zoneCluster);
    } else {
      // Пробуем фильтрацию по подстроке адреса
      const zoneLower = zone.toLowerCase();
      filteredDeliveries = deliveries.filter(
        (d) => d.zone?.toLowerCase().includes(zoneLower) || d.cluster?.includes(zoneLower),
      );
    }
  }

  // Если нет доставок — не отправляем (cron-режим)
  if (filteredDeliveries.length === 0 && !dryRun) {
    console.log(`[trip-optimizer] Нет доставок на ${fmtDate(date)}. Пропуск.`);

    await trace({
      name: "trip-optimizer-plan",
      input: { command: "plan", date: fmtDate(date), zone },
      output: { deliveries: 0, skipped: true },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets", dryRun },
    }).catch(() => {});

    return;
  }

  // Определяем кластеры маршрута
  const deliveryClusters = [...new Set(filteredDeliveries.map((d) => d.cluster).filter(Boolean))];

  // Сканируем допзадачи
  const allTasks = scanBundleTasks(state, clientAnalysis, clientProfiles, deliveryClusters);

  // Исключаем задачи для клиентов, которым и так делаем доставку сегодня
  const deliveryClientNames = new Set(filteredDeliveries.map((d) => d.client.toLowerCase()));
  const eligibleTasks = allTasks.filter(
    (t) => !t.client || !deliveryClientNames.has(t.client.toLowerCase()),
  );

  // Ранжируем и отбираем
  const { selected, excluded } = rankAndSelect(eligibleTasks, deliveryClusters, maxExtra);

  // Формируем сообщение
  const message = formatTelegramMessage({
    date,
    deliveries: filteredDeliveries,
    selected,
    excluded,
    clusters: deliveryClusters,
  });

  if (dryRun) {
    console.log("[DRY RUN] plan\n");
    // Убираем HTML-теги для консольного вывода
    console.log(message.replace(/<\/?b>/g, ""));
  } else {
    await sendThrottled(message, {
      thread: TG_THREAD_TRIP,
      silent: false,
      priority: "normal",
      parseMode: "HTML",
    });
    console.log(
      `[trip-optimizer] План на ${fmtDate(date)}: ${filteredDeliveries.length} доставок, ${selected.length} допзадач`,
    );
  }

  // Трейс в Langfuse
  await trace({
    name: "trip-optimizer-plan",
    input: {
      command: "plan",
      date: fmtDate(date),
      zone,
      maxExtra,
      deliveryCount: filteredDeliveries.length,
    },
    output: {
      deliveries: filteredDeliveries.length,
      selectedTasks: selected.length,
      excludedTasks: excluded.length,
      clusters: deliveryClusters,
      totalSavingsArs: selected.reduce((s, t) => s + t.savingsArs, 0),
    },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", dryRun },
  }).catch(() => {});
}

// -- Запуск -------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error("[trip-optimizer] Ошибка:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  findDeliveries,
  scanBundleTasks,
  rankAndSelect,
  formatTelegramMessage,
  loadClientProfiles,
  detectCluster,
  ZONE_CLUSTERS,
  TASK_PRIORITY,
};
