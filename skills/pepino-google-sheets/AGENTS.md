# Pepino Agent OS — Agent Guide

## Quick Navigation

- Scripts dir: /home/roman/openclaw/skills/pepino-google-sheets/
- Governance: /home/roman/openclaw/skills/pepino-core/
- Knowledge: ~/.openclaw/workspace/memory/knowledge/
- Client profiles: ~/.openclaw/workspace/memory/people/clients/
- Farm state cache: /tmp/pepino-farm-state.json
- Exchange rates: ~/.openclaw/.exchange-rates.json
- Knowledge index: ~/.openclaw/workspace/memory/knowledge-index.json

## How to Read Data

Always prefer farm-state.cjs cache over direct Sheets reads:

```js
const { getState, getClients, getStock } = require("./farm-state.cjs");
const state = await getState(); // auto-refreshes if stale
```

Direct Sheets (only if cache doesn't have what you need):

```js
const { readSheet, appendToSheet, PEPINO_SHEETS_ID } = await import("./sheets.js");
```

## How to Write Data

Append to Sheets: `appendToSheet(PEPINO_SHEETS_ID, [row], "Sheet Name")`
API POST: `curl -X POST -H "Auth..." http://127.0.0.1:4000/log/sales -d '{...}'`
Quick expense: `node expense-quick-entry.cjs "description amount"`

## How to Send Notifications

```js
// Prefer throttled sending (dedup + rate limit + quiet hours)
const { sendThrottled } = require("./notification-throttle.cjs");
await sendThrottled(message, { thread: 20, priority: "normal" });
```

## How to Search Knowledge

```js
const { search } = require("./knowledge-retriever.cjs");
const results = search("query", { domain: "finance", limit: 3 });
```

## How to Normalize Product Names

```js
const { normalize } = require("./product-aliases.cjs");
normalize("Свежий огурец"); // -> "Огурец"
```

## Key Patterns

- All .cjs scripts use `await import("./sheets.js")` for ESM from CJS
- All support --dry-run flag
- All include Langfuse tracing via langfuse-trace.cjs
- Telegram thread 20 = Director/Strategy topic
- Product names MUST be normalized via product-aliases.cjs
- Use helpers.cjs for parseNum/parseDate/fmtDate/rowsToObjects (don't duplicate)
- Use client-analytics.cjs for any client analysis (don't reimplement)
- Use farm-state.cjs for reading data (don't call readSheet directly)

## File Naming

- .cjs = CJS automation scripts (cron or interactive)
- .js = ESM scripts (morning-brief, weekly-report, etc.)
- SKILL.md = agent/skill definition
- SCRIPTS.md = full index of all scripts

## Testing

Run: node system-test.cjs (24 tests, must be 24/24)
Per-script: node --check <file>.cjs

## Don't

- Don't read Sheets directly if farm-state.cjs has the data
- Don't send Telegram without notification-throttle
- Don't use raw product names -- always normalize()
- Don't create new files unless necessary -- edit existing
- Don't install npm packages -- use built-in node modules
