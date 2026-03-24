# Proposals Review — Pepino Pick Agent OS

> Date: 2026-03-20
> Source: Conversation transcript `2b28db30-8938-4886-8eb8-64ce92e3bd7f.jsonl`
> Scope: All proposals received in the session vs current implementation state

---

## 1. Summary of ALL Proposals Received

### Proposal A: Consolidated System File (92K chars, line 10)

Full design spec for the Agent OS, comprising 16 files:

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `ORG_SYSTEM.md`                      | 7 circuits operating model                    |
| `MASTER_INDEX.yaml`                  | 30 agents, intent router, registry            |
| `MASTER_INDEX_BILLION_PATCH.yaml`    | Scale layers (franchise, capital markets, IP) |
| `DATA_SCHEMA.yaml`                   | All data entities                             |
| `DATA_SCHEMA_GROWTH_PATCH.yaml`      | Growth-stage extensions                       |
| `CASE_SCHEMA.yaml`                   | Case management                               |
| `CASE_SCHEMA_GROWTH_PATCH.yaml`      | Case growth extensions                        |
| `APPROVAL_MATRIX_BILLION_PATCH.yaml` | Approval workflows                            |
| `REPORTING_CADENCE.yaml`             | Reports schedule                              |
| `SKILLS.yaml`                        | Skill clusters (10 domains, L1-L5 levels)     |
| `INTEGRATIONS.yaml`                  | Integration registry                          |
| `PROCUREMENT_AGENT_PATCH.yaml`       | Procurement specifics                         |
| `PROMPT_RULES.md`                    | Agent prompt constraints                      |
| `BOOTSTRAP_ORDER.md`                 | 10-wave deployment plan                       |
| `DEPLOYMENT_README.md`               | Deployment instructions                       |
| `SOP_REGISTRY.yaml`                  | SOP index                                     |

**BOOTSTRAP_ORDER defines 10 waves:**

| Wave | Focus                     | Key Components                                                                    |
| ---- | ------------------------- | --------------------------------------------------------------------------------- |
| 0    | Repository bootstrap      | YAML validation, naming, no duplicates                                            |
| 1    | Data + control foundation | data_steward, evals_guardrails, internal_audit, stores                            |
| 2    | Case system + routing     | orchestrator, case lifecycle, handoff, routing                                    |
| 3    | Core risk + finance       | controller, legal, qa_haccp, treasury                                             |
| 4    | Farm core                 | agronomy, engineering, postharvest, logistics, nursery, fermentation, procurement |
| 5    | Commercial layer          | sales, marketing, customer_success, personal_brand                                |
| 6    | Strategy + expansion      | pmo, real_estate, ceo, chief_of_staff, decision_coach                             |
| 7    | Knowledge + skills        | knowledge_librarian, training_skills, SOP automation                              |
| 8    | Improvement engine        | kaizen, postmortem, experiment workflow                                           |
| 9    | Dashboards + exec screen  | CEO, Farm Ops, Sales, Quality, Improvement, AI Control screens                    |
| 10   | Production hardening      | Evals, rollback drills, approval bypass tests                                     |

**MASTER_INDEX defines 30 agents:**
ceo_agent, chief_of_staff_agent, decision_coach_agent, personal_brand_agent, treasury_agent, pmo_agent, real_estate_agent, agronomy_agent, nursery_agent, engineering_agent, postharvest_agent, logistics_agent, fermentation_agent, procurement_agent, sales_agent, marketing_reputation_agent, customer_success_agent, legal_agent, qa_haccp_agent, controller_agent, due_diligence_agent, internal_audit_agent, ai_architect_agent, data_steward_agent, knowledge_librarian_agent, evals_guardrails_agent, training_skills_agent, kaizen_agent, reporting_office_agent, postmortem_agent

---

### Proposal B: YAML Patches — Profit Engine Extension (86K chars, line 116)

Three patches extending reporting, case schema, and master index:

