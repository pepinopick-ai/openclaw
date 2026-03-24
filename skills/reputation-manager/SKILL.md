---
name: reputation-manager
description: Менеджер репутации Pepino Pick — мониторинг упоминаний компании, отзывов, хэштегов и обсуждений в аргентинском интернете. Анализирует сентимент, предлагает ответы на негатив, отправляет алерты в Telegram. Авто-вызывай при словах "репутация", "отзывы", "упоминания", "что говорят о нас", "негативные отзывы", "мониторинг бренда", "ответить на отзыв", "Instagram теги", "что пишут", "жалоба", "PR", "имидж", "reseñas", "opiniones", "menciones".
homepage: https://pepinopick.com
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["python3"] } } }
---

# Reputation Manager — Pepino Pick Argentina

Мониторинг репутации компании в аргентинском интернете.

## Архитектура

```
Claude (WebSearch + Firecrawl)  →  reputation_monitor.py add  →  SQLite DB
                                                              ↓
                                              Telegram алерт на негатив
                                              + предложенный ответ
Cron каждые 4ч  →  scan (Bing RSS)  ──────────────────────────────────────
```

## Скрипт и данные

- **Скрипт:** `~/.openclaw/workspace/scripts/reputation_monitor.py`
- **База:** `~/.openclaw/workspace/memory/reputation.db`
- **Токены:** `~/.openclaw/workspace/scripts/.env.trading`

## Алгоритм проверки (для Claude)

Когда пользователь спрашивает "что говорят о нас" или "проверь репутацию":

1. **Выполни WebSearch** по каждому запросу из списка ниже
2. **Для каждого релевантного результата** вызови команду `add`
3. **Проверь статус** и выведи сводку

### Запросы для WebSearch

```
"Pepino Pick" argentina
"Pepino Pick" reseña OR opiniones OR queja
pepinopick instagram
pepinos organicos frescos argentina
encurtidos artesanales argentina
microverdes microgreens argentina
hongos ostra venta argentina
verduras organicas delivery argentina
```

### Сохранение результата (команда add)

```bash
cd ~/.openclaw/workspace && source scripts/.env.trading && \
python3 scripts/reputation_monitor.py add '{"platform":"instagram.com","url":"https://...","author":"@usuario","text":"Texto del comentario o reseña","query":"pepino pick"}'
```

**Обязательные поля JSON:** `text`
**Опциональные:** `platform`, `url`, `author`, `query`

### Проверка статуса

```bash
python3 scripts/reputation_monitor.py status
```

## Команды CLI

| Команда         | Описание                                   |
| --------------- | ------------------------------------------ |
| `add '<json>'`  | Добавить упоминание (используется Claude)  |
| `scan`          | Автоматическое сканирование через Bing RSS |
| `alerts`        | Отправить накопленные Telegram-алерты      |
| `status`        | Статистика базы данных                     |
| `report [N]`    | Отчёт за N дней (по умолчанию 7)           |
| `report-tg [N]` | Отчёт за N дней + отправить в Telegram     |
| `respond <ID>`  | Предложить ответ на упоминание #ID         |
| `cron`          | Настроить автоматический запуск            |

## Сентимент и алерты

**Негативные маркеры (ES):**
malo, pésimo, podrido, marchito, tardó, no llegó, queja, reclamo,
decepcionante, no recomiendo, insípido, mala atención...

**Позитивные маркеры (ES):**
excelente, delicioso, fresco, recomiendo, rápido, buena calidad,
orgánico, sabroso, volvería a comprar, 5 estrellas...

При обнаружении негатива → мгновенный Telegram-алерт с предложенным ответом.

## Шаблоны ответов

**Задержка:**

> ¡Hola! Gracias por avisarnos 🙏 Lamentamos la demora. Escribinos a @pepinopick para resolverlo. 🥒

**Качество:**

> La calidad es nuestra prioridad. Escribinos a @pepinopick — cambio o reintegro garantizado.

**Цена:**

> Somos 100% orgánicos y producción propia. Tenemos combos con mejor precio. ¡Escribinos! 🌱

**Нет ответа:**

> Pedimos disculpas. Escribinos directamente a @pepinopick — te atendemos ahora mismo. 🥒

## Источники для мониторинга в Аргентине

| Платформа         | Что искать                                        |
| ----------------- | ------------------------------------------------- |
| **Instagram**     | #pepinopick, @pepinopick mentions, теги продуктов |
| **Mercado Libre** | Отзывы на конкурентов в категориях                |
| **Google Maps**   | Отзывы на компанию                                |
| **Facebook**      | Упоминания в группах                              |
| **Twitter/X**     | @pepinopick, "Pepino Pick"                        |
| **Taringa!**      | Обсуждения                                        |

## Автозапуск (cron)

```bash
python3 scripts/reputation_monitor.py cron
```

Устанавливает:

- Сканирование Bing RSS каждые 4 часа
- Еженедельный отчёт в Telegram (пн 09:00)

## Примеры запросов через OpenClaw

```
что говорят о Pepino Pick в интернете?
проверь негативные отзывы
что пишут в Instagram про наши огурцы?
сгенерируй ответ на жалобу #42
отчёт по репутации за месяц
запусти мониторинг
есть новые упоминания?
```
