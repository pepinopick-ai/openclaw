---
name: pepino-knowledge
description: "📚 База знаний Pepino Pick — СОПы, уроки, архив решений, захват знаний, поиск по базе, knowledge search, Obsidian интеграция. Авто-вызывай при словах найди СОП, добавь в базу знаний, уроки из прошлого, что мы делали раньше, архив решений, запомни это, создай инструкцию, поиск по базе, knowledge base, СОП, регламент, Obsidian, что мы знаем, найди информацию, покажи инсайты, история вопроса, какие решения."
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

## 7 режимов

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

**Интеграция агентов — полный write protocol:**

Vault path: `/home/roman/pepino-obsidian/`

### Как ЗАПИСАТЬ заметку в Obsidian (агент использует Write tool)

```python
# 1. Определить тип и папку по таблице:
note_type → папка:
  decision_memo  → 03_decision_memos/
  sop_index      → 04_sops_index/
  lesson         → 06_lessons_learned/
  postmortem     → 07_postmortems/
  research       → 11_market_intel/
  architecture   → 09_architecture_ai/
  person_profile → 12_partner_investor_research/
  case_context   → 02_cases_context/
  project_brief  → 10_projects/
  training       → 08_training/

# 2. Сформировать имя файла по конвенции:
  decision_memo__[domain]__[slug]__v1.md
  lesson__[domain]__[slug]__v1.md
  postmortem__[domain]__[incident]__[YYYYMMDD].md
  research__[domain]__[topic]__v1.md
  person__[lastname]_[firstname]__v1.md

# 3. Использовать обязательный frontmatter:
---
id: [type]-[YYYYMMDD]-[slug]
title: "[заголовок]"
type: [тип из allowed list]
status: draft
owner: roman
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
linked_cases: [CASE-YYYYMMDD-XXX]
linked_entities: []
linked_sops: []
linked_agents: []
tags: []
confidentiality: internal
---

# 4. Записать через Write tool:
   file_path: /home/roman/pepino-obsidian/[папка]/[имя_файла].md
```

### Примеры конкретных write-операций

```
# Решение после кейса:
/home/roman/pepino-obsidian/03_decision_memos/decision_memo__finance__change_pricing_q1__v1.md

# Урок после инцидента:
/home/roman/pepino-obsidian/06_lessons_learned/lesson__agronomy__powdery_mildew_night_humidity__v1.md

# Разбор болезни (постмортем):
/home/roman/pepino-obsidian/07_postmortems/postmortem__agronomy__botrytis_zone_a__20260319.md

# Market research из NotebookLM:
/home/roman/pepino-obsidian/11_market_intel/research__market__premium_mushrooms_ba_2026__v1.md

# Профиль шефа / поставщика:
/home/roman/pepino-obsidian/12_partner_investor_research/person__garces_pablo__v1.md

# Контекст кейса:
/home/roman/pepino-obsidian/02_cases_context/case_context__CASE-20260319-FIN.md
```

### Как ЧИТАТЬ из Obsidian (агент использует Read tool)

```python
# Поиск по типу:
Grep pattern="type: lesson" path="/home/roman/pepino-obsidian/"

# Поиск по тегу или домену:
Grep pattern="agronomy" path="/home/roman/pepino-obsidian/"

# Конкретный файл:
Read file_path="/home/roman/pepino-obsidian/03_decision_memos/..."

# Inbox:
Glob pattern="/home/roman/pepino-obsidian/00_inbox/*.md"
```

### Автоматические write-операции (когда скиллы пишут в vault)

| Скилл                       | Событие                  | Папка Obsidian              | Тип           |
| --------------------------- | ------------------------ | --------------------------- | ------------- |
| pepino-agro-cucumber-photos | 🔴 diagnosis confirmed   | 07_postmortems/             | postmortem    |
| pepino-dispatcher           | NotebookLM research done | 11_market_intel/ или соотв. | research      |
| pepino-weekly-review        | weekly review complete   | 01_dashboard_notes/         | case_context  |
| pepino-shadow-ceo           | strategic decision made  | 03_decision_memos/          | decision_memo |
| pepino-knowledge            | new lesson captured      | 06_lessons_learned/         | lesson        |
| pepino-qa-food-safety       | incident postmortem      | 07_postmortems/             | postmortem    |

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

**Рекомендуемые постоянные notebooks (актуальные IDs):**

| Notebook                   | ID                                     | Назначение                               |
| -------------------------- | -------------------------------------- | ---------------------------------------- |
| `pepino-market-intel`      | `5ad0c41d-85a2-40b5-9461-e8de2cce33c3` | Рестораны BA, тренды, premium сегмент    |
| `pepino-supplier-dd`       | `220a67b5-6eee-48be-ab9f-8e2855b4a32b` | Due diligence поставщиков                |
| `pepino-capex-investor`    | `1817e0d0-b51a-4814-a81e-24c73e28a64d` | Инвестиционные материалы, сценарии CAPEX |
| `pepino-regulatory`        | `8a947923-cc04-4ee4-8d7b-56b11d5ac43e` | SENASA, ANMAT, законодательство          |
| `pepino-agronomy-research` | `302edbe8-768a-4e13-afc1-31bbc0f9f82f` | Болезни, технологии, climate-control     |
| `pepino-ai-architecture`   | `c02daa98-e103-4082-bca4-3af0db15b0b5` | AI архитектура, prompt docs, schemas     |

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

