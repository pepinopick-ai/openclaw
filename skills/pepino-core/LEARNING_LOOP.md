# Pepino Pick Agent OS v2 -- Learning Loop

Система обратной связи и непрерывного улучшения.
Каждый закрытый кейс порождает данные для обучения агентов.

---

## Post-Decision Review (шаблон)

Обязательно заполняется для кейсов, удовлетворяющих ХОТЯ БЫ ОДНОМУ критерию:

- severity >= 2
- сумма решения >= 100 000 ARS
- стратегический (L3)
- эскалация произошла
- outcome_quality = poor или failed

```yaml
# --- Post-Decision Review ---
case_id: CASE-YYYYMMDD-XXX
date_closed: YYYY-MM-DD
domain: agronomy | finance | sales | logistics | engineering | strategy | brand | procurement
decision: "Краткое описание принятого решения"
outcome: "Фактический результат"
outcome_quality: excellent | good | acceptable | poor | failed
was_prediction_accurate: yes | partially | no
prediction_error: "Что именно не совпало с прогнозом (null если accurate)"
root_cause: "Почему прогноз оказался неточным (null если accurate)"
time_to_resolution: "Xh / Xd"
cost_of_decision: "X ARS (прямые затраты + opportunity cost)"
revenue_impact: "X ARS (положительный или отрицательный)"
agents_involved:
  - pepino-agro-ops
  - pepino-google-sheets
routing_correct: yes | no
routing_error: "Если no: какой навык нужен был, но не был назначен / какой лишний"
skill_gap: "Какие знания или данные отсутствовали у агентов"
blocker_occurred: yes | no
blocker_type: "data_missing | supplier_delay | approval_pending | external | technical"
blocker_duration: "Xh / Xd (null если no blocker)"
action_items:
  - type: update_sop
    target: "SOP-XXX"
    description: "Добавить шаг Y в протокол"
  - type: update_skill
    target: "pepino-procurement"
    description: "Добавить проверку backup-поставщика"
  - type: update_policy
    target: "POLICY_ENGINE.md"
    description: "Понизить порог auto-approve для X"
  - type: new_training
    target: "dispatcher"
    description: "Новый триггер для intent Z"
  - type: add_data
    target: "Sheets / Obsidian"
    description: "Внести справочные данные по X"
```

---

## Auto-Improvement Pipeline

### Этап 1: Collect (автоматически)

Каждый кейс, перешедший в `verified`, генерирует learning record.

**Источники данных:**

- Sheets "Кейсы" -- полная строка кейса
- Sheets "Алерты" -- если были алерты по кейсу
- Sheets "Решения" -- если было стратегическое решение
- Telegram -- время ответа пользователя (approval latency)
- Логи агентов -- token consumption, API calls, errors

**Минимальный learning record (для L1-кейсов без ошибок):**

```yaml
case_id: CASE-YYYYMMDD-XXX
domain: agronomy
complexity: L1
time_created_to_done: 2m
routing_correct: yes
outcome_quality: good
auto_verified: true
```

### Этап 2: Aggregate (еженедельно, пятница)

Cron-задача собирает все learning records за неделю.

**Агрегации:**

```
По домену:
  - Количество кейсов
  - Среднее время закрытия
  - % с outcome_quality >= good
  - % с routing_correct = yes
  - % эскалаций
  - Топ-3 blocker_type

По агенту:
  - Количество участий
  - Accuracy (% correct outcomes)
  - Avg time contribution
  - Token spend

По типу ошибки:
  - Частота каждого root_cause
  - Частота каждого skill_gap
  - Частота каждого blocker_type
```

**Выход:** Строка в Sheets "Метрики недели" + input для этапа Analyze.

### Этап 3: Analyze (еженедельно, после Aggregate)

Анализ паттернов за последние 4 недели (скользящее окно).

**Что ищем:**

1. **Повторяющиеся ошибки** -- один и тот же root_cause >= 3 раз за 4 недели
2. **Замедление** -- avg time_to_resolution выросло > 20% vs предыдущие 4 недели
3. **Неправильная маршрутизация** -- routing_correct = no >= 10% кейсов
4. **Частые блокеры** -- один blocker_type >= 5 раз за 4 недели
5. **Деградация качества** -- outcome_quality = poor/failed растёт
6. **Перегрузка агента** -- один агент участвует в > 60% кейсов

