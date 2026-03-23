#!/usr/bin/env node
/**
 * Pepino Pick -- Фото-библиотека теплицы
 *
 * Структура: /home/roman/pepino-photos/
 *   YYYY-MM-DD/
 *     harvest_001.jpg
 *     harvest_001.jpg.json   <- метаданные + выводы
 *
 * Использование:
 *   node pepino-photo-library.js add <path> --type <тип> --zone <зона> --notes "описание" [--date YYYY-MM-DD]
 *   node pepino-photo-library.js list [--type <тип>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   node pepino-photo-library.js analyze <path или meta.json>
 *   node pepino-photo-library.js report [--days 7]
 *   node pepino-photo-library.js sync
 *
 * Типы фото: harvest, disease, growth, equipment, delivery, quality, general
 *
 * ID формат: PHOTO-YYYY-MM-DD-NNN
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, copyFileSync, statSync,
} from "fs";
import { join, basename, extname } from "path";
import http from "http";
import { apiHeaders } from "./api-auth.js";

const PHOTO_DIR = "/home/roman/pepino-photos";
const SHEETS_API = "http://localhost:4000";
const ARGS = process.argv.slice(2);
const CMD = ARGS[0];

const VALID_TYPES = [
  "harvest", "disease", "growth", "equipment",
  "delivery", "quality", "general",
];

const TYPE_LABELS = {
  harvest: "Урожай",
  disease: "Болезнь/вредитель",
  growth: "Рост/развитие",
  equipment: "Оборудование",
  delivery: "Доставка/упаковка",
  quality: "Контроль качества",
  general: "Общее",
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Получить значение аргумента по флагу */
function getArg(flag) {
  const i = ARGS.indexOf(flag);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
}

