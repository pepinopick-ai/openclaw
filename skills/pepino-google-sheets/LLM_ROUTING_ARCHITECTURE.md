# Pepino Pick — Система автоматической маршрутизации LLM

> Архитектура v1.0 | Март 2026

---

## Проблема

Сейчас все 29 скиллов Pepino Pick используют одну модель (Claude Sonnet) для ВСЕХ задач — от простого "запиши урожай" до сложного "DCF проекта теплицы". Это как нанимать финансового директора для ввода данных в таблицу.

**Текущие расходы (оценка):** ~$150-300/мес при 3000 задач
**Целевые расходы:** ~$40-80/мес (-60-75%)

---

## Архитектура: 4-уровневая маршрутизация

```
Запрос пользователя
        |
        v
  [ДИСПЕТЧЕР] — определяет intent + skill
        |
        v
  [КЛАССИФИКАТОР СЛОЖНОСТИ] — определяет Tier (1-4)
        |
        v
  [LLM ROUTER] — выбирает модель по Tier + бюджету
        |
        +--- Tier 1 (простые) ------> Gemini Flash / GPT-4o-mini / Llama 8B
        |
        +--- Tier 2 (средние) ------> DeepSeek V3 / Kimi K2.5 / Claude Haiku
        |
        +--- Tier 3 (сложные) ------> Claude Sonnet / GPT-4o
        |
        +--- Tier 4 (критические) --> Claude Sonnet + верификация
        |
        v
  [QUALITY CHECKER] — проверяет ответ
        |
        +--- OK ---------> Возврат результата
        +--- Не ОК ------> Escalation на следующий Tier (cascading)
```

---

## Классификация скиллов по Tier

### Tier 1 — Простые ($0.001-0.005/задача)

Задачи: ввод данных, форматирование, извлечение, шаблонные операции.

| Скилл | Типичные задачи | Модель |
|-------|----------------|--------|
| **pepino-google-sheets** | Запись/чтение строк, append | Gemini Flash |
| **pepino-agro-ops** (режим записи) | "Запиши: EC 2.1, pH 6.2" | GPT-4o-mini |
| **pepino-maps-tools** | Маршрут, расстояние, расход | Gemini Flash |
| **pepino-knowledge** (режим поиска) | "Найди SOP по X" | GPT-4o-mini |
| **pepino-team-ops** (простые) | "Поставь задачу Хуану" | Gemini Flash |
| **pepino-finance-tools** (курсы) | "Курс Blue" | Llama 8B (Groq) |

**Критерии автоопределения:**
- Prompt < 500 токенов
- Intent = `data_entry`, `lookup`, `format`, `translate`
- Нет слов "почему", "проанализируй", "стратегия", "что если"
- Ожидаемый output < 200 токенов

**Стоимость:** ~$0.002/задача × 1800/мес = **$3.60/мес**

---

### Tier 2 — Средние ($0.01-0.05/задача)

Задачи: анализ, рекомендации, отчёты, контент.

| Скилл | Типичные задачи | Модель |
|-------|----------------|--------|
| **pepino-sales-crm** | КП, pipeline, follow-up | DeepSeek V3 |
| **pepino-procurement** | Оценка поставщика, заказы | Kimi K2.5 |
| **pepino-brand** | Instagram пост, контент-план | DeepSeek V3 |
| **pepino-controller** (отчёты) | Бюджет vs факт | Kimi K2.5 |
| **pepino-demand-oracle** | Прогноз спроса (недельный) | DeepSeek V3 |
| **pepino-weekly-review** | Еженедельная сводка | Claude Haiku |
| **pepino-agro-ops** (анализ) | "Тренд урожайности" | Kimi K2.5 |
| **pepino-climate-guard** | Диагностика микроклимата | DeepSeek V3 |
| **pepino-risk** (мониторинг) | Текущие риски, EWI | Kimi K2.5 |
| **pepino-argentina-finance** | FX мониторинг, pricing | DeepSeek V3 |
| **pepino-profit-engine** (дашборд) | Маржа по продуктам | DeepSeek V3 |

