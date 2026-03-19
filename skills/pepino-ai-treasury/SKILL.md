---
name: pepino-ai-treasury
description: "⚙️ AI Treasury — управление расходами на AI, контроль premium-моделей, prompt compression, бенчмарки моделей, провайдерная устойчивость. Авто-вызывай при словах AI расходы, token budget, стоимость AI, оптимизация промптов, сжать промпт, бенчмарк модели, смена провайдера, AI Control Screen, AI governance, prompt compression, cost per case."
homepage: https://pepino.pick
metadata:
  openclaw:
    emoji: "⚙️"
    requires:
      bins: []
---

# ⚙️ Pepino Pick — AI Treasury Layer

Governance AI-расходов, quality/cost баланс, prompt compression, управление провайдерами.

**Принцип:** Control integrity before token savings. Relevant context before complete history.

---

## Четыре модуля

### Модуль 1 — Cost Governance (llm_treasury_agent)

### Модуль 2 — Prompt Compression (prompt_compression_agent)

### Модуль 3 — Model Benchmarking (model_benchmark_agent)

### Модуль 4 — Provider Portfolio (provider_portfolio_agent)

---

## Модуль 1 — Cost Governance

**Триггеры:** "AI расходы", "стоимость AI", "token budget", "cost per case"

### Monitoring Framework

```
ЕЖЕДНЕВНО отслеживать:
  → AI spend сегодня (токены × тариф)
  → Premium model share (% от всех вызовов)
  → Cheap pass rate (% задач, решённых без premium)
  → Cache hit rate (% ответов из кэша)
  → Waste token rate (вывод без downstream use)

ЕЖЕНЕДЕЛЬНО:
  → Spend by circuit (agronomy / finance / sales / etc.)
  → Cost per case type (crop_issue / price_change / etc.)
  → Top-5 "дорогих" агентов
  → Budget vs actuals
```

### Budget Guardrails (Soft-Limit Model)

```
Режимы контроля:

NOTIFY-ONLY (всегда):
  → Логировать каждый llm run с cost estimate
  → Видимость spend по провайдеру / агенту / circuit

ADVISORY (при приближении к лимитам):
  → Рекомендовать: output caps, compression, cache hints
  → Не блокировать рабочие процессы

SOFT-LIMIT (при превышении еженедельного порога):
  → Перенаправить noncritical work на cheaper models
  → Premium usage — только с approval
  → Critical paths остаются доступными ВСЕГДА

FREEZE (только по явному решению CEO):
  → Заморозить new deployments
  → Сохранить only критические operational workflows
```

### AI Control Screen — метрики

```
📊 AI CONTROL SCREEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Сегодня:
  AI Spend:        [X] USD  | MTD: [Y] USD
  Premium share:   [X]%     | Target: < [Z]%
  Cheap pass rate: [X]%     | Target: > [Z]%
  Cache hit rate:  [X]%
  Waste tokens:    [X]%

Качество:
  Routing accuracy:     [X]%
  Eval pass rate:       [X]%
  Unsafe action blocks: [N] сегодня
  Stale prompts active: [N]

Провайдеры:
  [Провайдер 1]: [статус] | Runway: [X дней при текущем spend]
  [Провайдер 2]: [статус]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Модуль 2 — Prompt Compression

**Триггеры:** "сжать промпт", "оптимизировать промпт", "prompt compression", "слишком много токенов"

### Разрешённые методы компрессии

```
✅ Можно:
  → Дедупликация повторяющихся инструкций
  → Удаление narrative filler без смысла
  → Разделение stable boilerplate от variable context
  → Перенос повторяющейся истории в summary snapshots
  → Ограничение контекста до релевантных entities
  → Output-cap по типу задачи
  → Переупорядочивание для stable parsing и cacheability

❌ Нельзя:
  → Удалять required output fields (case_id, agent_id, next_actions, approval_status)
  → Удалять approval или review logic для рискованной работы
  → Удалять audit-related instructions
  → Заменять ясность двусмысленными сокращениями
  → Компрессия через скрытие decision requirements