/** Сегодняшняя дата YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Создать директорию, если не существует */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Загрузить JSON-метаданные из файла */
function loadMeta(metaPath) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/** HTTP POST к Sheets API */
function httpPost(url, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = http.request(url, {
      method: "POST",
      headers: apiHeaders({
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }),
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

/** Собрать все фото из библиотеки с метаданными */
function getAllPhotos() {
  ensureDir(PHOTO_DIR);
  const result = [];

  let days;
  try {
    days = readdirSync(PHOTO_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch {
    return result;
  }

  for (const day of days) {
    const dayDir = join(PHOTO_DIR, day);
    let files;
    try {
      files = readdirSync(dayDir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const mf of files) {
      const meta = loadMeta(join(dayDir, mf));
      if (meta) {
        meta._day = day;
        meta._metaPath = join(dayDir, mf);
        meta._photoPath = join(dayDir, meta.filename);
        result.push(meta);
      }
    }
  }
  return result;
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * add <filepath> --type <type> --zone <zone> --notes "text" [--date YYYY-MM-DD]
 *
 * Копирует фото в YYYY-MM-DD/, создает .json метаданные рядом.
 */
function cmdAdd() {
  const filePath = ARGS[1];
  if (!filePath || !existsSync(filePath)) {
    console.error("Ошибка: укажите путь к существующему файлу.");
    console.error("  node pepino-photo-library.js add <path> --type harvest --zone A1 --notes \"описание\"");
    process.exit(1);
  }

  const type = getArg("--type") || "general";
  if (!VALID_TYPES.includes(type)) {
    console.error(`Ошибка: неизвестный тип '${type}'. Допустимые: ${VALID_TYPES.join(", ")}`);
    process.exit(1);
  }

  const zone = getArg("--zone") || "";
  const notes = getArg("--notes") || "";
  const date = getArg("--date") || today();

  // Валидация даты
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`Ошибка: дата должна быть в формате YYYY-MM-DD, получено '${date}'`);
    process.exit(1);
  }

  const dayDir = join(PHOTO_DIR, date);
  ensureDir(dayDir);

  // Генерация последовательного имени файла
  const ext = extname(filePath).toLowerCase() || ".jpg";
  const existing = readdirSync(dayDir).filter((f) =>
    /\.(jpg|jpeg|png|webp|heic)$/i.test(f),
  );
  const num = existing.length + 1;
  const newName = `${type}_${String(num).padStart(3, "0")}${ext}`;
  const destPath = join(dayDir, newName);
  const metaPath = join(dayDir, `${newName}.json`);

  copyFileSync(filePath, destPath);

  const meta = {
    id: `PHOTO-${date}-${String(num).padStart(3, "0")}`,
    date,
    type,
    zone,
    notes,
    filename: newName,
    original: basename(filePath),
    added_at: new Date().toISOString(),
    analysis: null,
    conclusions: [],
    actions: [],
    tags: [],
  };

  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`Фото добавлено: ${destPath}`);
  console.log(`Метаданные:     ${metaPath}`);
  console.log(`ID:             ${meta.id}`);
  console.log(`Тип:            ${type} (${TYPE_LABELS[type] || type})`);
  if (zone) console.log(`Зона:           ${zone}`);
  if (notes) console.log(`Заметки:        ${notes}`);

  return meta;
}

/**
 * list [--type <type>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Список всех фото с фильтрацией, статус анализа, количество выводов.
 */
function cmdList() {
  const filterType = getArg("--type");
  const fromDate = getArg("--from") || "2000-01-01";
  const toDate = getArg("--to") || "2099-12-31";

  if (filterType && !VALID_TYPES.includes(filterType)) {
    console.error(`Ошибка: неизвестный тип '${filterType}'. Допустимые: ${VALID_TYPES.join(", ")}`);
    process.exit(1);
  }

  const photos = getAllPhotos()
    .filter((p) => p.date >= fromDate && p.date <= toDate)
    .filter((p) => !filterType || p.type === filterType);

  if (photos.length === 0) {
    console.log("Фото не найдено.");
    return;
  }

  let currentDay = "";
  for (const p of photos) {
    if (p.date !== currentDay) {
      currentDay = p.date;
      console.log(`\n  ${currentDay}`);
      console.log("  " + "-".repeat(50));
    }

    const status = p.analysis ? "[analyzed]" : "[pending] ";
    const conclusions = p.conclusions.length > 0
      ? ` (${p.conclusions.length} выводов)`
      : "";
    const zone = p.zone ? ` | zone: ${p.zone}` : "";
    console.log(
      `    ${status} ${p.id}  ${p.type.padEnd(10)}${zone}${conclusions}`,
    );
    if (p.notes) {
      console.log(`               ${p.notes}`);
    }
  }

  // Итоги
  const analyzed = photos.filter((p) => p.analysis).length;
  const pending = photos.length - analyzed;
  console.log(`\n  Итого: ${photos.length} фото | analyzed: ${analyzed} | pending: ${pending}`);
}

/**
 * analyze <filepath или meta.json>
 *
 * Выводит инструкции для AI-анализа фото: куда отправить, как обновить метаданные.
 */
function cmdAnalyze() {
  const target = ARGS[1];
  if (!target) {
    console.error("Ошибка: укажите путь к фото или .json метаданным.");
    console.error("  node pepino-photo-library.js analyze <path>");
    process.exit(1);
  }

  // Определить путь к метаданным
  let metaPath;
  if (target.endsWith(".json")) {
    metaPath = target;
  } else {
    metaPath = `${target}.json`;
  }

  if (!existsSync(metaPath)) {
    console.error(`Ошибка: метаданные не найдены: ${metaPath}`);
    process.exit(1);
  }

  const meta = loadMeta(metaPath);
  if (!meta) {
    console.error(`Ошибка: не удалось прочитать метаданные: ${metaPath}`);
    process.exit(1);
  }

  const photoPath = join(PHOTO_DIR, meta.date, meta.filename);

  // Промпты для анализа по типу
  const prompts = {
    harvest: "Оцени качество урожая: размер, цвет, однородность, товарный вид, дефекты, примерный вес.",
    disease: "Определи заболевание: симптомы, возбудитель, стадия, масштаб поражения, рекомендации по лечению.",
    growth: "Оцени стадию роста: возраст, здоровье, тургор, цвет листьев, завязи, проблемы.",
    equipment: "Оцени состояние оборудования: износ, повреждения, необходимость ремонта/замены.",
    delivery: "Оцени упаковку и доставку: качество упаковки, объем, целостность.",
    quality: "Контроль качества: размер, цвет, форма, дефекты, товарный/нетоварный.",
    general: "Опиши что видишь на фото, сделай выводы.",
  };

  const prompt = prompts[meta.type] || prompts.general;

  console.log(`Анализ фото: ${meta.id}`);
  console.log(`Файл:        ${photoPath}`);
  console.log(`Тип:         ${meta.type} (${TYPE_LABELS[meta.type] || meta.type})`);
  console.log(`Зона:        ${meta.zone || "не указана"}`);
  console.log("");
  console.log("Для AI-анализа:");
  console.log("");
  console.log("  1. Telegram: отправь фото в топик #14 (Агрономия) с текстом:");
  console.log(`     "${prompt}"`);
  console.log("");
  console.log("  2. CLI:");
  console.log(`     openclaw agent --message "Проанализируй фото ${photoPath}. ${prompt}"`);
  console.log("");
  console.log("После анализа обнови метаданные:");
  console.log(`  Файл: ${metaPath}`);
  console.log("  Заполни поля: analysis, conclusions, actions, tags");
  console.log("");
  console.log("  Пример:");
  console.log("  {");
  console.log('    "analysis": "Огурцы товарного вида, длина 18-22 см",');
  console.log('    "conclusions": ["Высокое качество", "Готовы к продаже"],');
  console.log('    "actions": [{"text": "Отгрузить клиенту X", "done": false}],');
  console.log('    "tags": ["огурец", "теплица1", "товарный"]');
  console.log("  }");
}

/**
 * report [--days 7]
 *
 * Сводка: всего фото, проанализировано, по типу, по зоне, ключевые выводы, открытые действия.
 */
function cmdReport() {
  const daysBack = parseInt(getArg("--days") || "7");
  const cutoff = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

  const photos = getAllPhotos().filter((p) => p.date >= cutoff);

  if (photos.length === 0) {
    console.log(`Нет фото за последние ${daysBack} дней.`);
    return;
  }

  const analyzed = photos.filter((p) => p.analysis).length;
  const byType = {};
  const byZone = {};
  const conclusions = [];
  const openActions = [];

  for (const p of photos) {
    byType[p.type] = (byType[p.type] || 0) + 1;
    if (p.zone) byZone[p.zone] = (byZone[p.zone] || 0) + 1;

    if (p.conclusions && p.conclusions.length > 0) {
      for (const c of p.conclusions) {
        conclusions.push({ date: p.date, type: p.type, text: c });
      }
    }

    if (p.actions && p.actions.length > 0) {
      for (const a of p.actions) {
        const action = typeof a === "string" ? { text: a, done: false } : a;
        if (!action.done) {
          openActions.push({ date: p.date, type: p.type, text: action.text });
        }
      }
    }
  }

  console.log(`ОТЧЕТ ФОТО-БИБЛИОТЕКИ (${daysBack} дней: ${cutoff} -> ${today()})`);
  console.log("=".repeat(55));

  console.log(`Всего:            ${photos.length}`);
  console.log(
    `Проанализировано: ${analyzed} (${photos.length > 0 ? Math.round((analyzed / photos.length) * 100) : 0}%)`,
  );
  console.log("");

  // По типу
  console.log("По типу:");
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(12)} ${c}`);
  }

  // По зоне
  if (Object.keys(byZone).length > 0) {
    console.log("\nПо зонам:");
    for (const [z, c] of Object.entries(byZone).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${z}: ${c}`);
    }
  }

  // Ключевые выводы
  if (conclusions.length > 0) {
    console.log("\nКлючевые выводы:");
    const show = conclusions.slice(-10);
    for (const c of show) {
      console.log(`  ${c.date} [${c.type}] ${c.text}`);
    }
    if (conclusions.length > 10) {
      console.log(`  ... и еще ${conclusions.length - 10}`);
    }
  }

  // Открытые действия
  if (openActions.length > 0) {
    console.log("\nОткрытые действия:");
    for (const a of openActions) {
      console.log(`  [ ] ${a.date} [${a.type}] ${a.text}`);
    }
  }

  // Неанализированные фото
  const unanalyzed = photos.filter((p) => !p.analysis);
  if (unanalyzed.length > 0) {
    console.log(`\nОжидают анализа: ${unanalyzed.length} фото`);
    for (const u of unanalyzed.slice(0, 5)) {
      console.log(`  - ${u.id} (${u.type}, ${u.date})`);
    }
    if (unanalyzed.length > 5) {
      console.log(`  ... и еще ${unanalyzed.length - 5}`);
    }
  }
}

