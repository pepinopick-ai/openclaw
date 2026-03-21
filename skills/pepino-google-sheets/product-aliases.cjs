/**
 * product-aliases.cjs — Canonical product name mapping
 *
 * Normalizes product names across all Sheets (Sales, Production, Inventory)
 * to a single canonical form for accurate analytics.
 *
 * Usage:
 *   const { normalize, ALIASES } = require("./product-aliases.cjs");
 *   normalize("Свежий огурец") // → "Огурец"
 *   normalize("укроп")         // → "Укроп"
 */

"use strict";

// Canonical name → array of aliases (case-insensitive matching)
const ALIASES = {
  Огурец: ["Свежий огурец", "огурец", "Свежие огурцы"],
  Томат: ["Свежий томат", "Томаты", "томат", "Помидор", "помидоры"],
  Корнишон: ["Корнишен", "корнишон", "Корнишоны"],
  Укроп: ["укроп"],
  Тархун: ["тархун"],
  Базилик: ["Базелик", "базилик", "базелик"],
  Баклажан: ["Свежий баклажан", "Баклажаны", "баклажан", "баклажаны"],
  "Острый перец": ["Перец острый", "острый перец", "Перец чили"],
  Щавель: ["щавель"],
  Кабачок: ["Кабачки", "Кабачек", "кабачок", "кабачки"],
  Свекла: ["Свежая свекла", "свекла"],
  Хрен: ["хрен", "Листья хрена"],
  "Соленые огурцы": ["соленые огурцы", "Соленый огурец"],
  Зелень: ["зелень", "Свежая зелень"],
  Мята: ["мята"],
  Кинза: ["кинза", "Кориандр"],
};

// Build reverse lookup (lowercase alias → canonical)
const _lookup = new Map();
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  _lookup.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) {
    _lookup.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalize a product name to its canonical form.
 * Returns the original name (trimmed, capitalized) if no alias found.
 * @param {string} name
 * @returns {string}
 */
function normalize(name) {
  if (!name) return "";
  const trimmed = name.trim();
  const canonical = _lookup.get(trimmed.toLowerCase());
  if (canonical) return canonical;
  // Capitalize first letter as fallback
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

module.exports = { normalize, ALIASES };
