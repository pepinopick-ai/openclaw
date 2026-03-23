/**
 * Еженедельный отчёт Pepino Pick
 * Собирает данные за неделю, формирует отчёт, отправляет в Telegram
 *
 * Usage: node weekly-report.js
 * Cron:  0 18 * * 5 cd /home/roman/openclaw/skills/pepino-google-sheets && /usr/bin/node weekly-report.js >> /tmp/weekly-report.log 2>&1
 */

import http from 'node:http';
import https from 'node:https';
import { apiHeaders } from './api-auth.js';
import { trace } from './langfuse-trace.js';

// --- Конфигурация ---

const API_BASE = 'http://localhost:4000';

// Telegram: токен вынесен в константу для возможного переноса в env
const TG_TOKEN = process.env.PEPINO_TG_TOKEN || '8711358749:AAF7QJRW2NdwNYGAp2VjL_AOdQOang5Wv00';
const TG_CHAT_ID = process.env.PEPINO_TG_CHAT_ID || '-1003757515497';
const TG_TOPIC_STRATEGY = 20;   // Стратегия/Директор — полный отчёт
const TG_TOPIC_RESULTS = 112;   // Итоги — краткая сводка

// --- HTTP-утилиты ---

/** GET-запрос к локальному API, возвращает распарсенный JSON */
function fetchJson(path) {
  const url = `${API_BASE}${path}`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15_000, headers: apiHeaders() }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} от ${path}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (err) {
          reject(new Error(`Ошибка парсинга JSON от ${path}: ${err.message}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Сетевая ошибка ${path}: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Таймаут запроса ${path}`)); });
  });
}

