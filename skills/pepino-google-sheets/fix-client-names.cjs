/**
 * fix-client-names.cjs
 *
 * Исправляет дублирующиеся/ошибочные имена клиентов в Google Sheets.
 * Замены:
 *   "У Белоруса"  -> "У Беларуса"
 *   "Чайхона"     -> "Чайхана"
 *   "Гастраном1"  -> "Гастроном 1"
 *
 * Идемпотентный: безопасно запускать повторно.
 * Использует findReplace через batchUpdate API.
 *
 * Запуск: node fix-client-names.cjs
 */

const { readFileSync } = require("fs");
const { google } = require("googleapis");

const SPREADSHEET_ID = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || "/home/roman/openclaw/google-credentials.json";

/** @type {Array<{wrong: string, correct: string}>} */
const REPLACEMENTS = [
  { wrong: "У Белоруса", correct: "У Беларуса" },
  { wrong: "Чайхона", correct: "Чайхана" },
  { wrong: "Гастраном1", correct: "Гастроном 1" },
];

async function getAuth() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

/**
 * Получает список всех листов с их sheetId
 * @returns {Promise<Array<{title: string, sheetId: number}>>}
 */
async function getSheets(sheets) {
  const resp = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties(sheetId,title)",
  });
  return resp.data.sheets.map((s) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

/**
 * Ищет вхождения строки в конкретном листе (без замены).
 * Возвращает количество найденных ячеек.
 */
async function countOccurrences(sheets, sheetId, searchText) {
  // Используем findReplace с dryRun-подходом:
  // Делаем поиск+замену на ту же строку -- Google вернёт occurrencesChanged = 0,
  // но valuesChanged покажет количество ячеек.
  // Лучше: просто читаем данные и считаем вручную.
  // Но для эффективности используем findReplace API напрямую.

  // findReplace не имеет dry-run, поэтому считаем при чтении данных
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetId}'`,
  });
  const rows = resp.data.values || [];
  let count = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (cell && cell.toString().includes(searchText)) {
        count++;
      }
    }
  }
  return count;
}

async function main() {
  const auth = await getAuth();
  const sheetsApi = google.sheets({ version: "v4", auth });

  // Получаем все листы
  const allSheets = await getSheets(sheetsApi);
  console.log(`Найдено ${allSheets.length} листов в таблице.\n`);

  // Фаза 1: Подсчёт вхождений по каждому листу
  console.log("=== ФАЗА 1: ПОИСК ОШИБОЧНЫХ ИМЁН ===\n");

  /** @type {Record<string, Record<string, number>>} */
  const report = {};
  let totalFound = 0;

  for (const sheet of allSheets) {
    for (const { wrong } of REPLACEMENTS) {
      try {
        const resp = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${sheet.title}'`,
        });
        const rows = resp.data.values || [];
        let count = 0;
        for (const row of rows) {
          for (const cell of row) {
            if (cell && cell.toString().includes(wrong)) {
              count++;
            }
          }
        }
        if (count > 0) {
          if (!report[sheet.title]) report[sheet.title] = {};
          report[sheet.title][wrong] = count;
          totalFound += count;
          console.log(`  [${sheet.title}] "${wrong}" -- ${count} ячеек`);
        }
      } catch (err) {
        // Некоторые листы могут быть пустыми
        if (err.code !== 400) {
          console.error(`  Ошибка чтения листа "${sheet.title}": ${err.message}`);
        }
      }
    }
  }

  if (totalFound === 0) {
    console.log("\nОшибочных имён не найдено. Таблица уже исправлена.");
    return;
  }

  console.log(`\nВсего найдено ячеек с ошибками: ${totalFound}\n`);

  // Фаза 2: Замена через batchUpdate findReplace
  console.log("=== ФАЗА 2: ЗАМЕНА ===\n");

  const requests = [];
  for (const { wrong, correct } of REPLACEMENTS) {
    // Глобальная замена по всей таблице (allSheets = true)
    requests.push({
      findReplace: {
        find: wrong,
        replacement: correct,
        allSheets: true,
        matchCase: true,
        matchEntireCell: false,
      },
    });
  }

  const batchResp = await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { requests },
  });

  // Отчёт по заменам
  const replies = batchResp.data.replies || [];
  let totalChanged = 0;

  for (let i = 0; i < REPLACEMENTS.length; i++) {
    const { wrong, correct } = REPLACEMENTS[i];
    const fr = replies[i]?.findReplace;
    const changed = fr?.valuesChanged || 0;
    const occurrences = fr?.occurrencesChanged || 0;
    totalChanged += changed;
    console.log(`  "${wrong}" -> "${correct}": ${changed} ячеек (${occurrences} вхождений)`);
  }

  // Итоговый отчёт
  console.log(`\n=== ИТОГ ===`);
  console.log(`Всего изменено ячеек: ${totalChanged}`);
  console.log(`\nОтчёт по листам:`);
  for (const [sheetTitle, corrections] of Object.entries(report)) {
    const items = Object.entries(corrections)
      .map(([wrong, count]) => `"${wrong}" x${count}`)
      .join(", ");
    console.log(`  ${sheetTitle}: ${items}`);
  }
  console.log("\nГотово. Скрипт идемпотентен -- повторный запуск не изменит данные.");
}

main().catch((err) => {
  console.error("ОШИБКА:", err.message);
  process.exit(1);
});
