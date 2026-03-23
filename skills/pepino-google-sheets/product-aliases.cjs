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
  // === СВЕЖИЕ ОВОЩИ ===
  Огурец: [
    "Свежий огурец",
    "огурец",
    "Свежие огурцы",
    "pepino",
    "Pepino",
    "pepino fresco",
    "Pepino fresco",
    "огурцы",
  ],
  Томат: [
    "Свежий томат",
    "Томаты",
    "томат",
    "Помидор",
    "помидоры",
    "помидор",
    "tomate",
    "Tomate",
    "Томаты бифы",
    "Томаты черри",
    "Бычье сердце",
    "томаты коллекционные",
  ],
  Корнишон: ["Корнишен", "корнишон", "Корнишоны", "корнишоны"],
  Укроп: ["укроп", "Eneldo", "eneldo", "eneldo fresco"],
  Щавель: ["щавель", "Acedera", "acedera"],
  Баклажан: ["Свежий баклажан", "Баклажаны", "баклажан", "баклажаны", "berenjena"],
  "Острый перец": ["Перец острый", "острый перец", "Перец чили", "chile", "ají", "aji picante"],
  "Сладкий перец": ["Перец сладкий", "перец сладкий", "morrón", "pimiento"],
  Кабачок: ["Кабачки", "Кабачек", "кабачок", "кабачки", "zapallito"],
  Свекла: ["Свежая свекла", "свекла", "Свекла цилиндра", "remolacha"],
  Картофель: ["Папитас андинас", "картошка", "papa", "patata"],
  "Зеленый лук": ["Лук зеленый", "лук на перо", "зеленый лук", "cebolla de verdeo"],
  Чеснок: ["чеснок", "ajo"],

  // === ЗЕЛЕНЬ И ТРАВЫ ===
  Тархун: ["тархун", "эстрагон", "estragón"],
  Базилик: ["Базелик", "базилик", "базелик", "albahaca"],
  Зелень: ["зелень", "Свежая зелень"],
  Мята: ["мята", "menta"],
  Кинза: ["кинза", "Кориандр", "cilantro", "кориандр"],
  Хрен: ["хрен", "Листья хрена"],

  // === ФЕРМЕНТИРОВАННЫЕ ПРОДУКТЫ ===
  "Соленые огурцы": [
    "соленые огурцы",
    "Соленый огурец",
    "pepinos en salmuera",
    "pepinos salados",
    "огурцы соленые",
    "Огурцы соленые",
  ],
  "Квашеная капуста": ["квашеная капуста", "капуста квашеная", "chucrut", "Chucrut", "sauerkraut"],
  Пелюстка: [
    "пелюстка",
    "капуста пелюстка",
    "Капуста пелюстка",
    "pelyustka",
    "Pelyustka",
    "repollo pelyustka",
  ],
  "Квашеные томаты": [
    "квашеные томаты",
    "квашеный томат",
    "tomates fermentados",
    "Tomates fermentados",
  ],
  "Острый соус": ["острый соус", "соус острый", "salsa picante", "Salsa picante", "hot sauce"],

  // === ТЕСТОВЫЕ ПРОДУКТЫ ===
  Вешенка: [
    "вешенка",
    "грибы",
    "Грибы",
    "hongos",
    "Hongos",
    "hongos ostra",
    "oyster mushroom",
    "грибы вешенка",
  ],
  Микрозелень: ["микрозелень", "microverdes", "Microverdes", "microgreens"],
  "Съедобные цветы": [
    "съедобные цветы",
    "цветы съедобные",
    "flores comestibles",
    "Flores comestibles",
    "edible flowers",
  ],

  // === ПРОИЗВОДСТВЕННЫЕ МАТЕРИАЛЫ ===
  Субстрат: ["субстрат", "sustrato", "sustrato hongos"],
  Мицелий: ["мицелий", "micelio"],
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
