#!/usr/bin/env node
/**
 * legal-tracker.cjs -- Трекер иммиграционных и легализационных задач Pepino Pick
 *
 * Управляет дедлайнами, документами и трамитами для Roman и жены (Суипача, Аргентина).
 *
 * Команды:
 *   node legal-tracker.cjs status                          # Все задачи
 *   node legal-tracker.cjs add "описание" --deadline 2026-04-15 --category residencia
 *   node legal-tracker.cjs docs                            # Статус документов
 *   node legal-tracker.cjs calendar                        # Ближайшие дедлайны
 *   node legal-tracker.cjs guide "monotributo"             # Пошаговый гайд
 *   node legal-tracker.cjs remind                          # Проверить дедлайны, отправить напоминания
 *   node legal-tracker.cjs done <id>                       # Отметить задачу как выполненную
 *   node legal-tracker.cjs --dry-run status                # Только вывод, без записи/отправки
 *
 * Хранилище: ~/.openclaw/workspace/memory/legal/legal-tasks.json
 * Напоминания: Telegram thread 20 (Директор)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { fmtDate, parseDate } = require("./helpers.cjs");

// ── Конфигурация ────────────────────────────────────────────────────────────

const LEGAL_DIR = path.join(process.env.HOME || "/home/roman", ".openclaw/workspace/memory/legal");
const TASKS_FILE = path.join(LEGAL_DIR, "legal-tasks.json");

/** Тред Директора для напоминаний */
const THREAD_DIRECTOR = 20;

/** Пороги напоминаний (дни до дедлайна) */
const REMINDER_THRESHOLDS = [30, 14, 7, 3, 1];

/** Категории трамитов */
const CATEGORIES = [
  "residencia",
  "monotributo",
  "senasa",
  "municipal",
  "laboral",
  "vehiculo",
  "salud",
  "general",
];

const CATEGORY_LABELS = {
  residencia: "Residencia / DNI",
  monotributo: "Monotributo / AFIP",
  senasa: "SENASA / Inocuidad",
  municipal: "Habilitacion Municipal",
  laboral: "Contratos / ART",
  vehiculo: "Licencia / VTV",
  salud: "Obra Social / PAMI",
  general: "Otros tramites",
};

// ── База знаний: гайды по трамитам ─────────────────────────────────────────