**Выход:** Список detected_patterns с severity и recommended_action.

### Этап 4: Propose (автоматически после Analyze)

Каждый detected_pattern порождает improvement proposal.

**Формат предложения:**

```yaml
proposal_id: PROP-YYYYMMDD-NNN
pattern: "routing_error: demand-oracle не назначается при триггере 'сколько заказать'"
severity: medium
recommendation: "Добавить триггер 'сколько заказать' в dispatcher intent-матрицу для DAT"
target_file: "skills/pepino-dispatcher/SKILL.md"
target_section: "Матрица: Intent -> Навыки -> ПРОГНОЗ СПРОСА"
estimated_impact: "Снижение routing_error на 5-8%"
effort: low
```

**Категории предложений:**
| Категория | Пример | Кто применяет |
| ---------------- | ------------------------------------------------ | ------------------- |
| routing_fix | Добавить триггер в dispatcher | pepino-dispatcher |
| sop_update | Обновить протокол в SKILL.md | целевой навык |
| policy_change | Изменить порог approval | POLICY_ENGINE.md |
| data_enrichment | Добавить справочные данные в Sheets | pepino-google-sheets|
| new_capability | Создать новый навык или режим | pepino-core |
| alert_tuning | Изменить severity/threshold алертов | целевой навык |

### Этап 5: Approve (человек)

Все предложения отправляются пользователю на ревью.

**Формат в Telegram:**

```
IMPROVEMENT PROPOSALS -- Неделя [N]

1. [LOW] routing_fix: Добавить триггер "сколько заказать" -> demand-oracle
   Причина: 3 кейса за 4 недели с неправильной маршрутизацией
   Ответ: /approve 1 или /reject 1 [причина]

2. [MEDIUM] sop_update: Добавить backup-поставщика в procurement протокол
   Причина: supplier_delay заблокировал 4 кейса, avg 36h блокировки
   Ответ: /approve 2 или /reject 2 [причина]
```

**Auto-approve для low-risk proposals:**

- routing_fix с effort=low и >= 3 подтверждающих кейса
- alert_tuning (только изменение severity на +/-1)

### Этап 6: Apply (после approval)

Одобренные предложения применяются к целевым файлам.

**Протокол применения:**

1. Создать ветку `improvement/PROP-YYYYMMDD-NNN`
2. Внести изменение в target_file + target_section
3. Обновить CHANGELOG в SKILL.md затронутого навыка
4. Залогировать в Sheets "Улучшения": proposal_id, дата, что изменено
5. Уведомить пользователя: "Применено: [краткое описание]"

### Этап 7: Measure (через 2-4 недели после Apply)

Проверяем, помогло ли улучшение.

**Метод:**

```
before_metrics = aggregate(cases, window=4_weeks_before_apply)
after_metrics  = aggregate(cases, window=4_weeks_after_apply)

delta = {
    routing_accuracy: after.routing_correct_pct - before.routing_correct_pct,
    avg_resolution_time: after.avg_time - before.avg_time,
    escalation_rate: after.escalation_pct - before.escalation_pct,
    quality_score: after.good_or_better_pct - before.good_or_better_pct,
}
```

**Результат:**

- Улучшение >= 5% -> proposal подтверждён, закрыть
- Без изменений -> оставить, наблюдать ещё 4 недели
- Ухудшение -> откатить изменение, открыть новый proposal

---

## Quality Metrics (Dashboard)

### Метрики по агентам

| Метрика               | Формула                                              | Целевое значение                 |
| --------------------- | ---------------------------------------------------- | -------------------------------- |
| **Accuracy**          | cases(outcome >= good) / total_cases                 | >= 85%                           |
| **Speed**             | avg(time_created_to_done)                            | < 2h (L1), < 8h (L2), < 48h (L3) |
| **Cost**              | avg(token_spend + api_cost) per case                 | Отслеживать тренд                |
| **Escalation rate**   | cases(escalated) / total_cases                       | < 10%                            |
| **Routing accuracy**  | cases(routing_correct) / total_cases                 | >= 90%                           |
| **Blocker rate**      | cases(blocked) / total_cases                         | < 15%                            |
| **Auto-verify rate**  | cases(auto_verified) / cases(verified)               | >= 60% (для L1)                  |
| **User satisfaction** | explicit_feedback(positive) / explicit_feedback(all) | >= 80%                           |

