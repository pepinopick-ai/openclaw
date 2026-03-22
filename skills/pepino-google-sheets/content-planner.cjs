#!/usr/bin/env node
/**
 * content-planner.cjs — AI-powered Social Media Content Planner для Pepino Pick
 *
 * Генерирует контент-план для Instagram на основе продуктового портфолио,
 * данных продаж (best-sellers приоритизируются) и календаря рубрик.
 *
 * CLI:
 *   node content-planner.cjs week                          # План на неделю
 *   node content-planner.cjs post                          # 1 пост (текст + идея)
 *   node content-planner.cjs post --product "соленые огурцы"  # Пост для конкретного продукта
 *   node content-planner.cjs post --type recipe             # Пост определённой рубрики
 *   node content-planner.cjs month                         # Месячный календарь
 *   node content-planner.cjs ideas                         # 10 идей для контента
 *   node content-planner.cjs hashtags                      # Релевантные хештеги
 *   node content-planner.cjs --dry-run week                # Без отправки в Sheets/Telegram
 *
 * Cron: 0 18 * * 0 (воскресенье 18:00 — генерация плана на следующую неделю)
 *
 * Интеграции:
 *   - farm-state.cjs: данные продаж для приоритизации продуктов
 *   - notification-throttle.cjs: отправка в Telegram (тред #16, маркетинг)
 *   - langfuse-trace.cjs: observability
 *   - sheets.js: сохранение в лист "Contenido"
 */

"use strict";

