#!/usr/bin/env node
/**
 * immigration-agent.cjs -- Comprehensive immigration management for Roman & Tatiana
 *
 * Tracks residencia, DNI, documents, deadlines, and provides strategy for permanent residency.
 * Designed for Russian citizens living in Suipacha, Buenos Aires Province.
 *
 * Commands:
 *   node immigration-agent.cjs status          # Current immigration status for both
 *   node immigration-agent.cjs timeline        # All deadlines and upcoming tasks
 *   node immigration-agent.cjs renew-dni       # Step-by-step DNI renewal guide
 *   node immigration-agent.cjs permanent       # Strategy for permanent residency
 *   node immigration-agent.cjs documents       # Document checklist with status
 *   node immigration-agent.cjs risks           # Risk assessment
 *   node immigration-agent.cjs monitor         # Check immigration news/updates
 *   node immigration-agent.cjs --dry-run status
 *
 * Storage: ~/.openclaw/workspace/memory/legal/immigration-status.json
 * Reminders: Telegram thread 20 (Director)
 *
 * Cron:
 *   Monthly (1st): status check + reminder
 *   Weekly (Wednesday): monitor immigration news
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { sendThrottled } = require("./notification-throttle.cjs");
const { trace } = require("./langfuse-trace.cjs");
const { fmtDate, parseDate, daysBetween } = require("./helpers.cjs");

// ── Configuration ────────────────────────────────────────────────────────────

const LEGAL_DIR = path.join(process.env.HOME || "/home/roman", ".openclaw/workspace/memory/legal");
const STATUS_FILE = path.join(LEGAL_DIR, "immigration-status.json");

/** Director thread for notifications */
const THREAD_DIRECTOR = 20;

/** Argentina UTC offset */
const AR_UTC_OFFSET = -3;

/** Reminder thresholds in days */
const REMINDER_DAYS = [90, 60, 30, 14, 7, 3, 1];

// ── Default state ────────────────────────────────────────────────────────────

const DEFAULT_STATE = {
  persons: [
    {
      name: "Roman Trubenkov",
      nationality: "Russian",
      dni_number: null,
      dni_type: "temporaria",
      dni_expiry: null,
      cuit: null,
      cuil: null,
      renaper_tramite: "00736114358",
      monotributo: false,
      precaria: null,
      residencia_type: "temporaria",
      residencia_since: null,
      residencia_expiry: null,
      documents: {
        pasaporte: { status: "vigente", expiry: null, note: null },
        antecedentes_ru: {
          status: "pendiente",
          expiry: null,
          note: "Obtener via consulado ruso BA",
        },
        antecedentes_ar: {
          status: "pendiente",
          expiry: null,
          note: "Registro Nacional de Reincidencia",
        },
        partida_nacimiento: { status: "apostillada", expiry: null, note: null },
        certificado_domicilio: { status: "pendiente", expiry: null, note: "Comisaria Suipacha" },
        seguro_salud: { status: "pendiente", expiry: null, note: null },
      },
      tasks: [],
    },
    {
      name: "Tatiana Trubenkova",
      nationality: "Russian",
      dni_number: null,
      dni_type: "temporaria",
      dni_expiry: null,
      cuit: "20-60484615-4",
      cuil: null,
      renaper_tramite: null,
      monotributo: true,
      precaria: null,
      residencia_type: "temporaria",
      residencia_since: null,
      residencia_expiry: null,
      documents: {
        pasaporte: { status: "vigente", expiry: null, note: null },
        antecedentes_ru: {
          status: "pendiente",
          expiry: null,
          note: "Obtener via consulado ruso BA",
        },
        antecedentes_ar: { status: "pendiente", expiry: null, note: null },
        partida_nacimiento: { status: "apostillada", expiry: null, note: null },
        certificado_domicilio: { status: "pendiente", expiry: null, note: null },
        seguro_salud: {
          status: "pendiente",
          expiry: null,
          note: "Monotributo incluye obra social",
        },
      },
      tasks: [],
    },
  ],
  timeline: [],
  last_check: null,
  last_monitor: null,
};

// ── Date utilities ───────────────────────────────────────────────────────────

/** Current date in Argentina (UTC-3) */
function nowArgentina() {
  const now = new Date();
  return new Date(now.getTime() + (AR_UTC_OFFSET - now.getTimezoneOffset() / 60) * 3600000);
}