```

### Context Budget Rules

```
По уровню риска задачи:
  LOW-RISK  → минимальный контекст: current case + linked entities
  MEDIUM    → scoped context + current case
  HIGH-RISK → wider context + required policy + approval refs
  PROTECTED → full required control context — всегда

Всегда включать в контекст:
  ✓ current case summary
  ✓ linked entities (only relevant)
  ✓ last approved decision
  ✓ active priorities
  ✓ required SOPs

Всегда исключать:
  ✗ entire conversation history
  ✗ obsolete prompt fragments
  ✗ stale dashboards/summaries
  ✗ irrelevant entities
```

### Summary Snapshot Template

```
# Summary Snapshot v[N] — [agent_id] — [дата]
Active objective: [цель]
Latest approved decision: [решение + дата]
Critical constraints: [ограничения]
Open risks: [риски]
Pending approvals: [если есть]
Linked entities: [entity IDs]
Updated: [timestamp]
Owner: [agent_id]

⚠️ Snapshots никогда не скрывают:
   - Unresolved approvals
   - Active incidents
   - Current red-state controls
```

### Compression Review Process

```
1. Открыть case: case_type = aiplatformchange или improvementidea
2. Baseline: current prompt tokens, eval pass rate, format validity
3. Compression candidate: применить методы выше
4. Staging test: сравнить tokens / quality / retry rate
5. Evidence required:
   - Token reduction %
   - Eval pass rate сохранён
   - Format validity сохранён
   - Guardrails не ослаблены
6. Approval: ai_architect_agent + evals_guardrails_agent
7. Deploy только после approval + rollback plan
```

---

## Модуль 3 — Model Benchmarking

**Триггеры:** "бенчмарк модели", "сравни модели", "новая модель", "сменить провайдера для задачи"

### Benchmark Framework

```
Принципы:
  → Нет "одной модели для всего" — task-class fit
  → Shadow testing перед promotion
  → Bounded rollout (5-10% трафика сначала)
  → Rollback plan обязателен
  → Approval required для production promotion

Task Classes для Pepino Pick:
  reporting/analysis   → quality + format validity
  crop_diagnostics     → accuracy + safe recommendations
  financial_review     → precision + no hallucination
  draft_communications → tone + format
  routing/triage       → speed + accuracy
  creative/content     → output quality + brand fit
```

### Benchmark Scorecard

```
🏆 BENCHMARK: [model] vs [baseline] — [task class]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Задач в тесте:     [N]
Метрика           Candidate    Baseline    Δ
────────────────────────────────────────────
Output quality:   [X]%         [X]%       [+/-X]
Format validity:  [X]%         [X]%       [+/-X]
Cost per task:    $[X]         $[X]       [+/-X]
Latency (p95):    [X]s         [X]s       [+/-X]
Eval pass rate:   [X]%         [X]%       [+/-X]
Retry rate:       [X]%         [X]%       [+/-X]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Recommendation:
  [Promote / Reject / Limited rollout / Need more data]
  Rationale: [конкретное обоснование]

Cautions:
  [Task classes где candidate небезопасен]
```

---

## Модуль 4 — Provider Portfolio

**Триггеры:** "провайдер", "резервный провайдер", "fallback", "зависимость от OpenAI/Anthropic", "диверсификация"

### Provider Health Monitoring

```
Отслеживать по каждому провайдеру:
  → Uptime / availability этой недели
  → Latency trend
  → Cost trajectory
  → Runway при текущем spend (дней)
  → Fallback coverage status
```

### Provider Restriction Rules

```
Protected paths (никогда не ограничивать):
  → critical-severity approvals
  → food safety QA releases
  → CEO-level strategic decisions
  → audit trail writes

Restriction triggers:
  → Provider uptime < 99% за неделю → advisory
  → Cost spike > 50% vs baseline → review
  → Concentration > 80% на одном провайдере → diversification plan
  → Новый лимит или policy change от провайдера → immediate review
```

---

## Reporting Integration

### В weekly quality audit review (добавляется автоматически):

```
AI TREASURY WEEK SUMMARY:
  AI spend WTD: [X] USD
  Premium violations: [N]
  Approval bypass attempts: [N]
  Rollback events: [N]
  Stale prompt alerts: [N]
