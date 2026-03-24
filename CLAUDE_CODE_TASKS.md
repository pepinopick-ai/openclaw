# CLAUDE_CODE_TASKS — Pepino Pick Agent OS Backlog

> Auto-generated: 2026-03-20
> Priority: P0 (critical) / P1 (important) / P2 (nice to have) / P3 (backlog)
> Sources: SOP hardening evaluation, crontab audit, skills inventory, knowledge graph MANIFEST

---

## P0 — Критичные

- [ ] **Sheets API: bind на 127.0.0.1** — `sheets-api.js:492` слушает на `0.0.0.0:4000` без авторизации. Любой может GET/POST к `/sales`, `/expenses`, `/kpi`. Grafana работает через `--network host`, достаточно `127.0.0.1`. (файлы: `skills/pepino-google-sheets/sheets-api.js`)

- [ ] **API keys из openclaw.json в env vars** — сервисные ключи хранятся в `~/.openclaw/openclaw.json` plain text. Вынести в `.env` или secrets manager, загружать через `process.env`. (файлы: `~/.openclaw/openclaw.json`, `skills/pepino-google-sheets/*.js`)

- [ ] **n8n webhook: bind на 127.0.0.1** — Docker forwarding порта 5678 на `0.0.0.0` без IP-ограничений. Перебиндить на `127.0.0.1:5678:5678` в docker-compose. (файлы: `Dockerfile`, `docker-compose.yml`)

- [ ] **VNC порты закрыть файрволом** — порты 5900/5901 потенциально открыты. Добавить UFW правила `deny from any to any port 5900:5901`. (файлы: firewall config)

---

## P1 — Важные

- [ ] **Skill audit: ревью 100+ скиллов** — в `~/.openclaw/skills/` 100 директорий, из них ~39 pepino-скиллов задокументированы в SOP INDEX, остальные без ревью. Quarantine policy (`~/.openclaw/skills/quarantine/POLICY.md`) создана, но не применяется. Провести аудит, переместить неиспользуемые в quarantine. (файлы: `~/.openclaw/skills/`, `~/.openclaw/skills/quarantine/POLICY.md`)

- [ ] **NotebookLM auto-sync pipeline** — YouTube knowledge pipeline работает вручную (`youtube-knowledge.cjs add`). Автоматизировать: новое видео в 05-sources/youtube -> автоматически `nblm_create_notebook` + `nblm_add_source_url` + `nblm_get_summary` + обновление .md. (файлы: `skills/pepino-google-sheets/youtube-knowledge.cjs`, `~/.openclaw/workspace/memory/pepino-graph/05-sources/youtube/`)

- [ ] **Grafana: нативный JSON API вместо Infinity plugin** — текущий workaround через Infinity plugin для чтения Sheets API. Перейти на встроенный JSON data source, который напрямую читает `localhost:4000`. (файлы: Grafana provisioning, `skills/pepino-google-sheets/sync-dashboard.cjs`)

- [ ] **Crontab: дедупликация morning-brief** — два задания на утренний бриф: `/home/roman/pepino-morning-brief.sh` в 06:00 и `morning-brief.js` в 07:00 (без `cd`). Второе, вероятно, падает. Унифицировать в один job. (файлы: crontab, `skills/pepino-google-sheets/morning-brief.js`, `/home/roman/pepino-morning-brief.sh`)

- [ ] **Алерты Grafana -> Telegram** — настроить Grafana Alerting: пороги KPI (урожайность, расходы, VPD) -> уведомления в Telegram через webhook. (файлы: Grafana alerting config, `skills/pepino-google-sheets/sheets-api.js`)

- [ ] **Knowledge graph enrichment** — MANIFEST показывает 3 сущности, 1 связь, 1 инсайт. Критически мало. Добавить entities для ключевых клиентов, поставщиков, продуктов; связи клиент->продукт, поставщик->компонент. (файлы: `~/.openclaw/workspace/memory/pepino-graph/01-entities/`, `02-relations/`)

---

