# Pepino Agent OS v2 — Полная инструкция

AI-powered операционная система для тепличного хозяйства Pepino Pick (Буэнос-Айрес, Аргентина).
71 скрипт | 42 cron | 6 n8n workflows | Digital Twin | 24/24 тестов

---

## Быстрый старт

```bash
# 1. Добавить CLI alias (один раз)
echo 'alias pepino="node /home/roman/openclaw/skills/pepino-google-sheets/pepino-cli.cjs"' >> ~/.bashrc
source ~/.bashrc

# 2. Проверить систему
pepino status        # здоровье: контейнеры, RAM, диск, сервисы
pepino test          # 24 e2e теста (должно быть 24/24 PASS)

# 3. Готово! Используй pepino для всего
pepino help          # полный список команд
```

---

## Ежедневное использование

### Утро (5 минут)

```bash
# Что происходит на ферме прямо сейчас
pepino twin

# Пример вывода:
# PEPINO PICK DIGITAL TWIN
# --- INVENTORY ---
# Products: 3 | RED:3 YEL:0 GRN:0
#   !!! Огурец: 0kg (0d left)
# --- CLIENTS ---
# Active:4 AtRisk:1 Churned:11
# Expected orders this week: 5
# --- 2-WEEK FORECAST ---
# Revenue: ~2.1M ARS | Margin: ~87%

# Посмотреть чеклист дня
pepino checklist

# Пример:
# 🌱 Утренний обход (07:00-08:00)
#   ☐ Проверить температуру/влажность
#   ☐ Готово к сбору: Огурец (98 кг)
# 📦 Сборка заказов (08:00-10:00)
#   Заказов: 0
# 🔧 Текущие задачи
#   ⚠️ Просроченные (4):
#   ☐ Обработать Zone B Ридомил Голд
```

### В течение дня

```bash
# Записать расход (автоматически определяет категорию!)
pepino expense "субстрат 5000"
pepino expense "доставка 3500 наличные"
pepino expense "зарплата Мигель 45000"
pepino expense "электричество 12000 перевод"

# Посмотреть расходы за сегодня / неделю
pepino expense --list
pepino expense --week

# Пример вывода --week:
# Персонал: 45 000 ARS (69%)
# Коммунальные: 12 000 ARS (18%)
# Материалы: 5 000 ARS (8%)
# ИТОГО: 65 500 ARS | Среднедневной: 9 357 ARS
```

### Вечер (2 минуты)

```bash
# Продажи за сегодня
pepino sales today

# P&L за неделю
pepino pnl week

# Пример:
# Выручка: 1 509 850 ARS
# Расходы: 65 500 ARS
# Маржа: 96% ⚠️ Расходы не внесены за последние 7 дней

# Склад
pepino stock

# Пример:
# 🔴 Огурец: 0 кг (0 дн.)
# 🔴 Соленые огурцы: 0 кг (0 дн.)
```

---

## Аналитика

### Клиенты

```bash
# Здоровье клиентов
pepino clients

# Пример:
# 🟢 Активные: 4
# 🟡 At risk (>14 дн.): 1
# 🔴 Churned (>30 дн.): 11
# Топ-5:
# 1. 🟢 У Беларуса — 3 дн. назад, 49 заказов, 13.4M ARS
# 2. 🟢 Чайхана — 3 дн. назад, 70 заказов, 2.5M ARS

# RFM-скоринг (A/B/C/D тиры)
pepino scores

# Пример:
# 🟢 Tier A (VIP): У Беларуса (85 pts), Гастроном 1 (82 pts)
# 🔴 Tier D: 11 клиентов, 1M ARS под угрозой
# Возможности:
# 🔄 Гастроном 1 [win-back] — перестал покупать: Томат, Укроп
# 📈 Главное что внутри [upsell] — частота растёт (12д → 7д)
```

### Финансы