/** Days until a target date (positive = future, negative = past) */
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return Infinity;
  const now = nowArgentina();
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Format date as DD/MM/YYYY */
function fmtDateLocal(dateStr) {
  if (!dateStr) return "---";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "---";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Format date as YYYY-MM-DD */
function fmtDateISO(d) {
  if (!d) return "---";
  if (typeof d === "string") d = new Date(d);
  if (isNaN(d.getTime())) return "---";
  return d.toISOString().slice(0, 10);
}

/** Urgency emoji based on days remaining */
function urgencyIcon(days) {
  if (days === Infinity) return "  ";
  if (days < 0) return "\u{1F534}"; // red circle
  if (days <= 7) return "\u{1F534}"; // red
  if (days <= 30) return "\u{1F7E1}"; // yellow
  if (days <= 90) return "\u{1F7E0}"; // orange
  return "\u{1F7E2}"; // green
}

/** Urgency label */
function urgencyLabel(days) {
  if (days === Infinity) return "";
  if (days < 0) return "VENCIDO";
  if (days <= 3) return "URGENTE";
  if (days <= 7) return "ESTA SEMANA";
  if (days <= 14) return "PRONTO";
  if (days <= 30) return "PLANIFICAR";
  if (days <= 90) return "EN AGENDA";
  return "OK";
}

// ── Storage ──────────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const raw = fs.readFileSync(STATUS_FILE, "utf-8");
    const data = JSON.parse(raw);
    // Merge with defaults to handle schema evolution
    const merged = JSON.parse(JSON.stringify(DEFAULT_STATE));
    if (data.persons && Array.isArray(data.persons)) {
      for (let i = 0; i < Math.min(data.persons.length, merged.persons.length); i++) {
        merged.persons[i] = { ...merged.persons[i], ...data.persons[i] };
        // Deep merge documents
        if (data.persons[i].documents) {
          merged.persons[i].documents = {
            ...merged.persons[i].documents,
            ...data.persons[i].documents,
          };
        }
      }
    }
    if (data.timeline) merged.timeline = data.timeline;
    if (data.last_check) merged.last_check = data.last_check;
    if (data.last_monitor) merged.last_monitor = data.last_monitor;
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  state.last_check = new Date().toISOString();
  if (!fs.existsSync(LEGAL_DIR)) {
    fs.mkdirSync(LEGAL_DIR, { recursive: true });
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ── HTTP helper (no deps) ────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("HTTP timeout")));
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** STATUS: current immigration status for both persons */
function cmdStatus(state) {
  const now = nowArgentina();
  const dateStr = fmtDateLocal(now.toISOString());

  console.log(`\n\u{1F6C2} IMMIGRATION STATUS -- ${dateStr}\n`);

  for (const person of state.persons) {
    console.log(`\u{1F464} ${person.name}`);
    console.log(`  \u{1F4CB} Residencia: ${capitalize(person.residencia_type)}`);

    // DNI
    const dniNum = person.dni_number || "[no registrado]";
    const dniExpiry = person.dni_expiry ? fmtDateLocal(person.dni_expiry) : "[fecha no registrada]";
    const dniDays = daysUntil(person.dni_expiry);
    const dniIcon = urgencyIcon(dniDays);
    console.log(`  \u{1F194} DNI: ${dniNum} -- vence: ${dniExpiry}`);

    if (dniDays !== Infinity) {
      if (dniDays < 0) {
        console.log(
          `  ${dniIcon} VENCIDO hace ${Math.abs(dniDays)} dias -- RENOVAR INMEDIATAMENTE`,
        );
      } else if (dniDays <= 90) {
        console.log(`  ${dniIcon} Renovar en: ${dniDays} dias`);
      } else {
        console.log(`  ${dniIcon} Vigente (${dniDays} dias restantes)`);
      }
    }

    // RENAPER tramite
    if (person.renaper_tramite) {
      console.log(`  \u{1F4C4} RENAPER tramite: ${person.renaper_tramite}`);
    }

    // Monotributo / CUIT
    if (person.monotributo) {
      console.log(`  \u{1F4BC} CUIT: ${person.cuit || "---"} (Monotributo activo)`);
    } else {
      console.log(`  \u{1F4CA} Monotributo: No`);
      if (!person.cuit) {
        console.log(`  \u{1F7E1} ACCION: Considerar inscripcion en Monotributo`);
      }
    }

    // Precaria
    if (person.precaria) {
      console.log(`  \u{1F4DD} Precaria: vigente hasta ${fmtDateLocal(person.precaria)}`);
    }

    // Overall status
    const issues = getPersonIssues(person);
    if (issues.length === 0) {
      console.log(`  \u{1F7E2} Estado: OK`);
    } else {
      for (const issue of issues) {
        console.log(`  ${issue.icon} ${issue.action}`);
      }
    }

    console.log("");
  }

  // Upcoming deadlines summary
  const deadlines = getAllDeadlines(state);
  if (deadlines.length > 0) {
    console.log(`\u{1F4C5} PROXIMOS VENCIMIENTOS:`);
    for (const dl of deadlines.slice(0, 8)) {
      console.log(`  ${dl.icon} ${dl.label}: ${dl.detail}`);
    }
    console.log("");
  }
}