### Метрики по доменам

| Домен     | Ключевой KPI            | Целевое значение |
| --------- | ----------------------- | ---------------- |
| Агрономия | Время записи журнала    | < 3 мин (L1)     |
| Финансы   | Точность прогноза маржи | +/- 5%           |
| Продажи   | Retention rate клиентов | >= 85%           |
| Логистика | % доставок вовремя      | >= 95%           |
| Стратегия | % реализованных решений | >= 70%           |

### Формат еженедельного отчёта

```
LEARNING LOOP REPORT -- Неделя [N], [дата]

ОБЪЁМ:
  Кейсов за неделю: XX
  Из них: L1=XX, L2=XX, L3=XX

КАЧЕСТВО:
  Accuracy: XX% (цель >= 85%)
  Routing accuracy: XX% (цель >= 90%)
  Avg resolution: L1=Xm, L2=Xh, L3=Xd

ПРОБЛЕМЫ:
  Эскалации: XX (XX%)
  Блокеры: XX (топ: supplier_delay x3, data_missing x2)
  Poor/failed outcomes: XX

УЛУЧШЕНИЯ:
  Применено на этой неделе: XX
  Ожидают approval: XX
  Подтверждены (measure OK): XX

ТРЕНД (vs прошлая неделя):
  Accuracy: +X% / -X%
  Speed: +X% / -X%
  Escalation rate: +X% / -X%
```

---

## Red-Team Scenarios (Eval Suite)

10 тестовых сценариев для валидации диспетчера, маршрутизации и исполнения.

### Scenario 1: Контаминация в зоне B во время пикового сбора

```yaml
id: RT-001
input: "Обнаружил зелёную плесень на 3 блоках в зоне B, сбор идёт полным ходом"
expected_intent: agronomy + food_safety + risk
expected_suffix: -AGR
expected_skills:
  - pepino-agro-ops # Зафиксировать в журнале, изолировать зону
  - pepino-qa-food-safety # Протокол контаминации, SENASA требования
  - pepino-risk # Оценка ущерба, страховка
expected_complexity: L3
expected_approval: required (карантин зоны = L2+)
expected_actions:
  - Изолировать зону B
  - Утилизировать поражённые блоки
  - Проверить соседние зоны
  - Рассчитать потери урожая
  - Уведомить клиентов о возможной задержке
sla: 1 час (критический)
severity: 4
```

### Scenario 2: Скачок blue dollar на 15% за ночь

```yaml
id: RT-002
input: "Blue dollar вчера был 1200, сегодня 1380. Что делать с ценами?"
expected_intent: finance + pricing
expected_suffix: -FIN
expected_skills:
  - pepino-argentina-finance # Анализ валютного шока
  - pepino-controller # Пересчёт себестоимости в ARS
  - pepino-profit-engine # Новые цены, margin simulation
expected_complexity: L3
expected_approval: required (изменение цен)
expected_actions:
  - Пересчитать себестоимость всех SKU
  - Смоделировать 3 сценария (повысить сразу / постепенно / держать)
  - Показать влияние на маржу
  - Подготовить коммуникацию клиентам
sla: 4 часа
severity: 3
```

### Scenario 3: Топ-клиент не заказывал 21 день

```yaml
id: RT-003
input: "Ресторан Mishiguene не заказывал уже 3 недели, раньше брали каждую неделю"
expected_intent: sales + retention
expected_suffix: -COM
expected_skills:
  - pepino-sales-crm # История заказов, churn risk
  - pepino-demand-oracle # Прогноз потерь выручки
expected_complexity: L2
expected_approval: not_required (анализ = L1)
expected_actions:
  - Проверить историю заказов
  - Рассчитать потерю выручки
  - Определить причину (конкурент? сезон? недовольство?)
  - Предложить retention-действие (звонок, спецпредложение)
sla: 8 часов
severity: 2
```

### Scenario 4: Поставщик субстрата не может доставить 2 недели