**Критерии автоопределения:**
- Prompt 500-3000 токенов
- Intent = `analysis`, `report`, `recommend`, `content`, `forecast`
- Требуется рассуждение, но не стратегическое
- Ожидаемый output 200-1500 токенов

**Стоимость:** ~$0.02/задача × 900/мес = **$18/мес**

---

### Tier 3 — Сложные ($0.05-0.30/задача)

Задачи: стратегия, моделирование, креатив, экспертиза.

| Скилл | Типичные задачи | Модель |
|-------|----------------|--------|
| **pepino-shadow-ceo** | Decision Framework, координация | Claude Sonnet |
| **pepino-financial-modeling** | DCF, сценарии P&L | Claude Sonnet |
| **pepino-profit-engine** (эксперименты) | Kill/Iterate/Scale решения | Claude Sonnet |
| **pepino-innovation-lab** | R&D, новые продукты | Claude Sonnet |
| **pepino-capital** | CAPEX planning, pitch | Claude Sonnet |
| **pepino-realtor** | Оценка участка (40+ критериев) | GPT-4o |
| **pepino-greenhouse-tech** | PPFD/HVAC расчёты | Claude Sonnet |
| **pepino-sales-crm** (стратегия) | Retention strategy, churn | Claude Sonnet |

**Критерии автоопределения:**
- Prompt > 3000 токенов ИЛИ
- Intent = `strategy`, `model`, `experiment`, `architecture`, `creative`
- Слова: "что если", "сценарий", "стратегия", "рассчитай NPV", "DCF"
- Ожидаемый output > 1500 токенов

**Стоимость:** ~$0.10/задача × 250/мес = **$25/мес**

---

### Tier 4 — Критические ($0.20-1.00/задача)

Задачи: решения с юридическими/финансовыми последствиями.

| Скилл | Типичные задачи | Модель |
|-------|----------------|--------|
| **pepino-qa-food-safety** (release) | Выпуск/блокировка партии | Claude Sonnet + верификация |
| **pepino-legal** | Договоры, SENASA compliance | Claude Sonnet |
| **pepino-controller** (блокировки) | Платежи > 250K, CAPEX > 1M | Claude Sonnet |
| **pepino-shadow-ceo** (guardrails) | Проверка решений CEO | Claude Sonnet |
| **pepino-procurement** (DD) | Due Diligence поставщика | Claude Sonnet |

**Критерии автоопределения:**
- Skill имеет флаг `critical: true`
- Intent содержит `approval`, `release`, `contract`, `audit`
- Dispatcher hard_block активирован
- Сумма > 250K ARS или решение с юридическими последствиями

**Двойная проверка:**
1. Основная модель генерирует ответ
2. Второй вызов (та же или другая модель) верифицирует ключевые факты
3. При расхождении — эскалация на человека

**Стоимость:** ~$0.40/задача × 50/мес = **$20/мес**

---

## Итоговая экономика

| Tier | Задач/мес | Стоимость/задача | Итого/мес |
|------|-----------|-----------------|-----------|
| T1 Простые | 1,800 (60%) | $0.002 | $3.60 |
| T2 Средние | 900 (30%) | $0.020 | $18.00 |
| T3 Сложные | 250 (8%) | $0.100 | $25.00 |
| T4 Критические | 50 (2%) | $0.400 | $20.00 |
| **ИТОГО** | **3,000** | **$0.022 avg** | **$66.60** |

**vs текущий подход (всё через Sonnet): ~$200/мес**
**Экономия: ~67% ($133/мес)**

---

## Cascading: автоматическая эскалация

Если дешёвая модель не справилась, запрос автоматически переходит на следующий уровень:

```
T1 модель → ответ некачественный? → T2 модель → ответ некачественный? → T3 модель
```