const GUIDES = {
  residencia_temporaria: {
    title: "Residencia Temporaria (2 anos)",
    where: "Direccion Nacional de Migraciones",
    url: "https://www.argentina.gob.ar/interior/migraciones/residir-en-argentina",
    requirements: [
      "Pasaporte vigente",
      "Certificado de antecedentes penales (apostillado)",
      "Partida de nacimiento (apostillada)",
      "Certificado de domicilio (certificacion policial o declaracion jurada)",
      "Seguro de salud",
      "Foto 4x4",
      "Pago de tasa migratoria (verificar monto actual en migraciones.gov.ar)",
      "Turno online en migraciones.gov.ar",
    ],
    steps: [
      "1. Sacar turno online en migraciones.gov.ar",
      "2. Preparar documentacion (apostillar en pais de origen o consulado)",
      "3. Traducir documentos al espanol (traductor publico)",
      "4. Presentarse con turno + documentos en delegacion Migraciones",
      "5. Pagar tasa migratoria",
      "6. Esperar resolucion (30-90 dias)",
      "7. Retirar DNI en delegacion de RENAPER o Correo Argentino",
    ],
    tips: [
      "La precaria (permiso temporal) se otorga el mismo dia del tramite",
      "Con la precaria ya podes trabajar y sacar CUIL",
      "Renovacion: 90 dias antes del vencimiento",
      "Desde Suipacha: delegacion mas cercana en Lujan o CABA",
    ],
    cost_estimate: "~50,000 ARS (tasa 2026, verificar)",
    timeline: "30-90 dias para DNI definitivo",
  },

  dni: {
    title: "DNI (Documento Nacional de Identidad)",
    where: "RENAPER / Registro Civil",
    url: "https://www.argentina.gob.ar/interior/renaper",
    requirements: [
      "Residencia temporaria o permanente aprobada",
      "Turno en mi.argentina.gob.ar o RENAPER",
      "Foto (se toma en el momento)",
    ],
    steps: [
      "1. Esperar aprobacion de residencia",
      "2. Sacar turno en mi.argentina.gob.ar (seccion DNI)",
      "3. Presentarse en oficina de RENAPER",
      "4. Toma de foto y huellas digitales",
      "5. Retirar DNI en 15-30 dias (Correo Argentino o en oficina)",
    ],
    tips: [
      "El DNI es necesario para: abrir cuenta bancaria, monotributo, comprar propiedad",
      "Podes hacer el tramite expres (48hs) con costo adicional",
      "Registro Civil de Suipacha puede gestionar turnos RENAPER",
    ],
    cost_estimate: "~5,000 ARS (tramite normal), ~15,000 ARS (expres)",
    timeline: "15-30 dias (normal), 48hs (expres)",
  },

  monotributo: {
    title: "Monotributo (Regimen Simplificado)",
    where: "AFIP (afip.gob.ar)",
    url: "https://www.afip.gob.ar/monotributo/",
    requirements: [
      "CUIL o CUIT",
      "DNI argentino",
      "Domicilio fiscal",
      "Clave fiscal nivel 2+ (se saca en AFIP presencial)",
    ],
    steps: [
      "1. Obtener CUIL (con precaria o DNI, en ANSES)",
      "2. Obtener clave fiscal nivel 2 (ir a AFIP con DNI)",
      "3. Sacar CUIT en afip.gob.ar",
      "4. Inscribirse en Monotributo desde afip.gob.ar",
      "5. Elegir categoria (A-K segun facturacion)",
      "6. Adherir obra social (opcional pero recomendado)",
      "7. Pagar mensualmente (VEP o debito automatico)",
    ],
    categories: [
      "A: hasta $2,108,288/ano -- cuota ~$13,000/mes (2026)",
      "B: hasta $3,133,941/ano -- cuota ~$15,000/mes",
      "C: hasta $4,387,518/ano -- cuota ~$17,500/mes",
      "D: hasta $5,449,094/ano -- cuota ~$21,000/mes",
      "E-K: montos mayores (verificar en afip.gob.ar)",
    ],
    tips: [
      "Factura C para consumidores finales",
      "Factura B para otros monotributistas/RI",
      "Recategorizacion: enero y julio de cada ano",
      "Desde Suipacha: AFIP mas cercano en Mercedes o Lujan",
      "Componente impositivo + obra social + jubilacion incluidos",
    ],
    cost_estimate: "Cuota mensual segun categoria (ver arriba)",
    timeline: "1-2 semanas (si ya tenes CUIT y clave fiscal)",
  },

  cuil: {
    title: "CUIL (Clave Unica de Identificacion Laboral)",
    where: "ANSES (anses.gob.ar)",
    url: "https://www.anses.gob.ar/cuil",
    requirements: ["DNI o residencia precaria", "Pasaporte"],
    steps: [
      "1. Ir a oficina de ANSES con DNI/precaria y pasaporte",
      "2. Solicitar asignacion de CUIL",
      "3. El CUIL se asigna en el momento",
      "4. Consultar online: anses.gob.ar/consulta/constancia-de-cuil",
    ],
    tips: [
      "Se puede hacer el mismo dia que recibes la precaria",
      "Es gratuito",
      "CUIL es prerequisito para CUIT y monotributo",
      "ANSES mas cercano: Mercedes o Lujan",
    ],
    cost_estimate: "Gratuito",
    timeline: "Inmediato (en oficina)",
  },

  senasa_habilitacion: {
    title: "Habilitacion SENASA (produccion de alimentos)",
    where: "SENASA (senasa.gob.ar)",
    url: "https://www.argentina.gob.ar/senasa",
    requirements: [
      "CUIT activo",
      "Establecimiento con condiciones sanitarias",
      "Registro Nacional Sanitario de Productores Agropecuarios (RENSPA)",
      "Plan de manejo de inocuidad",
      "Agua potable certificada",
    ],
    steps: [
      "1. Obtener RENSPA en senasa.gob.ar",
      "2. Solicitar inspeccion de establecimiento",
      "3. Cumplir requisitos de BPM (Buenas Practicas de Manufactura)",
      "4. Habilitacion para elaboracion de conservas (si aplica)",
      "5. Registro de productos (encurtidos, fermentados)",
    ],
    tips: [
      "Fermentados/encurtidos requieren habilitacion especial",
      "Inspeccion puede demorar 30-60 dias",
      "Bromatologia municipal es adicional a SENASA",
      "Consultar con INTA Suipacha para asesoramiento gratuito",
      "RENSPA es gratuito y obligatorio para todo productor agropecuario",
    ],
    cost_estimate: "Variable (tasa de inspeccion + habilitacion)",
    timeline: "30-60 dias (inspeccion + resolucion)",
  },

  renspa: {
    title: "RENSPA (Registro Nacional Sanitario de Productores Agropecuarios)",
    where: "SENASA (senasa.gob.ar)",
    url: "https://aps2.senasa.gob.ar/renspa",
    requirements: [
      "CUIT activo",
      "Datos del establecimiento (ubicacion, superficie)",
      "Tipo de produccion",
    ],
    steps: [
      "1. Ingresar a aps2.senasa.gob.ar/renspa con clave fiscal",
      "2. Completar datos del establecimiento",
      "3. Indicar tipo de produccion (horticola, etc.)",
      "4. Obtener numero RENSPA",
    ],
    tips: [
      "Es gratuito y obligatorio",
      "Se renueva cada 2 anos",
      "Prerequisito para habilitacion SENASA",
    ],
    cost_estimate: "Gratuito",
    timeline: "Inmediato (online)",
  },

  habilitacion_municipal: {
    title: "Habilitacion Municipal (Suipacha)",
    where: "Municipalidad de Suipacha",
    url: "https://www.suipacha.gob.ar",
    requirements: [
      "CUIT",
      "Habilitacion SENASA (si corresponde)",
      "Plano del establecimiento",
      "Certificado de aptitud ambiental",
      "Seguro de responsabilidad civil",
      "Libre deuda municipal",
    ],
    steps: [
      "1. Consultar en oficina de habilitaciones de la Municipalidad",
      "2. Presentar documentacion",
      "3. Inspeccion del establecimiento",
      "4. Pago de tasa de habilitacion",
      "5. Obtener certificado",
    ],
    tips: [
      "Habilitacion de bromatologia es separada",
      "Consultar horarios: lun-vie 7:00-13:00 generalmente",
      "Renovacion anual",
    ],
    cost_estimate: "Variable (tasa municipal)",
    timeline: "15-30 dias",
  },

  bromatologia: {
    title: "Habilitacion Bromatologica (elaboracion de alimentos)",
    where: "Bromatologia Municipal / Provincial",
    requirements: [
      "CUIT",
      "Libreta sanitaria vigente",
      "Habilitacion municipal del local",
      "Analisis de agua potable",
      "Plan de BPM",
      "Carnet de manipulador de alimentos",
    ],
    steps: [
      "1. Obtener carnet de manipulador de alimentos (curso gratuito)",
      "2. Realizar analisis de agua del establecimiento",
      "3. Presentar documentacion en bromatologia municipal",
      "4. Inspeccion del lugar de elaboracion",
      "5. Obtener habilitacion bromatologica",
    ],
    tips: [
      "Obligatorio para vender alimentos elaborados (fermentados, conservas)",
      "Carnet de manipulador: curso gratuito en municipalidad",
      "Productos envasados requieren rotulado segun Codigo Alimentario Argentino",
      "RNE (Registro Nacional de Establecimiento) si vendes fuera del municipio",
      "RNPA (Registro Nacional de Producto Alimenticio) por cada producto",
    ],
    cost_estimate: "~10,000-30,000 ARS (analisis + tasas)",
    timeline: "30-60 dias",
  },

  licencia_conducir: {
    title: "Licencia de Conducir (Suipacha)",
    where: "Municipalidad de Suipacha / Direccion de Transito",
    requirements: [
      "DNI argentino",
      "Certificado de domicilio",
      "Examen psicofisico",
      "Curso de educacion vial",
      "Examen teorico y practico",
    ],
    steps: [
      "1. Sacar turno en municipalidad",
      "2. Realizar examen psicofisico (en municipalidad)",
      "3. Completar curso de educacion vial",
      "4. Rendir examen teorico",
      "5. Rendir examen practico",
      "6. Retirar licencia",
    ],
    tips: [
      "Licencia original (no canje) si no tenes licencia argentina previa",
      "Canje de licencia extranjera: solo si hay convenio bilateral (Rusia no tiene)",
      "Categoria B para auto particular",
    ],
    cost_estimate: "~15,000-25,000 ARS",
    timeline: "1-2 semanas",
  },

  obra_social: {
    title: "Obra Social (a traves de Monotributo)",
    where: "Obra social elegida + AFIP",
    requirements: ["Monotributo activo", "DNI", "Formulario de opcion de obra social"],
    steps: [
      "1. Elegir obra social de la lista de Superintendencia de Servicios de Salud",
      "2. Presentar opcion de cambio (si ya tenes una asignada)",
      "3. Esperar 3 meses para efectivizar cambio",
      "4. Tramitar credencial en la obra social elegida",
    ],
    tips: [
      "Con monotributo ya tenes cobertura basica incluida",
      "Podes sumar aportes para plan superior",
      "Cambio de obra social: solo 1 vez por ano",
      "Alternativa: prepaga privada (Swiss Medical, OSDE, etc.)",
    ],
    cost_estimate: "Incluido en cuota de monotributo",
    timeline: "Inmediato (con monotributo activo), 3 meses para cambio",
  },
};

