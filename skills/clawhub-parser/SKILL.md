---
name: clawhub-parser
description: "Parses and analyzes the Clawhub skills registry to discover, score, and recommend new skills. Use when the user asks: 'what new skills should I install?', 'find useful skills on clawhub', 'what am I missing?', 'audit my skills', 'top clawhub skills', or wants a comparison of installed vs available skills."
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["clawhub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "clawhub",
              "bins": ["clawhub"],
              "label": "Install ClawHub CLI (npm)",
            },
          ],
      },
  }
---

# ClawHub Parser & Skill Analyst

Systematically analyzes the Clawhub registry to surface the most useful, unique, and high-signal skills given what's already installed.

## Workflow

### Step 1 — Gather installed skills

```bash
clawhub list
```

Also check local skills directory for untracked items:

```bash
ls skills/
```

### Step 2 — Explore Clawhub catalog

Fetch latest updated skills:

```bash
clawhub explore
```

Search by high-value categories (run each):

```bash
clawhub search "memory knowledge graph agent"
clawhub search "productivity automation workflow"
clawhub search "search web research"
clawhub search "security vetting audit"
clawhub search "communication email calendar"
clawhub search "code development IDE"
clawhub search "proactive autonomous agent"
clawhub search "data analysis sheets csv"
```

### Step 3 — Inspect top candidates

For any skill with high stars/downloads that isn't installed, inspect it:

```bash
clawhub inspect <slug>
```

### Step 4 — Score and rank candidates

For each candidate not yet installed, score across these dimensions (1–5):

| Dimension        | Description                                              |
| ---------------- | -------------------------------------------------------- |
| **Popularity**   | Stars + downloads from Clawhub listing                   |
| **Uniqueness**   | Does it cover a gap not filled by any installed skill?   |
| **Requirements** | Minimal deps (no API key = higher score), cross-platform |
| **Utility**      | How often would it be used in typical workflows?         |
| **Safety**       | VirusTotal clean + OpenClaw scan = benign                |

Total score = sum of dimensions. Recommend skills with score ≥ 18/25.

### Step 5 — Output report

Present results as a Markdown table:

```
| Skill | Stars | Gap Filled | Score | Install |
|-------|-------|------------|-------|---------|
| ...   | ...   | ...        | ...   | clawhub install <slug> |
```

Group by category:

- 🧠 **Agent Intelligence** — memory, proactive behavior, self-improvement
- 🔍 **Research & Search** — multi-engine search, web research
- 🔒 **Security** — skill vetting, audit
- 🔗 **Integrations** — APIs, calendars, communication
- 🛠️ **Dev Tools** — code, automation, workflows
- 🎨 **Content** — writing, media, text transforms

### Step 6 — Confirm and install

Show the top 5 recommendations. Ask user which to install, then:

```bash
clawhub install <slug>
```

## Scoring Reference — Known High-Value Gaps

Based on analysis of the Clawhub catalog vs typical OpenClaw installs, these skills consistently fill genuine gaps:

| Skill                 | Category              | Why It's Unique                                                                                |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `ontology`            | 🧠 Agent Intelligence | Typed knowledge graph for persistent structured memory — not covered by note-taking skills     |
| `proactive-agent`     | 🧠 Agent Intelligence | WAL protocol, working buffer, compaction recovery — proactive patterns beyond self-improvement |
| `skill-vetter`        | 🔒 Security           | Vets skills before install; catches suspicious patterns. No equivalent installed               |
| `find-skills`         | 🔍 Discovery          | Helps agent discover skills dynamically when user asks capability questions                    |
| `multi-search-engine` | 🔍 Research           | 17 engines (8 CN + 9 global), no API key required                                              |
| `api-gateway`         | 🔗 Integrations       | 100+ OAuth APIs (Google, MS365, HubSpot, Airtable) via managed auth                            |
| `auto-updater`        | 🛠️ Maintenance        | Daily cron-based skill auto-update with changelog digest                                       |
| `humanizer`           | 🎨 Content            | Makes AI-generated text sound natural — no other installed skill does this                     |
| `caldav-calendar`     | 🔗 Integrations       | Syncs iCloud/Google/Nextcloud calendars via vdirsyncer + khal                                  |
| `answeroverflow`      | 🔍 Research           | Searches indexed Discord dev community threads — unique source                                 |

## Notes

- Always run `clawhub inspect <slug>` before recommending. Check: license, VirusTotal status, OpenClaw scan result.
- Flag skills marked "Suspicious" by OpenClaw scanner — present the details to the user and let them decide.
- Never auto-install without explicit user confirmation.
- Skills requiring paid API keys score lower on Requirements unless the user already has the key.
- Prefer skills by verified/trusted authors (`@steipete`, `@pskoett`, `@oswalpalash`, `@halthelobster`) but always verify the scan regardless.
- After installing, suggest the user restart the agent session so new skills are loaded.

## Quick Commands

```bash
# Full catalog browse
clawhub explore

# Targeted search
clawhub search "<topic>"

# Check a specific skill before installing
clawhub inspect <slug>

# Install
clawhub install <slug>

# Update all
clawhub update --all

# List installed
clawhub list
```
