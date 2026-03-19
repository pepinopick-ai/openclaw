---
name: pepino-knowledge
description: "📚 База знаний Pepino Pick — СОПы, уроки, архив решений, захват знаний, поиск по базе, Obsidian интеграция. Авто-вызывай при словах найди СОП, добавь в базу знаний, уроки из прошлого, что мы делали раньше, архив решений, запомни это, создай инструкцию, поиск по базе, knowledge base, СОП, регламент, Obsidian."
homepage: https://pepino.pick
metadata:
  openclaw:
    emoji: "📚"
    requires:
      bins: []
---

# 📚 Pepino Pick — База знаний и Institutional Memory

Библиотека СОПов, архив решений, уроки, захват знаний. Служит институциональной памятью бизнеса. Интегрируется с Obsidian vault.

**Google Sheets ID:** `1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc`
Решения → лист "Решения". Задачи знаний → лист "Задачи".

---

## 5 режимов

### Режим 1 — SOP Library (Библиотека регламентов)

**Найти СОП:** по ключевым словам или SOP-ID.
**Создать СОП:** из описания процесса → структурировать как нумерованные шаги.
**Обновить СОП:** предыдущую версию пометить `[superseded]`.

**Реестр СОПов (известные, пополнять из реальных операций):**

| SOP-ID      | Название                        | Домен       | Статус |
| ----------- | ------------------------------- | ----------- | ------ |
| SOP-AGR-001 | Инокуляция блоков               | Агрономия   | active |
| SOP-AGR-002 | Протокол уборки урожая (огурцы) | Агрономия   | active |
| SOP-AGR-003 | Ежедневный контроль EC/pH       | Агрономия   | active |
| SOP-FER-001 | Открытие батча ферментации      | Ферментация | active |
| SOP-FER-002 | Проверка качества ферментации   | Ферментация | active |
| SOP-QA-001  | Процедура hold партии           | QA          | active |
| SOP-QA-002  | Чеклист выпуска партии          | QA          | active |
| SOP-LOG-001 | Подготовка маршрута доставки    | Логистика   | active |
| SOP-FIN-001 | Еженедельная финансовая запись  | Финансы     | active |
| SOP-CEO-001 | Протокол обзора понедельника    | CEO         | active |

**Шаблон СОПа:**

```
# [SOP-ID]: [название]
Версия: [N] | Дата: [YYYY-MM-DD] | Статус: [active/superseded]
Ответственный: [роль]
Триггер: [когда применять этот СОП]

## Шаги
1. [шаг]
2. [шаг]
...

## Критические точки контроля
- [что может пойти не так и как это предотвратить]

## Связанные СОПы: [SOP-XXX, SOP-YYY]
## Связанные навыки: [skill-name]
```

---

### Режим 2 — Lessons Learned (Уроки и ретроспективы)

Захватывать и находить операционные уроки.

**Шаблон урока:**

```
# LESSON-YYYYMMDD: [краткое название]
Контекст:        [что произошло]
Проблема/успех:  [что пошло не так / что сработало отлично]
Причина (root cause): [почему это произошло]
Действие:        [что изменили в результате]
Домен:           [agronomy / finance / logistics / qa / fermentation / sales]
Теги:            [ключевые слова для поиска]
Применимо к:     [похожие ситуации в будущем]
```

**Поиск уроков:** по домену, ключевым словам, дате, тегам.

**Пример запроса:** "Что мы узнали о субстрате в прошлом квартале?" → фильтр по домену=agronomy + теги=субстрат + дата_диапазон.

---

### Режим 3 — Decision Archive (Архив решений)

Читает решения из Google Sheets лист "Решения":

```
Дата | решение | агент | обоснование | затронутые_домены | дедлайн | статус
```

Добавить новое решение:

1. Получить описание решения от владельца
2. Заполнить поля шаблона
3. Записать в "Решения" через `pepino-google-sheets`

**Поиск в архиве:**

