# Pepino Pick Agent OS v2 — Retrieval Policy

Правила доступа агентов к knowledge layer.

---

## Domain Access Matrix

| Agent                 | Allowed Domains                         | Sensitivity |
| --------------------- | --------------------------------------- | ----------- |
| pepino-dispatcher     | all (routing only)                      | read-only   |
| pepino-agronomist     | agronomy, sop, incidents                | full        |
| pepino-finance        | finance, sop, decisions, strategy       | full        |
| pepino-sales          | sales, sop, clients                     | full        |
| pepino-procurement    | procurement, sop, finance (prices only) | filtered    |
| pepino-legal          | legal, risk, sop, reference             | full        |
| pepino-risk           | risk, legal, sop, incidents             | full        |
| pepino-dev            | governance, sop, reference              | full        |
| pepino-ceo (director) | all domains                             | full        |
| cron scripts          | domain-specific per script              | automated   |

## Retrieval Rules

1. **Claude Code decides** — retrieval is triggered only by Claude Code orchestrator, not by individual agents
2. **Domain filter required** — every search MUST specify domain(s), no "search everything"
3. **Source attribution** — results MUST include source filepath for verification
4. **Sensitivity filter** — `sensitivity: restricted` documents only visible to director + legal
5. **Result limit** — max 5 chunks per query to avoid context flooding
6. **Freshness preference** — prefer documents updated within 30 days over older ones

## Document Types & Indexing Priority

| Type        | Priority | Index?    | Notes                             |
| ----------- | -------- | --------- | --------------------------------- |
| sop         | High     | Always    | Standard operating procedures     |
| decision    | High     | Always    | Business decisions with rationale |
| incident    | High     | Always    | Past incidents, lessons learned   |
| reference   | Medium   | Always    | Formulas, specs, regulations      |
| playbook    | Medium   | Always    | Role-specific action scenarios    |
| source-note | Low      | If tagged | Raw notes, only if has domain tag |
| draft       | None     | Never     | Work in progress                  |
| daily-log   | None     | Never     | Ephemeral, use episodes instead   |

## Knowledge Lifecycle

```
New note → Obsidian Vault
      ↓ (cron: vault-organizer)
Domain directory → knowledge/
      ↓ (cron: knowledge-indexer)
JSON Index → knowledge-index.json
      ↓ (on-demand: knowledge-retriever)
Agent query → ranked results with source paths
```

## Usage

```bash
# Index all knowledge
node knowledge-indexer.cjs index

# Search with domain filter
node knowledge-retriever.cjs "minimum margin pricing" --domain finance --limit 3

# Agent-role search
node knowledge-retriever.cjs "pest control cucumber" --agent agronomist
```