### Как определить "некачественный ответ"

| Сигнал | Проверка | Действие |
|--------|---------|----------|
| Пустой ответ | `response.length < 10` | Escalate |
| "Я не могу" | Regex: `не могу|cannot|sorry` | Escalate |
| JSON невалидный | `JSON.parse()` fails | Escalate |
| Числа нереальные | Value > 10x median | Escalate |
| Нет ключевых полей | Missing required fields | Escalate |
| Галлюцинация | Факт не найден в источнике | Escalate |

### Cascading flow (конкретный пример)

```
Запрос: "Маржа по вешенке за март"

1. [Gemini Flash] → ответ: {"product": "вешенка", "margin": 0.43}
   ✅ JSON валиден, число реальное (0-1 range) → RETURN

Запрос: "Что если поднять цены на 15%?"

1. [Gemini Flash] → ответ: "Нужно больше данных для анализа..."
   ❌ Слишком короткий, нет конкретики → ESCALATE
2. [DeepSeek V3] → ответ: сценарий с 3 вариантами, NPV, impact
   ✅ Развёрнутый ответ с числами → RETURN
```

---

## Провайдерская матрица

### Основные провайдеры

| Провайдер | Модели | Input $/1M | Output $/1M | Latency | Uptime |
|-----------|--------|-----------|-------------|---------|--------|
| **Groq** | Llama 3.x 8B/70B | $0.05-0.59 | $0.08-0.79 | Очень низкая | 99%+ |
| **DeepSeek** | V3 | $0.27 | $1.10 | Средняя | 95%+ |
| **Google** | Gemini Flash | $0.075 | $0.30 | Низкая | 99.5%+ |
| **OpenAI** | GPT-4o-mini | $0.15 | $0.60 | Средняя | 99.5%+ |
| **Anthropic** | Claude Haiku | $0.80 | $4.00 | Средняя | 99.5%+ |
| **Anthropic** | Claude Sonnet | $3.00 | $15.00 | Средняя | 99.5%+ |
| **Kimi** | K2.5 | ~$0.50 | ~$2.00 | Средняя | 95%+ |

### Fallback chains

```
Tier 1: Gemini Flash → GPT-4o-mini → Llama 8B (Groq) → Claude Haiku
Tier 2: DeepSeek V3 → Kimi K2.5 → Claude Haiku → GPT-4o
Tier 3: Claude Sonnet → GPT-4o → Gemini Pro → DeepSeek V3
Tier 4: Claude Sonnet → GPT-4o → Claude Sonnet (retry)
```

---

## Система KPI

### Dashboard метрики (обновляется ежедневно)

| KPI | Формула | Цель |
|-----|---------|------|
| **Cost per task** | total_spend / total_tasks | < $0.025 |
| **Cheap pass rate** | T1_successful / T1_total | > 85% |
| **Escalation rate** | escalated_tasks / total_tasks | < 15% |
| **Quality score** | human_approved / total_reviewed | > 95% |
| **Avg latency** | sum(response_time) / total_tasks | < 5s |
| **Premium share** | (T3+T4_tasks) / total_tasks | < 12% |
| **Budget utilization** | actual_spend / monthly_budget | < 100% |
| **Cache hit rate** | cached_responses / total_tasks | > 20% |
| **Provider diversity** | unique_providers_used / total_providers | > 60% |

### Алерты

| Алерт | Условие | Действие |
|-------|---------|----------|
| Budget warning | spend > 80% monthly budget | Уведомление CEO |
| Budget exceeded | spend > 100% monthly budget | Переключить T2→T1 |
| Quality drop | quality_score < 90% | Escalate более T3 |
| Provider down | 3 consecutive errors | Failover автоматически |
| Cost spike | daily_cost > 3x avg | Расследование |

---

## Оптимизации

### 1. Кэширование (экономия ~20%)