/** Mapa de alias para busqueda de guias */
const GUIDE_ALIASES = {
  residencia: "residencia_temporaria",
  temporaria: "residencia_temporaria",
  precaria: "residencia_temporaria",
  documento: "dni",
  identidad: "dni",
  afip: "monotributo",
  impuestos: "monotributo",
  factura: "monotributo",
  senasa: "senasa_habilitacion",
  inocuidad: "senasa_habilitacion",
  municipal: "habilitacion_municipal",
  habilitacion: "habilitacion_municipal",
  bromatologia: "bromatologia",
  alimentos: "bromatologia",
  licencia: "licencia_conducir",
  conducir: "licencia_conducir",
  auto: "licencia_conducir",
  salud: "obra_social",
  prepaga: "obra_social",
  renspa: "renspa",
  cuil: "cuil",
  cuit: "monotributo",
};

// ── Хранилище задач ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} LegalTask
 * @property {string} id - Уникальный ID (8 символов hex)
 * @property {string} description - Описание задачи
 * @property {string} category - Категория (из CATEGORIES)
 * @property {string} person - "roman" | "wife" | "both"
 * @property {string|null} deadline - Дедлайн (ISO date string)
 * @property {string|null} expiresAt - Дата истечения документа
 * @property {string} status - "pending" | "in_progress" | "done" | "blocked"
 * @property {string} createdAt - Дата создания (ISO)
 * @property {string|null} completedAt - Дата завершения (ISO)
 * @property {string[]} notes - Заметки
 * @property {number[]} remindedDays - Дни, по которым уже отправлены напоминания
 */

