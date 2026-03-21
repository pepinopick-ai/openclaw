# Pepino Pick Agent OS v2 — Memory System

Формализованная система памяти агентов. 4 типа с разным TTL и назначением.

---

## 1. Working Memory (оперативная)

**TTL:** текущая сессия (до завершения задачи)
**Хранение:** контекст агента (in-memory)
**Назначение:** данные для текущей задачи — промежуточные расчёты, состояние диалога, контекст запроса.

```yaml
# Пример working memory
session_id: "2026-03-21-morning-brief"
current_task: "generate_morning_report"
intermediate:
  sales_7d_total: 485000
  expenses_7d_total: 210000
  margin_pct: 56.7
  alerts_pending: 3
```

**Правила:**

- Не персистится между сессиями
- Каждый агент управляет своей working memory
- Очищается после завершения задачи
- Максимальный размер: 50 KB на агента

---

## 2. Episodic Memory (эпизодическая)

**TTL:** 90 дней (auto-archive)
**Хранение:** `~/.openclaw/workspace/memory/episodes/`
**Назначение:** конкретные события, решения, инциденты. "Что произошло и когда."

```yaml
# Пример episodic memory
id: EP-20260321-001
date: 2026-03-21
type: incident | decision | milestone | lesson
domain: agronomy | finance | sales | logistics | engineering
summary: "Клиент Casa Vegana не заказывал 32 дня — отток подтверждён"
details: |
  churn-detector выявил отток 2026-03-21 10:03.
  Последний заказ: 2026-02-17, 5 кг вешенки.
  Причина: переехали на другого поставщика (дешевле на 15%).
  Action: pepino-sales-crm создал follow-up задачу.
outcome: "Клиент вернулся после предложения скидки 10%"
outcome_quality: good
agents_involved: [churn-detector, pepino-sales-crm]
tags: [churn, retention, pricing]
linked_decisions: [DEC-20260321-001]
```

**Правила:**

- Автоматически создаётся после: инцидентов severity >= 2, решений >= 50K ARS, эскалаций
- Агенты МОГУТ ссылаться на эпизоды при принятии аналогичных решений
- Auto-archive через 90 дней (перемещается в `archive/`)
- Формат файла: `EP-YYYYMMDD-NNN.yaml`

---

## 3. Semantic Memory (семантическая)

**TTL:** бессрочно (обновляется при изменениях)
**Хранение:** `~/.openclaw/workspace/memory/knowledge/`
**Назначение:** устоявшиеся факты, бизнес-правила, профили. "Что мы знаем."

### 3.1 Клиентские профили

```yaml
# ~/.openclaw/workspace/memory/knowledge/clients/{slug}.yaml
id: "casa-vegana"
name: "Casa Vegana"
type: restaurant | retail | wholesale | individual
contact:
  phone: "+54..."
  instagram: "@casavegana"
  address: "..."
location:
  zone: "Palermo"
  delivery_distance_km: 12
products_ordered: [veshyonka, microgreens_mix]
avg_order_kg: 8.5
avg_order_ars: 42500
order_frequency_days: 7
lifetime_value_ars: 850000
first_order: 2025-11-15
last_order: 2026-03-14
status: active | at_risk | churned | new
preferences: "Предпочитает доставку до 10:00, платит наличными"
notes: "Шеф-повар Марио — любит крупные грибы"
```

### 3.2 Продуктовые знания

```yaml
# ~/.openclaw/workspace/memory/knowledge/products/{slug}.yaml
id: "veshyonka-standard"
name: "Вешенка стандарт"
category: mushrooms
unit: kg
cost_per_kg: 2800 # ARS, обновляется ежемесячно
price_per_kg: 5000 # ARS, рекомендованная
target_margin: 0.44
shelf_life_days: 7
storage_temp_c: [2, 4]
growing_cycle_days: 21
yield_per_block_kg: 1.2
competitors_price_range: [4000, 6500] # ARS
best_months: [3, 4, 5, 9, 10, 11] # Mar-May, Sep-Nov
```

### 3.3 Поставщики

```yaml
# ~/.openclaw/workspace/memory/knowledge/suppliers/{slug}.yaml
id: "grainspan-sa"
name: "GrainSpan SA"
products: [sustrato_trigo, sustrato_girasol]
lead_time_days: 3
min_order_kg: 100
payment_terms: "30 días"
reliability_score: 0.92 # 0-1, from delivery history
last_price_update: 2026-03-01
notes: "Contacto: Juan, +54... Backup: SustratoBA"
```

