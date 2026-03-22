#!/usr/bin/env node
/**
 * whatsapp-marketing.cjs — Генератор маркетинговых сообщений для WhatsApp/Telegram
 *
 * Создает промо-сообщения для продвижения продуктов Pepino Pick
 * среди аргентинских ресторанов и потребителей. Все сообщения на испанском.
 *
 * CLI:
 *   node whatsapp-marketing.cjs launch "капуста пелюстка"        # Запуск нового продукта
 *   node whatsapp-marketing.cjs promo "weekly"                    # Еженедельные предложения
 *   node whatsapp-marketing.cjs seasonal                          # Сезонные продукты
 *   node whatsapp-marketing.cjs reactivation                      # Реактивация неактивных клиентов
 *   node whatsapp-marketing.cjs referral                          # Реферальная программа
 *   node whatsapp-marketing.cjs recipe                            # Рецепт с продуктом
 *   node whatsapp-marketing.cjs --dry-run launch "tomates fermentados"
 *
 * Интеграции:
 *   - farm-state.cjs: текущий склад и продажи
 *   - client-analytics.cjs: неактивные клиенты для reactivation
 *   - notification-throttle.cjs: отправка в Telegram (тред #16, маркетинг)
 *   - langfuse-trace.cjs: observability
 */

"use strict";

const { getState, getStock } = require("./farm-state.cjs");
const { analyzeClients } = require("./client-analytics.cjs");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");

// -- Константы ----------------------------------------------------------------

/** ID топика маркетинга в Telegram */
const TG_TOPIC_MARKETING = 16;

/** Ссылка WhatsApp для сообщений */
const WHATSAPP_LINK = "https://wa.me/5491131500000";

/** Минимальный заказ в кг */
const MIN_ORDER_KG = 5;

/** Дней без заказа для реактивации */
const REACTIVATION_THRESHOLD_DAYS = 14;

// -- Продуктовый каталог ------------------------------------------------------

/** @typedef {{ name_es: string, name_ru: string, season: string, category: string, usp: string, benefits: string[], recipe_ideas: string[], health: string }} Product */