- По дате / диапазону
- По домену (finance / agronomy / logistics / strategy)
- По ключевым словам
- По статусу (open / closed / pending)

**Паттерн-анализ:** "Какие решения мы принимали по поставщикам за 3 месяца?" → извлечь паттерны и тренды.

---

### Режим 4 — Knowledge Capture (Захват знаний)

При фразах "запомни", "запомни это", "добавь в базу", "сохрани урок":

```
Шаг 1: Классифицировать → СОП / Урок / Решение / Справка / Метрика
Шаг 2: Извлечь ключевые данные
Шаг 3: Оформить по шаблону типа
Шаг 4: Сохранить → Sheets (Решения / Задачи) и/или Obsidian vault
Шаг 5: Подтвердить: "Сохранено как [тип]: [краткое резюме]"
```

**Быстрый захват:**

```
"запомни: [факт/урок/решение]"
  → агент классифицирует и сохраняет автоматически
  → выводит: "📚 Сохранено как [LESSON/SOP/DECISION]: [summary]"
```

---

### Режим 5 — Obsidian Integration (Второй мозг)

**Obsidian как Knowledge Brain Pepino Pick.**

Принцип разделения:

- **Google Sheets** = операционный SSOT (транзакции, логи, KPI, задачи, алерты)
- **Obsidian** = knowledge layer (контекст, СОПы с деталями, уроки, стратегия, отношения)

**Текущая структура vault (v2.0):**

```
pepino-obsidian/
├── 00_inbox/            # Входящие — разобрать за 48h
├── 01_dashboard_notes/  # CEO flash-notes, weekly prep
├── 02_cases_context/    # Расширенный контекст для case_id
├── 03_decision_memos/   # Архив решений с альтернативами
├── 04_sops_index/       # Навигационный индекс SOPов
├── 05_playbooks/        # Пошаговые тактические сценарии
├── 06_lessons_learned/  # Уроки из опыта
├── 07_postmortems/      # Разбор 🔴 инцидентов
├── 08_training/         # Обучение команды
├── 09_architecture_ai/  # AI система, агенты, routing
├── 10_projects/         # R&D, эксперименты
├── 11_people/           # Клиенты, поставщики, OSINT
├── 12_market_intel/     # Рынок, конкуренты, тренды
└── 99_archive/          # Архив без удаления
```

**Рекомендуемые плагины:**

| Плагин            | Назначение                                                     |
| ----------------- | -------------------------------------------------------------- |
| Dataview          | Запросы к заметкам как к БД (все активные эксперименты и т.д.) |
| Templater         | Стандартные шаблоны для СОП/Решение/Урок                       |
| Tasks             | Трекинг действий в заметках                                    |
| Obsidian Git      | Версионирование vault                                          |
| Smart Connections | AI-поиск по семантике (интеграция с Claude)                    |

**Варианты синхронизации:**

1. **Obsidian Sync** (платный) — проще всего, работает на мобильном
2. **iCloud** — бесплатно, Mac/iOS
3. **Git sync** — с контролем версий, ручной на мобильном

**Интеграция агентов:**

- `pepino-knowledge` читает Obsidian через файловую систему (`~/pepino-obsidian/`)
- `pepino-weekly-review` → авто-сохраняет дайджест в `00-CEO-Dashboard/`
- Решения из Sheets → sync скрипт → `03-Decisions/`
- CEO может делать заметки в Obsidian → агенты читают через `pepino-knowledge`

**Что НЕ ставить в Obsidian:**

- Финансовые транзакции (остаются в Sheets)
- Реал-тайм производственные логи (Sheets)
- Трекинг задач как основной инструмент (Sheets "Задачи")

**Шаги настройки:**

```
1. Установить Obsidian → создать vault в ~/pepino-obsidian/
2. Установить плагины: Dataview, Templater, Tasks, Git, Smart Connections
3. Создать структуру папок по схеме выше
4. Создать шаблоны: Template-SOP.md, Template-Lesson.md, Template-Decision.md
5. Настроить Obsidian Git → commit каждые 30 мин автоматически
6. Подключить Smart Connections → API key Claude
7. Настроить pepino-weekly-review → сохранять в 00-CEO-Dashboard/
```

