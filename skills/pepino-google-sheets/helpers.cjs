/**
 * helpers.cjs — Общие утилиты для скриптов Pepino Pick
 *
 * Консолидация дублирующихся функций из 10+ скриптов:
 * parseNum, parseDate, fmtDate, fmtNum, rowsToObjects, daysBetween
 *
 * Usage:
 *   const { parseNum, parseDate, fmtDate, fmtNum, rowsToObjects, daysBetween } = require("./helpers.cjs");
 */

"use strict";

/**
 * Парсит число из строки. Поддерживает аргентинский формат:
 *   - точки как разделитель тысяч (1.500.000 -> 1500000)
 *   - запятая как десятичный разделитель (1.500,50 -> 1500.50)
 *   - удаляет знак %, пробелы, символы валюты
 *
 * @param {unknown} val — значение для парсинга
 * @returns {number} — число или 0 при ошибке
 */
function parseNum(val) {
  if (typeof val === "number") return val;
  if (val === undefined || val === null || val === "") return 0;
  const s = String(val)
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("%", "")
    .replace(/[^\d.\-]/g, "");
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num;
}

/**
 * Парсит дату из строки. Поддерживает форматы:
 *   - DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
 *   - YYYY-MM-DD (ISO prefix)
 *   - Произвольные строки через new Date()
 *
 * @param {unknown} val — значение для парсинга
 * @returns {Date|null} — дата или null при ошибке
 */
function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

  const s = String(val).trim();

  // DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  // YYYY-MM-DD (с возможным временем после)
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback: нативный парсер Date
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Форматирует дату как YYYY-MM-DD.
 *
 * @param {Date} d — дата
 * @returns {string} — строка в формате YYYY-MM-DD
 */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Форматирует число с разделителем тысяч (пробел).
 * Примеры: 1500000 -> "1 500 000", 1234.5 -> "1 234.5"
 *
 * @param {number} n — число
 * @returns {string} — отформатированная строка
 */
function fmtNum(n) {
  if (typeof n !== "number" || isNaN(n)) return "0";
  const [intPart, decPart] = String(n).split(".");
  // Добавляем пробелы между группами по 3 цифры
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return decPart !== undefined ? `${formatted}.${decPart}` : formatted;
}

/**
 * Преобразует массив строк из Google Sheets в массив объектов.
 * Первая строка — заголовки, остальные — данные.
 *
 * @param {string[][]} rows — массив строк [[headers], [row1], [row2], ...]
 * @returns {Record<string, string>[]} — массив объектов {header: value}
 */
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((key, i) => {
      obj[key] = row[i] ?? "";
    });
    return obj;
  });
}

/**
 * Количество дней между двумя датами (абсолютное значение).
 *
 * @param {Date} d1 — первая дата
 * @param {Date} d2 — вторая дата
 * @returns {number} — количество дней (всегда >= 0)
 */
function daysBetween(d1, d2) {
  return Math.abs(Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)));
}

module.exports = { parseNum, parseDate, fmtDate, fmtNum, rowsToObjects, daysBetween };
