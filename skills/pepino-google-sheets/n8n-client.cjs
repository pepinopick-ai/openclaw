#!/usr/bin/env node
/**
 * n8n-client.cjs -- Переиспользуемый клиент n8n REST API для Pepino Pick
 *
 * Позволяет скриптам автоматизации управлять n8n-воркфлоу:
 *   - Список / получение / активация / деактивация воркфлоу
 *   - Запуск воркфлоу с данными
 *   - Просмотр истории выполнений
 *
 * API ключ: process.env.N8N_API_KEY или fallback из ~/.profile
 * API base: http://127.0.0.1:5678/api/v1
 *
 * CLI:
 *   node n8n-client.cjs list                  — список воркфлоу
 *   node n8n-client.cjs status                — обзор (total/active/inactive)
 *   node n8n-client.cjs trigger <id> [json]   — запустить воркфлоу
 *   node n8n-client.cjs executions <id> [N]   — последние N выполнений
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ── Конфигурация ────────────────────────────────────────────────────────────

const API_BASE = "http://127.0.0.1:5678/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

// ── Загрузка API-ключа ─────────────────────────────────────────────────────

/**
 * Читает N8N_API_KEY из env или парсит ~/.profile как fallback.
 * @returns {string}
 */
function loadApiKey() {
  if (process.env.N8N_API_KEY) {
    return process.env.N8N_API_KEY;
  }

  // Fallback: попробовать прочитать из ~/.profile
  const profilePath = path.join(process.env.HOME || "/root", ".profile");
  try {
    const content = fs.readFileSync(profilePath, "utf8");
    const match = content.match(/export\s+N8N_API_KEY=["']?([^"'\s\n]+)["']?/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // Файл не найден — не критично
  }

  console.warn(
    "[n8n-client] N8N_API_KEY не найден в env и ~/.profile. Запросы будут неавторизованы.",
  );
  return "";
}

const API_KEY = loadApiKey();

// ── HTTP-утилита ────────────────────────────────────────────────────────────

/**
 * Выполняет HTTP-запрос к n8n API.
 * @param {string} method - HTTP метод (GET, POST, PATCH)
 * @param {string} endpoint - Путь после /api/v1 (например /workflows)
 * @param {object|null} body - Тело запроса (для POST/PATCH)
 * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
 */
function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve) => {
    const url = new URL(`${API_BASE}${endpoint}`);

    /** @type {http.RequestOptions} */
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        Accept: "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    if (API_KEY) {
      options.headers["X-N8N-API-KEY"] = API_KEY;
    }

    const bodyStr = body != null ? JSON.stringify(body) : null;
    if (bodyStr) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const timer = setTimeout(() => {
      resolve({ ok: false, status: 0, data: null, error: "timeout (10s)" });
    }, REQUEST_TIMEOUT_MS + 500);

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        clearTimeout(timer);
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({
          ok,
          status: res.statusCode,
          data: parsed,
          error: ok ? undefined : `HTTP ${res.statusCode}`,
        });
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, data: null, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      clearTimeout(timer);
      resolve({ ok: false, status: 0, data: null, error: "timeout (10s)" });
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ── Публичные функции ───────────────────────────────────────────────────────

/**
 * Список всех воркфлоу.
 * @returns {Promise<Array<{id: string, name: string, active: boolean}>>}
 */
async function listWorkflows() {
  const res = await apiRequest("GET", "/workflows");
  if (!res.ok) {
    throw new Error(`listWorkflows failed: ${res.error}`);
  }
  const items = res.data.data || res.data || [];
  return items.map((/** @type {any} */ w) => ({
    id: w.id,
    name: w.name,
    active: w.active,
  }));
}

/**
 * Получить полный воркфлоу по ID.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getWorkflow(id) {
  const res = await apiRequest("GET", `/workflows/${id}`);
  if (!res.ok) {
    throw new Error(`getWorkflow(${id}) failed: ${res.error}`);
  }
  return res.data;
}

/**
 * Активировать воркфлоу.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function activateWorkflow(id) {
  const res = await apiRequest("PATCH", `/workflows/${id}`, { active: true });
  if (!res.ok) {
    throw new Error(`activateWorkflow(${id}) failed: ${res.error}`);
  }
  return res.data;
}

/**
 * Деактивировать воркфлоу.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function deactivateWorkflow(id) {
  const res = await apiRequest("PATCH", `/workflows/${id}`, { active: false });
  if (!res.ok) {
    throw new Error(`deactivateWorkflow(${id}) failed: ${res.error}`);
  }
  return res.data;
}

/**
 * Запустить воркфлоу с данными.
 * @param {string} id
 * @param {object} data - Входные данные для воркфлоу
 * @returns {Promise<object>}
 */