/** TIMELINE: all deadlines sorted by urgency */
function cmdTimeline(state) {
  console.log("\n\u{1F4C5} TIMELINE MIGRATORIO\n");

  const deadlines = getAllDeadlines(state);

  if (deadlines.length === 0) {
    console.log("No hay fechas registradas.");
    console.log(
      "Completar datos: editar ~/.openclaw/workspace/memory/legal/immigration-status.json",
    );
    return;
  }

  // Group by urgency
  const overdue = deadlines.filter((d) => d.days < 0);
  const urgent = deadlines.filter((d) => d.days >= 0 && d.days <= 7);
  const soon = deadlines.filter((d) => d.days > 7 && d.days <= 30);
  const planned = deadlines.filter((d) => d.days > 30 && d.days <= 90);
  const ok = deadlines.filter((d) => d.days > 90 && d.days !== Infinity);
  const unknown = deadlines.filter((d) => d.days === Infinity);

  if (overdue.length > 0) {
    console.log("*** VENCIDOS ***");
    for (const d of overdue) console.log(`  ${d.icon} ${d.label}: ${d.detail}`);
    console.log("");
  }
  if (urgent.length > 0) {
    console.log("--- URGENTE (esta semana) ---");
    for (const d of urgent) console.log(`  ${d.icon} ${d.label}: ${d.detail}`);
    console.log("");
  }
  if (soon.length > 0) {
    console.log("--- PRONTO (este mes) ---");
    for (const d of soon) console.log(`  ${d.icon} ${d.label}: ${d.detail}`);
    console.log("");
  }
  if (planned.length > 0) {
    console.log("--- EN AGENDA (3 meses) ---");
    for (const d of planned) console.log(`  ${d.icon} ${d.label}: ${d.detail}`);
    console.log("");
  }
  if (ok.length > 0) {
    console.log("--- OK ---");
    for (const d of ok) console.log(`  ${d.icon} ${d.label}: ${d.detail}`);
    console.log("");
  }
  if (unknown.length > 0) {
    console.log("--- FECHA DESCONOCIDA (completar) ---");
    for (const d of unknown) console.log(`  \u{2753} ${d.label}: sin fecha registrada`);
    console.log("");
  }

  // Fixed calendar items
  console.log("--- CALENDARIO FIJO ---");
  console.log("  \u{1F4C6} Enero: Recategorizacion Monotributo (semestre jul-dic)");
  console.log("  \u{1F4C6} Julio: Recategorizacion Monotributo (semestre ene-jun)");
  console.log("  \u{1F4C6} 1ro de cada mes: Revision estado migratorio (este script)");
  console.log("  \u{1F4C6} Miercoles: Monitoreo noticias migratorias");
  console.log("");
}