---

### Режим 6 — NotebookLM Research Layer

**Архитектура (NOTEBOOKLM_IN_SYSTEM_ARCHITECTURE.yaml):**

```yaml
role:
  notebooklm: source_grounded_research_workspace # НЕ source of truth
  claude_code: orchestration_and_normalization_layer
  mcp_server: tool_adapter # notebooklm-pepino (Connected)
  case_store: canonical_case_truth # Sheets
  audit_log_store: immutable_control_log # Sheets
  dashboard_data_store: canonical_kpi_serving_layer # Sheets
```

**Поток (строго соблюдать):**

```
owner_request
  → front_door_orchestrator открывает case
  → claude_code решает: нужен ли NotebookLM?
  → mcp_tool создаёт/обновляет notebook
  → sources добавляются
  → notebooklm_outputs_brief
  → claude_code нормализует output
  → result сохраняется в case_memo или Obsidian note
  → approval и logging — только в canonical systems (Sheets)
```

**Guardrails (никогда не нарушать):**

```
❌ no_case_status_in_notebooklm
❌ no_approval_truth_in_notebooklm
❌ no_kpi_source_values_from_notebooklm
❌ no_legal_signoff_from_notebooklm
❌ no_payment_authorization_from_notebooklm
```

**MCP инструменты (notebooklm-pepino, Connected):**

```
nblm_list_notebooks           → список всех notebooks
nblm_use_notebook(id)         → выбрать активный
nblm_create_notebook(title)   → создать под кейс
nblm_ask(question)            → zero-hallucination ответ с цитатами
nblm_add_source_url(url)      → добавить URL/YouTube/GDoc
nblm_add_source_text(t, text) → добавить текстовый источник
nblm_list_sources()           → что загружено
nblm_get_summary()            → AI summary всего пакета
nblm_create_note(t, content)  → сохранить вывод в notebook
nblm_generate_brief(topic, [questions]) → полный research brief
```

**Рекомендуемые постоянные notebooks:**

```
pepino-market-intel    → рынок, рестораны, тренды BA
pepino-supplier-dd     → due diligence поставщиков
pepino-agronomy-res    → болезни, технологии, trials
pepino-regulations     → labeling, HACCP, compliance
pepino-ai-architecture → prompt docs, eval outputs
pepino-investor-pack   → инвест-мемо, сценарии
```

**Когда использовать NotebookLM:**

- Нужно синтезировать 5+ источников с цитатами
- Supplier due diligence (много документов)
- Market research с источниками
- Анализ регуляторных документов
- Board prep (ты создаёшь Audio Overview вручную)

**Когда НЕ использовать (быстрее WebSearch):**

- Один-два факта / цена
- Актуальные новости (NotebookLM не обновляется в реальном времени)
- Простой вопрос без источников

**Auth статус:** ⏳ Ожидает `storage_state.json` с Windows (см. NOTEBOOKLM_MCP_SPEC.md)

---

## Метрики базы знаний

```
📚 БАЗА ЗНАНИЙ — статус
  Активных СОПов:        [N]
  Уроков за квартал:     [N]
  Решений за квартал:    [N]
  Последнее обновление:  [дата]
  Obsidian vault:        [подключён / не настроен]
```

---

## Примеры команд

```
Найди СОП по инокуляции
Запомни урок: потеряли партию из-за перегрева — всегда проверять термометр утром
Что мы решали насчёт поставщиков субстрата?
Создай новый СОП для доставки в рестораны
Покажи все уроки по ферментации
Как настроить Obsidian как второй мозг для фермы?
Где хранятся наши данные и как это организовано?
Добавь в архив решений: решили не брать второй кредит, причина — высокая ставка
Покажи паттерны решений за Q1
```