```yaml
id: RT-004
input: "Агрофибра сообщила что субстрат будет только через 2 недели, у нас запас на 5 дней"
expected_intent: procurement + risk + agronomy
expected_suffix: -LOG
expected_skills:
  - pepino-procurement # Поиск альтернативных поставщиков
  - pepino-risk # Оценка impact на производство
  - pepino-agro-ops # Скорректировать план инокуляции
expected_complexity: L3
expected_approval: required (смена поставщика = L2+)
expected_actions:
  - Оценить текущий запас (дней осталось)
  - Найти 2-3 альтернативных поставщика
  - Сравнить цены и качество
  - Скорректировать график инокуляции
  - Уведомить о возможном снижении урожая
sla: 4 часа (запас на 5 дней = срочно)
severity: 4
```

### Scenario 5: Новый ресторан хочет 50 кг/неделю грибов

```yaml
id: RT-005
input: "Новый ресторан в Palermo хочет 50 кг вешенки в неделю, шеф-повар готов встретиться"
expected_intent: sales + demand_planning + logistics
expected_suffix: -COM
expected_skills:
  - pepino-sales-crm # Оформить лид, КП, pipeline
  - pepino-demand-oracle # Хватит ли мощностей?
  - pepino-logistics # Маршрут доставки, стоимость
expected_complexity: L3
expected_approval: required (новый клиент 50kg/week = strategic)
expected_actions:
  - Проверить свободную мощность
  - Рассчитать маржинальность при текущих ценах
  - Оптимизировать маршрут доставки
  - Подготовить КП
  - Запланировать встречу с шеф-поваром
sla: 24 часа
severity: 2
```

### Scenario 6: Сотрудник уволился без предупреждения

```yaml
id: RT-006
input: "Хуан (сборщик, зона A+B) ушёл без предупреждения, завтра сбор"
expected_intent: team_ops + risk
expected_suffix: -STR
expected_skills:
  - pepino-team-ops # Кадровый учёт, замена
  - pepino-shadow-ceo # Решение по приоритизации
  - pepino-risk # Оценка impact на сбор
expected_complexity: L3
expected_approval: required (кадровое решение)
expected_actions:
  - Оценить impact на завтрашний сбор
  - Перераспределить зоны между оставшимися
  - Начать поиск замены
  - Скорректировать план сбора на неделю
  - Оценить финансовый impact (сверхурочные, потери)
sla: 4 часа (сбор завтра)
severity: 3
```

### Scenario 7: Инспекция SENASA через 3 дня

```yaml
id: RT-007
input: "SENASA приедет с проверкой через 3 дня, нужно подготовиться"
expected_intent: compliance + food_safety
expected_suffix: -AGR
expected_skills:
  - pepino-qa-food-safety # Чек-лист SENASA, протоколы
  - pepino-legal # Юридические требования, документы
expected_complexity: L2
expected_approval: not_required (подготовка = L1)
expected_actions:
  - Сгенерировать чек-лист SENASA требований
  - Проверить все журналы (температура, влажность, обработки)
  - Проверить сроки годности и маркировку
  - Подготовить документы (лицензии, сертификаты)
  - Провести предварительный внутренний аудит
sla: 24 часа (3 дня до инспекции)
severity: 4
```

### Scenario 8: Конкурент запустил тот же продукт на 30% дешевле

```yaml
id: RT-008
input: "Hongos del Sur запустил вешенку по 2500 ARS/kg, у нас 3500. Клиенты спрашивают"
expected_intent: strategy + pricing + brand
expected_suffix: -STR
expected_skills:
  - pepino-profit-engine # Анализ маржи, предел снижения цены
  - pepino-brand # Дифференциация, ценностное предложение
  - pepino-shadow-ceo # Стратегическое решение
expected_complexity: L3
expected_approval: required (стратегия ценообразования)
expected_actions:
  - Анализ: можем ли снизить цену и остаться прибыльными
  - Анализ: чем мы лучше (качество, сервис, упаковка)
  - 3 стратегии ответа (цена, дифференциация, микс)
  - Подготовить talking points для менеджера продаж
  - Мониторинг реакции клиентов
sla: 24 часа
severity: 3
```

### Scenario 9: Grafana упал, cron-задачи не работают

