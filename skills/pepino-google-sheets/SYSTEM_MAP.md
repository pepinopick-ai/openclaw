# Pepino Agent OS v2 — System Map

> Этот файл = полная карта системы для системного анализа.
> Читай ПЕРЕД оценкой любых предложений по улучшению.

## Компоненты (что есть)

### Data Layer

- **Google Sheets** (SSOT) — 18 листов, все бизнес-данные
- **farm-state.cjs** — shared cache, refresh \*/15, все скрипты читают отсюда
- **Sheets API v2** (port 4000) — 27+ endpoints, Bearer auth
- **Knowledge index** — 70 docs / 761 chunks / 8 domains, daily sync

### Automation Layer (59 CJS + 14 JS)

- **Pipelines**: morning (5 steps), evening (5 steps), sunday (4 steps)
- **Cron**: 43 jobs (high-freq \*/5-30, daily, weekly, monthly)
- **n8n**: 6 active workflows (webhooks + scheduled)

### Intelligence Layer

- **Digital Twin** — 7-section farm model + 2-week forecast
- **Trend Radar** — 5 RSS streams (supplier-risk, ai, marketing, agro, sales)
- **Demand Predictor** — 4-week sales forecast + client order prediction
- **Competitive Intel** — Mercado Libre prices
- **Web Intel** — prices, suppliers, competitors, news, reviews

### Client Layer

- **churn-detector** — churned >30d, at_risk >14d
- **client-outreach** — auto follow-up tasks in CRM
- **client-scorer** — RFM scoring A/B/C/D tiers
- **client-analytics.cjs** — shared module for all client logic

### Financial Layer

- **daily-pnl** — revenue/expenses/margin daily
- **cashflow-forecast** — 7/30 day projections
- **margin-optimizer** — per-product/client profitability
- **auto-pricing** — cost-based pricing with L2 policy
- **currency-updater** — live Blue rate

### Quality Layer

- **system-test** — 24/24 e2e tests
- **self-healer** — auto-restart containers, disk/RAM checks
- **alert-aggregator** — dedup + P1/P2/P3 priority
- **notification-throttle** — anti-spam (5/hr, quiet hours, dedup)
- **eval-runner** — Langfuse dataset (15 items, 5 domains)

### Governance Layer (pepino-core, 9 files)

- ENTITIES (11 schemas) → POLICIES (L0-L4) → STATE MACHINE (9 states)
- AGENT REGISTRY (31 agents) → LEARNING LOOP → MEMORY SYSTEM (4 types)
- RETRIEVAL POLICY (domain access) → EVAL SUITE (50 tests)

### UX Layer

- **pepino CLI** — 23 commands
- **Telegram** — 15 topics with role-based agents
- **Grafana** — 6 dashboards
- **HTML status page** — auto-generated \*/10

### Shared Modules (8)

farm-state, client-analytics, product-aliases, notification-throttle,
langfuse-trace, api-auth, telegram-helper, currency-updater

## Ограничения (что НЕ МОЖЕТ)

- VPS: 8GB RAM (77% used), нет GPU
- ML API: 403 from VPS IP (rate limiting)
- n8n: Docker container on 2026.3.11 (CLI updated to 2026.3.13)
- Expenses: entered ~33% of days (margin inflated)
- No real-time IoT data (sensors not connected)
- No browser automation (no Chrome on VPS)
- Gateway: needs dangerouslyAllowHostHeaderOriginFallback for Caddy

## Чеклист оценки предложений

Перед принятием ЛЮБОГО предложения, ответь на:

1. ☐ Это уже реализовано? (проверь SCRIPTS.md)
2. ☐ Это дублирует существующий скрипт?
3. ☐ Хватит ли RAM? (сейчас 77%, лимит 85%)
4. ☐ Добавит ли это бизнес-value для 1 оператора?
5. ☐ Можно ли это сделать через существующие shared modules?
6. ☐ Не создаст ли это alert fatigue? (уже 43 cron)
7. ☐ Есть ли данные для этой функции? (expenses gap, no IoT)