```bash
# Прогноз cash flow
pepino forecast

# Пример:
# avg_daily: 643K ARS
# forecast_7d: 4.5M ARS
# forecast_30d: 19.3M ARS
# best_day: Среда

# Потери производства
pepino waste

# Маржинальность (запуск 1-го и 15-го числа)
cd ~/openclaw/skills/pepino-google-sheets
node margin-optimizer.cjs --dry-run
```

### Прогнозы

```bash
# Прогноз спроса на 4 недели (запуск по понедельникам)
node demand-predictor.cjs --dry-run

# Пример:
# Огурец: 310 кг → 330 кг → 351 кг → 373 кг, пик: Ср, Сб
# Клиенты, ожидающие заказ:
# • У Беларуса — ожидается сегодня (цикл: ~4д)
# • Чайхана — через 3д (цикл: ~7д)
```

---

## Digital Twin

Реальная модель фермы с 7 секциями и 2-недельным прогнозом.

```bash
# Текстовая сводка
pepino twin

# HTML-дашборд (открыть в браузере)
pepino twin html
# → /tmp/pepino-twin.html

# Полный JSON (для интеграций)
node digital-twin.cjs
```

Секции: Production Zones | Inventory | Financial | Client Health | Weather | Operations | 2-Week Forecast

---

## Pipelines (автоматические цепочки)

Вместо отдельных скриптов — 3 pipeline'а запускают всё последовательно:

```bash
# Утренний (06:00): доставка → чеклист → склад → агрегаты → бриф
pepino morning

# Вечерний (20:30): агрегаты → P&L → полнота данных → LLM costs → алерты
pepino evening

# Воскресный (17:00): потери → план производства → знания → CEO дайджест
pepino sunday
```

---

## Trend Radar

5 потоков внешней разведки через Google News RSS:

```bash
# Запустить все потоки
node trend-radar.cjs --dry-run all

# Один поток
node trend-radar.cjs --dry-run supplier-risk

# Потоки:
# supplier-risk   — ежедневно 07:30 (поставщики, цены, риски)
# ai-agents       — пн/ср/пт 08:00 (Claude Code, n8n, MCP)
# marketing       — пн/ср/пт 08:00 (Instagram, food brands)
# agro-tech       — вт/чт 08:00 (теплицы, грибы, гидропоника)
# sales           — пн/чт 08:30 (B2B, рестораны, retention)
```

Результаты: лист "📡 Trend Radar" в Sheets + Telegram топ-сигналы

---

## Market Intelligence

```bash
# Поиск цен конкурентов (Mercado Libre)
node web-intel.cjs prices "hongos ostra" --dry-run

# Поиск поставщиков
node web-intel.cjs suppliers "sustrato hongos" --dry-run

# Анализ конкурентов
node web-intel.cjs competitors "pepinos frescos" --dry-run

# Сводный отчёт
node web-intel.cjs report

# Анализ отзывов (ежемесячно)
node review-miner.cjs "hongos ostra frescos" --dry-run
```

---

## Knowledge Layer

Поиск по доменной базе знаний (70 документов, 761 chunk, 8 доменов):

```bash
# Поиск по всей базе
pepino search "маржа ценообразование"

# Поиск по роли (автофильтр доменов)
node knowledge-retriever.cjs "pest control" --agent agronomist

# Доступные домены: agronomy, finance, sales, procurement, sop, governance
# Доступные роли: agronomist, finance, sales, procurement, director, dev

# Статистика индекса
pepino index

# Переиндексация
node knowledge-indexer.cjs index
node knowledge-indexer.cjs sync    # инкрементальная

# Организация vault по доменам
node vault-organizer.cjs
```

---

## n8n Workflows

6 активных workflow'ов (управление через CLI):