/**
 * @typedef {Object} LegalStore
 * @property {LegalTask[]} tasks
 * @property {Object<string, {name: string, status: string, expiresAt: string|null, person: string}>} documents
 * @property {string} updatedAt
 */

/** Загружает хранилище задач */
function loadStore() {
  /** @type {LegalStore} */
  const empty = { tasks: [], documents: {}, updatedAt: new Date().toISOString() };
  try {
    if (!fs.existsSync(TASKS_FILE)) return empty;
    const raw = fs.readFileSync(TASKS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return { ...empty, ...data };
  } catch {
    return empty;
  }
}

/** Сохраняет хранилище задач */
function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  if (!fs.existsSync(LEGAL_DIR)) {
    fs.mkdirSync(LEGAL_DIR, { recursive: true });
  }
  fs.writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

/** Генерирует уникальный ID для задачи */
function genId() {
  return crypto.randomBytes(4).toString("hex");
}

// ── Утилиты дат ─────────────────────────────────────────────────────────────

/** Текущая дата в Аргентине (UTC-3) */
function nowArgentina() {
  const now = new Date();
  return new Date(now.getTime() + (-3 - now.getTimezoneOffset() / 60) * 3600000);
}

/** Количество дней между двумя датами (положительное = в будущем) */
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const target = new Date(dateStr);
  const now = nowArgentina();
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/** Форматирует дату для вывода */
function formatDate(dateStr) {
  if (!dateStr) return "---";
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Эмодзи статуса */
function statusEmoji(status) {
  const map = {
    pending: "[ ]",
    in_progress: "[~]",
    done: "[x]",
    blocked: "[!]",
  };
  return map[status] || "[ ]";
}

/** Срочность по дням до дедлайна */
function urgencyLabel(days) {
  if (days < 0) return "VENCIDO";
  if (days <= 3) return "URGENTE";
  if (days <= 7) return "PRONTO";
  if (days <= 14) return "ATENCION";
  if (days <= 30) return "PLANIFICAR";
  return "";
}

// ── Команды ─────────────────────────────────────────────────────────────────

/** Показать все задачи (с фильтром по категории) */
function cmdStatus(store, filterCategory) {
  const tasks = store.tasks.filter((t) => {
    if (filterCategory && t.category !== filterCategory) return false;
    return true;
  });

  if (tasks.length === 0) {
    console.log("No hay tareas registradas.");
    console.log(
      'Agregar: node legal-tracker.cjs add "descripcion" --deadline 2026-04-15 --category residencia',
    );
    return;
  }

  // Сортировка: сначала по статусу (pending/in_progress перед done), потом по дедлайну
  const statusOrder = { blocked: 0, pending: 1, in_progress: 2, done: 3 };
  tasks.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 1;
    const sb = statusOrder[b.status] ?? 1;
    if (sa !== sb) return sa - sb;
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return da - db;
  });

  console.log("=== LEGAL TRACKER - Pepino Pick ===\n");

  /** @type {Object<string, LegalTask[]>} */
  const byCategory = {};
  for (const t of tasks) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }

  for (const [cat, catTasks] of Object.entries(byCategory)) {
    const label = CATEGORY_LABELS[cat] || cat;
    console.log(`--- ${label} ---`);
    for (const t of catTasks) {
      const days = daysUntil(t.deadline);
      const urg = urgencyLabel(days);
      const urgStr = urg ? ` [${urg}]` : "";
      const deadlineStr = t.deadline ? ` | vence: ${formatDate(t.deadline)}` : "";
      const personStr = t.person !== "both" ? ` (${t.person})` : "";
      console.log(
        `  ${statusEmoji(t.status)} [${t.id}] ${t.description}${personStr}${deadlineStr}${urgStr}`,
      );
    }
    console.log("");
  }

  // Счётчики
  const pending = tasks.filter((t) => t.status === "pending").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const done = tasks.filter((t) => t.status === "done").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const overdue = tasks.filter((t) => t.status !== "done" && daysUntil(t.deadline) < 0).length;

  console.log(
    `Total: ${tasks.length} | Pendiente: ${pending} | En curso: ${inProgress} | Hecho: ${done} | Bloqueado: ${blocked}`,
  );
  if (overdue > 0) {
    console.log(`ATENCION: ${overdue} tarea(s) vencida(s)`);
  }
}