**Auth статус:** ✅ Connected — cookies: `/home/roman/.notebooklm/storage_state.json`, auto-refresh: пон 08:50 (`/home/roman/refresh-notebooklm-cookies.sh`)

---

### Режим 7 — Knowledge Search (Полнотекстовый поиск по всем знаниям)

Когда пользователь спрашивает "что мы знаем о X", "найди информацию о Y", "какие решения мы принимали по Z", "есть ли SOP для...", "покажи инсайты по...", "история вопроса":

**Протокол:**

```
ШАГ 1: Извлечь ключевые слова из запроса
  → Убрать стоп-слова, оставить предметные термины
  → Пример: "что мы знаем о вешенке и марже" → keywords: ["вешенка", "маржа"]

ШАГ 2: Запустить knowledge-search.cjs
  → node /home/roman/openclaw/skills/pepino-google-sheets/knowledge-search.cjs "<keywords>"
  → Для включения Sheets данных: добавить --include-sheets
  → Скрипт ищет по: pepino-graph, pepino-obsidian, (опц.) Google Sheets API

ШАГ 3: Прочитать top 3-5 файлов из результатов
  → Использовать Read tool для каждого файла из results[].file
  → Обратить внимание на type результата (decision, sop, lesson, insight, entity)

ШАГ 4: Синтезировать ответ с цитатами
  → Каждый факт сопровождать ссылкой: [source: filename]
  → Группировать по типу: решения, СОПы, уроки, инсайты
  → Формат ответа:

    📚 KNOWLEDGE SEARCH: "<исходный запрос>"
    Найдено: [N] результатов в [источники]

    ### Решения
    - [факт] [source: decision_memo__finance__pricing__v1.md]

    ### СОПы
    - [факт] [source: SOP-AGR-002]

    ### Инсайты и уроки
    - [факт] [source: insight__market__premium_trend.md]

    ### Операционные данные
    - [факт] [source: sheets://kpi]

ШАГ 5: Если результатов 0
  → Сообщить: "По запросу '<keywords>' ничего не найдено в базе знаний."
  → Предложить: "Создать заметку-инсайт по этой теме? (Режим 4 — Knowledge Capture)"
  → Предложить: "Запустить research через NotebookLM? (Режим 6)"
```

**Источники поиска:**

| Источник        | Путь                                         | Содержимое                                     |
| --------------- | -------------------------------------------- | ---------------------------------------------- |
| pepino-graph    | `~/.openclaw/workspace/memory/pepino-graph/` | Сущности, связи, инсайты, решения, СОПы        |
| pepino-obsidian | `~/pepino-obsidian/`                         | Decision memos, lessons, postmortems, research |
| Google Sheets   | `localhost:4000` (флаг `--include-sheets`)   | KPI, алерты, продажи                           |

**Примеры запросов:**

```
"что мы знаем о вешенке"            → keywords: вешенка
"найди информацию о поставщике X"   → keywords: поставщик, X
"какие решения по ценообразованию"  → keywords: решения, ценообразование, цена
"есть ли SOP для сбора урожая"      → keywords: sop, сбор, урожай
"покажи инсайты по рынку"           → keywords: инсайт, рынок
"история вопроса по субстрату"      → keywords: субстрат
```

---

### Режим 8 — YouTube Source Processing (Видео-pipeline)

Автоматическая обработка YouTube-видео как источников знаний для Pepino Pick.

**Триггеры:** "добавь видео", "youtube", "сохрани видео", "запомни видео", YouTube URL в сообщении.

**Скрипт:** `node ~/openclaw/skills/pepino-google-sheets/youtube-knowledge.cjs auto <URL> [title] [--tags t1,t2]`

**Pipeline (полный цикл):**

```
ШАГ 1: Получить YouTube URL из сообщения пользователя
  → Извлечь video_id (youtube.com/watch?v=, youtu.be/, shorts/)
  → Определить title (из аргумента, из HTML <title>, или fallback)

ШАГ 2: Создать source-файл
  → Запустить: node youtube-knowledge.cjs auto "<URL>" "<title>" --tags <теги>
  → Файл: ~/.openclaw/workspace/memory/pepino-graph/05-sources/youtube/
  → Формат имени: YYYY-MM-DD__youtube__slug.md
  → MANIFEST.md обновляется автоматически

ШАГ 3: Оценить релевантность для NotebookLM
  → Тема агрономии/теплицы → nblm_use_notebook("pepino-agronomy-research")
  → Тема рынка/ресторанов → nblm_use_notebook("pepino-market-intel")
  → Тема регуляторики → nblm_use_notebook("pepino-regulatory")
  → Общая/обучающая тема → пропустить NotebookLM, оставить pending

ШАГ 4 (если NotebookLM релевантен):
  → nblm_add_source_url("<URL>")
  → nblm_get_summary()
  → Обновить секцию "Summary" в source-файле
  → Заполнить "Key Points" из summary
  → Предложить "Actions" и "SOP Patches" на основе контента

ШАГ 5: Подтвердить результат пользователю
  → Вывести путь к файлу
  → Указать статус NotebookLM (обработан / pending)
  → Если есть actionable items — предложить создать задачи
```