/** @type {Record<string, Product>} */
const PRODUCTS = {
  pepino_fresco: {
    name_es: "Pepino fresco",
    name_ru: "Свежий огурец",
    season: "todo el ano",
    category: "fresh",
    usp: "De invernadero a tu mesa en 24 horas",
    benefits: [
      "Cosechado el mismo dia del envio",
      "Sin pesticidas ni quimicos",
      "Ideal para ensaladas, gazpacho y jugos",
    ],
    recipe_ideas: [
      "Gazpacho fresco",
      "Ensalada griega",
      "Pepino con hummus",
      "Agua de pepino con menta",
    ],
    health: "Hidratacion, vitamina K, antioxidantes",
  },
  tomates_coleccion: {
    name_es: "Tomates de coleccion",
    name_ru: "Коллекционные томаты",
    season: "primavera-verano",
    category: "fresh",
    usp: "Variedades raras que no encontras en el super",
    benefits: [
      "Mas de 5 variedades heritage",
      "Sabor intenso, no industrial",
      "Directo del invernadero",
    ],
    recipe_ideas: ["Bruschetta multicolor", "Ensalada caprese", "Salsa casera", "Tomate relleno"],
    health: "Licopeno, vitamina C, antioxidantes",
  },
  pepinos_salados: {
    name_es: "Pepinos en salmuera",
    name_ru: "Соленые огурцы",
    season: "todo el ano",
    category: "fermented",
    usp: "Receta tradicional rusa — fermentacion natural sin vinagre",
    benefits: [
      "Fermentacion natural de 14 dias",
      "Sin conservantes artificiales",
      "Probioticos vivos para tu digestion",
    ],
    recipe_ideas: ["Tabla de encurtidos", "Sandwich con pepinos", "Ensalada rusa", "Okroshka"],
    health: "Probioticos naturales, digestion, vitamina B",
  },
  chucrut: {
    name_es: "Chucrut casero",
    name_ru: "Квашеная капуста",
    season: "otono-invierno",
    category: "fermented",
    usp: "Receta de abuela ucraniana — fermentacion lenta 21 dias",
    benefits: [
      "21 dias de fermentacion lenta",
      "Receta familiar ucraniana autentica",
      "Acompanamiento perfecto para carnes",
    ],
    recipe_ideas: ["Hot dog gourmet", "Ensalada de chucrut", "Acompanamiento para asado"],
    health: "Probioticos, vitamina C, fibra, inmunidad",
  },
  pelyustka: {
    name_es: "Repollo Pelyustka",
    name_ru: "Капуста пелюстка",
    season: "todo el ano",
    category: "fermented",
    usp: "Receta ucraniana exclusiva — repollo con remolacha, unico en Argentina",
    benefits: [
      "Unico en Argentina — receta exclusiva",
      "Remolacha natural le da color rosa intenso",
      "Probioticos + hierro de remolacha",
    ],
    recipe_ideas: ["Como guarnicion", "En sandwich gourmet", "En ensalada con queso de cabra"],
    health: "Probioticos, antioxidantes de remolacha, hierro",
  },
  salsas_picantes: {
    name_es: "Salsas picantes artesanales",
    name_ru: "Острые соусы (3 вида)",
    season: "todo el ano",
    category: "fermented",
    usp: "3 niveles de picante — desde suave hasta extreme",
    benefits: [
      "3 intensidades para cada gusto",
      "Chiles cultivados en nuestro invernadero",
      "Fermentacion que potencia el sabor",
    ],
    recipe_ideas: ["Wings con salsa", "Tacos mexicanos", "Huevos rancheros", "Pizza picante"],
    health: "Capsaicina, metabolismo, antioxidantes",
  },
  tomates_fermentados: {
    name_es: "Tomates fermentados",
    name_ru: "Квашеные томаты",
    season: "verano-otono",
    category: "fermented",
    usp: "Fermentacion natural que realza el sabor umami",
    benefits: [
      "Umami natural sin glutamato",
      "Fermentacion que potencia el licopeno",
      "Ideal para pastas y carnes",
    ],
    recipe_ideas: ["Con pasta fresca", "En bruschetta", "Salsa fermentada para carnes"],
    health: "Probioticos, licopeno potenciado, umami natural",
  },
  flores_comestibles: {
    name_es: "Flores comestibles",
    name_ru: "Съедобные цветы",
    season: "primavera-verano",
    category: "testing",
    usp: "Decoracion gourmet que se come — para chefs creativos",
    benefits: [
      "Cultivadas sin pesticidas",
      "Elevan la presentacion de cualquier plato",
      "Frescas, cosechadas el mismo dia",
    ],
    recipe_ideas: ["Ensalada con flores", "Decoracion de postres", "Cocktails florales"],
    health: "Antioxidantes, vitaminas, decoracion natural",
  },
  microverdes: {
    name_es: "Microverdes",
    name_ru: "Микрозелень",
    season: "todo el ano",
    category: "testing",
    usp: "Superalimento con 40x mas nutrientes que la verdura madura",
    benefits: [
      "40 veces mas nutrientes concentrados",
      "Sabor intenso en formato mini",
      "Topping premium para cualquier plato",
    ],
    recipe_ideas: ["Topping para todo", "Smoothie verde", "Ensalada power"],
    health: "40x mas nutrientes, vitaminas concentradas, clorofila",
  },
  hongos: {
    name_es: "Hongos ostra frescos",
    name_ru: "Грибы вешенка",
    season: "todo el ano",
    category: "testing",
    usp: "Cultivados en sustrato organico — textura y sabor unicos",
    benefits: [
      "Cultivados en sustrato 100% organico",
      "Textura carnosa, ideal para veganos",
      "Cosechados frescos, sin camara",
    ],
    recipe_ideas: ["Risotto de hongos", "Hongos a la plancha", "Ramen con hongos"],
    health: "Proteina vegetal, vitamina D, bajo en calorias",
  },
};

// -- Маппинг сезонов к месяцам (Южное полушарие) -----------------------------

/** @type {Record<string, number[]>} */
const SEASON_MONTHS = {
  "todo el ano": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  "primavera-verano": [9, 10, 11, 12, 1, 2, 3],
  "verano-otono": [12, 1, 2, 3, 4, 5],
  "otono-invierno": [3, 4, 5, 6, 7, 8],
};

// -- Утилиты ------------------------------------------------------------------

/**
 * Находит продукт по имени (es или ru, case-insensitive, partial match).
 * @param {string} query — поисковый запрос
 * @returns {Product|null}
 */
function findProduct(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();

  // Точное совпадение по ключу
  if (PRODUCTS[q]) return PRODUCTS[q];

  // Поиск по name_es или name_ru
  for (const [, product] of Object.entries(PRODUCTS)) {
    if (product.name_es.toLowerCase() === q) return product;
    if (product.name_ru.toLowerCase() === q) return product;
  }

  // Частичное совпадение
  for (const [, product] of Object.entries(PRODUCTS)) {
    if (product.name_es.toLowerCase().includes(q)) return product;
    if (product.name_ru.toLowerCase().includes(q)) return product;
  }

  return null;
}