/** Добавить новую задачу */
function cmdAdd(store, description, options, dryRun) {
  const category = options.category || "general";
  if (!CATEGORIES.includes(category)) {
    console.error(`Categoria invalida: "${category}". Opciones: ${CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  /** @type {LegalTask} */
  const task = {
    id: genId(),
    description,
    category,
    person: options.person || "both",
    deadline: options.deadline || null,
    expiresAt: options.expires || null,
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    notes: options.note ? [options.note] : [],
    remindedDays: [],
  };

  if (dryRun) {
    console.log("[DRY-RUN] Se crearia la tarea:");
    console.log(JSON.stringify(task, null, 2));
    return task;
  }

  store.tasks.push(task);
  saveStore(store);
  console.log(`Tarea creada: [${task.id}] ${task.description}`);
  if (task.deadline) {
    console.log(`  Deadline: ${formatDate(task.deadline)} (${daysUntil(task.deadline)} dias)`);
  }
  return task;
}

/** Отметить задачу как выполненную */
function cmdDone(store, taskId, dryRun) {
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Tarea no encontrada: ${taskId}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Se marcaria como hecha: [${task.id}] ${task.description}`);
    return;
  }

  task.status = "done";
  task.completedAt = new Date().toISOString();
  saveStore(store);
  console.log(`Hecho: [${task.id}] ${task.description}`);
}