const { getState } = require("./farm-state.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Константы ----------------------------------------------------------------

/** ID топика маркетинга в Telegram */
const TG_TOPIC_MARKETING = 16;

/** Имя листа в Google Sheets для контент-плана */
const CONTENT_SHEET_NAME = "\u{1F4F1} Contenido";

// -- Продуктовый каталог ------------------------------------------------------

const PRODUCTS = {
  pepino_fresco: {
    name_es: "Pepino fresco",
    name_ru: "\u0421\u0432\u0435\u0436\u0438\u0439 \u043E\u0433\u0443\u0440\u0435\u0446",
    season: "todo el a\u00F1o",
    category: "fresh",
    usp: "De invernadero a tu mesa en 24 horas",
    hashtags: ["#pepinofrescos", "#ensalada", "#huerta"],
    recipe_ideas: ["Gazpacho", "Ensalada griega", "Pepino con hummus", "Agua de pepino"],
    photo_ideas: ["Pepino con gotas de agua", "Corte transversal macro", "En la planta con flor"],
    health: "Hidrataci\u00F3n, vitamina K, antioxidantes",
  },
  tomates_coleccion: {
    name_es: "Tomates de colecci\u00F3n",
    name_ru:
      "\u041A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u043E\u043D\u043D\u044B\u0435 \u0442\u043E\u043C\u0430\u0442\u044B",
    season: "primavera-verano",
    category: "fresh",
    usp: "Variedades raras que no encontr\u00E1s en el super",
    hashtags: ["#tomateheritage", "#tomatecherry", "#huertaorganica"],
    recipe_ideas: ["Bruschetta multicolor", "Ensalada caprese", "Salsa casera", "Tomate relleno"],
    photo_ideas: ["Arco\u00EDris de variedades", "En la rama", "Corte con sal y albahaca"],
    health: "Licopeno, vitamina C, antioxidantes",
  },
  pepinos_salados: {
    name_es: "Pepinos en salmuera",
    name_ru: "\u0421\u043E\u043B\u0435\u043D\u044B\u0435 \u043E\u0433\u0443\u0440\u0446\u044B",
    season: "todo el a\u00F1o",
    category: "fermented",
    usp: "Receta tradicional rusa \u2014 fermentaci\u00F3n natural sin vinagre",
    hashtags: ["#fermentados", "#pepinossalados", "#probioticos"],
    recipe_ideas: ["Tabla de encurtidos", "S\u00E1ndwich con pepinos", "Ensalada rusa", "Okroshka"],
    photo_ideas: [
      "Frasco abierto con eneldo visible",
      "Proceso de fermentaci\u00F3n d\u00EDa a d\u00EDa",
      "Con pan negro",
    ],
    health: "Probi\u00F3ticos naturales, digesti\u00F3n, vitamina B",
  },
  chucrut: {
    name_es: "Chucrut casero",
    name_ru:
      "\u041A\u0432\u0430\u0448\u0435\u043D\u0430\u044F \u043A\u0430\u043F\u0443\u0441\u0442\u0430",
    season: "oto\u00F1o-invierno",
    category: "fermented",
    usp: "Receta de abuela ucraniana \u2014 fermentaci\u00F3n lenta 21 d\u00EDas",
    hashtags: ["#chucrut", "#fermentacion", "#comidasaludable"],
    recipe_ideas: ["Hot dog gourmet", "Ensalada de chucrut", "Acompa\u00F1amiento para carnes"],
    photo_ideas: [
      "En proceso de fermentaci\u00F3n",
      "Servido en plato r\u00FAstico",
      "Con salchicha artesanal",
    ],
    health: "Probi\u00F3ticos, vitamina C, fibra, inmunidad",
  },
  pelyustka: {
    name_es: "Repollo Pelyustka",
    name_ru:
      "\u041A\u0430\u043F\u0443\u0441\u0442\u0430 \u043F\u0435\u043B\u044E\u0441\u0442\u043A\u0430",
    season: "todo el a\u00F1o",
    category: "fermented",
    usp: "Receta ucraniana exclusiva \u2014 repollo con remolacha, \u00FAnico en Argentina",
    hashtags: ["#pelyustka", "#recetaucraniana", "#encurtidos"],
    recipe_ideas: ["Como guarnici\u00F3n", "En sandwich", "En ensalada"],
    photo_ideas: [
      "Color rosa intenso en frasco",
      "Plato de presentaci\u00F3n",
      "Proceso con remolacha",
    ],
    health: "Probi\u00F3ticos, antioxidantes de remolacha, hierro",
  },
  salsas_picantes: {
    name_es: "Salsas picantes artesanales",
    name_ru:
      "\u041E\u0441\u0442\u0440\u044B\u0435 \u0441\u043E\u0443\u0441\u044B (3 \u0432\u0438\u0434\u0430)",
    season: "todo el a\u00F1o",
    category: "fermented",
    usp: "3 niveles de picante \u2014 desde suave hasta extreme",
    hashtags: ["#salsapicante", "#hotsauce", "#artesanal"],
    recipe_ideas: ["Wings con salsa", "Tacos", "Huevos rancheros", "Pizza picante"],
    photo_ideas: ["3 frascos en degrad\u00E9 de color", "Vertiendo sobre comida", "Chiles frescos"],
    health: "Capsaicina, metabolismo, antioxidantes",
  },
  tomates_fermentados: {
    name_es: "Tomates fermentados",
    name_ru:
      "\u041A\u0432\u0430\u0448\u0435\u043D\u044B\u0435 \u0442\u043E\u043C\u0430\u0442\u044B",
    season: "verano-oto\u00F1o",
    category: "fermented",
    usp: "Fermentaci\u00F3n natural que realza el sabor umami",
    hashtags: ["#tomatesfermentados", "#fermentacion", "#umami"],
    recipe_ideas: ["Con pasta", "En bruschetta", "Salsa fermentada para carnes"],
    photo_ideas: [
      "En frasco con hierbas visibles",
      "Cortado mostrando textura",
      "Al lado de tomates frescos",
    ],
    health: "Probi\u00F3ticos, licopeno potenciado, umami natural",
  },
  flores_comestibles: {
    name_es: "Flores comestibles",
    name_ru:
      "\u0421\u044A\u0435\u0434\u043E\u0431\u043D\u044B\u0435 \u0446\u0432\u0435\u0442\u044B",
    season: "primavera-verano",
    category: "testing",
    usp: "Decoraci\u00F3n gourmet que se come \u2014 para chefs creativos",
    hashtags: ["#florescomestibles", "#gastronomia", "#chefslife"],
    recipe_ideas: ["Ensalada con flores", "Decoraci\u00F3n de postres", "Cocktails florales"],
    photo_ideas: ["Macro de p\u00E9talos", "En plato de chef", "Campo de flores en invernadero"],
    health: "Antioxidantes, vitaminas, decoraci\u00F3n natural",
  },
  microverdes: {
    name_es: "Microverdes",
    name_ru: "\u041C\u0438\u043A\u0440\u043E\u0437\u0435\u043B\u0435\u043D\u044C",
    season: "todo el a\u00F1o",
    category: "testing",
    usp: "Superalimento con 40x m\u00E1s nutrientes que la verdura madura",
    hashtags: ["#microgreens", "#superalimento", "#nutricion"],
    recipe_ideas: ["Topping para todo", "Smoothie verde", "Ensalada power"],
    photo_ideas: ["Bandeja verde vibrante", "Macro de brotes", "En plato gourmet"],
    health: "40x m\u00E1s nutrientes, vitaminas concentradas, clorofila",
  },
  hongos: {
    name_es: "Hongos ostra frescos",
    name_ru: "\u0413\u0440\u0438\u0431\u044B \u0432\u0435\u0448\u0435\u043D\u043A\u0430",
    season: "todo el a\u00F1o",
    category: "testing",
    usp: "Cultivados en sustrato org\u00E1nico \u2014 textura y sabor \u00FAnicos",
    hashtags: ["#hongosostra", "#hongos", "#cultivodehongos"],
    recipe_ideas: ["Risotto de hongos", "Hongos a la plancha", "Ramen con hongos"],
    photo_ideas: ["Racimos en el sustrato", "Cortados para cocina", "Plato terminado"],
    health: "Prote\u00EDna vegetal, vitamina D, bajo en calor\u00EDas",
  },
};

// -- Рубрики и расписание -----------------------------------------------------

/**
 * @typedef {Object} Rubric
 * @property {string} emoji
 * @property {string} name
 * @property {string} description
 * @property {string[]} formats - предпочтительные форматы контента
 * @property {string[]} preferred_categories - категории продуктов для этой рубрики
 */

/** @type {Record<string, Rubric>} */
const RUBRICS = {
  PRODUCTO: {
    emoji: "\u{1F952}",
    name: "PRODUCTO",
    description: "Producto showcase \u2014 beauty shot, foco en calidad y frescura",
    formats: ["foto", "carousel"],
    preferred_categories: ["fresh", "fermented", "testing"],
  },
  PROCESO: {
    emoji: "\u{1F331}",
    name: "PROCESO",
    description: "Behind the scenes \u2014 invernadero, cultivo, cosecha",
    formats: ["reels", "carousel", "stories"],
    preferred_categories: ["fresh", "testing"],
  },
  RECETA: {
    emoji: "\u{1F468}\u200D\u{1F373}",
    name: "RECETA",
    description: "Receta con nuestros productos \u2014 para chefs y cocineros caseros",
    formats: ["reels", "carousel"],
    preferred_categories: ["fresh", "fermented"],
  },
  FERMENTACION: {
    emoji: "\u{1FAD9}",
    name: "FERMENTACI\u00D3N",
    description: "Proceso de fermentaci\u00F3n, tradiciones, beneficios para la salud",
    formats: ["reels", "carousel", "stories"],
    preferred_categories: ["fermented"],
  },
  TIP: {
    emoji: "\u{1F4A1}",
    name: "TIP",
    description: "Tips r\u00E1pidos \u2014 conservaci\u00F3n, elecci\u00F3n, datos nutricionales",
    formats: ["stories", "carousel"],
    preferred_categories: ["fresh", "fermented", "testing"],
  },
  HISTORIA: {
    emoji: "\u{1F4D6}",
    name: "HISTORIA",
    description: "Historia de marca, herencia rusa/ucraniana, vida de campo",
    formats: ["foto", "reels", "stories"],
    preferred_categories: ["fermented", "fresh"],
  },
  COMUNIDAD: {
    emoji: "\u{1F389}",
    name: "COMUNIDAD",
    description: "Fotos de clientes, colabs con chefs, visitas al mercado",
    formats: ["foto", "stories", "reels"],
    preferred_categories: ["fresh", "fermented", "testing"],
  },
};

/** Расписание рубрик по дням недели (0 = воскресенье) */
const WEEKLY_SCHEDULE = {
  1: "PRODUCTO", // Понедельник
  2: "PROCESO", // Вторник
  3: "RECETA", // Среда
  4: "FERMENTACION", // Четверг
  5: "TIP", // Пятница (чередуется с HISTORIA)
  6: "COMUNIDAD", // Суббота
};

/** Лучшее время для публикации (ART = UTC-3) */
const POSTING_TIMES = [
  { slot: "almuerzo", hours: "11:00-13:00", days: ["Mar", "Jue", "S\u00E1b"] },
  { slot: "cena", hours: "19:00-21:00", days: ["Mar", "Jue", "S\u00E1b"] },
];

/** Общие хештеги бренда */
const BRAND_HASHTAGS = [
  "#pepinopick",
  "#invernadero",
  "#productosorganicos",
  "#delcampoalamesa",
  "#huertatuinvernadero",
  "#cocinaargentina",
  "#alimentossaludables",
  "#fermentadoscaseros",
  "#comidanatural",
  "#buenosairesfoodies",
];

// -- Утилиты ------------------------------------------------------------------

/**
 * Возвращает текущую дату в таймзоне Аргентины (UTC-3).
 * @returns {Date}
 */
function nowART() {
  const now = new Date();
  // Сдвигаем на -3 часа от UTC для получения аргентинского времени
  const artOffset = -3 * 60;
  const localOffset = now.getTimezoneOffset();
  const diff = artOffset - -localOffset;
  return new Date(now.getTime() + diff * 60 * 1000);
}

/**
 * Форматирует дату как YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Название дня недели на испанском (сокращённое).
 * @param {number} dow - день недели (0=Dom, 1=Lun, ..., 6=Sab)
 * @returns {string}
 */
function dayNameES(dow) {
  const names = ["Dom", "Lun", "Mar", "Mi\u00E9", "Jue", "Vie", "S\u00E1b"];
  return names[dow] || "???";
}

/**
 * Детерминированный pseudo-random на основе даты для стабильной ротации.
 * @param {string} seed - строка-seed (обычно дата YYYY-MM-DD)
 * @returns {number} 0..1
 */
function seededRandom(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 10000) / 10000;
}