```bash
# Статус всех workflow'ов
pepino n8n

# Список с деталями
pepino n8n list

# Активные:
# 🚨 QA Alert Pipeline     — алерты severity ≥ 4 каждые 15 мин
# 🌡️ IoT Sensor Gateway    — webhook для датчиков теплицы
# 📝 Telegram Data Logger   — парсинг TG сообщений → Sheets
# 🛒 Client Order Portal    — webhook заказов
# 🌿 Harvest Logger         — логирование урожая каждые 2ч
# 🛒 ML Price Monitor       — мониторинг цен каждые 6ч
```

---

## Sheets API v2

REST API для всех данных (port 4000, Bearer auth):

```bash
TOKEN=$(cat ~/.openclaw/.sheets-api-token)

# Базовые данные
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/sales?all=true
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/production?all=true
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/expenses?all=true
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/inventory

# Аналитика (API v2)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/clients    # здоровье клиентов
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/forecast   # прогноз 7/30 дней
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/waste      # потери
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/dashboard  # компактная сводка

# Запись данных
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:4000/log/sales \
  -d '{"client":"Клиент","product":"Огурец","qty_kg":10,"price_per_kg":6750,"total_ars":67500}'

curl -X POST http://127.0.0.1:4000/log/expense \
  -d '{"description":"Субстрат","amount_ars":5000}'

# Query params: ?all=true (все данные), ?limit=N (последние N)
```

---

## Langfuse Eval

Система измерения качества агентов:

```bash
# Засеять датасет (15 тест-кейсов, 5 доменов)
pepino eval seed

# Оценить трейс (0 = плохо, 1 = отлично)
pepino eval score <trace_id> 0.8 "хороший ответ"

# Отчёт по оценкам
pepino eval report
```

---

## Мониторинг

```bash
# Системный статус
pepino status

# HTML-дашборд (обновляется каждые 10 мин)
# → /tmp/pepino-status.html

# 24 e2e теста
pepino test

# Логи конкретного скрипта
pepino logs daily-pnl
pepino logs inventory-tracker
pepino logs trend-radar

# Cron-задачи с последним запуском
pepino cron
```

---

## Notification Throttle

Защита от спама в Telegram (автоматически для 6 скриптов):

- **Дедупликация**: одинаковые сообщения не повторяются 4 часа
- **Rate limit**: макс 5 сообщений/час на тред
- **Тихие часы**: 22:00-06:00 — только P1/critical проходят
- **Priority override**: "CRITICAL", "P1", "!!!" — всегда доставляются

---

## Governance (pepino-core)

9 файлов управления системой в `skills/pepino-core/`:

| Файл                | Назначение                                           |
| ------------------- | ---------------------------------------------------- |
| ENTITIES.md         | 11 схем данных (SKU, Customer, Supplier...)          |
| AGENT_REGISTRY.md   | 31 агент (capabilities, SLA, limits)                 |
| POLICY_ENGINE.md    | L0-L4 уровни одобрения (auto → human-only)           |
| STATE_MACHINE.md    | 9 состояний задачи (created → archived)              |
| LEARNING_LOOP.md    | Post-decision review, 10 red-team сценариев          |
| MEMORY_SYSTEM.md    | 4 типа памяти (working/episodic/semantic/procedural) |
| RETRIEVAL_POLICY.md | Матрица доступа к знаниям по ролям                   |
| EVAL_SUITE.md       | 50 тест-кейсов для валидации                         |
| SKILL.md            | Манифест pepino-core v2.0.0                          |

---

## Правила (.claude/rules/)

| Файл                   | Что контролирует                              |
| ---------------------- | --------------------------------------------- |
| 00-core.md             | Запреты, approval policy, Definition of Done  |
| 20-agro.md             | Production safety, EC/pH нормы                |
| 30-finance.md          | Маржа ≥35%, пороги одобрения ARS              |
| 50-skill-quarantine.md | Новые skills → карантин → review → production |
| 60-trend-radar.md      | Фильтры качества сигналов, routing            |
| git.md                 | Conventional Commits, ветки                   |
| security.md            | SQL injection, secrets, auth                  |