### 3.4 Операционные правила

```yaml
# ~/.openclaw/workspace/memory/knowledge/rules/
# pricing-rules.yaml, delivery-rules.yaml, quality-rules.yaml
id: "pricing-minimum"
rule: "Минимальная цена вешенки = себестоимость * 1.35"
reason: "Ниже 35% маржи — убыточно с учётом потерь"
enforced_by: auto-pricing.cjs
last_validated: 2026-03-21
```

**Правила:**

- Обновляется при поступлении новых данных (новый заказ → обновить avg_order)
- knowledge-distiller.cjs обновляет еженедельно
- Агенты ОБЯЗАНЫ читать перед принятием решений о клиентах/продуктах
- Конфликт с свежими данными из Sheets → Sheets побеждает (SSOT)

---

## 4. Procedural Memory (процедурная)

**TTL:** бессрочно (обновляется через Learning Loop)
**Хранение:** `~/.openclaw/workspace/memory/procedures/`
**Назначение:** как делать вещи. Алгоритмы решений, выученные из опыта.

```yaml
# ~/.openclaw/workspace/memory/procedures/handle-churn.yaml
id: PROC-001
name: "Обработка оттока клиента"
trigger: "churn-detector выявил churned (>30d без заказов)"
version: 2
last_updated: 2026-03-21
updated_from: EP-20260321-001 # эпизод, из которого выучена процедура

steps:
  - step: 1
    action: "Проверить историю заказов клиента за 6 месяцев"
    tool: "readSheet('🛒 Продажи', filter=client)"

  - step: 2
    action: "Определить причину оттока"
    conditions:
      - if: "последний заказ < средней суммы"
        likely_cause: "цена"
        recommendation: "Предложить скидку 10-15%"
      - if: "жалоба в последнем заказе"
        likely_cause: "качество"
        recommendation: "Предложить бесплатный образец + извинение"
      - if: "сезонный паттерн (аналогичный период прошлого года)"
        likely_cause: "сезонность"
        recommendation: "Напомнить о себе через 2 недели"

  - step: 3
    action: "Создать follow-up задачу в CRM"
    tool: "appendToSheet('📋 Задачи', {...})"

  - step: 4
    action: "Отправить сообщение оператору"
    tool: "sendReport(message, thread=20)"

  - step: 5
    action: "Если клиент вернулся — обновить episodic memory с outcome"

success_rate: 0.67 # 2 из 3 клиентов вернулись
avg_resolution_days: 5
```

**Правила:**

- Каждая процедура привязана к эпизоду, из которого выучена
- Learning Loop обновляет success_rate и steps
- Новая процедура создаётся если: outcome_quality = poor И нет существующей процедуры
- Агенты ОБЯЗАНЫ следовать процедурам при наличии matching trigger

---

## Обслуживание памяти

### Автоматическое

| Действие                 | Триггер | Скрипт                    |
| ------------------------ | ------- | ------------------------- |
| Archive episodes >90d    | weekly  | `memory-maintenance.cjs`  |
| Update client profiles   | daily   | `knowledge-distiller.cjs` |
| Update product knowledge | weekly  | `knowledge-distiller.cjs` |
| Validate procedures      | monthly | manual review             |
| Cleanup orphaned files   | monthly | `memory-maintenance.cjs`  |

### Метрики здоровья памяти

- `episodic_count`: количество активных эпизодов (target: 20-100)
- `semantic_coverage`: % клиентов с полным профилем (target: >80%)
- `procedure_success_rate`: средний success_rate процедур (target: >0.7)
- `stale_knowledge_pct`: % записей не обновлявшихся >30d (target: <20%)

---

## Взаимодействие типов памяти

```
Working Memory (текущая задача)
      ↓ завершение задачи
Episodic Memory (что произошло)
      ↓ паттерн обнаружен
Semantic Memory (что мы знаем)
      ↓ правило выведено
Procedural Memory (как действовать)
      ↓ применяется при следующем trigger
Working Memory (новая задача — уже с контекстом)
```

Learning Loop (LEARNING_LOOP.md) обеспечивает переход между типами памяти.
Policy Engine (POLICY_ENGINE.md) использует Semantic + Procedural для принятия решений.
State Machine (STATE_MACHINE.md) обновляет Episodic при смене состояний.