/**
 * Выбирает элемент из массива на основе seed.
 * @template T
 * @param {T[]} arr
 * @param {string} seed
 * @returns {T}
 */
function pickBySeed(arr, seed) {
  if (arr.length === 0) throw new Error("pickBySeed: пустой массив");
  const idx = Math.floor(seededRandom(seed) * arr.length);
  return arr[idx];
}

// -- Данные продаж для приоритизации ------------------------------------------

/**
 * Загружает данные продаж из farm-state и возвращает ранжированный список продуктов.
 * Best-sellers получают больше эфирного времени.
 * @returns {Promise<Map<string, number>>} productKey -> score (0..1)
 */
async function loadSalesRanking() {
  /** @type {Map<string, number>} */
  const ranking = new Map();

  try {
    const state = await getState();
    const products = state.analytics?.products || {};

    // Собираем суммы продаж по ключам каталога
    const salesByKey = new Map();
    for (const [productKey, data] of Object.entries(PRODUCTS)) {
      // Ищем совпадение по русскому имени в данных продаж
      const nameRu = data.name_ru.toLowerCase();
      let totalArs = 0;
      for (const [soldName, soldData] of Object.entries(products)) {
        if (soldName.toLowerCase().includes(nameRu) || nameRu.includes(soldName.toLowerCase())) {
          totalArs += soldData.ars || 0;
        }
      }
      salesByKey.set(productKey, totalArs);
    }

    // Нормализуем в 0..1
    const maxSales = Math.max(...salesByKey.values(), 1);
    for (const [key, ars] of salesByKey) {
      ranking.set(key, ars / maxSales);
    }
  } catch (err) {
    // Если farm-state недоступен — все продукты получают равный вес
    console.error(`[content-planner] farm-state недоступен: ${err.message}`);
    const keys = Object.keys(PRODUCTS);
    for (const key of keys) {
      ranking.set(key, 0.5);
    }
  }

  return ranking;
}

/**
 * Возвращает список ключей продуктов, отсортированных по приоритету.
 * Best-sellers идут первыми, но все продукты включены (каждый минимум 2 раза/месяц).
 * @param {Map<string, number>} ranking
 * @param {string} [preferredCategory] - фильтр по категории
 * @returns {string[]}
 */
function prioritizedProducts(ranking, preferredCategory) {
  let keys = Object.keys(PRODUCTS);

  if (preferredCategory) {
    const filtered = keys.filter((k) => {
      const cat = PRODUCTS[k].category;
      return preferredCategory === cat || preferredCategory.includes(cat);
    });
    if (filtered.length > 0) keys = filtered;
  }

  // Сортируем: выше ранг = первее в списке
  keys.sort((a, b) => (ranking.get(b) || 0) - (ranking.get(a) || 0));
  return keys;
}

// -- Генерация контента -------------------------------------------------------

/**
 * Подбирает лучшее время публикации для данного дня.
 * @param {number} dow - день недели (0-6)
 * @returns {string}
 */
function bestPostingTime(dow) {
  const dayName = dayNameES(dow);
  for (const slot of POSTING_TIMES) {
    if (slot.days.includes(dayName)) {
      return `${dayName} ${slot.hours}`;
    }
  }
  // Дни без оптимального слота — универсальное время
  return `${dayName} 12:00-13:00`;
}

/**
 * Генерирует набор из 20 хештегов для продукта.
 * Микс: продуктовые + рубричные + брендовые + общие.
 * @param {string} productKey
 * @param {string} rubricKey
 * @returns {string[]}
 */