---

## Полный daily cycle

```
03:00  memory-maintenance (вс)     — очистка памяти
04:00  knowledge-indexer           — синхронизация индекса знаний
06:00  MORNING PIPELINE            — доставка → чеклист → склад → агрегаты → бриф
07:15  digital-twin                — модель фермы
07:30  trend-radar supplier-risk   — разведка рисков
08:00  trend-radar ai+marketing    — тренды (пн/ср/пт)
09:00  supplier-monitor            — алерты по материалам
09:00  currency-updater            — курс Blue (будние)
10:03  churn-detector              — отток клиентов (пн-пт)
10:00  client-outreach             — CRM follow-up (вт/пт)
11:00  competitive-intel           — конкуренты ML (пн)
12:07  auto-pricing                — ценообразование (пн/ср/пт)
17:00  SUNDAY PIPELINE             — потери → план → знания → CEO
18:00  cashflow-forecast (ср)      — прогноз cash flow
18:00  weekly-report (пт)          — недельный отчёт
20:30  EVENING PIPELINE            — агрегаты → P&L → полнота → costs → алерты
```

---

## Troubleshooting

```bash
# Всё сломалось?
pepino test          # что именно не работает (24 теста)
pepino status        # какие сервисы упали

# Контейнер упал?
docker ps -a         # найти проблемный
docker restart <name>

# Sheets API не отвечает?
docker restart pepino-sheets-api

# Gateway крашится?
docker logs openclaw-openclaw-gateway-1 --tail 20
# Частая причина: неправильный ключ в openclaw.json

# Langfuse не работает?
docker compose -f ~/openclaw/infra/langfuse/docker-compose.yml restart

# Cron не запускается?
crontab -l | grep <script>   # проверить что в расписании
cat ~/logs/<script>.log       # посмотреть ошибки
```

---

## Архитектура

```
Telegram (15 топиков) ←→ OpenClaw Gateway (2026.3.11)
         ↓
Claude Code (Opus 4.6, orchestrator)
         ↓
┌────────────────┐  ┌─────────────┐  ┌──────────────────┐
│ 57 CJS + 14 JS │  │ Sheets API  │  │ Knowledge Layer  │
│ 42 cron + 3    │→ │ v2 (27+     │  │ 70 docs / 761    │
│ pipelines      │  │ endpoints)  │  │ chunks / 8 dom   │
└────────────────┘  └─────────────┘  └──────────────────┘
         ↓               ↓                    ↓
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Grafana  │  │ Langfuse │  │ Trend    │  │ Digital  │
│ 6 dashbd │  │ v3 eval  │  │ Radar 5  │  │ Twin v1  │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
         ↓
┌──────────────────────────────────────────────────┐
│ pepino-core governance (9 files)                 │
│ 7 rules · notification throttle · skill quarantine│
└──────────────────────────────────────────────────┘
```

---

## Ключевые файлы

| Файл                        | Что делает                          |
| --------------------------- | ----------------------------------- |
| `pepino-cli.cjs`            | Единый CLI (23 команды)             |
| `pipeline-runner.cjs`       | Morning/evening/sunday pipelines    |
| `digital-twin.cjs`          | Модель фермы + 2-нед. прогноз       |
| `system-test.cjs`           | 24 e2e теста                        |
| `status-page.cjs`           | HTML дашборд системы                |
| `notification-throttle.cjs` | Anti-spam для Telegram              |
| `product-aliases.cjs`       | Нормализация названий (40+ алиасов) |
| `knowledge-indexer.cjs`     | Индекс знаний (FTS)                 |
| `knowledge-retriever.cjs`   | Поиск по базе знаний                |
| `n8n-client.cjs`            | n8n API клиент                      |
| `eval-runner.cjs`           | Langfuse eval система               |
| `SCRIPTS.md`                | Полный индекс всех скриптов         |