/** Показать статус документов */
function cmdDocs(store) {
  console.log("=== DOCUMENTOS ===\n");

  const docs = store.documents || {};
  if (Object.keys(docs).length === 0) {
    console.log("No hay documentos registrados.");
    console.log("\nDocumentos tipicos para agregar:");
    console.log("  - Pasaporte (Roman / esposa)");
    console.log("  - Residencia precaria / temporaria");
    console.log("  - DNI");
    console.log("  - CUIL / CUIT");
    console.log("  - Monotributo");
    console.log("  - Licencia de conducir");
    console.log("  - RENSPA");
    console.log("  - Habilitacion municipal");
    console.log("  - Seguro de salud");
    return;
  }

  for (const [key, doc] of Object.entries(docs)) {
    const expiresStr = doc.expiresAt ? ` | vence: ${formatDate(doc.expiresAt)}` : "";
    const days = daysUntil(doc.expiresAt);
    const urg = days !== Infinity ? ` (${days} dias)` : "";
    const warning = days < 30 && days >= 0 ? " <- RENOVAR PRONTO" : "";
    const expired = days < 0 ? " <- VENCIDO" : "";
    console.log(
      `  [${doc.status === "vigente" ? "x" : " "}] ${doc.name} (${doc.person})${expiresStr}${urg}${warning}${expired}`,
    );
  }
}