/**
 * Возвращает продукты, доступные в текущем сезоне.
 * @param {number} [month] — месяц (1-12), по умолчанию текущий
 * @returns {Product[]}
 */
function getSeasonalProducts(month) {
  const m = month || new Date().getMonth() + 1;
  return Object.values(PRODUCTS).filter((p) => {
    const months = SEASON_MONTHS[p.season];
    return months ? months.includes(m) : true;
  });
}

/**
 * Выбирает случайный элемент из массива.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Возвращает текущую дату в формате DD/MM/YYYY.
 * @returns {string}
 */
function todayFormatted() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${now.getFullYear()}`;
}

/**
 * Возвращает название текущего месяца на испанском.
 * @returns {string}
 */
function currentMonthName() {
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  return months[new Date().getMonth()];
}

/**
 * Возвращает текущий сезон (Южное полушарие) на испанском.
 * @returns {string}
 */
function currentSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 9 && m <= 11) return "primavera";
  if (m === 12 || m <= 2) return "verano";
  if (m >= 3 && m <= 5) return "otono";
  return "invierno";
}

// -- Генераторы сообщений -----------------------------------------------------

/**
 * Генерирует сообщение запуска нового продукта.
 * @param {string} productQuery — название продукта
 * @returns {string}
 */
function generateLaunch(productQuery) {
  const product = findProduct(productQuery);
  if (!product) {
    return `[ERROR] Producto no encontrado: "${productQuery}". Productos disponibles:\n${Object.values(
      PRODUCTS,
    )
      .map((p) => `  - ${p.name_es} (${p.name_ru})`)
      .join("\n")}`;
  }

  const benefits = product.benefits.map((b) => `  - ${b}`).join("\n");

  return [
    `NUEVO! ${product.name_es} de Pepino Pick`,
    "",
    product.usp,
    "",
    benefits,
    "",
    `Disponible desde hoy`,
    `Entrega en Buenos Aires y alrededores`,
    `Pedi por WhatsApp: ${WHATSAPP_LINK}`,
    "",
    `Primeros 10 pedidos: 10% de descuento`,
  ].join("\n");
}

/**
 * Генерирует еженедельное промо-сообщение с доступными продуктами.
 * @param {Product[]} [availableProducts] — продукты со склада (если есть)
 * @returns {string}
 */
function generatePromo(availableProducts) {
  const seasonal = getSeasonalProducts();

  // Делим на категории
  const fresh = seasonal.filter((p) => p.category === "fresh");
  const fermented = seasonal.filter((p) => p.category === "fermented");

  // Выбираем 3 свежих (или сколько есть)
  const freshList = fresh
    .slice(0, 3)
    .map((p) => `  - ${p.name_es}`)
    .join("\n");

  // Список ферментированных
  const fermentedList = fermented.map((p) => `  - ${p.name_es}`).join("\n");

  // Случайный совет
  const tips = [
    "Los fermentados se conservan hasta 3 meses en heladera",
    "Nuestros pepinos en salmuera son ideales para una tabla de picada",
    "El chucrut acompana perfecto un asado del domingo",
    "Las salsas picantes tienen 3 niveles: elegí tu intensidad",
    "Los microverdes tienen 40x mas nutrientes que la verdura adulta",
    "Combina pepinos frescos + pepinos en salmuera en una ensalada",
  ];

  return [
    `FRESCOS DE LA SEMANA - Pepino Pick`,
    "",
    `Esta semana tenemos:`,
    freshList || "  - Consultanos disponibilidad",
    "",
    `FERMENTADOS disponibles:`,
    fermentedList || "  - Consultanos disponibilidad",
    "",
    `Tip de la semana: ${pickRandom(tips)}`,
    "",
    `Pedido minimo: ${MIN_ORDER_KG} kg`,
    `Delivery: martes y jueves`,
    `Pedi: ${WHATSAPP_LINK}`,
  ].join("\n");
}

/**
 * Генерирует сезонное сообщение.
 * @returns {string}
 */
function generateSeasonal() {
  const month = currentMonthName();
  const season = currentSeason();
  const seasonal = getSeasonalProducts();

  const productList = seasonal.map((p) => `  - ${p.name_es} — ${p.usp}`).join("\n");

  const highlights = seasonal.filter((p) => p.category !== "testing").slice(0, 3);

  const highlightSection = highlights.map((p) => `${p.name_es}: ${p.benefits[0]}`).join("\n");

  return [
    `QUE HAY DE TEMPORADA? - ${month} (${season})`,
    "",
    `En Pepino Pick esta es nuestra seleccion de ${month}:`,
    "",
    productList,
    "",
    `Destacados:`,
    highlightSection,
    "",
    `Todos nuestros productos son de invernadero propio.`,
    `Cosecha fresca, fermentacion natural, sin quimicos.`,
    "",
    `Pedidos: ${WHATSAPP_LINK}`,
  ].join("\n");
}

/**
 * Генерирует сообщение реактивации для неактивных клиентов.
 * @returns {Promise<string>} — сообщение (или несколько, по одному на клиента)
 */
async function generateReactivation() {
  /** @type {{ name: string, daysSinceLast: number, products: string[], lastOrder: string|null }[]} */
  let inactiveClients = [];

  try {
    const analysis = await analyzeClients();
    if (analysis && analysis.clients) {
      inactiveClients = analysis.clients
        .filter((c) => c.daysSinceLast >= REACTIVATION_THRESHOLD_DAYS && c.status !== "churned")
        .slice(0, 10);
    }
  } catch (err) {
    console.error(`[whatsapp-marketing] Error al analizar clientes: ${err.message}`);
  }

  if (inactiveClients.length === 0) {
    return [
      `REACTIVACION - No hay clientes inactivos (${REACTIVATION_THRESHOLD_DAYS}+ dias)`,
      "",
      `Todos los clientes realizaron pedidos recientemente.`,
    ].join("\n");
  }

  // Generar un mensaje por cada cliente inactivo
  const newProducts = getSeasonalProducts()
    .filter((p) => p.category !== "testing")
    .slice(0, 2);

  const messages = inactiveClients.map((client) => {
    const novedades = newProducts.map((p) => `  - ${p.name_es}: ${p.usp}`).join("\n");

    return [
      `--- REACTIVACION: ${client.name} ---`,
      "",
      `Hola ${client.name}!`,
      "",
      `Hace ${client.daysSinceLast} dias que no nos pedis nada. Esta todo bien?`,
      "",
      `Te cuento las novedades:`,
      novedades,
      `  - Oferta especial para vos: 10% en tu proximo pedido`,
      "",
      `Si pedis esta semana, te bonificamos el delivery`,
      "",
      `Queres que te arme un pedido como el ultimo? Solo responde "dale"`,
    ].join("\n");
  });

  const header = `REACTIVACION - ${inactiveClients.length} clientes inactivos (${REACTIVATION_THRESHOLD_DAYS}+ dias)\n`;
  return header + "\n" + messages.join("\n\n");
}

/**
 * Генерирует сообщение реферальной программы.
 * @returns {string}
 */
function generateReferral() {
  return [
    `PROGRAMA DE REFERIDOS - Pepino Pick`,
    "",
    `Tenes un amigo restaurador o chef?`,
    "",
    `Por cada referido que haga su primer pedido:`,
    `  Vos recibis: 1 kg de pepinos EN SALMUERA gratis`,
    `  Tu referido recibe: 10% de descuento en su primer pedido`,
    "",
    `Es simple:`,
    `1. Comparti este mensaje con tu contacto`,
    `2. Que nos mencione tu nombre al pedir`,
    `3. Listo! Los dos ganan`,
    "",
    `Pedidos: ${WHATSAPP_LINK}`,
  ].join("\n");
}

/**
 * Генерирует карточку рецепта для случайного продукта.
 * @returns {string}
 */
function generateRecipe() {
  const product = pickRandom(Object.values(PRODUCTS).filter((p) => p.category !== "testing"));
  const recipe = pickRandom(product.recipe_ideas);

  // Мини-рецепты для каждого типа блюда
  /** @type {Record<string, string>} */
  const miniRecipes = {
    "Gazpacho fresco":
      "Pepino + tomate + ajo + aceite de oliva. Licuar todo bien frio. Servir con cubitos de pepino.",
    "Ensalada griega":
      "Pepino + tomate + cebolla morada + aceitunas + queso feta. Aceite de oliva y oregano.",
    "Pepino con hummus": "Cortar pepino en bastones. Servir con hummus casero. Snack perfecto!",
    "Agua de pepino con menta":
      "Rodajas de pepino + hojas de menta + agua fria + hielo. Refrescante!",
    "Bruschetta multicolor":
      "Tostar pan, cubrir con tomates de coleccion cortados + albahaca + aceite de oliva.",
    "Ensalada caprese": "Tomate + mozzarella + albahaca + aceite de oliva. Clasica italiana.",
    "Tabla de encurtidos": "Pepinos en salmuera + aceitunas + queso + embutidos. Ideal para picar.",
    "Sandwich con pepinos": "Pan de centeno + queso crema + pepinos en salmuera + eneldo fresco.",
    "Hot dog gourmet": "Salchicha artesanal + chucrut + mostaza + pan brioche.",
    "Ensalada de chucrut":
      "Chucrut + manzana verde + nueces + aceite de oliva. Fresco y probiotico.",
    "Wings con salsa": "Alitas al horno + nuestra salsa picante nivel 2. Irresistibles!",
    "Risotto de hongos": "Hongos ostra salteados + arroz arborio + caldo + parmesano. Cremoso!",
    "Hongos a la plancha":
      "Hongos ostra a la plancha con ajo, perejil y aceite de oliva. Simple y delicioso.",
    "Ramen con hongos": "Caldo + fideos + hongos ostra + huevo + cebolla de verdeo.",
  };

  const instructions =
    miniRecipes[recipe] ||
    `${recipe}: combina con ${product.name_es} para un plato increible. Consulta la receta completa en nuestras redes!`;

  return [
    `RECETA RAPIDA con ${product.name_es}`,
    "",
    `${recipe}`,
    "",
    instructions,
    "",
    `Dato saludable: ${product.health}`,
    "",
    `Consegui ${product.name_es} en Pepino Pick`,
    `Pedidos: ${WHATSAPP_LINK}`,
  ].join("\n");
}

// -- CLI ----------------------------------------------------------------------

/**
 * Punto de entrada principal.
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filteredArgs = args.filter((a) => a !== "--dry-run");

  const command = (filteredArgs[0] || "").toLowerCase();
  const param = filteredArgs.slice(1).join(" ");

  if (!command) {
    console.log(
      [
        "whatsapp-marketing.cjs — Generador de mensajes de marketing",
        "",
        "Uso:",
        '  node whatsapp-marketing.cjs launch "nombre del producto"',
        '  node whatsapp-marketing.cjs promo "weekly"',
        "  node whatsapp-marketing.cjs seasonal",
        "  node whatsapp-marketing.cjs reactivation",
        "  node whatsapp-marketing.cjs referral",
        "  node whatsapp-marketing.cjs recipe",
        "",
        "Opciones:",
        "  --dry-run    Solo mostrar el mensaje, no enviar a Telegram",
        "",
        "Productos disponibles:",
        ...Object.values(PRODUCTS).map((p) => `  - ${p.name_es} (${p.name_ru})`),
      ].join("\n"),
    );
    process.exit(0);
  }

  const startTime = Date.now();
  let message = "";
  let messageType = command;

  try {
    switch (command) {
      case "launch": {
        if (!param) {
          console.error(
            '[ERROR] Falta el nombre del producto. Ejemplo: node whatsapp-marketing.cjs launch "pepinos en salmuera"',
          );
          process.exit(1);
        }
        message = generateLaunch(param);
        break;
      }

      case "promo": {
        message = generatePromo();
        break;
      }

      case "seasonal": {
        message = generateSeasonal();
        break;
      }

      case "reactivation": {
        message = await generateReactivation();
        break;
      }

      case "referral": {
        message = generateReferral();
        break;
      }

      case "recipe": {
        message = generateRecipe();
        break;
      }

      default:
        console.error(`[ERROR] Comando desconocido: "${command}"`);
        console.error("Comandos: launch, promo, seasonal, reactivation, referral, recipe");
        process.exit(1);
    }
  } catch (err) {
    console.error(`[ERROR] Fallo al generar mensaje "${command}": ${err.message}`);
    process.exit(1);
  }

  // Вывод в stdout для копирования в WhatsApp
  console.log("\n=== MENSAJE DE MARKETING ===\n");
  console.log(message);
  console.log("\n============================\n");

  // Отправка в Telegram (если не dry-run)
  if (!dryRun) {
    try {
      const tgMessage = `[Marketing] ${messageType.toUpperCase()}\n\n${message}`;
      await sendThrottled(tgMessage, {
        thread: TG_TOPIC_MARKETING,
        priority: "normal",
        silent: true,
      });
      console.log(`[OK] Enviado a Telegram (topic #${TG_TOPIC_MARKETING})`);
    } catch (err) {
      console.error(`[WARN] No se pudo enviar a Telegram: ${err.message}`);
    }
  } else {
    console.log("[DRY-RUN] Mensaje no enviado a Telegram");
  }

  // Langfuse trace
  const durationMs = Date.now() - startTime;
  try {
    await trace({
      name: "whatsapp-marketing",
      input: { command, param, dryRun },
      output: { messageLength: message.length, messageType },
      metadata: { skill: "pepino-google-sheets", script: "whatsapp-marketing.cjs" },
      duration_ms: durationMs,
    });
  } catch {
    // Трейсинг не критичен
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
