# Pepino Pick Automation Scripts Index

All scripts run from: `/home/roman/openclaw/skills/pepino-google-sheets/`
All support `--dry-run` flag (skip Telegram/Sheets writes).

## Core Infrastructure

| Script                | Purpose                                     | Schedule           |
| --------------------- | ------------------------------------------- | ------------------ |
| `sheets-api.js`       | JSON API server for Sheets data (port 4000) | Docker container   |
| `sheets.js`           | Google Sheets read/write module             | imported by others |
| `api-auth.js/cjs`     | Shared Bearer token auth module             | imported by others |
| `telegram-helper.cjs` | Telegram send helper (threads, HTML)        | imported by others |
| `langfuse-trace.cjs`  | LLM observability tracing                   | imported by others |
| `product-aliases.cjs` | Product name normalization (40+ aliases)    | imported by others |

## Daily Operations

| Script                       | Purpose                              | Schedule        |
| ---------------------------- | ------------------------------------ | --------------- |
| `sync-telegram-to-sheets.js` | Telegram messages to Sheets          | _/15 _ \* \* \* |
| `pepino-healthcheck.js`      | System health + auto-fix (14 checks) | _/30 _ \* \* \* |
| `sync-dashboard.cjs`         | Grafana dashboard sync               | _/5 _ \* \* \*  |
| `health-status.cjs`          | System health JSON                   | _/10 _ \* \* \* |
| `llm-cost-report.cjs`        | LLM cost tracking                    | _/5 _ \* \* \*  |
| `morning-brief.js`           | Morning dashboard + alerts           | 06:00 daily     |
| `inventory-tracker.cjs`      | Stock alerts, days-of-stock          | 08:03 daily     |
| `supplier-monitor.cjs`       | Raw material alerts, price changes   | 09:00 daily     |
| `recalculate-aggregates.js`  | P&L + KPI aggregation                | 07:00, 20:30    |
| `daily-dashboard-update.js`  | CEO Dashboard update                 | 07:00, 20:00    |
| `data-completeness-check.js` | Data gaps reminder                   | 20:00 daily     |
| `daily-pnl.cjs`              | P&L + margin alerts                  | 21:07 daily     |
| `llm-cost-telegram.cjs`      | AI costs report                      | 22:00 daily     |

## Client & Sales Intelligence

| Script                  | Purpose                         | Schedule            |
| ----------------------- | ------------------------------- | ------------------- |
| `churn-detector.cjs`    | Client churn detection (>30d)   | 10:03 Mon-Fri       |
| `client-outreach.cjs`   | CRM auto follow-up tasks        | 10:00 Tue, Fri      |
| `auto-pricing.cjs`      | Cost-based pricing + L2 policy  | 12:07 Mon, Wed, Fri |
| `competitive-intel.cjs` | Mercado Libre competitor prices | 11:00 Monday        |
| `cashflow-forecast.cjs` | Cash flow forecast 7/30 days    | 18:00 Wednesday     |

## Weekly Analytics & Planning

| Script                    | Purpose                            | Schedule     |
| ------------------------- | ---------------------------------- | ------------ |
| `production-planner.cjs`  | Weekly production plan + weather   | 17:00 Sunday |
| `weekly-report.js`        | Weekly operations report           | 18:00 Friday |
| `knowledge-distiller.cjs` | Business intelligence extraction   | 19:00 Sunday |
| `ceo-weekly-digest.cjs`   | Unified CEO report                 | 20:00 Sunday |
| `memory-maintenance.cjs`  | Memory cleanup + client enrichment | 03:00 Sunday |

## System Health & Self-Healing

| Script                 | Purpose                                           | Schedule        |
| ---------------------- | ------------------------------------------------- | --------------- |
| `self-healer.cjs`      | Auto-restart containers, disk/RAM/cron monitoring | _/30 _ \* \* \* |
| `alert-aggregator.cjs` | Smart alert dedup + P1/P2/P3 priority batching    | 0 _/2 _ \* \*   |