/** Показать календарь дедлайнов */
function cmdCalendar(store) {
  const upcoming = store.tasks
    .filter((t) => t.status !== "done" && t.deadline)
    .map((t) => ({ ...t, daysLeft: daysUntil(t.deadline) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // Также добавить документы с датой истечения
  const docItems = Object.values(store.documents || {})
    .filter((d) => d.expiresAt)
    .map((d) => ({
      description: `[DOC] ${d.name} (${d.person}) - vencimiento`,
      deadline: d.expiresAt,
      daysLeft: daysUntil(d.expiresAt),
      category: "general",
      status: "doc",
    }));

  const all = [...upcoming, ...docItems].sort((a, b) => a.daysLeft - b.daysLeft);

  if (all.length === 0) {
    console.log("No hay fechas pendientes.");
    return;
  }

  console.log("=== CALENDARIO LEGAL ===\n");

  // Группировка: просроченные, эта неделя, этот месяц, далее
  const overdue = all.filter((t) => t.daysLeft < 0);
  const thisWeek = all.filter((t) => t.daysLeft >= 0 && t.daysLeft <= 7);
  const thisMonth = all.filter((t) => t.daysLeft > 7 && t.daysLeft <= 30);
  const later = all.filter((t) => t.daysLeft > 30);

  if (overdue.length > 0) {
    console.log("*** VENCIDOS ***");
    for (const t of overdue) {
      console.log(
        `  ${formatDate(t.deadline)} | ${t.description} (${Math.abs(t.daysLeft)} dias atrasado)`,
      );
    }
    console.log("");
  }

  if (thisWeek.length > 0) {
    console.log("--- Esta semana ---");
    for (const t of thisWeek) {
      console.log(`  ${formatDate(t.deadline)} | ${t.description} (${t.daysLeft} dias)`);
    }
    console.log("");
  }

  if (thisMonth.length > 0) {
    console.log("--- Este mes ---");
    for (const t of thisMonth) {
      console.log(`  ${formatDate(t.deadline)} | ${t.description} (${t.daysLeft} dias)`);
    }
    console.log("");
  }

  if (later.length > 0) {
    console.log("--- Mas adelante ---");
    for (const t of later) {
      console.log(`  ${formatDate(t.deadline)} | ${t.description} (${t.daysLeft} dias)`);
    }
    console.log("");
  }
}

/** Показать гайд по трамиту */
function cmdGuide(query) {
  if (!query) {
    console.log("=== GUIAS DISPONIBLES ===\n");
    for (const [key, guide] of Object.entries(GUIDES)) {
      console.log(`  ${key} -- ${guide.title}`);
    }
    console.log("\nUso: node legal-tracker.cjs guide <nombre>");
    console.log(
      "Aliases: residencia, monotributo, senasa, municipal, bromatologia, licencia, cuil, renspa, etc.",
    );
    return;
  }

  const normalized = query.toLowerCase().replace(/[^a-z_]/g, "");
  const guideKey = GUIDE_ALIASES[normalized] || normalized;
  const guide = GUIDES[guideKey];

  if (!guide) {
    console.error(`Guia no encontrada: "${query}"`);
    console.log("Guias disponibles:");
    for (const key of Object.keys(GUIDES)) {
      console.log(`  - ${key}`);
    }
    process.exit(1);
  }

  console.log(`\n=== ${guide.title} ===`);
  console.log(`Donde: ${guide.where}`);
  if (guide.url) console.log(`Web: ${guide.url}`);
  if (guide.cost_estimate) console.log(`Costo estimado: ${guide.cost_estimate}`);
  if (guide.timeline) console.log(`Plazo: ${guide.timeline}`);

  console.log("\n--- Requisitos ---");
  for (const req of guide.requirements) {
    console.log(`  - ${req}`);
  }

  console.log("\n--- Pasos ---");
  for (const step of guide.steps) {
    console.log(`  ${step}`);
  }

  if (guide.categories) {
    console.log("\n--- Categorias ---");
    for (const cat of guide.categories) {
      console.log(`  ${cat}`);
    }
  }

  if (guide.tips && guide.tips.length > 0) {
    console.log("\n--- Tips ---");
    for (const tip of guide.tips) {
      console.log(`  * ${tip}`);
    }
  }
}

/** Проверить дедлайны и отправить напоминания */
async function cmdRemind(store, dryRun) {
  const now = nowArgentina();
  const alerts = [];

  // Проверяем задачи с дедлайнами
  for (const task of store.tasks) {
    if (task.status === "done") continue;
    if (!task.deadline) continue;

    const days = daysUntil(task.deadline);

    // Просроченные
    if (days < 0) {
      alerts.push({
        type: "overdue",
        message: `VENCIDO (${Math.abs(days)}d): ${task.description}`,
        task,
        days,
        priority: "CRITICAL",
      });
      continue;
    }

    // Проверяем пороги напоминаний
    for (const threshold of REMINDER_THRESHOLDS) {
      if (days <= threshold && !(task.remindedDays || []).includes(threshold)) {
        alerts.push({
          type: "reminder",
          message: `${urgencyLabel(days)} (${days}d): ${task.description}`,
          task,
          days,
          threshold,
          priority: days <= 3 ? "P1" : "normal",
        });
        // Отмечаем, что напоминание по этому порогу отправлено
        if (!dryRun) {
          if (!task.remindedDays) task.remindedDays = [];
          task.remindedDays.push(threshold);
        }
        break; // Только одно напоминание за раз
      }
    }
  }

  // Проверяем документы с датой истечения
  const docs = store.documents || {};
  for (const [key, doc] of Object.entries(docs)) {
    if (!doc.expiresAt) continue;
    const days = daysUntil(doc.expiresAt);

    if (days < 0) {
      alerts.push({
        type: "doc_expired",
        message: `DOCUMENTO VENCIDO: ${doc.name} (${doc.person}) -- vencio hace ${Math.abs(days)} dias`,
        days,
        priority: "CRITICAL",
      });
    } else if (days <= 30) {
      alerts.push({
        type: "doc_expiring",
        message: `Documento por vencer (${days}d): ${doc.name} (${doc.person})`,
        days,
        priority: days <= 7 ? "P1" : "normal",
      });
    }
  }

  if (alerts.length === 0) {
    console.log("Sin alertas pendientes.");
    return;
  }

  // Формируем сводное сообщение
  const header = "LEGAL TRACKER -- Alertas\n";
  const lines = alerts.map((a) => `- ${a.message}`);
  const footer = `\n${alerts.length} alerta(s) | ${formatDate(now.toISOString())}`;
  const fullMessage = header + lines.join("\n") + footer;

  console.log(fullMessage);

  if (dryRun) {
    console.log("\n[DRY-RUN] No se envian notificaciones.");
    return;
  }

  // Отправляем в Telegram
  try {
    await sendThrottled(fullMessage, {
      thread: THREAD_DIRECTOR,
      priority: alerts.some((a) => a.priority === "CRITICAL") ? "CRITICAL" : "normal",
    });
    console.log("Notificacion enviada a Telegram (thread 20).");
  } catch (err) {
    console.error("Error enviando notificacion:", err.message);
  }

  // Сохраняем состояние (отметки о напоминаниях)
  saveStore(store);
}

// ── Парсинг аргументов ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    positional: [],
    options: {},
    dryRun: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--dry-run") {
      result.dryRun = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        result.options[key] = val;
        i += 2;
      } else {
        result.options[key] = true;
        i++;
      }
      continue;
    }

    if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const parsed = parseArgs(process.argv);
  const dryRun = parsed.dryRun;
  const store = loadStore();

  if (dryRun) {
    console.log("[DRY-RUN] Modo de prueba -- sin escrituras ni envios\n");
  }

  try {
    switch (parsed.command) {
      case "status":
        cmdStatus(store, parsed.options.category);
        break;

      case "add": {
        const desc = parsed.positional[0];
        if (!desc) {
          console.error(
            'Uso: node legal-tracker.cjs add "descripcion" --deadline 2026-04-15 --category residencia',
          );
          process.exit(1);
        }
        cmdAdd(store, desc, parsed.options, dryRun);
        break;
      }

      case "done": {
        const taskId = parsed.positional[0];
        if (!taskId) {
          console.error("Uso: node legal-tracker.cjs done <id>");
          process.exit(1);
        }
        cmdDone(store, taskId, dryRun);
        break;
      }

      case "docs":
        cmdDocs(store);
        break;

      case "calendar":
        cmdCalendar(store);
        break;

      case "guide":
        cmdGuide(parsed.positional[0]);
        break;

      case "remind":
        await cmdRemind(store, dryRun);
        break;

      default:
        console.log("Legal Tracker -- Pepino Pick");
        console.log("");
        console.log("Comandos:");
        console.log("  status                    Mostrar todas las tareas");
        console.log('  add "desc" --deadline ...  Agregar tarea');
        console.log("  done <id>                 Marcar tarea como hecha");
        console.log("  docs                      Estado de documentos");
        console.log("  calendar                  Calendario de vencimientos");
        console.log("  guide [tema]              Guia paso a paso");
        console.log("  remind                    Verificar y enviar alertas");
        console.log("");
        console.log("Opciones:");
        console.log("  --dry-run                 Modo de prueba");
        console.log("  --category <cat>          Filtrar por categoria");
        console.log("  --deadline <YYYY-MM-DD>   Fecha limite");
        console.log("  --person <roman|wife|both> Persona");
        console.log("  --expires <YYYY-MM-DD>    Fecha de vencimiento de documento");
        console.log('  --note "texto"             Nota adicional');
        console.log("");
        console.log(`Categorias: ${CATEGORIES.join(", ")}`);
        console.log(`Guias: ${Object.keys(GUIDES).join(", ")}`);
        console.log(`Almacenamiento: ${TASKS_FILE}`);
        break;
    }
  } finally {
    // Langfuse trace
    const duration = Date.now() - startTime;
    await trace({
      name: "legal-tracker",
      input: { command: parsed.command, options: parsed.options, dryRun },
      output: { duration_ms: duration },
      metadata: { skill: "pepino-google-sheets", script: "legal-tracker.cjs" },
      duration_ms: duration,
    }).catch(() => {
      /* тихий fallback -- Langfuse не критичен */
    });
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