function generateHashtags(productKey, rubricKey) {
  const product = PRODUCTS[productKey];
  if (!product) return [...BRAND_HASHTAGS];

  /** @type {Set<string>} */
  const tags = new Set();

  // Продуктовые хештеги
  for (const tag of product.hashtags) {
    tags.add(tag);
  }

  // Рубричные хештеги
  const rubricTags = {
    PRODUCTO: ["#productshowcase", "#foodphotography", "#freshfood"],
    PROCESO: ["#behindthescenes", "#farmlife", "#growingfood"],
    RECETA: ["#recetafacil", "#recetasaludable", "#cocinar"],
    FERMENTACION: ["#fermentacion", "#probioticos", "#gutHealth"],
    TIP: ["#tipsdecocina", "#nutricion", "#sabiasque"],
    HISTORIA: ["#nuestrahistoria", "#emprendimiento", "#inmigrantes"],
    COMUNIDAD: ["#comunidad", "#clientesfelices", "#gracias"],
  };
  for (const tag of rubricTags[rubricKey] || []) {
    tags.add(tag);
  }

  // Брендовые хештеги
  for (const tag of BRAND_HASHTAGS) {
    tags.add(tag);
  }

  // Общие хештеги гастрономии Argentina
  const generalTags = [
    "#gastronomiaargentina",
    "#comidasana",
    "#vidasaludable",
    "#foodie",
    "#instafood",
    "#healthyfood",
    "#organico",
    "#sustentable",
    "#km0",
    "#slowfood",
  ];
  for (const tag of generalTags) {
    if (tags.size >= 20) break;
    tags.add(tag);
  }

  return Array.from(tags).slice(0, 20);
}

/**
 * Генерирует 3 вариации caption для поста.
 * @param {string} productKey
 * @param {string} rubricKey
 * @returns {{ formal: string, casual: string, storytelling: string }}
 */
function generateCaptions(productKey, rubricKey) {
  const product = PRODUCTS[productKey];
  const rubric = RUBRICS[rubricKey];
  if (!product || !rubric) {
    return {
      formal: "Descubri nuestros productos frescos del invernadero.",
      casual: "Veni a probar lo mejor de la huerta!",
      storytelling: "Cada producto tiene una historia. Esta es la nuestra.",
    };
  }

  const captionTemplates = {
    PRODUCTO: {
      formal: `Presentamos ${product.name_es}: ${product.usp}. Cultivado con dedicaci\u00F3n en nuestro invernadero, llega a tu mesa con la frescura y calidad que merec\u00E9s. ${product.health}.`,
      casual: `\u00BFConoc\u00E9s ${product.name_es.toLowerCase()}? ${product.usp} \u{1F331} Prob\u00E1 la diferencia de lo fresco de verdad. Disponible ${product.season}!`,
      storytelling: `Cada ma\u00F1ana recorremos el invernadero buscando el punto perfecto de cosecha. ${product.name_es} no es solo un producto \u2014 es el resultado de cuidar cada detalle. ${product.usp}.`,
    },
    PROCESO: {
      formal: `As\u00ED cultivamos ${product.name_es.toLowerCase()} en Pepino Pick. Nuestro invernadero permite controlar cada variable para garantizar la mejor calidad, temporada tras temporada.`,
      casual: `Tour por el inverna! \u{1F3E0}\u{1F33F} Hoy te mostramos c\u00F3mo crece ${product.name_es.toLowerCase()} \u2014 del sustrato a tu cocina. Swipe para ver el proceso completo!`,
      storytelling: `Son las 6 de la ma\u00F1ana. El invernadero todav\u00EDa est\u00E1 fresco. Revisamos ${product.name_es.toLowerCase()} uno por uno \u2014 porque la calidad no se negocia.`,
    },
    RECETA: {
      formal: `Receta del d\u00EDa: ${pickBySeed(product.recipe_ideas, productKey + rubricKey)} con ${product.name_es.toLowerCase()}. Una preparaci\u00F3n simple que resalta el sabor natural de productos frescos del invernadero.`,
      casual: `Dale, animate! \u{1F468}\u200D\u{1F373} Hoy hacemos ${pickBySeed(product.recipe_ideas, productKey + rubricKey).toLowerCase()} con ${product.name_es.toLowerCase()}. F\u00E1cil, r\u00E1pido y DELICIOSO. Receta completa en el caption!`,
      storytelling: `Mi abuela siempre dec\u00EDa: "Lo simple es lo mejor". ${pickBySeed(product.recipe_ideas, productKey + rubricKey)} con ${product.name_es.toLowerCase()} es exactamente eso \u2014 pocos ingredientes, mucho sabor.`,
    },
    FERMENTACION: {
      formal: `${product.name_es}: ${product.usp}. La fermentaci\u00F3n natural es un arte ancestral que potencia sabores y aporta beneficios \u00FAnicos: ${product.health.toLowerCase()}.`,
      casual: `Fermentados level \u{1F4AF}! ${product.name_es} \u2014 ${product.usp.toLowerCase()}. \u00BFSab\u00EDas que aporta ${product.health.toLowerCase()}? Prob\u00E1 y cont\u00E1nos!`,
      storytelling: `Esta receta viaj\u00F3 miles de kil\u00F3metros desde Europa del Este hasta Argentina. ${product.name_es} \u2014 ${product.usp.toLowerCase()}. Un sabor que conecta generaciones.`,
    },
    TIP: {
      formal: `Tip del d\u00EDa: ${product.health}. Inclu\u00ED ${product.name_es.toLowerCase()} en tu alimentaci\u00F3n y not\u00E1 la diferencia. Disponible ${product.season}.`,
      casual: `TIP \u{1F4A1} \u00BFC\u00F3mo conservar ${product.name_es.toLowerCase()}? En heladera, envuelto en papel absorbente, dura hasta 1 semana. Y tiene: ${product.health.toLowerCase()}!`,
      storytelling: `Despu\u00E9s de a\u00F1os cultivando, aprendimos algo: ${product.name_es.toLowerCase()} sabe mejor cuando lo cosech\u00E1s en el momento justo. Ac\u00E1 va nuestro secreto...`,
    },
    HISTORIA: {
      formal: `La historia de Pepino Pick es la historia de tradiciones que cruzan oc\u00E9anos. ${product.name_es} nace de recetas y t\u00E9cnicas tra\u00EDdas desde Rusia y Ucrania.`,
      casual: `Storytime! \u{1F4D6} \u00BFC\u00F3mo termin\u00F3 una familia ruso-ucraniana cultivando ${product.name_es.toLowerCase()} en Argentina? Spoiler: con mucha pasi\u00F3n y un invernadero.`,
      storytelling: `Mi abuelo cultivaba pepinos en Ucrania. Hoy, a miles de km, seguimos esa tradici\u00F3n. ${product.name_es} no es solo comida \u2014 es memoria, es identidad, es amor por la tierra.`,
    },
    COMUNIDAD: {
      formal: `Gracias a nuestra comunidad por elegir ${product.name_es.toLowerCase()} de Pepino Pick. Cada compra apoya la agricultura local y sustentable.`,
      casual: `GRACIAS fam! \u2764\uFE0F Ustedes hacen que todo valga la pena. \u00BFYa probaste ${product.name_es.toLowerCase()}? Dejanos tu opini\u00F3n en comentarios!`,
      storytelling: `Ayer un cliente nos dijo: "Desde que prob\u00E9 ${product.name_es.toLowerCase()} de Pepino Pick, no puedo comer otro". Momentos as\u00ED nos llenan el coraz\u00F3n.`,
    },
  };

  const templates = captionTemplates[rubricKey];
  if (!templates) {
    return {
      formal: `Descubr\u00ED ${product.name_es} de Pepino Pick. ${product.usp}.`,
      casual: `Prob\u00E1 ${product.name_es.toLowerCase()} \u2014 ${product.usp.toLowerCase()}!`,
      storytelling: `Cada producto tiene una historia. ${product.name_es} es la nuestra.`,
    };
  }

  return templates;
}