## Margin & Profitability

| Script                 | Purpose                                           | Schedule         |
| ---------------------- | ------------------------------------------------- | ---------------- |
| `margin-optimizer.cjs` | Per-product/client profitability, recommendations | 1st+15th monthly |
| `waste-tracker.cjs`    | Production waste analysis                         | 17:00 Friday     |

## Interactive Tools (manual run)

| Script                    | Purpose                    | Usage                                                           |
| ------------------------- | -------------------------- | --------------------------------------------------------------- |
| `telegram-commands.cjs`   | Quick status queries       | `node telegram-commands.cjs status\|stock\|clients\|sales\|pnl` |
| `expense-quick-entry.cjs` | Fast expense logging       | `node expense-quick-entry.cjs "субстрат 5000"`                  |
| `delivery-optimizer.cjs`  | Route optimization         | `node delivery-optimizer.cjs [--date YYYY-MM-DD]`               |
| `people-import.cjs`       | Bulk client profile import | `node people-import.cjs`                                        |
| `fix-client-names.cjs`    | Normalize client names     | `node fix-client-names.cjs`                                     |

## Knowledge & Learning

| Script                  | Purpose                    |
| ----------------------- | -------------------------- |
| `knowledge-import.cjs`  | Import knowledge articles  |
| `knowledge-search.cjs`  | Search knowledge base      |
| `article-knowledge.cjs` | Article extraction         |
| `youtube-knowledge.cjs` | YouTube content extraction |

## Grafana Dashboards

| Script                          | Purpose                      |
| ------------------------------- | ---------------------------- |
| `create-ai-costs-dashboard.cjs` | Provision AI costs dashboard |
| `create-farm-ops-dashboard.cjs` | Provision farm ops dashboard |
| `pnl-reconciliation.cjs`        | P&L data reconciliation      |

## Sheets API v2 Endpoints (port 4000)

| Endpoint               | Method | Purpose                                |
| ---------------------- | ------ | -------------------------------------- |
| `/health`              | GET    | Health check (public, no auth)         |
| `/sales?all=true`      | GET    | All sales data                         |
| `/production?all=true` | GET    | All production data                    |
| `/expenses?all=true`   | GET    | All expenses data                      |
| `/inventory`           | GET    | Current stock                          |
| `/clients`             | GET    | Client health (active/at_risk/churned) |
| `/forecast`            | GET    | 7/30-day revenue forecast              |
| `/waste`               | GET    | Production waste by product            |
| `/dashboard`           | GET    | Compact summary for widgets            |
| `/log/sales`           | POST   | Log a sale                             |
| `/log/expense`         | POST   | Log an expense                         |
| `/log/production`      | POST   | Log production                         |

Query params: `?all=true` (no limit), `?limit=N`
Auth: `Authorization: Bearer <token>` (token at `~/.openclaw/.sheets-api-token`)

## Market Intelligence

| Script                  | Purpose                              | Usage                                                             |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `web-intel.cjs`         | Unified market research (5 commands) | `node web-intel.cjs prices\|suppliers\|competitors\|news\|report` |
| `review-miner.cjs`      | ML review analysis + sentiment       | `node review-miner.cjs "query"` (1st monthly)                     |
| `competitive-intel.cjs` | ML competitor price monitoring       | cron Monday 11:00                                                 |

## Knowledge Layer

| Script                    | Purpose                         | Schedule    |
| ------------------------- | ------------------------------- | ----------- |
| `vault-organizer.cjs`     | Organize vault by 8 domains     | manual      |
| `knowledge-indexer.cjs`   | FTS index (70 docs, 761 chunks) | 04:00 daily |
| `knowledge-retriever.cjs` | Domain-filtered search          | on-demand   |

## Architecture

```
Telegram → sync-telegram-to-sheets.js → Google Sheets (SSOT)
                                              ↓
                                    Cron scripts (read)
                                              ↓
                              Telegram reports + Grafana + Langfuse
```