async function triggerWorkflow(id, data = {}) {
  const res = await apiRequest("POST", `/workflows/${id}/run`, data);
  if (!res.ok) {
    throw new Error(`triggerWorkflow(${id}) failed: ${res.error}`);
  }
  return res.data;
}

/**
 * Получить историю выполнений воркфлоу.
 * @param {string} workflowId
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
async function getExecutions(workflowId, limit = 10) {
  const query = `?workflowId=${workflowId}&limit=${limit}`;
  const res = await apiRequest("GET", `/executions${query}`);
  if (!res.ok) {
    throw new Error(`getExecutions(${workflowId}) failed: ${res.error}`);
  }
  return res.data.data || res.data || [];
}

/**
 * Обзор: сколько воркфлоу всего, активных, неактивных.
 * @returns {Promise<{total: number, active: number, inactive: number, names: string[]}>}
 */
async function getOverview() {
  const workflows = await listWorkflows();
  const active = workflows.filter((/** @type {any} */ w) => w.active).length;
  return {
    total: workflows.length,
    active,
    inactive: workflows.length - active,
    names: workflows.map(
      (/** @type {any} */ w) => `${w.id}: ${w.name} [${w.active ? "ON" : "OFF"}]`,
    ),
  };
}

// ── Экспорт ─────────────────────────────────────────────────────────────────

module.exports = {
  listWorkflows,
  getWorkflow,
  activateWorkflow,
  deactivateWorkflow,
  triggerWorkflow,
  getExecutions,
  getOverview,
};

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(`Pepino Pick n8n Client

Использование:
  node n8n-client.cjs list                  Список воркфлоу
  node n8n-client.cjs status                Обзор (total/active/inactive)
  node n8n-client.cjs trigger <id> [json]   Запустить воркфлоу
  node n8n-client.cjs executions <id> [N]   Последние N выполнений (по умолчанию 10)

Переменные окружения:
  N8N_API_KEY   API-ключ для n8n (или читается из ~/.profile)`);
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "list": {
        const workflows = await listWorkflows();
        if (workflows.length === 0) {
          console.log("Нет воркфлоу.");
        } else {
          console.log(`Воркфлоу (${workflows.length}):\n`);
          for (const w of workflows) {
            const status = w.active ? "\x1b[32mON\x1b[0m" : "\x1b[90mOFF\x1b[0m";
            console.log(`  [${status}] ${w.id}: ${w.name}`);
          }
        }
        break;
      }

      case "status": {
        const overview = await getOverview();
        console.log(`n8n Обзор:`);
        console.log(`  Всего:      ${overview.total}`);
        console.log(`  Активных:   ${overview.active}`);
        console.log(`  Неактивных: ${overview.inactive}`);
        if (overview.names.length > 0) {
          console.log(`\nВоркфлоу:`);
          for (const name of overview.names) {
            console.log(`  ${name}`);
          }
        }
        break;
      }

      case "trigger": {
        const id = args[1];
        if (!id) {
          console.error("Ошибка: укажите ID воркфлоу. Пример: node n8n-client.cjs trigger 5");
          process.exit(1);
        }
        let data = {};
        if (args[2]) {
          try {
            data = JSON.parse(args[2]);
          } catch {
            console.error("Ошибка: невалидный JSON для данных воркфлоу.");
            process.exit(1);
          }
        }
        const result = await triggerWorkflow(id, data);
        console.log("Воркфлоу запущен:");
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "executions": {
        const wfId = args[1];
        if (!wfId) {
          console.error("Ошибка: укажите ID воркфлоу. Пример: node n8n-client.cjs executions 5");
          process.exit(1);
        }
        const limit = parseInt(args[2], 10) || 10;
        const execs = await getExecutions(wfId, limit);
        if (execs.length === 0) {
          console.log(`Нет выполнений для воркфлоу ${wfId}.`);
        } else {
          console.log(`Последние выполнения воркфлоу ${wfId} (${execs.length}):\n`);
          for (const ex of execs) {
            const finished = ex.stoppedAt || ex.finished || "—";
            const status = ex.status || (ex.finished ? "success" : "running");
            console.log(
              `  #${ex.id}  ${status}  started: ${ex.startedAt || "—"}  finished: ${finished}`,
            );
          }
        }
        break;
      }

      default:
        console.error(`Неизвестная команда: ${cmd}. Используйте --help.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  }
}

// Запуск CLI только при прямом вызове
if (require.main === module) {
  main();
}
