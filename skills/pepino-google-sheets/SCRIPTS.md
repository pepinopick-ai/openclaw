# Pepino Agent OS — Script Catalog

**80 scripts | 66 CJS + 14 JS | 0 syntax errors**
All scripts run from: `/home/roman/openclaw/skills/pepino-google-sheets/`
All support `--dry-run` flag.

## Shared Modules (use, don't duplicate!)

| Module                      | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `farm-state.cjs`            | Cached Sheets data (auto-refresh 15min). `getState()`              |
| `helpers.cjs`               | `parseNum, parseDate, fmtDate, fmtNum, rowsToObjects, daysBetween` |
| `client-analytics.cjs`      | RFM scoring, churn detection. `analyzeClients()`                   |
| `product-aliases.cjs`       | Product name normalization. `normalize()`                          |
| `notification-throttle.cjs` | Anti-spam Telegram. `sendThrottled()`                              |
| `langfuse-trace.cjs`        | LLM observability. `trace()`                                       |
| `api-auth.cjs`              | Bearer token for Sheets API                                        |
| `telegram-helper.cjs`       | Telegram send. `send(), sendReport()`                              |
| `currency-updater.cjs`      | Blue Dollar rate. `getBlueRate()`                                  |
| `n8n-client.cjs`            | n8n API client                                                     |

## Strategic Intelligence

| Script                   | Cron         | Description                                              |
| ------------------------ | ------------ | -------------------------------------------------------- |
| `task-brain.cjs`         | on-demand    | 8-dim task analysis, Eisenhower matrix, optimal day plan |
| `planning-cycle.cjs`     | daily 19-20h | Evening/weekly/monthly planning + review                 |
| `multiplier-planner.cjs` | Mon 06:30    | "7 tasks with 1 action" scoring                          |
| `trip-optimizer.cjs`     | daily 05:45  | Smart delivery trip bundling                             |
| `pepino-cli.cjs`         | CLI          | Unified entry point (33 commands)                        |

## Pipelines

| Pipeline  | Cron      | Steps                                                 |
| --------- | --------- | ----------------------------------------------------- |
| `morning` | 06:00     | delivery → checklist → inventory → aggregates → brief |
| `evening` | 20:30     | aggregates → P&L → gaps → LLM costs → alerts          |
| `sunday`  | Sun 17:00 | waste → production → knowledge → CEO digest           |

## Business Analytics

| Script                  | Cron      | Description                            |
| ----------------------- | --------- | -------------------------------------- |
| `daily-pnl.cjs`         | pipeline  | Revenue/expenses/margin, 7-day rolling |
| `cashflow-forecast.cjs` | Wed 18:00 | 7/30-day forecast                      |
| `margin-optimizer.cjs`  | 1st,15th  | Per-product/client margin analysis     |
| `demand-predictor.cjs`  | Mon 07:00 | 4-week demand + client prediction      |
| `ceo-weekly-digest.cjs` | pipeline  | Weekly executive summary               |
| `waste-tracker.cjs`     | pipeline  | Production waste analysis              |

## Client Management

| Script                | Cron        | Description                       |
| --------------------- | ----------- | --------------------------------- |
| `churn-detector.cjs`  | daily 10:03 | At-risk/churned detection         |
| `client-outreach.cjs` | Tue,Fri     | Auto follow-up tasks              |
| `client-scorer.cjs`   | 1st,15th    | RFM scoring, growth opportunities |

## Operations

| Script                    | Cron        | Description                 |
| ------------------------- | ----------- | --------------------------- |
| `daily-ops-checklist.cjs` | pipeline    | Daily operations checklist  |
| `delivery-optimizer.cjs`  | pipeline    | Route optimization          |
| `inventory-tracker.cjs`   | pipeline    | Stock levels, alerts        |
| `production-planner.cjs`  | pipeline    | Weekly production + weather |
| `supplier-monitor.cjs`    | daily 09:00 | Raw material monitoring     |
| `auto-pricing.cjs`        | Mon,Wed,Fri | Cost-based pricing          |

## Market Intelligence

| Script                  | Cron        | Description              |
| ----------------------- | ----------- | ------------------------ |
| `competitive-intel.cjs` | Mon 11:00   | ML competitor monitoring |
| `trend-radar.cjs`       | daily 07:45 | 5-stream intelligence    |
| `ai-radar-report.cjs`   | Fri 16:00   | AI improvement proposals |
| `web-intel.cjs`         | on-demand   | Market research tool     |
| `review-miner.cjs`      | monthly     | ML review analysis       |

## Infrastructure

| Script                 | Cron      | Description                       |
| ---------------------- | --------- | --------------------------------- |
| `self-healer.cjs`      | \*/30     | Auto-fix containers, disk, memory |
| `system-test.cjs`      | on-demand | 24 end-to-end tests               |
| `alert-aggregator.cjs` | \*/2h     | Unified P1/P2/P3 alerts           |

## Knowledge Layer

| Script                    | Cron        | Description                              |
| ------------------------- | ----------- | ---------------------------------------- |
| `knowledge-indexer.cjs`   | daily 04:00 | Build search index (70 docs, 761 chunks) |
| `knowledge-retriever.cjs` | on-demand   | Domain-filtered search                   |
| `vault-organizer.cjs`     | on-demand   | Organize memory by domain                |