/**
 * Генерирует один пост.
 * @param {Object} options
 * @param {string} options.productKey
 * @param {string} options.rubricKey
 * @param {string} options.date - YYYY-MM-DD
 * @returns {Object} объект поста
 */
function generatePost({ productKey, rubricKey, date }) {
  const product = PRODUCTS[productKey];
  const rubric = RUBRICS[rubricKey];
  if (!product || !rubric) {
    throw new Error(`Неизвестный продукт (${productKey}) или рубрика (${rubricKey})`);
  }

  const dow = new Date(date + "T12:00:00").getDay();
  const captions = generateCaptions(productKey, rubricKey);
  const hashtags = generateHashtags(productKey, rubricKey);
  const format = pickBySeed(rubric.formats, date + productKey);
  const photoIdea = pickBySeed(product.photo_ideas, date + rubricKey);
  const recipeIdea =
    rubricKey === "RECETA" ? pickBySeed(product.recipe_ideas, date + productKey) : null;

  // Идеи для cross-promotion
  const crossPromo = [];
  if (product.category === "fresh") {
    crossPromo.push("Mencion\u00E1 nuestros fermentados como acompa\u00F1amiento");
  }
  if (product.category === "fermented") {
    crossPromo.push("Link a recetas con este producto en highlights");
  }
  crossPromo.push("Stories poll: \u00BFlo probaste? S\u00ED/Todav\u00EDa no");
  crossPromo.push("Repost en stories de clientes que nos etiqueten");

  return {
    date,
    day: dayNameES(dow),
    rubric: `${rubric.emoji} ${rubric.name}`,
    rubric_key: rubricKey,
    product_es: product.name_es,
    product_ru: product.name_ru,
    product_key: productKey,
    format,
    photo_idea: photoIdea,
    recipe: recipeIdea,
    captions,
    hashtags,
    posting_time: bestPostingTime(dow),
    cross_promotion: crossPromo,
    usp: product.usp,
    health: product.health,
  };
}

// -- Команды ------------------------------------------------------------------

/**
 * Генерирует план на неделю (7 постов, начиная с понедельника).
 * @param {Map<string, number>} ranking
 * @returns {Object[]}
 */
function generateWeekPlan(ranking) {
  const today = nowART();
  // Находим следующий понедельник
  const dow = today.getDay();
  const daysUntilMon = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  const monday = new Date(today);
  monday.setDate(monday.getDate() + daysUntilMon);

  const posts = [];
  // Собираем продукты для ротации — каждый день свой продукт
  const usedProducts = new Set();

  for (let i = 0; i < 7; i++) {
    const postDate = new Date(monday);
    postDate.setDate(monday.getDate() + i);
    const dateStr = fmtDate(postDate);
    const postDow = postDate.getDay();

    // Воскресенье — выходной от контента
    if (postDow === 0) continue;

    // Рубрика по расписанию; пятница чередуется между TIP и HISTORIA
    let rubricKey = WEEKLY_SCHEDULE[postDow];
    if (postDow === 5) {
      // Чётная неделя = TIP, нечётная = HISTORIA
      const weekNum = Math.floor(postDate.getTime() / (7 * 24 * 60 * 60 * 1000));
      rubricKey = weekNum % 2 === 0 ? "TIP" : "HISTORIA";
    }

    const rubric = RUBRICS[rubricKey];
    // Выбираем продукт с учётом рубрики и ранжирования
    const preferredCats = rubric.preferred_categories.join(",");
    const productList = prioritizedProducts(ranking, preferredCats);

    // Выбираем продукт, который ещё не использовался на этой неделе
    let productKey = productList[0];
    for (const pk of productList) {
      if (!usedProducts.has(pk)) {
        productKey = pk;
        break;
      }
    }
    usedProducts.add(productKey);

    posts.push(generatePost({ productKey, rubricKey, date: dateStr }));
  }

  return posts;
}

/**
 * Генерирует план на месяц (4 недели).
 * @param {Map<string, number>} ranking
 * @returns {Object[]}
 */