| Тип | Что кэшируется | TTL | Экономия |
|-----|----------------|-----|---------|
| Exact match | Идентичные запросы | 24h | 5% |
| Semantic cache | Похожие по смыслу запросы (cosine > 0.95) | 12h | 10% |
| KPI cache | "Какая маржа?", "Сколько клиентов?" | 1h | 5% |

### 2. Prompt compression (экономия ~15%)

| Техника | Описание | Экономия токенов |
|---------|---------|-----------------|
| System prompt trimming | Убрать неиспользуемые режимы из контекста | 30-50% input |
| Context window management | Только релевантные данные, не вся таблица | 20-40% input |
| Response format hints | JSON schema вместо "ответь в формате..." | 10-20% input |
| History pruning | Только последние 3 обмена, не вся история | 30-60% input |

### 3. Batching (экономия ~10%)

```
Утренний бриф: вместо 5 отдельных вызовов (KPI + алерты + погода + курс + задачи)
→ 1 batch-вызов с 5 промптами = 1 вызов API
Экономия: 4 × overhead = ~40% на этой задаче
```

---

## Мониторинг и отчёты

### Ежедневный отчёт (автоматический)

```
📊 AI Costs — 20 марта 2026

Задач:     127 (T1: 78, T2: 35, T3: 12, T4: 2)
Расход:    $2.84
Avg/task:  $0.022
Escalated: 8 (6.3%)
Cached:    24 (18.9%)

Топ-3 дорогих:
1. pepino-financial-modeling: $0.89 (3 задачи)
2. pepino-shadow-ceo: $0.45 (2 задачи)
3. pepino-sales-crm: $0.38 (8 задач)

Budget: $66.60/мес → использовано $38.20 (57%)
```

### Еженедельный отчёт

```
📊 AI Costs — Неделя 12/2026

Задач:      890
Расход:     $19.80
Avg/task:   $0.022
Cheap rate: 87.2% ✅
Quality:    96.1% ✅
Escalated:  11.4% ✅

Экономия vs all-Sonnet: $47.20 (70.5%)

Рекомендации:
• pepino-brand можно перевести T2→T1 (качество стабильно)
• pepino-procurement DD лучше оставить T3 (2 эскалации за неделю)
```

---

## Реализация

### Фаза 1 — Rule-based Router (неделя 1)

Простой роутер на основе правил:

```javascript
// llm-router.cjs

const TIER_RULES = {
  // Tier 1: Simple
  tier1: {
    skills: ['pepino-google-sheets', 'pepino-maps-tools'],
    intents: ['data_entry', 'lookup', 'format', 'translate', 'status_check'],
    maxInputTokens: 500,
    keywords_exclude: ['почему', 'проанализируй', 'стратегия', 'что если', 'сценарий'],
    model: 'gemini-2.0-flash',
    fallback: 'gpt-4o-mini'
  },

  // Tier 2: Medium
  tier2: {
    skills: ['pepino-sales-crm', 'pepino-procurement', 'pepino-brand', 'pepino-demand-oracle'],
    intents: ['analysis', 'report', 'recommend', 'content', 'forecast', 'monitor'],
    model: 'deepseek-chat',
    fallback: 'claude-3-5-haiku-latest'
  },

  // Tier 3: Complex
  tier3: {
    skills: ['pepino-shadow-ceo', 'pepino-financial-modeling', 'pepino-innovation-lab'],
    intents: ['strategy', 'model', 'experiment', 'architecture', 'creative'],
    model: 'claude-sonnet-4-20250514',
    fallback: 'gpt-4o'
  },

  // Tier 4: Critical
  tier4: {
    skills: ['pepino-qa-food-safety', 'pepino-legal'],
    intents: ['approval', 'release', 'contract', 'audit'],
    hardBlock: true,
    model: 'claude-sonnet-4-20250514',
    verify: true
  }
};

function classifyTier(skill, intent, prompt) {
  // Critical override
  if (TIER_RULES.tier4.skills.includes(skill) ||
      TIER_RULES.tier4.intents.includes(intent)) {
    return 'tier4';
  }

  // Complex
  if (TIER_RULES.tier3.skills.includes(skill) ||
      TIER_RULES.tier3.intents.includes(intent) ||
      prompt.length > 3000) {
    return 'tier3';
  }

  // Simple check
  const hasComplexKeywords = TIER_RULES.tier1.keywords_exclude
    .some(kw => prompt.toLowerCase().includes(kw));

  if (!hasComplexKeywords &&
      (TIER_RULES.tier1.skills.includes(skill) ||
       TIER_RULES.tier1.intents.includes(intent) ||
       prompt.length < 500)) {
    return 'tier1';
  }

  // Default: medium
  return 'tier2';
}
```