/** Отправка сообщения в Telegram через Bot API */
function sendTelegram(text, messageThreadId) {
  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    message_thread_id: messageThreadId,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok) {
              reject(new Error(`Telegram error: ${parsed.description || body}`));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Telegram: невалидный ответ: ${body}`));
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Telegram сетевая ошибка: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram таймаут')); });
    req.write(payload);
    req.end();
  });
}

// --- Вспомогательные функции ---

/** Определяет границы текущей недели (пн 00:00 — пт 23:59 или вс 23:59) */
function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=вс, 1=пн, ..., 5=пт, 6=сб
  // Понедельник текущей недели
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  friday.setHours(23, 59, 59, 999);

  return { start: monday, end: friday };
}

/** Форматирует дату в DD.MM */
function fmtDateShort(d) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Форматирует дату в DD.MM.YYYY */
function fmtDate(d) {
  return `${fmtDateShort(d)}.${d.getFullYear()}`;
}

/** Форматирует число с разделителями тысяч: 1234567 → 1,234,567 */
function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  return Math.round(n).toLocaleString('ru-RU');
}

/** Рассчитывает процент изменения; возвращает строку +X% / -X% / N/A */
function pctChange(current, previous) {
  if (!previous || previous === 0) return 'N/A';
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// --- Сбор и агрегация данных ---

/**
 * Собирает все данные из API.
 * Каждый эндпоинт может вернуть ошибку — обрабатываем отдельно,
 * чтобы один упавший не сломал весь отчёт.
 */
async function collectData() {
  const endpoints = [
    { key: 'production', path: '/production' },
    { key: 'sales', path: '/sales' },
    { key: 'expenses', path: '/expenses' },
    { key: 'kpi', path: '/kpi' },
    { key: 'alerts', path: '/alerts' },
    { key: 'inventory', path: '/inventory' },
  ];

  const results = await Promise.allSettled(
    endpoints.map((ep) => fetchJson(ep.path))
  );

  const data = {};
  const errors = [];

  for (let i = 0; i < endpoints.length; i++) {
    const { key } = endpoints[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      data[key] = result.value;
    } else {
      errors.push(`${key}: ${result.reason.message}`);
      data[key] = null;
    }
  }

  return { data, errors };
}

/**
 * Фильтрует массив записей по дате.
 * Ожидает поле date (ISO строка или YYYY-MM-DD) в каждой записи.
 */
function filterByWeek(records, start, end, dateField = 'date') {
  if (!Array.isArray(records)) return [];
  return records.filter((r) => {
    const d = new Date(r[dateField]);
    return d >= start && d <= end;
  });
}

/** Агрегирует урожай по продуктам, возвращает Map<product, {current, previous}> */
function aggregateProduction(data, weekStart, weekEnd) {
  const currentWeek = filterByWeek(data, weekStart, weekEnd);

  // Предыдущая неделя — 7 дней назад
  const prevStart = new Date(weekStart);
  prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd = new Date(weekEnd);
  prevEnd.setDate(prevEnd.getDate() - 7);
  const prevWeek = filterByWeek(data, prevStart, prevEnd);

  const aggregate = (records) => {
    const map = new Map();
    for (const r of records) {
      const product = r.product || r.name || 'Без названия';
      const kg = parseFloat(r.quantity_kg || r.kg || r.quantity || 0);
      map.set(product, (map.get(product) || 0) + kg);
    }
    return map;
  };

  const current = aggregate(currentWeek);
  const previous = aggregate(prevWeek);
  const totalCurrent = [...current.values()].reduce((a, b) => a + b, 0);
  const totalPrev = [...previous.values()].reduce((a, b) => a + b, 0);

  return { byProduct: current, previousByProduct: previous, totalCurrent, totalPrev };
}

/** Агрегирует продажи — выручка и топ клиенты */
function aggregateSales(data, weekStart, weekEnd) {
  const records = filterByWeek(data, weekStart, weekEnd);
  let totalRevenue = 0;
  const clientMap = new Map();

  for (const r of records) {
    const amount = parseFloat(r.total || r.amount || r.revenue || 0);
    totalRevenue += amount;
    const client = r.client || r.customer || r.buyer || 'Неизвестный';
    clientMap.set(client, (clientMap.get(client) || 0) + amount);
  }

  // Топ-3 клиента по выручке
  const topClients = [...clientMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Выручка за предыдущую неделю
  const prevStart = new Date(weekStart);
  prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd = new Date(weekEnd);
  prevEnd.setDate(prevEnd.getDate() - 7);
  const prevRecords = filterByWeek(data, prevStart, prevEnd);
  const prevRevenue = prevRecords.reduce(
    (sum, r) => sum + parseFloat(r.total || r.amount || r.revenue || 0),
    0
  );

  return { totalRevenue, prevRevenue, topClients };
}

/** Агрегирует расходы */
function aggregateExpenses(data, weekStart, weekEnd) {
  const records = filterByWeek(data, weekStart, weekEnd);
  const total = records.reduce(
    (sum, r) => sum + parseFloat(r.amount || r.total || r.cost || 0),
    0
  );

  const prevStart = new Date(weekStart);
  prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd = new Date(weekEnd);
  prevEnd.setDate(prevEnd.getDate() - 7);
  const prevRecords = filterByWeek(data, prevStart, prevEnd);
  const prevTotal = prevRecords.reduce(
    (sum, r) => sum + parseFloat(r.amount || r.total || r.cost || 0),
    0
  );

  return { total, prevTotal };
}

/** Считает открытые алерты */
function countAlerts(data) {
  if (!Array.isArray(data)) return { open: 0, details: [] };
  const open = data.filter(
    (a) =>
      (a.status || '').toLowerCase() === 'открыт' ||
      (a.status || '').toLowerCase() === 'open'
  );
  return {
    open: open.length,
    details: open.slice(0, 5).map((a) => a.title || a.message || a.description || 'Без описания'),
  };
}

/** Извлекает ключевые KPI-метрики */
function extractKpi(data) {
  if (!data) return [];
  // KPI может быть массивом или объектом — обрабатываем оба варианта
  if (Array.isArray(data)) {
    return data.slice(0, 6).map((item) => ({
      name: item.name || item.metric || item.label || '—',
      value: item.value ?? item.current ?? '—',
      target: item.target ?? item.goal ?? '—',
      unit: item.unit || '',
    }));
  }
  // Объект: преобразуем ключи в массив
  return Object.entries(data).slice(0, 6).map(([key, val]) => ({
    name: key,
    value: typeof val === 'object' ? (val.value ?? val.current ?? '—') : val,
    target: typeof val === 'object' ? (val.target ?? '—') : '—',
    unit: typeof val === 'object' ? (val.unit || '') : '',
  }));
}

/** Извлекает данные склада */
function extractInventory(data) {
  if (!Array.isArray(data)) return [];
  return data.slice(0, 5).map((item) => ({
    name: item.product || item.name || item.item || '—',
    quantity: parseFloat(item.quantity || item.stock || item.amount || 0),
    unit: item.unit || 'кг',
  }));
}

// --- Форматирование отчётов ---

/** Формирует полный отчёт (для топика Стратегия/Директор) */
function formatFullReport({ week, production, sales, expenses, alerts, kpi, inventory, errors }) {
  const { start, end } = week;
  const lines = [];

  lines.push(`📊 <b>ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ | ${fmtDateShort(start)} — ${fmtDate(end)}</b>`);
  lines.push('');

  // Производство
  lines.push('🌱 <b>ПРОИЗВОДСТВО</b>');
  if (production) {
    for (const [product, kg] of production.byProduct) {
      const prevKg = production.previousByProduct.get(product) || 0;
      const change = pctChange(kg, prevKg);
      lines.push(`  ${product}: ${fmtNum(kg)} кг (${change} к пред. неделе)`);
    }
    lines.push(`  <b>Итого: ${fmtNum(production.totalCurrent)} кг</b> (${pctChange(production.totalCurrent, production.totalPrev)})`);
  } else {
    lines.push('  ⚠️ Данные недоступны');
  }
  lines.push('');

  // Финансы
  lines.push('💰 <b>ФИНАНСЫ</b>');
  if (sales && expenses) {
    const revenue = sales.totalRevenue;
    const cost = expenses.total;
    const ebitda = revenue - cost;
    const margin = revenue > 0 ? ((ebitda / revenue) * 100).toFixed(1) : '0.0';

    lines.push(`  Выручка: ${fmtNum(revenue)} ARS (${pctChange(revenue, sales.prevRevenue)})`);
    lines.push(`  Расходы: ${fmtNum(cost)} ARS (${pctChange(cost, expenses.prevTotal)})`);
    lines.push(`  EBITDA: ${fmtNum(ebitda)} ARS`);
    lines.push(`  Маржа: ${margin}%`);
  } else {
    if (!sales) lines.push('  ⚠️ Продажи: данные недоступны');
    if (!expenses) lines.push('  ⚠️ Расходы: данные недоступны');
  }
  lines.push('');

  // Топ клиенты
  lines.push('🏆 <b>ТОП КЛИЕНТЫ</b>');
  if (sales && sales.topClients.length > 0) {
    sales.topClients.forEach(([client, amount], i) => {
      lines.push(`  ${i + 1}. ${client} — ${fmtNum(amount)} ARS`);
    });
  } else {
    lines.push('  Нет данных за неделю');
  }
  lines.push('');

  // Алерты
  lines.push(`⚠️ <b>АЛЕРТЫ:</b> ${alerts.open} открытых`);
  if (alerts.details.length > 0) {
    for (const detail of alerts.details) {
      lines.push(`  • ${detail}`);
    }
  }
  lines.push('');

  // KPI
  if (kpi.length > 0) {
    lines.push('📈 <b>KPI</b>');
    for (const m of kpi) {
      const targetStr = m.target !== '—' ? ` (цель: ${m.target}${m.unit})` : '';
      lines.push(`  ${m.name}: ${m.value}${m.unit}${targetStr}`);
    }
    lines.push('');
  }

  // Склад
  if (inventory.length > 0) {
    lines.push('📦 <b>СКЛАД</b>');
    for (const item of inventory) {
      lines.push(`  ${item.name}: ${fmtNum(item.quantity)} ${item.unit}`);
    }
    lines.push('');
  }

  // Ошибки сбора данных
  if (errors.length > 0) {
    lines.push('🔴 <b>ОШИБКИ СБОРА ДАННЫХ</b>');
    for (const err of errors) {
      lines.push(`  • ${err}`);
    }
  }

  return lines.join('\n');
}

/** Формирует краткую сводку (для топика Итоги) */
function formatSummary({ week, production, sales, expenses, alerts }) {
  const { start, end } = week;
  const lines = [];

  lines.push(`📊 <b>СВОДКА НЕДЕЛИ | ${fmtDateShort(start)} — ${fmtDate(end)}</b>`);
  lines.push('');

  if (production) {
    lines.push(`🌱 Урожай: ${fmtNum(production.totalCurrent)} кг (${pctChange(production.totalCurrent, production.totalPrev)})`);
  }

  if (sales && expenses) {
    const revenue = sales.totalRevenue;
    const cost = expenses.total;
    const ebitda = revenue - cost;
    const margin = revenue > 0 ? ((ebitda / revenue) * 100).toFixed(1) : '0.0';

    lines.push(`💰 Выручка: ${fmtNum(revenue)} ARS | Маржа: ${margin}%`);
  }

  if (sales && sales.topClients.length > 0) {
    const [topClient, topAmount] = sales.topClients[0];
    lines.push(`🏆 Топ клиент: ${topClient} — ${fmtNum(topAmount)} ARS`);
  }

  lines.push(`⚠️ Алерты: ${alerts.open} открытых`);

  return lines.join('\n');
}

// --- Главная логика ---

async function main() {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Запуск еженедельного отчёта Pepino Pick`);

  const week = getWeekRange();
  console.log(`Период: ${fmtDateShort(week.start)} — ${fmtDate(week.end)}`);

  // Сбор данных
  const { data, errors } = await collectData();

  if (errors.length > 0) {
    console.warn(`Ошибки при сборе данных: ${errors.join('; ')}`);
  }

  // Агрегация
  const production = data.production
    ? aggregateProduction(data.production, week.start, week.end)
    : null;

  const sales = data.sales
    ? aggregateSales(data.sales, week.start, week.end)
    : null;

  const expenses = data.expenses
    ? aggregateExpenses(data.expenses, week.start, week.end)
    : null;

  const alerts = countAlerts(data.alerts);
  const kpi = extractKpi(data.kpi);
  const inventory = extractInventory(data.inventory);

  const reportData = { week, production, sales, expenses, alerts, kpi, inventory, errors };

  // Форматирование
  const fullReport = formatFullReport(reportData);
  const summary = formatSummary(reportData);

  console.log('--- Полный отчёт ---');
  console.log(fullReport);
  console.log('--- Краткая сводка ---');
  console.log(summary);

  // Отправка в Telegram
  let sentCount = 0;

  try {
    await sendTelegram(fullReport, TG_TOPIC_STRATEGY);
    console.log(`Полный отчёт отправлен в топик #${TG_TOPIC_STRATEGY} (Стратегия/Директор)`);
    sentCount++;
  } catch (err) {
    console.error(`Ошибка отправки в топик #${TG_TOPIC_STRATEGY}: ${err.message}`);
  }

  // Небольшая пауза между сообщениями — Telegram rate limit
  await new Promise((r) => setTimeout(r, 1000));

  try {
    await sendTelegram(summary, TG_TOPIC_RESULTS);
    console.log(`Сводка отправлена в топик #${TG_TOPIC_RESULTS} (Итоги)`);
    sentCount++;
  } catch (err) {
    console.error(`Ошибка отправки в топик #${TG_TOPIC_RESULTS}: ${err.message}`);
  }

  console.log(`[${new Date().toISOString()}] Готово. Отправлено ${sentCount}/2 сообщений.`);

  await trace({
    name: "weekly-report",
    input: { period: `${fmtDateShort(week.start)} - ${fmtDate(week.end)}`, endpoints: 6 },
    output: { sentCount, errors: errors.length },
    duration_ms: Date.now() - startMs,
    metadata: { skill: "pepino-google-sheets", cron: "weekly-report" },
  }).catch(() => {});

  // Код завершения: 0 если оба отправлены, 1 если хотя бы одно не ушло
  if (sentCount < 2) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