function generateMonthPlan(ranking) {
  const today = nowART();
  const allPosts = [];
  const productUsageCount = new Map();

  // 4 недели, начиная с ближайшего понедельника
  const dow = today.getDay();
  const daysUntilMon = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  const startMonday = new Date(today);
  startMonday.setDate(today.getDate() + daysUntilMon);

  for (let week = 0; week < 4; week++) {
    const weekUsed = new Set();

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const postDate = new Date(startMonday);
      postDate.setDate(startMonday.getDate() + week * 7 + dayIdx);
      const dateStr = fmtDate(postDate);
      const postDow = postDate.getDay();

      if (postDow === 0) continue;

      let rubricKey = WEEKLY_SCHEDULE[postDow];
      if (postDow === 5) {
        rubricKey = week % 2 === 0 ? "TIP" : "HISTORIA";
      }

      const rubric = RUBRICS[rubricKey];
      const preferredCats = rubric.preferred_categories.join(",");
      const productList = prioritizedProducts(ranking, preferredCats);

      // Ротация: приоритет продуктам с меньшим количеством появлений в плане
      let productKey = productList[0];
      let minUsage = Infinity;
      for (const pk of productList) {
        const usage = productUsageCount.get(pk) || 0;
        if (!weekUsed.has(pk) && usage < minUsage) {
          minUsage = usage;
          productKey = pk;
        }
      }
      weekUsed.add(productKey);
      productUsageCount.set(productKey, (productUsageCount.get(productKey) || 0) + 1);

      allPosts.push(generatePost({ productKey, rubricKey, date: dateStr }));
    }
  }

  return allPosts;
}

/**
 * Генерирует 10 идей для контента.
 * @param {Map<string, number>} ranking
 * @returns {Object[]}
 */
function generateIdeas(ranking) {
  const ideas = [];
  const productKeys = prioritizedProducts(ranking);
  const rubricKeys = Object.keys(RUBRICS);
  const today = fmtDate(nowART());

  for (let i = 0; i < 10; i++) {
    const productKey = productKeys[i % productKeys.length];
    const rubricKey = rubricKeys[i % rubricKeys.length];
    const product = PRODUCTS[productKey];
    const rubric = RUBRICS[rubricKey];

    const ideaTemplates = [
      `Reels: proceso de cosecha de ${product.name_es.toLowerCase()} en time-lapse`,
      `Carousel: antes/despu\u00E9s de la fermentaci\u00F3n de ${product.name_es.toLowerCase()}`,
      `Stories quiz: \u00BFCu\u00E1ntas variedades de ${product.name_es.toLowerCase()} conoces?`,
      `Foto: flat lay de todos nuestros productos fermentados`,
      `Reels: ${pickBySeed(product.recipe_ideas, today + String(i))} paso a paso (60 seg)`,
      `Carousel: 5 beneficios de ${product.name_es.toLowerCase()} para tu salud`,
      `Stories: un d\u00EDa en el invernadero (behind the scenes)`,
      `Reels: chef invitado prepara plato con ${product.name_es.toLowerCase()}`,
      `Foto: ${pickBySeed(product.photo_ideas, today + String(i))} (estilo editorial)`,
      `Carousel: la historia de c\u00F3mo ${product.name_es.toLowerCase()} lleg\u00F3 a Argentina`,
    ];

    ideas.push({
      number: i + 1,
      rubric: `${rubric.emoji} ${rubric.name}`,
      product: product.name_es,
      idea: ideaTemplates[i],
      format: pickBySeed(rubric.formats, today + String(i)),
      hashtags: generateHashtags(productKey, rubricKey).slice(0, 5),
    });
  }

  return ideas;
}

/**
 * Генерирует список рекомендованных хештегов.
 * @returns {Object}
 */
function generateHashtagGuide() {
  const guide = {
    brand: BRAND_HASHTAGS,
    by_product: {},
    by_rubric: {},
    general: [
      "#gastronomiaargentina",
      "#comidasana",
      "#vidasaludable",
      "#foodie",
      "#instafood",
      "#healthyfood",
      "#organico",
      "#sustentable",
      "#km0",
      "#slowfood",
    ],
    tips: [
      "Usar 20-25 hashtags por post (m\u00E1ximo de Instagram: 30)",
      "Mezclar hashtags populares (>100K) con nicho (<10K)",
      "Rotar hashtags para evitar shadowban",
      "Incluir siempre #pepinopick como primer hashtag",
    ],
  };

  for (const [key, product] of Object.entries(PRODUCTS)) {
    guide.by_product[product.name_es] = product.hashtags;
  }

  for (const [key, rubric] of Object.entries(RUBRICS)) {
    guide.by_rubric[`${rubric.emoji} ${rubric.name}`] = generateHashtags(
      Object.keys(PRODUCTS)[0],
      key,
    ).slice(0, 10);
  }

  return guide;
}

// -- Форматирование -----------------------------------------------------------

/**
 * Форматирует пост для вывода в терминал/Telegram.
 * @param {Object} post
 * @returns {string}
 */
function formatPost(post) {
  const lines = [];
  lines.push(
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  );
  lines.push(`${post.rubric} | ${post.date} (${post.day})`);
  lines.push(`Producto: ${post.product_es} (${post.product_ru})`);
  lines.push(`Formato: ${post.format.toUpperCase()}`);
  lines.push(`Horario: ${post.posting_time}`);
  lines.push(`USP: ${post.usp}`);
  lines.push(`Foto idea: ${post.photo_idea}`);
  if (post.recipe) {
    lines.push(`Receta: ${post.recipe}`);
  }
  lines.push("");
  lines.push("--- CAPTION FORMAL ---");
  lines.push(post.captions.formal);
  lines.push("");
  lines.push("--- CAPTION CASUAL ---");
  lines.push(post.captions.casual);
  lines.push("");
  lines.push("--- CAPTION STORYTELLING ---");
  lines.push(post.captions.storytelling);
  lines.push("");
  lines.push(`Hashtags: ${post.hashtags.join(" ")}`);
  lines.push("");
  lines.push(`Cross-promo: ${post.cross_promotion.join(" | ")}`);

  return lines.join("\n");
}

/**
 * Форматирует план на неделю для Telegram (HTML).
 * @param {Object[]} posts
 * @returns {string}
 */