/**
 * sync
 *
 * Для disease-фото с analysis: POST в /log/alert, помечает synced в метаданных.
 */
async function cmdSync() {
  const photos = getAllPhotos();
  let synced = 0;
  let skipped = 0;

  for (const p of photos) {
    // Только disease-тип с анализом, еще не синхронизированные
    if (p.type !== "disease") {
      continue;
    }
    if (!p.analysis) {
      skipped++;
      continue;
    }
    if (p.synced) {
      continue;
    }

    const result = await httpPost(`${SHEETS_API}/log/alert`, {
      type: `photo-${p.type}`,
      zone: p.zone || "Теплица",
      description: `${p.id}: ${p.conclusions.join("; ") || p.notes || "требует внимания"}`,
    });

    if (result && result.status >= 200 && result.status < 300) {
      // Обновить метаданные: пометить synced
      p.synced = true;
      // Убрать временные поля перед сохранением
      const toSave = { ...p };
      delete toSave._day;
      delete toSave._metaPath;
      delete toSave._photoPath;
      writeFileSync(p._metaPath, JSON.stringify(toSave, null, 2));
      synced++;
      console.log(`  [synced] ${p.id} -> /log/alert`);
    } else {
      console.log(`  [error]  ${p.id} -- HTTP ${result ? result.status : "no response"}`);
    }
  }

  console.log(
    `\nСинхронизация завершена: ${synced} отправлено, ${skipped} пропущено (нет анализа)`,
  );
}