### Фаза 2 — Cost Tracker + Dashboard (неделя 2)

- Логирование каждого вызова: `{timestamp, skill, tier, model, input_tokens, output_tokens, cost, latency, quality}`
- Ежедневный отчёт в Telegram (silent)
- Grafana дашборд "AI Costs"

### Фаза 3 — Cascading + Quality Checker (неделя 3)

- Автоматическая эскалация при некачественном ответе
- JSON validation, length check, hallucination detection
- Метрики escalation rate

### Фаза 4 — ML-based Router (месяц 2)

- Сбор данных за 30 дней
- Обучение классификатора на реальных задачах
- A/B тестирование vs rule-based
- Замена rule-based если ML лучше

---

## Сравнение вариантов реализации

| Вариант | Плюсы | Минусы | Стоимость | Рекомендация |
|---------|-------|--------|-----------|-------------|
| **OpenRouter Auto** | Zero setup, работает сразу | Markup 5-20%, нет контроля | $80-120/мес | Быстрый старт |
| **LiteLLM self-hosted** | Полный контроль, fallback, cost tracking | Нужно развернуть, поддерживать | $50-70/мес + DevOps | Лучший баланс |
| **Custom Router (наш)** | Максимальный контроль, заточен под Pepino | Разработка, тестирование | $40-70/мес + Dev time | Оптимально долгосрочно |
| **RouteLLM + LiteLLM** | ML routing + proxy в одном | Сложнее, нужны данные для обучения | $40-60/мес + setup | Фаза 4 |

### Рекомендация

**Фаза 1-3:** Custom Router (простые правила) — 0 внешних зависимостей, работает сразу.
**Фаза 4:** Добавить LiteLLM как proxy для multi-provider fallback + cost tracking.
**Фаза 5:** Добавить RouteLLM для ML-based routing если данных достаточно (>5000 задач).

---

## Контрольный чеклист внедрения

### Неделя 1
- [ ] Создать `llm-router.cjs` с rule-based классификатором
- [ ] Интегрировать с pepino-dispatcher (добавить tier в case_id)
- [ ] Настроить API ключи: Groq, DeepSeek, Google AI, OpenAI
- [ ] Тестовый прогон: 50 задач через router

### Неделя 2
- [ ] Cost tracker: логирование в Google Sheets лист "AI Costs"
- [ ] Telegram отчёт: ежедневный silent, еженедельный loud
- [ ] Grafana дашборд "AI Costs"
- [ ] Бюджет: установить $80/мес лимит

### Неделя 3
- [ ] Cascading: автоэскалация при низком качестве
- [ ] Quality checker: JSON validation + length + keywords
- [ ] Fallback chains: протестировать все 4 цепочки
- [ ] Alert system: budget warning + provider down

### Месяц 2
- [ ] Анализ данных: 30 дней логов
- [ ] A/B тест: rule-based vs adjusted rules
- [ ] Cache layer: semantic caching для Top-20 запросов
- [ ] Prompt compression: audit Top-10 самых дорогих скиллов

---

*Pepino Pick LLM Routing System v1.0 — оптимальная модель для каждой задачи.*