**Расширенный шаблон source-файла (auto):**

Файл содержит секции:

- **Summary** -- краткое содержание (из NotebookLM или вручную)
- **Key Points** -- ключевые тезисы видео
- **Applicable to Pepino Pick** -- что применимо к нашему хозяйству
- **Actions** -- конкретные действия для внедрения
- **SOP Patches** -- какие СОПы обновить/создать
- **Related Entities** -- связи с pepino-graph

**Примеры команд пользователя:**

```
Добавь видео https://youtube.com/watch?v=abc123
Сохрани видео: https://youtu.be/xyz789 "Выращивание огурцов зимой"
Запомни видео по теме огурцов https://youtube.com/watch?v=def456
```

**Теги (рекомендуемые):** огурцы, теплица, агрономия, грибы, субстрат, климат, бизнес, маркетинг, упаковка, ферментация

---

### Режим 9 — Article Source Processing (Статьи и PDF)

Автоматическая обработка веб-статей и PDF-документов как источников знаний для Pepino Pick.

**Триггеры:** "сохрани статью", "добавь статью", "запомни ссылку", "article", "нашёл статью", "PDF", "исследование", "paper", URL статьи или PDF в сообщении.

**Скрипт:** `node ~/openclaw/skills/pepino-google-sheets/article-knowledge.cjs auto <URL> [title] [--tags t1,t2]`

**Pipeline (полный цикл):**

```
ШАГ 1: Получить URL из сообщения пользователя
  -> Определить тип: article (HTML) или pdf
  -> Определить title (из аргумента, из HTML <title>, или fallback)
  -> Извлечь домен для метаданных

ШАГ 2: Создать source-файл
  -> Запустить: node article-knowledge.cjs auto "<URL>" "<title>" --tags <теги>
  -> Файл: ~/.openclaw/workspace/memory/pepino-graph/05-sources/articles/
  -> Формат имени: YYYY-MM-DD__article__slug.md (или YYYY-MM-DD__pdf__slug.md)
  -> MANIFEST.md обновляется автоматически

ШАГ 3: Оценить релевантность для NotebookLM
  -> Тема агрономии/теплицы -> nblm_use_notebook("pepino-agronomy-research")
  -> Тема рынка/ресторанов -> nblm_use_notebook("pepino-market-intel")
  -> Тема регуляторики/SENASA -> nblm_use_notebook("pepino-regulatory")
  -> Тема поставщиков/DD -> nblm_use_notebook("pepino-supplier-dd")
  -> Общая/обучающая тема -> пропустить NotebookLM, оставить pending

ШАГ 4 (если NotebookLM релевантен):
  -> nblm_add_source_url("<URL>")
  -> nblm_get_summary()
  -> Обновить секцию "Summary" в source-файле
  -> Заполнить "Key Points" из summary
  -> Предложить "Actions" и "SOP Patches" на основе контента

ШАГ 5: Маршрутизация (Route)
  -> Если есть actionable insight -> создать заметку в pepino-graph/03-insights/
  -> Если market intel -> сохранить в pepino-obsidian/11_market_intel/
  -> Если урок/рецепт -> сохранить в pepino-obsidian/06_lessons_learned/

ШАГ 6: Подтвердить результат пользователю
  -> Вывести путь к файлу
  -> Указать статус NotebookLM (обработан / pending)
  -> Если есть actionable items -> предложить создать задачи
```

**Расширенный шаблон source-файла (auto):**

Файл содержит секции:

- **Summary** -- краткое содержание (из NotebookLM или вручную)
- **Key Points** -- ключевые тезисы статьи
- **Applicable to Pepino Pick** -- что применимо к нашему хозяйству
- **Actions** -- конкретные действия для внедрения
- **SOP Patches** -- какие СОПы обновить/создать
- **Related Entities** -- связи с pepino-graph
- **Route** -- куда маршрутизировать инсайты (pepino-graph, pepino-obsidian)

**Отличие от Режим 8 (YouTube):**

- Поддерживает как HTML-статьи, так и PDF-документы
- Автоматическое определение типа по URL (\*.pdf, /pdf/ -> PDF)
- Извлечение домена для группировки по источникам
- Секция Route для маршрутизации инсайтов

**Примеры команд пользователя:**

```
Сохрани статью https://example.com/greenhouse-guide
Добавь статью: https://sciencedirect.com/article.pdf "Cucumber Growth Optimization"
Запомни ссылку https://medium.com/@farm/hydroponics-tips --tags агрономия,гидропоника
Нашёл исследование по VPD: https://journals.org/vpd-study.pdf
```

**Теги (рекомендуемые):** огурцы, теплица, агрономия, грибы, субстрат, климат, бизнес, маркетинг, упаковка, ферментация, VPD, гидропоника, исследование, PDF

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