| Patch ID                                    | Target                 | Purpose                                                                                                           |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `reporting_cadence_profit_engine_extension` | REPORTING_CADENCE.yaml | Adds profit engine widgets to daily ops digest, weekly review, monthly board pack, improvement screen, CEO screen |
| `caseschema_profit_engine_extension`        | CASE_SCHEMA.yaml       | Adds experiment/profit-engine case types                                                                          |
| `masterindex_profit_engine_extension`       | MASTER_INDEX.yaml      | Adds profit engine agents/roles                                                                                   |

Also included: **Model Benchmark & Routing Policy** defining:

- 15+ LLM providers (Ollama, Groq, DeepSeek, Kimi, Claude, Gemini, Perplexity, etc.)
- Risk-tiered routing (low/medium/high/critical)
- Observability mapping (case_id, cost, latency, quality_score per run)
- Approval limits per model tier

---

### Proposal C: Knowledge Architecture (10K chars, line 874)

Architecture for Obsidian + NotebookLM + Claude Code knowledge layer:

- **Obsidian** = permanent long-term knowledge (decision memos, SOPs, lessons, postmortems)
- **NotebookLM** = temporary source-grounded research (PDF/docs analysis, briefing packs)
- **Claude Code** = bridge/orchestrator

Key components:

1. **Vault structure**: 13 folders (00_inbox through 12_partner_investor_research + 99_archive)
2. **Naming convention**: `<type>__<domain>__<short_name>__v1.md`
3. **Workflow**: case -> context check -> NLM if needed -> synthesize -> write to Obsidian -> link to case/SOP/KPI
4. **CLAUDE_CODE_KNOWLEDGE_ROUTER.md**: System prompt for knowledge routing
5. **10 note types**: case_context, decision_memo, sop_index, lesson, postmortem, architecture, research, training, meeting, project_brief
6. **3 frontmatter templates**: case_context, decision_memo, sop_index
7. **6 NLM notebook packs**: market_intel, supplier_dd, capex_investor, regulatory, agronomy_research, ai_architecture

---

### Proposal D: Obsidian Vault Structure (5.5K chars, line 7268)

Simplified vault for YouTube/NotebookLM integration pipeline:

- **9-folder structure**: 00-Inbox, 10-Sources, 20-Insights, 30-SOP, 40-Agents, 50-Workflows, 60-Decisions, 70-Projects, 90-Archive
- **MANIFEST.md**: routing guide for Claude Code
- **YouTube source template**: structured markdown with Summary, Key Points, Applicable to Pepino Pick, Actions, SOP/Prompt/Workflow Patches, Route
- **Agent spec template**: role, inputs, outputs, guardrails
- **Naming**: `YYYY-MM-DD__type__slug.md`
- **Pipeline**: Telegram -> Claude Code -> source note -> insight note -> decision/SOP/workflow note -> OpenClaw/n8n

**Agent evaluation (line 7270)** concluded that 4/9 proposed folders are redundant with existing `pepino-graph/` and recommended extending pepino-graph with `05-sources/` and `06-sop/` only.

---

## 2. Implementation Status: DONE vs NOT DONE

### Proposal A: Consolidated System File