```

### В monthly board pack:

```
AI SPEND BY CIRCUIT (месяц):
  [circuit]: [X] USD  [%]
  ...
  Total: [X] USD
  Premium share trend: [▲▼]
  Savings achieved: [X] USD vs baseline
```

### В quarterly architecture review:

```
AI PLATFORM HEALTH:
  Benchmarks completed: [N]
  Promotions: [N] | Demotions: [N]
  Provider resilience score: [X]
  Prompt waste eliminated: [X]% vs Q prior
  Compression savings: [X] USD
```

---

## Правила изменений AI системы

Любое изменение промпта / схемы / routing / провайдера требует:

```
1. case_type: aiplatformchange
2. Evidence: change_note + eval_results + rollback_plan
3. Approvals: ai_architect_agent + evals_guardrails_agent
4. Staging test перед production
5. Audit log entry
6. Rollback drill confirmed
```

**Запрещено:**

- Неформальные изменения промптов в production
- Компрессия без eval проверки
- Смена модели без benchmark scorecard
- Отключение audit logging даже временно

---

## Реестр моделей — Routing Guide

Система использует 4 уровня провайдеров. Выбор по умолчанию:

| Risk Level | Первый выбор               | Второй                          | Fallback        |
| ---------- | -------------------------- | ------------------------------- | --------------- |
| LOW        | `ollama_local` (бесплатно) | `groq_llama_33_70b` (ultra_low) | `deepseek_chat` |
| MEDIUM     | `groq_llama_33_70b`        | `kimi_k25` (low)                | `claude_haiku`  |
| HIGH       | `kimi_k25`                 | `claude_sonnet`                 | `gemini_pro`    |
| CRITICAL   | `claude_sonnet`            | `claude_opus`                   | `gemini_pro`    |
| SEARCH     | `perplexity_sonar`         | `perplexity_sonar_reasoning`    |                 |
| MULTIMODAL | `gemini_flash`             | `gemini_pro`                    | `claude_sonnet` |
| CODING     | `qwen_coder_api`           | `kimi_k25`                      | `claude_sonnet` |

### Правила approval по моделям

**Никогда не авторитативны без human review:**

- `ollama_local`, `groq_llama`, `deepseek_chat`, `qwen_turbo`, `perplexity_sonar`

**Требуют review для final high-risk use:**

- `deepseek_reasoner`, `glm_45_full`, `kimi_k25`, `claude_haiku`, `gemini_flash`

**Разрешены для critical final draft (с approval flow):**

- `claude_sonnet`, `claude_opus`, `gemini_pro`

### Принцип экономии (Cost-First Routing)

```
1. Сначала local (cost: zero)
2. Потом ultra_low (groq, deepseek) — стандартные задачи
3. Standard (kimi, claude_haiku) — сложный контент
4. Premium (claude_sonnet, opus) — только критический риск
5. Research (perplexity) — только живой поиск в интернете
```

### Агенты → Risk Class mapping (Pepino Pick)

| Агент                     | Risk Class | Рекомендуемая модель        |
| ------------------------- | ---------- | --------------------------- |
| front_door_orchestrator   | medium     | groq / kimi_k25             |
| agronomy_agent            | high       | kimi_k25 / claude_sonnet    |
| qa_haccp_agent            | critical   | claude_sonnet               |
| controller_agent          | critical   | claude_sonnet               |
| legal_agent               | critical   | claude_opus / claude_sonnet |
| ceo_agent / strategic     | critical   | claude_sonnet / opus        |
| reporting / weekly digest | medium     | kimi_k25 / claude_haiku     |
| sales / marketing         | medium     | kimi_k25 / groq             |
| innovation_lab / R&D      | high       | kimi_k25 / claude_sonnet    |
| shadow_ceo                | high       | claude_sonnet               |

## Примеры команд

```
Покажи AI Control Screen
Сколько мы тратим на AI в этом месяце?
Сжать промпт для agronomy_agent — он слишком длинный
Сравни Claude Sonnet vs Haiku для reporting задач
Есть ли риск зависимости от одного провайдера?
Оптимизировать context loading для weekly review
Что дают токены — стоит ли тратить на premium?
```