## P2 — Улучшения

- [ ] **Article knowledge pipeline** — аналог youtube-knowledge для веб-статей и PDF. CLI: `article-knowledge.cjs add "https://..."` -> создание .md в `05-sources/articles/`, обработка через NotebookLM. Сейчас только ручное создание .md. (файлы: новый скрипт, `~/.openclaw/workspace/memory/pepino-graph/05-sources/articles/`)

- [ ] **Daily summary -> Obsidian автоматизация** — `pepino-sheets-obsidian-sync.py` работает 3 раза в день, но session summary hook (auto-export из чат-сессий в pepino-graph) не реализован. Добавить post-session hook. (файлы: `/home/roman/bin/pepino-sheets-obsidian-sync.py`, `~/.openclaw/workspace/memory/pepino-graph/99-reports/`)

- [ ] **System health dashboard** — объединённый мониторинг: n8n status, gateway uptime, Sheets API health, cron job success rate. Healthcheck (`pepino-healthcheck.js`) работает каждые 30 мин, но нет единой панели. (файлы: `skills/pepino-google-sheets/pepino-healthcheck.js`, Grafana)

- [ ] **Утренний бриф v2: графики из Grafana** — текущий `morning-brief.js` отправляет текст. Добавить Grafana render API для отправки PNG-графиков KPI в Telegram. (файлы: `skills/pepino-google-sheets/morning-brief.js`, Grafana render plugin)

- [ ] **Done criteria checklist** — из SOP evaluation: нет формализованного определения "задача выполнена" для скиллов. Создать шаблон с чеклистом (тесты, документация, security review). (файлы: `~/.openclaw/workspace/memory/pepino-graph/06-sop/`)

- [ ] **Ежедневный P&L reconciliation** — автоматическая сверка: Telegram логи продаж vs Google Sheets vs банковские данные. Выявление расхождений и отправка отчёта. (файлы: `skills/pepino-google-sheets/sync-telegram-to-sheets.js`, `skills/pepino-google-sheets/data-completeness-check.js`)

---

## P3 — Бэклог

- [ ] **Telegram silent/edit/quote messages** — OpenClaw API поддерживает silent mode и edit, но скиллы отправляют обычные сообщения. Статусные обновления (healthcheck OK, sync done) перевести на silent notifications. (файлы: `skills/pepino-google-sheets/pepino-healthcheck.js`, все скрипты с Telegram-отправкой)

- [ ] **Auto-pricing bot** — мониторинг цен конкурентов на MercadoLibre (`pepino-ml-scraper`) -> анализ -> рекомендации по ценообразованию в Google Sheets. Сейчас scraper и analyst работают раздельно без автоматической связки. (файлы: `~/.openclaw/skills/pepino-ml-scraper/`, `~/.openclaw/skills/pepino-analyst/`)

- [ ] **Supplier DD automation** — Alibaba supplier due diligence: автоматический сбор данных поставщика -> проверка через OSINT -> отчёт в Google Sheets. Скиллы `pepino-procurement` и `pepino-osint` не интегрированы. (файлы: `~/.openclaw/skills/pepino-procurement/`, `~/.openclaw/skills/pepino-osint/`)

- [ ] **Inventory tracking automation** — реал-тайм учёт запасов: субстрат, удобрения, упаковка. Триггер при низком остатке -> уведомление + авто-заказ у поставщика. Сейчас учёт ручной в Sheets. (файлы: `~/.openclaw/skills/pepino-logistics/`, Google Sheets)

- [ ] **Crontab: morning-brief.js missing cd** — строка `0 7 * * * /usr/bin/node morning-brief.js` выполняется без `cd`, скорее всего падает с ENOENT. Исправить или удалить (если дублирует pepino-morning-brief.sh). (файлы: crontab)

- [ ] **Log rotation для cron jobs** — логи пишутся в `/home/roman/logs/` и `/tmp/` без ротации. Настроить logrotate для `*.log` файлов. (файлы: `/home/roman/logs/`, logrotate config)