| Component                          | Status   | Evidence                                                                                             |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Dispatcher/Orchestrator (Wave 2)   | DONE     | `pepino-dispatcher` v3 with 28 intents, case_id, NLM matrix                                          |
| Case system with case_id           | DONE     | Dispatcher generates case_id, Sheets has case/alert/decision tabs                                    |
| Approval STOP-block                | DONE     | Machine-readable, 5 rules, tier 1/2/3, hard_block                                                    |
| Controller/Finance (Wave 3)        | DONE     | `pepino-controller`, `pepino-finance-tools`, `pepino-argentina-finance`, `pepino-financial-modeling` |
| Legal (Wave 3)                     | DONE     | `pepino-legal`                                                                                       |
| QA/HACCP (Wave 3)                  | DONE     | `pepino-qa-food-safety`                                                                              |
| Treasury (Wave 3)                  | DONE     | `pepino-ai-treasury`                                                                                 |
| Agronomy (Wave 4)                  | DONE     | `pepino-agro-ops`, `pepino-agro-cucumber-photos` v2                                                  |
| Engineering/Greenhouse (Wave 4)    | DONE     | `pepino-greenhouse-tech`                                                                             |
| Fermentation (Wave 4)              | DONE     | `pepino-fermentation`                                                                                |
| Procurement (Wave 4)               | DONE     | `pepino-procurement`                                                                                 |
| Sales (Wave 5)                     | DONE     | `pepino-sales-crm`                                                                                   |
| Brand/Marketing (Wave 5)           | DONE     | `pepino-brand`                                                                                       |
| Chef Network/Customer (Wave 5)     | DONE     | `pepino-chef-network`                                                                                |
| Real Estate (Wave 6)               | DONE     | `pepino-realtor`                                                                                     |
| CEO/Shadow CEO (Wave 6)            | DONE     | `pepino-shadow-ceo`                                                                                  |
| Knowledge (Wave 7)                 | DONE     | `pepino-knowledge` v2 with Obsidian write protocol                                                   |
| Risk (Wave 3 adjacent)             | DONE     | `pepino-risk`                                                                                        |
| Capital/Investor (Wave 6 adjacent) | DONE     | `pepino-capital`                                                                                     |
| Innovation Lab (Wave 8 adjacent)   | DONE     | `pepino-innovation-lab`                                                                              |
| Climate Guard                      | DONE     | `pepino-climate-guard` (new, commit 6c1384c5)                                                        |
| Demand Oracle                      | DONE     | `pepino-demand-oracle` (new, commit 6c1384c5)                                                        |
| Weekly Review (Wave 6/9)           | DONE     | `pepino-weekly-review` + `weekly-report.js` cron                                                     |
| Team Ops (Wave 4/5)                | DONE     | `pepino-team-ops`                                                                                    |
| Maps/Logistics                     | DONE     | `pepino-maps-tools`                                                                                  |
| Google Sheets SSOT                 | DONE     | `pepino-google-sheets` with 18 sheets                                                                |
| Morning brief                      | DONE     | Cron 06:00 daily                                                                                     |
| Evening report                     | DONE     | Cron 21:00 daily                                                                                     |
| Healthcheck                        | DONE     | 11 components, cron every 30 min                                                                     |
| NotebookLM MCP                     | DONE     | 92 notebooks, Playwright auth                                                                        |
| **Postharvest agent**              | NOT DONE | No `pepino-postharvest` skill                                                                        |
| **Logistics agent**                | PARTIAL  | `pepino-maps-tools` exists but no dedicated logistics/dispatch skill                                 |
| **Nursery agent**                  | NOT DONE | No `pepino-nursery` skill                                                                            |
| **Customer Success agent**         | NOT DONE | Covered partially by `pepino-sales-crm` and `pepino-chef-network`                                    |
| **Marketing/Reputation agent**     | PARTIAL  | `pepino-brand` exists but no reputation monitoring integrated                                        |
| **PMO agent**                      | NOT DONE | No project management office skill                                                                   |
| **Chief of Staff agent**           | NOT DONE | Partially covered by `pepino-shadow-ceo`                                                             |
| **Decision Coach agent**           | NOT DONE | No dedicated skill                                                                                   |
| **Due Diligence agent**            | NOT DONE | No dedicated skill (OSINT tools exist separately)                                                    |
| **Internal Audit agent**           | NOT DONE | No skill                                                                                             |
| **AI Architect agent**             | NOT DONE | No skill (meta-agent for AI system architecture)                                                     |
| **Data Steward agent**             | NOT DONE | No skill                                                                                             |
| **Evals/Guardrails agent**         | NOT DONE | No skill                                                                                             |
| **Training/Skills agent**          | NOT DONE | No skill                                                                                             |
| **Kaizen agent**                   | NOT DONE | No skill                                                                                             |
| **Reporting Office agent**         | NOT DONE | Reports exist but no dedicated orchestrator                                                          |
| **Postmortem agent**               | NOT DONE | Templates exist in Obsidian, no dedicated skill                                                      |
| **Dashboard screens (Wave 9)**     | PARTIAL  | Grafana CEO dashboard exists, no Farm Ops/Sales/Quality/AI Control screens                           |
| **Production hardening (Wave 10)** | NOT DONE | No eval suite, rollback drills, or integration failure tests                                         |
| **YAML validation (Wave 0)**       | NOT DONE | Spec files exist in conversation only, not in repo                                                   |