function formatWeekPlanTelegram(posts) {
  if (posts.length === 0) return "No hay posts planificados.";

  const firstDate = posts[0].date;
  const lastDate = posts[posts.length - 1].date;

  const lines = [];
  lines.push(`<b>\u{1F4C5} Content Plan: ${firstDate} \u2014 ${lastDate}</b>`);
  lines.push("");

  for (const post of posts) {
    const emoji = post.rubric.split(" ")[0];
    lines.push(`${emoji} <b>${post.day} ${post.date}</b> | ${post.product_es}`);
    lines.push(`   Formato: ${post.format} | ${post.posting_time}`);
    lines.push(`   <i>${post.captions.casual.slice(0, 100)}...</i>`);
    lines.push("");
  }

  lines.push(
    `\u{1F4CA} Total: ${posts.length} posts | Productos: ${new Set(posts.map((p) => p.product_key)).size}`,
  );

  return lines.join("\n");
}

// -- Sheets интеграция --------------------------------------------------------

/**
 * Сохраняет план в Google Sheets.
 * @param {Object[]} posts
 * @returns {Promise<string>} URL листа
 */
async function saveToSheets(posts) {
  const { appendToSheet, PEPINO_SHEETS_ID, createSheetIfNotExists } = await import("./sheets.js");

  // Создаём лист если не существует
  await createSheetIfNotExists(PEPINO_SHEETS_ID, CONTENT_SHEET_NAME);

  // Формируем строки для записи
  const rows = posts.map((post) => [
    post.date,
    post.day,
    post.rubric,
    post.product_es,
    post.product_ru,
    post.format,
    post.posting_time,
    post.captions.casual,
    post.hashtags.join(" "),
    post.photo_idea,
    post.recipe || "",
    post.usp,
    post.cross_promotion.join("; "),
    "pendiente", // статус
    new Date().toISOString().slice(0, 19), // дата генерации
  ]);

  await appendToSheet(PEPINO_SHEETS_ID, rows, CONTENT_SHEET_NAME);

  return `https://docs.google.com/spreadsheets/d/${PEPINO_SHEETS_ID}`;
}

// -- CLI ----------------------------------------------------------------------

/**
 * Выводит help.
 */
function printHelp() {
  const help = `
content-planner.cjs -- Generador de contenido para Pepino Pick

Uso:
  node content-planner.cjs week                              Plan semanal (6 posts)
  node content-planner.cjs post                              Un post aleatorio
  node content-planner.cjs post --product "solenye ogurcy"   Post de producto espec\u00EDfico
  node content-planner.cjs post --type recipe                Post de rub\u00E9rica espec\u00EDfica
  node content-planner.cjs month                             Calendario mensual (24 posts)
  node content-planner.cjs ideas                             10 ideas de contenido
  node content-planner.cjs hashtags                          Gu\u00EDa de hashtags

Opciones:
  --dry-run    Sin env\u00EDo a Sheets/Telegram
  --help       Mostrar esta ayuda

Cron: 0 18 * * 0  (domingos 18:00 ART)
`.trim();

  console.log(help);
}

/**
 * Парсит аргументы CLI.
 * @param {string[]} argv
 * @returns {{ command: string, dryRun: boolean, product: string|null, type: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "";
  let dryRun = false;
  /** @type {string|null} */
  let product = null;
  /** @type {string|null} */
  let type = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (arg === "--product" && i + 1 < args.length) {
      product = args[++i];
    } else if (arg === "--type" && i + 1 < args.length) {
      type = args[++i];
    } else if (!command) {
      command = arg;
    }
  }

  return { command, dryRun, product, type };
}

/**
 * Находит ключ продукта по названию (поиск по name_es, name_ru, ключу).
 * @param {string} query
 * @returns {string|null}
 */
function findProductKey(query) {
  const q = query.toLowerCase().trim();

  for (const [key, product] of Object.entries(PRODUCTS)) {
    if (
      key.toLowerCase() === q ||
      product.name_es.toLowerCase() === q ||
      product.name_ru.toLowerCase() === q ||
      product.name_es.toLowerCase().includes(q) ||
      product.name_ru.toLowerCase().includes(q)
    ) {
      return key;
    }
  }
  return null;
}

/**
 * Находит ключ рубрики по типу.
 * @param {string} query
 * @returns {string|null}
 */
