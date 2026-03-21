# Pepino Agent OS v2 — Automation Platform

AI-powered operating system for Pepino Pick greenhouse farm (Buenos Aires, Argentina).

## Quick Start

```bash
# Add CLI alias (one time)
echo 'alias pepino="node /home/roman/openclaw/skills/pepino-google-sheets/pepino-cli.cjs"' >> ~/.bashrc
source ~/.bashrc

# System status
pepino status

# Sales this week
pepino sales week

# Log an expense
pepino expense "субстрат 5000"

# Client health scores
pepino scores

# Run system tests
pepino test

# Full help
pepino help
```

## Architecture

```
Telegram (15 topics) ←→ OpenClaw Gateway
         ↓
Claude Code (orchestrator)
         ↓
┌──────────────┐  ┌───────────┐  ┌─────────────────┐
│ 54 CJS       │  │ Sheets    │  │ Knowledge Layer  │
│ scripts      │→ │ API v2    │  │ 70 docs          │
│ 49 cron jobs │  │ 27 endpts │  │ 761 chunks       │
└──────────────┘  └───────────┘  └─────────────────┘
         ↓              ↓               ↓
┌──────────┐  ┌──────────┐  ┌──────────────────┐
│ Grafana  │  │ Langfuse │  │ Trend Radar      │
│ 6 dashbd │  │ v3 obsrv │  │ 5 streams        │
└──────────┘  └──────────┘  └──────────────────┘
```

## Key Files

- `SCRIPTS.md` — full index of all automation scripts
- `pepino-cli.cjs` — unified CLI entry point
- `system-test.cjs` — 24 e2e tests (run: `pepino test`)
- `status-page.cjs` — HTML dashboard at /tmp/pepino-status.html
- `pipeline-runner.cjs` — morning/evening/sunday pipelines

## Governance

All governance at `skills/pepino-core/`:

- `ENTITIES.md` — 11 canonical schemas
- `AGENT_REGISTRY.md` — 31 agent cards
- `POLICY_ENGINE.md` — L0-L4 approval levels
- `STATE_MACHINE.md` — 9-state task lifecycle
- `LEARNING_LOOP.md` — post-decision review
- `MEMORY_SYSTEM.md` — 4-type memory
- `RETRIEVAL_POLICY.md` — domain access matrix
- `EVAL_SUITE.md` — 50 test cases

## Daily Cycle

| Time  | Script                 | Purpose            |
| ----- | ---------------------- | ------------------ |
| 04:00 | knowledge-indexer      | Index sync         |
| 06:00 | morning-brief          | Morning dashboard  |
| 06:30 | delivery-optimizer     | Route planning     |
| 06:45 | daily-ops-checklist    | Operator checklist |
| 07:00 | recalculate-aggregates | P&L aggregation    |
| 08:03 | inventory-tracker      | Stock alerts       |
| 09:00 | supplier-monitor       | Material alerts    |
| 20:00 | data-completeness      | Gap check          |
| 21:07 | daily-pnl              | P&L + margin       |
| 22:00 | llm-cost-telegram      | AI costs           |

## Sheets API (port 4000)

Auth: `Authorization: Bearer <token>` (token at `~/.openclaw/.sheets-api-token`)

Key endpoints: `/sales`, `/production`, `/expenses`, `/inventory`, `/clients`, `/forecast`, `/waste`, `/dashboard`

Query: `?all=true` (no limit), `?limit=N`