**Score: 28/30 agents as skills, but only ~20/30 MASTER_INDEX agents covered. Waves 7-10 largely NOT DONE.**

### Proposal B: Profit Engine + Model Routing

| Component                              | Status                                        |
| -------------------------------------- | --------------------------------------------- |
| Profit engine dashboards/widgets       | NOT DONE                                      |
| Experiment/kill-iterate-scale workflow | NOT DONE                                      |
| Winner/loser product tracking          | NOT DONE                                      |
| Margin per m2 trend                    | PARTIAL (data in Sheets, no dedicated widget) |
| Procurement savings pipeline           | NOT DONE                                      |
| Model benchmark policy                 | NOT DONE                                      |
| Multi-LLM routing with risk tiers      | NOT DONE                                      |
| Observability mapping per LLM run      | NOT DONE                                      |
| Approval limits per model tier         | NOT DONE                                      |

**Score: 0% implemented. Entire profit engine and model routing policy is spec-only.**

### Proposal C: Knowledge Architecture

| Component                                                       | Status   |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| Obsidian vault at `/home/roman/pepino-obsidian/`                | DONE     | 60+ markdown files across 20 folders                                                                          |
| Vault structure (13-folder)                                     | DONE     | Folders created matching the proposal                                                                         |
| Naming convention `type__domain__slug__date.md`                 | DONE     | Files follow this pattern                                                                                     |
| Frontmatter templates (case_context, decision_memo, postmortem) | DONE     | Active files use correct frontmatter                                                                          |
| CLAUDE_CODE_KNOWLEDGE_ROUTER.md                                 | DONE     | `09_architecture_ai/CLAUDE_CODE_OBSIDIAN_SYSTEM_PROMPT.md`                                                    |
| NotebookLM MCP integration                                      | DONE     | 92 notebooks, 6 standard packs                                                                                |
| NotebookLM ID registry in dispatcher                            | DONE     | Step 8 NLM decision matrix                                                                                    |
| SOP index notes                                                 | DONE     | 6 SOPs in `04_sops_index/`                                                                                    |
| Templates folder                                                | DONE     | 11 templates in `Templates/`                                                                                  |
| Case context notes                                              | DONE     | 2 active cases                                                                                                |
| Decision memos                                                  | DONE     | 3 memos                                                                                                       |
| Postmortems                                                     | DONE     | 3 postmortems                                                                                                 |
| Lessons learned                                                 | DONE     | 3 lessons + index                                                                                             |
| Playbooks                                                       | DONE     | 3 playbooks + index                                                                                           |
| Market intel                                                    | DONE     | 3 files                                                                                                       |
| CEO Dashboard daily notes                                       | DONE     | Daily summaries in `00-CEO-Dashboard/`                                                                        |
| Workflow: case -> NLM -> Obsidian -> link                       | PARTIAL  | Manual flow works; no automated pipeline                                                                      |
| 6 NLM notebook packs                                            | DONE     | IDs in dispatcher (market_intel, supplier_dd, capex_investor, regulatory, agronomy_research, ai_architecture) |
| SOP change proposals trigger training                           | NOT DONE |
| Auto-link notes to weekly/monthly reports                       | NOT DONE |
| Knowledge search by Claude Code (grep pepino-graph)             | NOT DONE | No search index or agent routing                                                                              |