```yaml
id: RT-009
input: "Grafana не открывается, утренний отчёт не пришёл, cron молчит"
expected_intent: infrastructure + monitoring
expected_suffix: -ENG
expected_skills:
  - pepino-ai-treasury # Мониторинг инфраструктуры, health check
  - pepino-healthcheck # Системная диагностика
expected_complexity: L2
expected_approval: not_required (диагностика = L1)
expected_actions:
  - Проверить статус Grafana (docker, порты, логи)
  - Проверить cron-задачи (crontab, последний запуск)
  - Проверить дисковое пространство и память
  - Восстановить сервисы
  - Запустить пропущенные отчёты вручную
sla: 1 час (мониторинг критичен)
severity: 4
```

### Scenario 10: Инвестор просит финансовые данные для due diligence

```yaml
id: RT-010
input: "Потенциальный инвестор хочет видеть P&L, unit economics и план роста за последние 6 месяцев"
expected_intent: capital + financial_reporting
expected_suffix: -FIN
expected_skills:
  - pepino-capital # Investor relations, pitch materials
  - pepino-financial-modeling # P&L, unit economics, projections
  - pepino-controller # Верификация данных, аудит
expected_complexity: L3
expected_approval: required (раскрытие финансовых данных = L3)
expected_actions:
  - Собрать P&L за 6 месяцев из Sheets
  - Рассчитать unit economics по каждому SKU
  - Подготовить прогноз роста (3 сценария)
  - Оформить investor deck / data room
  - Проверить данные на консистентность (аудит)
  - Удалить чувствительные данные из выдачи
sla: 48 часов
severity: 3
```

---

## Eval Runner (спецификация)

Для автоматического прогона red-team сценариев:

```python
# Псевдокод eval runner
from dataclasses import dataclass

@dataclass
class EvalResult:
    scenario_id: str
    routing_match: bool        # Правильные навыки назначены?
    complexity_match: bool     # Правильная сложность?
    approval_match: bool       # Правильный approval level?
    actions_coverage: float    # % ожидаемых действий покрыто
    sla_met: bool              # Уложились в SLA?
    severity_match: bool       # Правильная severity?
    score: float               # Взвешенный итог (0-100)

WEIGHTS = {
    "routing_match": 0.30,     # Маршрутизация -- самое важное
    "complexity_match": 0.10,
    "approval_match": 0.15,
    "actions_coverage": 0.25,
    "sla_met": 0.10,
    "severity_match": 0.10,
}

def run_eval(scenario) -> EvalResult:
    """Отправить input диспетчеру, сравнить с expected_*."""
    response = dispatcher.process(scenario.input)
    return EvalResult(
        scenario_id=scenario.id,
        routing_match=set(response.skills) == set(scenario.expected_skills),
        complexity_match=response.complexity == scenario.expected_complexity,
        approval_match=response.approval == scenario.expected_approval,
        actions_coverage=len(
            set(response.actions) & set(scenario.expected_actions)
        ) / len(scenario.expected_actions),
        sla_met=response.time <= scenario.sla,
        severity_match=response.severity == scenario.severity,
        score=weighted_score(...),
    )

# Пороговые значения для прохождения
PASS_THRESHOLD = 75.0          # Минимальный score для pass
ROUTING_HARD_GATE = True       # routing_match=False -> автоматический fail
```

**Расписание прогона:**

- После каждого изменения dispatcher SKILL.md
- Еженедельно (понедельник, вместе с Aggregate)
- После применения improvement proposal

**Отчёт:**

```
EVAL SUITE REPORT -- [дата]

OVERALL: 8/10 passed (80%)
AVG SCORE: 82.3

PASSED:
  RT-001 Контаминация        92.5
  RT-002 Blue dollar          87.0
  RT-003 Churn клиент         95.0
  RT-005 Новый клиент         88.5
  RT-006 Увольнение           79.0
  RT-007 SENASA               91.0
  RT-009 Grafana down         85.5
  RT-010 Инвестор DD          83.0

FAILED:
  RT-004 Поставщик субстрата  68.0  <- routing_match=False (procurement не назначен)
  RT-008 Конкурент цена       72.0  <- actions_coverage=0.6

ACTION ITEMS:
  - RT-004: Добавить триггер "запас на X дней" -> procurement
  - RT-008: Добавить в brand навык "competitive response" режим
```