// ── help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`Pepino Pick -- Фото-библиотека теплицы

Команды:
  add <path> --type <тип> --zone <зона> --notes "описание" [--date YYYY-MM-DD]
      Добавить фото в библиотеку. Копирует файл, создает метаданные.

  list [--type <тип>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
      Список фото с фильтрацией. Показывает статус анализа.

  analyze <path или meta.json>
      Инструкции для AI-анализа: куда отправить, как обновить.

  report [--days 7]
      Сводка: всего, проанализировано, по типам, по зонам, выводы, действия.

  sync
      Синхронизация disease-фото с анализом в Sheets API (/log/alert).

Типы фото:
  harvest    -- урожай
  disease    -- болезнь/вредитель
  growth     -- рост/развитие
  equipment  -- оборудование
  delivery   -- доставка/упаковка
  quality    -- контроль качества
  general    -- общее фото

Директория: ${PHOTO_DIR}/YYYY-MM-DD/
ID формат:  PHOTO-YYYY-MM-DD-NNN`);
}

// ── main ─────────────────────────────────────────────────────────────────────

// Создать директорию фото-библиотеки при первом запуске
ensureDir(PHOTO_DIR);

switch (CMD) {
  case "add":
    cmdAdd();
    break;
  case "list":
    cmdList();
    break;
  case "analyze":
    cmdAnalyze();
    break;
  case "report":
    cmdReport();
    break;
  case "sync":
    await cmdSync();
    break;
  default:
    printHelp();
    break;
}