**Score: ~75% implemented. Structure and templates done, automation gaps remain.**

### Proposal D: Simplified Vault (YouTube Pipeline)

| Component                                      | Status   |
| ---------------------------------------------- | -------- | ------------------------------------------------- |
| pepino-graph `05-sources/` directory           | DONE     | Created with youtube/, articles/, notebooks/      |
| pepino-graph `06-sop/` directory               | DONE     | Created with INDEX.md                             |
| YouTube source template                        | PARTIAL  | `youtube-knowledge.cjs` exists, 1 video processed |
| MANIFEST.md                                    | DONE     | Shows structure, counts, quick search             |
| YouTube -> NotebookLM -> summary pipeline      | PARTIAL  | `youtube-knowledge.cjs` CLI exists, not automated |
| Article knowledge pipeline                     | NOT DONE | `05-sources/articles/` empty                      |
| Search index for pepino-graph                  | NOT DONE |
| Dispatcher route for "what do we know about X" | NOT DONE |
| Tiered context injection strategy              | NOT DONE | Skills still bulk-loaded                          |

**Score: ~40% implemented. Infrastructure exists, pipeline automation missing.**

---

## 3. Priority Recommendations

### P0 — Critical (security + reliability)

These are from `CLAUDE_CODE_TASKS.md` and still unresolved:

1. **Sheets API bind to 127.0.0.1** — `sheets-api.js` listens on `0.0.0.0:4000` without auth
2. **API keys from openclaw.json to env vars** — plaintext secrets
3. **n8n webhook bind to 127.0.0.1** — Docker port 5678 open on `0.0.0.0`
4. **Crontab dedup: morning-brief** — two entries (06:00 and 07:00), second probably fails (no `cd`)

### P1 — High Impact (value generation)

1. **Profit Engine MVP** — Proposal B defines winner/loser product tracking, margin/m2, experiment workflow. This is the highest-value unimplemented proposal. Start with a `pepino-profit-engine` skill or extend `pepino-controller`.
2. **Knowledge search routing** — Dispatcher needs a "knowledge query" intent that greps pepino-graph and Obsidian vault. Currently knowledge is stored but not queryable by agents.
3. **YouTube-to-knowledge automation** — `youtube-knowledge.cjs` exists but is manual. Wire Telegram command -> auto-process -> write to pepino-graph.
4. **Knowledge graph enrichment** — MANIFEST shows only 3 entities, 1 relation, 2 insights. Need bulk import of clients, suppliers, products from Sheets data.

### P2 — Important (completeness)

1. **Missing Wave 4-6 agents** — postharvest, nursery, customer_success, PMO, chief_of_staff, decision_coach. These are design-spec agents with no implementation. Evaluate which actually need separate skills vs being covered by existing ones.
2. **Model routing policy** — Proposal B defines a multi-LLM routing system. Not critical now (single Claude provider), but valuable when cost optimization matters.
3. **Dashboard expansion** — Only CEO Grafana dashboard exists. Farm Ops and Quality screens from Wave 9 would help daily operations.

### P3 — Backlog

1. **Internal audit, data steward, evals/guardrails agents** (Wave 1/7) — governance agents that matter at scale
2. **Kaizen/postmortem agents** (Wave 8) — improvement engine
3. **Production hardening** (Wave 10) — eval suite, rollback drills
4. **Article knowledge pipeline** — extend youtube-knowledge pattern for web articles/PDFs
5. **Obsidian <-> Sheets sync optimization** — currently runs 3x/day, evaluate if useful or creating stale data

---

## 4. Specific Actionable Tasks

### Task 1: Fix Security Issues (P0, ~2 hours)