function findRubricKey(query) {
  const q = query.toLowerCase().trim();

  const aliases = {
    producto: "PRODUCTO",
    product: "PRODUCTO",
    proceso: "PROCESO",
    process: "PROCESO",
    receta: "RECETA",
    recipe: "RECETA",
    fermentacion: "FERMENTACION",
    fermentation: "FERMENTACION",
    tip: "TIP",
    tips: "TIP",
    historia: "HISTORIA",
    history: "HISTORIA",
    story: "HISTORIA",
    comunidad: "COMUNIDAD",
    community: "COMUNIDAD",
  };

  return aliases[q] || null;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  const { command, dryRun, product, type } = parseArgs(process.argv);

  if (!command || command === "help") {
    printHelp();
    process.exit(0);
  }

  const dryLabel = dryRun ? " [DRY-RUN]" : "";
  console.error(`[content-planner]${dryLabel} Команда: ${command}`);

  // Загружаем ранжирование продаж
  const ranking = await loadSalesRanking();

  try {
    switch (command) {
      case "week": {
        const posts = generateWeekPlan(ranking);
        // Вывод в stdout
        for (const post of posts) {
          console.log(formatPost(post));
          console.log("");
        }

        if (!dryRun) {
          // Сохраняем в Sheets
          const url = await saveToSheets(posts);
          console.error(`[content-planner] Guardado en Sheets: ${url}`);

          // Отправляем в Telegram
          const tgMessage = formatWeekPlanTelegram(posts);
          const tgResult = await sendThrottled(tgMessage, {
            thread: TG_TOPIC_MARKETING,
            silent: false,
            parseMode: "HTML",
          });
          console.error(`[content-planner] Telegram: ${tgResult.action}`);
        } else {
          console.error("[content-planner] DRY-RUN: Sheets/Telegram пропущены");
        }

        // Langfuse trace
        await trace({
          name: "content-planner/week",
          input: { command: "week", dry_run: dryRun, posts_count: posts.length },
          output: { products: [...new Set(posts.map((p) => p.product_key))] },
          duration_ms: Date.now() - startMs,
          metadata: { skill: "pepino-google-sheets" },
        });
        break;
      }

      case "post": {
        // Определяем продукт и рубрику
        let productKey = product ? findProductKey(product) : null;
        let rubricKey = type ? findRubricKey(type) : null;

        if (product && !productKey) {
          console.error(`[content-planner] Producto no encontrado: "${product}"`);
          console.error("Productos disponibles:");
          for (const [k, v] of Object.entries(PRODUCTS)) {
            console.error(`  ${k}: ${v.name_es} / ${v.name_ru}`);
          }
          process.exit(1);
        }

        // Если продукт не указан — выбираем best-seller
        if (!productKey) {
          const productList = prioritizedProducts(ranking);
          productKey = pickBySeed(productList, fmtDate(nowART()));
        }

        // Если рубрика не указана — по текущему дню недели
        if (!rubricKey) {
          const dow = nowART().getDay();
          rubricKey = WEEKLY_SCHEDULE[dow] || "PRODUCTO";
          if (dow === 5) {
            const weekNum = Math.floor(nowART().getTime() / (7 * 24 * 60 * 60 * 1000));
            rubricKey = weekNum % 2 === 0 ? "TIP" : "HISTORIA";
          }
        }

        const post = generatePost({
          productKey,
          rubricKey,
          date: fmtDate(nowART()),
        });

        console.log(formatPost(post));

        await trace({
          name: "content-planner/post",
          input: { command: "post", product: productKey, rubric: rubricKey, dry_run: dryRun },
          output: { format: post.format, product_es: post.product_es },
          duration_ms: Date.now() - startMs,
          metadata: { skill: "pepino-google-sheets" },
        });
        break;
      }

      case "month": {
        const posts = generateMonthPlan(ranking);

        // Краткий вывод для месяца (полные посты слишком длинные)
        console.log(`=== CONTENT CALENDAR: ${posts.length} posts ===\n`);
        for (const post of posts) {
          const emoji = post.rubric.split(" ")[0];
          console.log(
            `${post.date} ${post.day} | ${emoji} ${post.rubric_key.padEnd(13)} | ${post.product_es.padEnd(28)} | ${post.format}`,
          );
        }

        // Статистика ротации
        console.log("\n=== ROTACION DE PRODUCTOS ===");
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const post of posts) {
          counts.set(post.product_es, (counts.get(post.product_es) || 0) + 1);
        }
        for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${name}: ${count}x`);
        }

        if (!dryRun) {
          const url = await saveToSheets(posts);
          console.error(`[content-planner] Guardado en Sheets: ${url}`);

          const summary = [
            `<b>\u{1F4C5} Content Calendar: ${posts[0].date} \u2014 ${posts[posts.length - 1].date}</b>`,
            `Total: ${posts.length} posts`,
            `Productos: ${counts.size}`,
            "",
            [...counts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => `  ${name}: ${count}x`)
              .join("\n"),
          ].join("\n");

          await sendThrottled(summary, {
            thread: TG_TOPIC_MARKETING,
            silent: false,
            parseMode: "HTML",
          });
        } else {
          console.error("[content-planner] DRY-RUN: Sheets/Telegram пропущены");
        }

        await trace({
          name: "content-planner/month",
          input: { command: "month", dry_run: dryRun, posts_count: posts.length },
          output: { products: [...counts.keys()] },
          duration_ms: Date.now() - startMs,
          metadata: { skill: "pepino-google-sheets" },
        });
        break;
      }

      case "ideas": {
        const ideas = generateIdeas(ranking);

        console.log("=== 10 IDEAS DE CONTENIDO ===\n");
        for (const idea of ideas) {
          console.log(`${idea.number}. ${idea.rubric} | ${idea.product}`);
          console.log(`   ${idea.idea}`);
          console.log(`   Formato: ${idea.format} | Tags: ${idea.hashtags.join(" ")}`);
          console.log("");
        }

        await trace({
          name: "content-planner/ideas",
          input: { command: "ideas" },
          output: { ideas_count: ideas.length },
          duration_ms: Date.now() - startMs,
          metadata: { skill: "pepino-google-sheets" },
        });
        break;
      }

      case "hashtags": {
        const guide = generateHashtagGuide();

        console.log("=== GUIA DE HASHTAGS ===\n");

        console.log("MARCA:");
        console.log(`  ${guide.brand.join(" ")}\n`);

        console.log("POR PRODUCTO:");
        for (const [name, tags] of Object.entries(guide.by_product)) {
          console.log(`  ${name}: ${tags.join(" ")}`);
        }

        console.log("\nPOR RUBRICA:");
        for (const [name, tags] of Object.entries(guide.by_rubric)) {
          console.log(`  ${name}: ${tags.join(" ")}`);
        }

        console.log("\nGENERALES:");
        console.log(`  ${guide.general.join(" ")}`);

        console.log("\nTIPS:");
        for (const tip of guide.tips) {
          console.log(`  - ${tip}`);
        }

        await trace({
          name: "content-planner/hashtags",
          input: { command: "hashtags" },
          output: { brand_count: guide.brand.length },
          duration_ms: Date.now() - startMs,
          metadata: { skill: "pepino-google-sheets" },
        });
        break;
      }

      default:
        console.error(`[content-planner] Comando desconocido: "${command}"`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[content-planner] ERROR: ${err.message}`);
    if (err.stack) console.error(err.stack);

    await trace({
      name: `content-planner/${command}`,
      input: { command, error: true },
      output: { error: err.message },
      duration_ms: Date.now() - startMs,
      metadata: { skill: "pepino-google-sheets", error: true },
    });

    process.exit(1);
  }

  const elapsed = Date.now() - startMs;
  console.error(`[content-planner] Listo en ${elapsed}ms`);
}

// -- Запуск -------------------------------------------------------------------

if (require.main === module) {
  main();
}

// -- Экспорт ------------------------------------------------------------------

module.exports = {
  PRODUCTS,
  RUBRICS,
  WEEKLY_SCHEDULE,
  BRAND_HASHTAGS,
  generatePost,
  generateWeekPlan,
  generateMonthPlan,
  generateIdeas,
  generateHashtags,
  generateCaptions,
  generateHashtagGuide,
  formatPost,
  formatWeekPlanTelegram,
  findProductKey,
  findRubricKey,
};