/** RENEW-DNI: step-by-step guide */
function cmdRenewDni(state) {
  console.log("\n\u{1F194} RENOVACION DNI -- Guia paso a paso\n");

  // Evaluate each person
  for (const person of state.persons) {
    const dniDays = daysUntil(person.dni_expiry);
    const resExpiry = daysUntil(person.residencia_expiry);
    const resSince = person.residencia_since;
    let monthsWithRes = null;
    if (resSince) {
      const since = new Date(resSince);
      const now = nowArgentina();
      monthsWithRes = Math.floor((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    }

    console.log(`--- ${person.name} ---`);
    if (dniDays !== Infinity) {
      if (dniDays < 0) {
        console.log(`  DNI: VENCIDO hace ${Math.abs(dniDays)} dias -- ACCION INMEDIATA`);
      } else {
        console.log(`  DNI vence en: ${dniDays} dias (${fmtDateLocal(person.dni_expiry)})`);
      }
    } else {
      console.log("  DNI: fecha de vencimiento no registrada");
    }
    console.log("");
  }

  console.log("OPCION A: Renovar Temporaria (mas facil)");
  console.log("  Tiempo: 2-4 semanas");
  console.log("  Costo: ~ARS 80,000-120,000 (tasa migratoria)");
  console.log("");
  console.log("  Paso 1: Verificar que la residencia temporaria este vigente");
  console.log("          Si vencio -> primero renovar en Migraciones");
  console.log("  Paso 2: Sacar turno en mi.argentina.gob.ar");
  console.log("          Seccion: DNI -> Renovacion -> Extranjero");
  console.log("  Paso 3: Preparar documentos:");
  console.log("          [x] DNI actual (incluso vencido)");
  console.log("          [x] Pasaporte vigente");
  console.log("          [x] Constancia de residencia vigente");
  console.log("          [ ] Si residencia vencida -> primero renovar en Migraciones");
  console.log("  Paso 4: Presentarse en oficina RENAPER");
  console.log("  Paso 5: Foto + huellas (en el momento)");
  console.log("  Paso 6: Retirar en 15-30 dias (Correo o en oficina)");
  console.log("");

  console.log("OPCION B: Convertir a Permanente (mejor a largo plazo)");
  console.log("  Requisito: 2+ anos con temporaria");
  console.log("  Tiempo: 3-6 meses");
  console.log("  Costo: ~ARS 100,000-180,000");
  console.log("");
  console.log("  Ventajas:");
  console.log("    [+] No renovar cada 2 anos");
  console.log("    [+] Mas estabilidad legal");
  console.log("    [+] Facilita creditos y contratos");
  console.log("    [+] Paso hacia ciudadania (2 anos mas con permanente)");
  console.log("");
  console.log("  Riesgos:");
  console.log("    [!] Si no cumplen 2 anos -> rechazo");
  console.log("    [!] Antecedentes penales deben ser recientes (<90 dias)");
  console.log("    [!] Necesitan demostrar medios de vida (Monotributo ayuda)");
  console.log("");

  // Recommendation
  console.log("MI RECOMENDACION:");
  for (const person of state.persons) {
    const resSince = person.residencia_since;
    let monthsWithRes = null;
    if (resSince) {
      const since = new Date(resSince);
      const now = nowArgentina();
      monthsWithRes = Math.floor((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    }

    if (monthsWithRes !== null && monthsWithRes >= 24) {
      console.log(`  ${person.name}: ${monthsWithRes} meses con temporaria -> INTENTAR PERMANENTE`);
    } else if (monthsWithRes !== null) {
      console.log(
        `  ${person.name}: ${monthsWithRes} meses con temporaria -> RENOVAR TEMPORARIA (faltan ${24 - monthsWithRes} meses para permanente)`,
      );
    } else {
      console.log(
        `  ${person.name}: fecha de inicio de residencia no registrada -> verificar y actualizar`,
      );
    }
  }
  console.log("");
}

/** PERMANENT: strategy for permanent residency */
function cmdPermanent(state) {
  console.log("\n\u{1F3E0} ESTRATEGIA: RESIDENCIA PERMANENTE\n");

  console.log("REQUISITOS (ciudadanos rusos, Ley 25.871 art. 22):");
  console.log("  [req] 2+ anos con residencia temporaria continua");
  console.log("  [req] Certificado de antecedentes penales (Argentina + Rusia)");
  console.log("  [req] Constancia de medios de vida (Monotributo/empleo)");
  console.log("  [req] Certificado de domicilio");
  console.log("  [req] Partida de nacimiento apostillada + traducida");
  console.log("  [req] Pago de tasa migratoria permanente");
  console.log("");

  for (const person of state.persons) {
    const resSince = person.residencia_since;
    let monthsWithRes = null;
    let meetsTimeReq = false;
    if (resSince) {
      const since = new Date(resSince);
      const now = nowArgentina();
      monthsWithRes = Math.floor((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
      meetsTimeReq = monthsWithRes >= 24;
    }

    console.log(`EVALUACION: ${person.name}`);
    console.log(
      `  Residencia temporaria desde: ${resSince ? fmtDateLocal(resSince) : "[no registrado]"}`,
    );
    console.log(
      `  Tiempo acumulado: ${monthsWithRes !== null ? monthsWithRes + " meses" : "[calcular]"}`,
    );
    console.log(
      `  Cumple 2 anos?: ${meetsTimeReq ? "SI" : monthsWithRes !== null ? "NO (faltan " + (24 - monthsWithRes) + " meses)" : "[verificar]"}`,
    );

    if (person.monotributo) {
      console.log(`  Monotributo: SI (CUIT ${person.cuit}) -> [+] FORTALEZA`);
    } else {
      console.log(`  Monotributo: NO -> [!] DEBILIDAD (inscribirse cuanto antes)`);
    }

    // Document readiness
    const docs = person.documents || {};
    let readyDocs = 0;
    let totalDocs = 0;
    for (const [key, doc] of Object.entries(docs)) {
      totalDocs++;
      if (doc.status === "vigente" || doc.status === "apostillada" || doc.status === "traducida") {
        readyDocs++;
      }
    }
    console.log(`  Documentos listos: ${readyDocs}/${totalDocs}`);
    console.log("");
  }

  console.log("ESTRATEGIA OPTIMA:");
  console.log("  1. Tatiana solicita permanente PRIMERO (tiene Monotributo)");
  console.log("  2. Roman se inscribe en Monotributo (con nuevo CUIT)");
  console.log("  3. Roman solicita permanente 1-2 meses despues");
  console.log("  4. Alternativa: Roman como 'familiar de residente'");
  console.log("     si Tatiana obtiene permanente primero");
  console.log("");

  console.log("TIMELINE RECOMENDADO:");
  console.log("  Mes 1: Recopilar documentos (antecedentes RU, traducciones)");
  console.log("         -- Antecedentes penales Rusia: solicitar via consulado BA");
  console.log("         -- Demora estimada: 2-3 meses");
  console.log("  Mes 2: Tatiana presenta solicitud en Migraciones");
  console.log("         -- Turno online en migraciones.gov.ar");
  console.log("         -- Antecedentes AR: obtener 1 semana antes del turno");
  console.log("  Mes 3: Roman se inscribe en Monotributo");
  console.log("         -- AFIP Mercedes o Lujan (clave fiscal nivel 2)");
  console.log("  Mes 4: Roman solicita permanente");
  console.log("  Mes 5-8: Resolucion esperada para ambos");
  console.log("");

  console.log("DESPUES DE PERMANENTE:");
  console.log("  -> 2 anos mas con permanente = elegible para CIUDADANIA");
  console.log("  -> Aplicar en Juzgado Federal");
  console.log("  -> Requisitos: espanol basico, Constitucion, medios de vida");
  console.log("");
}

/** DOCUMENTS: checklist with status */
function cmdDocuments(state) {
  console.log("\n\u{1F4C4} DOCUMENTOS -- Estado actual\n");

  const docLabels = {
    pasaporte: "Pasaporte ruso",
    antecedentes_ru: "Antecedentes penales (Rusia)",
    antecedentes_ar: "Antecedentes penales (Argentina)",
    partida_nacimiento: "Partida de nacimiento",
    certificado_domicilio: "Certificado de domicilio",
    seguro_salud: "Seguro de salud",
    traduccion_partida: "Traduccion partida nacimiento",
    traduccion_antecedentes: "Traduccion antecedentes RU",
  };

  const statusIcon = {
    vigente: "[OK]",
    apostillada: "[OK]",
    traducida: "[OK]",
    pendiente: "[  ]",
    vencido: "[!!]",
    en_tramite: "[~~]",
  };

  for (const person of state.persons) {
    console.log(`--- ${person.name} ---`);

    const docs = person.documents || {};
    for (const [key, doc] of Object.entries(docs)) {
      const label = docLabels[key] || key;
      const icon = statusIcon[doc.status] || "[??]";
      const expiry = doc.expiry ? ` | vence: ${fmtDateLocal(doc.expiry)}` : "";
      const days = daysUntil(doc.expiry);
      const warn =
        days < 0
          ? " <- VENCIDO"
          : days <= 30
            ? " <- RENOVAR PRONTO"
            : days <= 90
              ? ` (${days} dias)`
              : "";
      const note = doc.note ? ` (${doc.note})` : "";
      console.log(`  ${icon} ${label}${expiry}${warn}${note}`);
    }

    // Additional status
    if (person.dni_number) {
      const dniDays = daysUntil(person.dni_expiry);
      const dniWarn = dniDays < 0 ? " <- VENCIDO" : dniDays <= 30 ? " <- RENOVAR" : "";
      console.log(
        `  [${dniDays < 0 ? "!!" : dniDays <= 90 ? "~~" : "OK"}] DNI ${person.dni_type}: ${person.dni_number} | vence: ${fmtDateLocal(person.dni_expiry)}${dniWarn}`,
      );
    } else {
      console.log(`  [  ] DNI: numero no registrado`);
    }

    if (person.cuit) {
      console.log(
        `  [OK] CUIT: ${person.cuit}${person.monotributo ? " (Monotributo activo)" : ""}`,
      );
    } else {
      console.log("  [  ] CUIT: no registrado");
    }

    console.log("");
  }

  console.log("LEYENDA: [OK] = listo | [  ] = pendiente | [!!] = vencido | [~~] = en tramite");
  console.log("");

  // What's needed for permanente
  console.log("DOCUMENTOS NECESARIOS PARA PERMANENTE:");
  console.log("  1. Pasaporte vigente (ambos)");
  console.log("  2. Antecedentes penales Rusia -- apostillados + traducidos (<90 dias)");
  console.log("  3. Antecedentes penales Argentina (<90 dias)");
  console.log("  4. Partida de nacimiento apostillada + traducida");
  console.log("  5. Certificado de domicilio actual");
  console.log("  6. Constancia Monotributo / medios de vida");
  console.log("  7. Seguro de salud vigente");
  console.log("  8. Fotos 4x4");
  console.log("  9. Pago tasa migratoria permanente");
  console.log("");
}

/** RISKS: risk assessment */
function cmdRisks(state) {
  console.log("\n\u{26A0}\u{FE0F} RISK ASSESSMENT\n");

  const risks = [];

  for (const person of state.persons) {
    const dniDays = daysUntil(person.dni_expiry);
    const resDays = daysUntil(person.residencia_expiry);

    // DNI expired or expiring
    if (dniDays < 0) {
      risks.push({
        level: "ALTO",
        icon: "\u{1F534}",
        person: person.name,
        message: `DNI VENCIDO hace ${Math.abs(dniDays)} dias`,
        action:
          "Renovar INMEDIATAMENTE. Sin DNI vigente no pueden facturar, operar Monotributo, ni viajar",
        priority: 1,
      });
    } else if (dniDays <= 30 && dniDays !== Infinity) {
      risks.push({
        level: "ALTO",
        icon: "\u{1F534}",
        person: person.name,
        message: `DNI vence en ${dniDays} dias`,
        action: "Iniciar renovacion AHORA. Sacar turno en mi.argentina.gob.ar",
        priority: 2,
      });
    } else if (dniDays <= 90 && dniDays !== Infinity) {
      risks.push({
        level: "MEDIO",
        icon: "\u{1F7E1}",
        person: person.name,
        message: `DNI vence en ${dniDays} dias`,
        action: "Planificar renovacion. Ventana de 90 dias abierta",
        priority: 4,
      });
    }

    // Residencia expired or expiring
    if (resDays < 0 && resDays !== Infinity) {
      risks.push({
        level: "ALTO",
        icon: "\u{1F534}",
        person: person.name,
        message: `Residencia VENCIDA hace ${Math.abs(resDays)} dias`,
        action: "Renovar residencia en Migraciones ANTES de renovar DNI. Solicitar precaria",
        priority: 1,
      });
    }

    // No Monotributo (Roman)
    if (!person.monotributo && person.name.includes("Roman")) {
      risks.push({
        level: "MEDIO",
        icon: "\u{1F7E1}",
        person: person.name,
        message: "Sin Monotributo = dificil demostrar medios de vida para permanente",
        action: "Inscribirse en Monotributo cuanto antes (AFIP Mercedes/Lujan)",
        priority: 5,
      });
    }

    // Missing critical documents
    const docs = person.documents || {};
    if (docs.antecedentes_ru && docs.antecedentes_ru.status === "pendiente") {
      risks.push({
        level: "ALTO",
        icon: "\u{1F534}",
        person: person.name,
        message: "Sin antecedentes penales de Rusia",
        action:
          "Obtener via consulado ruso BA (demora 2-3 meses). Iniciar AHORA si planean permanente",
        priority: 3,
      });
    }

    // Passport check
    if (docs.pasaporte) {
      const ppDays = daysUntil(docs.pasaporte.expiry);
      if (ppDays < 0) {
        risks.push({
          level: "ALTO",
          icon: "\u{1F534}",
          person: person.name,
          message: "Pasaporte VENCIDO",
          action: "Renovar en consulado ruso BA (Rodriguez Pena 1741, CABA)",
          priority: 1,
        });
      } else if (ppDays <= 180 && ppDays !== Infinity) {
        risks.push({
          level: "MEDIO",
          icon: "\u{1F7E1}",
          person: person.name,
          message: `Pasaporte vence en ${ppDays} dias`,
          action: "Renovar en consulado ruso. Necesario para tramites migratorios",
          priority: 4,
        });
      }
    }
  }

  // General risks
  risks.push({
    level: "MEDIO",
    icon: "\u{1F7E1}",
    person: "Ambos",
    message: "Cambio de domicilio (si se van de Suipacha)",
    action: "Actualizar en RENAPER + Migraciones + AFIP",
    priority: 6,
  });

  risks.push({
    level: "BAJO",
    icon: "\u{1F7E2}",
    person: "Ambos",
    message: "Cambios legislativos migratorios",
    action: "Monitorear noticias con 'node immigration-agent.cjs monitor'",
    priority: 8,
  });

  // Sort by priority
  risks.sort((a, b) => a.priority - b.priority);

  // Group by level
  const alto = risks.filter((r) => r.level === "ALTO");
  const medio = risks.filter((r) => r.level === "MEDIO");
  const bajo = risks.filter((r) => r.level === "BAJO");

  if (alto.length > 0) {
    console.log("\u{1F534} ALTO RIESGO:");
    for (let i = 0; i < alto.length; i++) {
      const r = alto[i];
      console.log(`  ${i + 1}. [${r.person}] ${r.message}`);
      console.log(`     -> Accion: ${r.action}`);
    }
    console.log("");
  }

  if (medio.length > 0) {
    console.log("\u{1F7E1} MEDIO RIESGO:");
    for (let i = 0; i < medio.length; i++) {
      const r = medio[i];
      console.log(`  ${i + 1}. [${r.person}] ${r.message}`);
      console.log(`     -> Accion: ${r.action}`);
    }
    console.log("");
  }

  if (bajo.length > 0) {
    console.log("\u{1F7E2} BAJO RIESGO:");
    for (let i = 0; i < bajo.length; i++) {
      const r = bajo[i];
      console.log(`  ${i + 1}. [${r.person}] ${r.message}`);
      console.log(`     -> Accion: ${r.action}`);
    }
    console.log("");
  }
}

/** MONITOR: check Google News RSS for immigration updates */
async function cmdMonitor(state, dryRun) {
  console.log("\n\u{1F4E1} MONITOR MIGRATORIO\n");

  const queries = [
    "migraciones+argentina+residencia+extranjeros+2026",
    "DNI+renovacion+extranjeros+Argentina",
    "residencia+permanente+Argentina+requisitos",
    "ley+migraciones+argentina+2026",
  ];

  const results = [];

  for (const query of queries) {
    const url = `https://news.google.com/rss/search?q=${query}&hl=es-419&gl=AR&ceid=AR:es-419`;
    try {
      console.log(`  Buscando: ${query.replace(/\+/g, " ")}...`);
      const res = await httpGet(url, 15000);

      if (res.status === 200) {
        // Parse RSS items (simple regex extraction)
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(res.body)) !== null) {
          const itemXml = match[1];
          const title = (itemXml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
          const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
          const pubDate = (itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";

          // Clean CDATA
          const cleanTitle = title
            .replace(/<!\[CDATA\[/g, "")
            .replace(/\]\]>/g, "")
            .trim();

          if (cleanTitle && isRelevant(cleanTitle)) {
            items.push({ title: cleanTitle, link, pubDate });
          }
        }

        // Take top 3 per query
        for (const item of items.slice(0, 3)) {
          results.push(item);
        }
      } else {
        console.log(`    [!] HTTP ${res.status} para query: ${query}`);
      }
    } catch (err) {
      console.log(`    [!] Error: ${err.message}`);
    }
  }

  // Deduplicate by title
  const seen = new Set();
  const unique = results.filter((r) => {
    const key = r.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log("");
  if (unique.length === 0) {
    console.log("No se encontraron noticias relevantes recientes.");
  } else {
    console.log(`--- ${unique.length} noticias relevantes ---\n`);
    for (const item of unique.slice(0, 10)) {
      const date = item.pubDate ? ` (${item.pubDate.slice(0, 16)})` : "";
      console.log(`  * ${item.title}${date}`);
      if (item.link) console.log(`    ${item.link}`);
    }
  }

  console.log("");

  // Update last monitor date
  if (!dryRun) {
    state.last_monitor = new Date().toISOString();
    saveState(state);
    console.log(`Ultima verificacion actualizada: ${fmtDateLocal(state.last_monitor)}`);
  } else {
    console.log("[DRY-RUN] No se actualiza fecha de verificacion.");
  }

  // Telegram summary if there are results
  if (unique.length > 0 && !dryRun) {
    const summary =
      `MONITOR MIGRATORIO -- ${fmtDateLocal(new Date().toISOString())}\n\n` +
      unique
        .slice(0, 5)
        .map((r) => `* ${r.title}`)
        .join("\n") +
      `\n\n${unique.length} noticias encontradas`;

    try {
      await sendThrottled(summary, { thread: THREAD_DIRECTOR, priority: "normal" });
      console.log("Resumen enviado a Telegram (thread 20).");
    } catch (err) {
      console.error("Error enviando resumen:", err.message);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a news title is relevant to immigration */
function isRelevant(title) {
  const lower = title.toLowerCase();
  const keywords = [
    "migracion",
    "migrante",
    "residencia",
    "dni",
    "extranjero",
    "renaper",
    "precaria",
    "permanente",
    "temporaria",
    "deportacion",
    "visa",
    "naturaliz",
    "ciudadania",
  ];
  const excludeWords = [
    "futbol",
    "seleccion",
    "deporte",
    "europa",
    "eeuu",
    "estados unidos",
    "mexico",
  ];

  const hasKeyword = keywords.some((kw) => lower.includes(kw));
  const hasExclude = excludeWords.some((kw) => lower.includes(kw));
  return hasKeyword && !hasExclude;
}

/** Get all deadlines from state, sorted by days remaining */
function getAllDeadlines(state) {
  const deadlines = [];

  for (const person of state.persons) {
    const shortName = person.name.split(" ")[0];

    // DNI
    if (person.dni_expiry) {
      const days = daysUntil(person.dni_expiry);
      deadlines.push({
        label: `DNI ${shortName}`,
        date: person.dni_expiry,
        days,
        icon: urgencyIcon(days),
        detail:
          days < 0
            ? `vencido hace ${Math.abs(days)} dias -- RENOVAR YA`
            : `vence en ${days} dias (${fmtDateLocal(person.dni_expiry)})`,
      });
    } else {
      deadlines.push({
        label: `DNI ${shortName}`,
        date: null,
        days: Infinity,
        icon: "\u{2753}",
        detail: "fecha no registrada",
      });
    }

    // Residencia
    if (person.residencia_expiry) {
      const days = daysUntil(person.residencia_expiry);
      deadlines.push({
        label: `Residencia ${shortName}`,
        date: person.residencia_expiry,
        days,
        icon: urgencyIcon(days),
        detail:
          days < 0 ? `vencida hace ${Math.abs(days)} dias -- RENOVAR` : `vence en ${days} dias`,
      });
    }

    // Passport
    const pp = (person.documents || {}).pasaporte;
    if (pp && pp.expiry) {
      const days = daysUntil(pp.expiry);
      deadlines.push({
        label: `Pasaporte ${shortName}`,
        date: pp.expiry,
        days,
        icon: urgencyIcon(days),
        detail: days < 0 ? `vencido hace ${Math.abs(days)} dias` : `vigente (${days} dias)`,
      });
    }

    // Precaria
    if (person.precaria) {
      const days = daysUntil(person.precaria);
      deadlines.push({
        label: `Precaria ${shortName}`,
        date: person.precaria,
        days,
        icon: urgencyIcon(days),
        detail:
          days < 0
            ? `vencida hace ${Math.abs(days)} dias`
            : `vigente hasta ${fmtDateLocal(person.precaria)} (${days} dias)`,
      });
    }
  }

  // Fixed deadlines
  const now = nowArgentina();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  // Monotributo recategorizacion: January and July
  const nextRecatMonth = currentMonth < 6 ? 6 : 0; // July or January
  const nextRecatYear = currentMonth < 6 ? currentYear : currentYear + 1;
  const nextRecat = new Date(nextRecatYear, nextRecatMonth, 31);
  const recatDays = daysUntil(nextRecat.toISOString());
  deadlines.push({
    label: "Monotributo recategorizacion (Tatiana)",
    date: nextRecat.toISOString(),
    days: recatDays,
    icon: urgencyIcon(recatDays),
    detail: `${fmtDateLocal(nextRecat.toISOString())} (${recatDays} dias)`,
  });

  // Sort by days
  deadlines.sort((a, b) => {
    if (a.days === Infinity && b.days === Infinity) return 0;
    if (a.days === Infinity) return 1;
    if (b.days === Infinity) return -1;
    return a.days - b.days;
  });

  return deadlines;
}

/** Get actionable issues for a person */
function getPersonIssues(person) {
  const issues = [];
  const dniDays = daysUntil(person.dni_expiry);
  const resDays = daysUntil(person.residencia_expiry);

  if (dniDays < 0) {
    issues.push({ icon: "\u{1F534}", action: "ACCION: DNI vencido -- renovar inmediatamente" });
  } else if (dniDays <= 30 && dniDays !== Infinity) {
    issues.push({
      icon: "\u{1F534}",
      action: `ACCION: DNI vence en ${dniDays} dias -- iniciar renovacion`,
    });
  } else if (dniDays <= 90 && dniDays !== Infinity) {
    issues.push({
      icon: "\u{1F7E1}",
      action: `ATENCION: DNI vence en ${dniDays} dias -- planificar renovacion`,
    });
  }

  if (resDays < 0 && resDays !== Infinity) {
    issues.push({
      icon: "\u{1F534}",
      action: "ACCION: Residencia vencida -- renovar en Migraciones",
    });
  } else if (resDays <= 30 && resDays !== Infinity) {
    issues.push({ icon: "\u{1F534}", action: `ACCION: Residencia vence en ${resDays} dias` });
  }

  if (!person.monotributo && person.name.includes("Roman")) {
    issues.push({ icon: "\u{1F7E1}", action: "SUGERENCIA: Inscribirse en Monotributo" });
  }

  return issues;
}

/** Capitalize first letter */
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const parsed = parseArgs(process.argv);
  const dryRun = parsed.dryRun;
  const state = loadState();

  if (dryRun) {
    console.log("[DRY-RUN] Modo de prueba -- sin escrituras ni envios\n");
  }

  try {
    switch (parsed.command) {
      case "status":
        cmdStatus(state);
        break;

      case "timeline":
        cmdTimeline(state);
        break;

      case "renew-dni":
        cmdRenewDni(state);
        break;

      case "permanent":
        cmdPermanent(state);
        break;

      case "documents":
      case "docs":
        cmdDocuments(state);
        break;

      case "risks":
        cmdRisks(state);
        break;

      case "monitor":
        await cmdMonitor(state, dryRun);
        break;

      default:
        console.log("Immigration Agent -- Pepino Pick");
        console.log("");
        console.log("Comandos:");
        console.log("  status          Estado migratorio actual (ambas personas)");
        console.log("  timeline        Todos los vencimientos y tareas");
        console.log("  renew-dni       Guia paso a paso para renovar DNI");
        console.log("  permanent       Estrategia para residencia permanente");
        console.log("  documents       Checklist de documentos con estado");
        console.log("  risks           Evaluacion de riesgos");
        console.log("  monitor         Buscar noticias migratorias recientes");
        console.log("");
        console.log("Opciones:");
        console.log("  --dry-run       Modo de prueba (sin escrituras ni envios)");
        console.log("");
        console.log(`Almacenamiento: ${STATUS_FILE}`);
        console.log(`Guia completa: ~/.openclaw/workspace/memory/legal/IMMIGRATION_GUIDE.md`);
        break;
    }

    // Save state on non-dry-run status checks
    if (!dryRun && parsed.command && parsed.command !== "monitor") {
      state.last_check = new Date().toISOString();
      saveState(state);
    }
  } finally {
    const duration = Date.now() - startTime;
    await trace({
      name: "immigration-agent",
      input: { command: parsed.command, dryRun },
      output: { duration_ms: duration },
      metadata: { skill: "pepino-google-sheets", script: "immigration-agent.cjs" },
      duration_ms: duration,
    }).catch(() => {
      /* Langfuse not critical */
    });
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