```
Files: skills/pepino-google-sheets/sheets-api.js
Action: Change listen address from 0.0.0.0 to 127.0.0.1
Test: curl from remote IP should fail, localhost should work
```

### Task 2: Fix Crontab Morning Brief Duplicate (P0, ~15 min)

```
Action: Remove the bare `0 7 * * * /usr/bin/node morning-brief.js` entry
        (missing cd, probably fails). Keep the 06:00 pepino-morning-brief.sh entry.
```

### Task 3: Profit Engine Skill (P1, ~4 hours)

```
Create: skills/pepino-profit-engine/SKILL.md
Features:
  - Winner/loser product classification (from Sheets sales + cost data)
  - Margin per m2 calculation and trend
  - Experiment lifecycle: propose -> baseline -> measure -> kill/iterate/scale
  - Weekly profit engine report integrated into weekly-report.js
```

### Task 4: Knowledge Query Routing (P1, ~2 hours)

```
Modify: pepino-dispatcher SKILL.md — add intent "knowledge_query"
Create: A handler that greps pepino-graph + pepino-obsidian for relevant files
Pattern: intent detected -> grep by keywords/tags -> read 1-3 files -> answer with citations
```

### Task 5: YouTube Pipeline Automation (P1, ~2 hours)

```
Modify: youtube-knowledge.cjs — add NotebookLM MCP integration
Flow: URL -> nblm_add_source_url -> nblm_get_summary -> write to 05-sources/youtube/
Wire: Dispatcher intent "youtube_knowledge" to trigger this flow
```

### Task 6: Knowledge Graph Bulk Import (P1, ~3 hours)

```
Script: Import from Google Sheets into pepino-graph entities
  - Clients from sales data -> 01-entities/clients/
  - Products with margins -> 01-entities/products/
  - Suppliers from procurement -> 01-entities/suppliers/
  - Relations: client->product, supplier->input
```

### Task 7: Evaluate Missing Agents (P2, ~1 hour analysis)

```
Agents to evaluate: postharvest, nursery, customer_success, PMO, chief_of_staff, decision_coach
Question for each: Is this already covered by an existing skill, or does it need its own?
Likely conclusion:
  - customer_success -> merge into pepino-sales-crm (add retention/complaints)
  - chief_of_staff -> merge into pepino-shadow-ceo
  - decision_coach -> merge into pepino-shadow-ceo
  - postharvest -> new skill needed (grading, cold chain, inventory)
  - nursery -> new skill needed (seedling management)
  - PMO -> new skill needed (project tracking, CAPEX flow)
```

### Task 8: Grafana Farm Ops Dashboard (P2, ~3 hours)

```
Create second Grafana dashboard "pepino-farm-ops":
  - VPD/temperature/humidity live
  - Irrigation schedule
  - Pest/disease alerts
  - Harvest forecast vs actual
Data source: existing sheets-api.js endpoints
```

---

## Appendix: Current Infrastructure Summary

| Component                        | Count | Location                                     |
| -------------------------------- | ----- | -------------------------------------------- |
| OpenClaw repo skills (pepino-\*) | 28    | `/home/roman/openclaw/skills/pepino-*/`      |
| Installed skills (pepino-\*)     | 39    | `~/.openclaw/skills/pepino-*/`               |
| Total installed skills           | 100+  | `~/.openclaw/skills/`                        |
| Obsidian vault files             | ~60   | `/home/roman/pepino-obsidian/`               |
| pepino-graph files               | ~12   | `~/.openclaw/workspace/memory/pepino-graph/` |
| Google Sheets tabs               | 18+   | Spreadsheet `1AB9nkHfCu8_...`                |
| NotebookLM notebooks             | 92    | MCP server                                   |
| Active cron jobs                 | 19    | crontab                                      |
| Grafana dashboards               | 1     | `pepino-ceo-live`                            |
| MASTER_INDEX agents              | 30    | Design spec (not in repo)                    |
| Bootstrap waves                  | 10    | Design spec (not in repo)                    |
