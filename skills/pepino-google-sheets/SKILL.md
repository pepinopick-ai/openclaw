---
name: pepino-google-sheets
description: Write, read, append and clear data in the Pepino Pick OS Google Sheets system. Use when recording sales, expenses, harvest, logistics, HR, alerts, tasks, or any business data. Covers all 14 department sheets.
homepage: https://developers.google.com/sheets/api
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": [] } } }
---

# Pepino Pick — Google Sheets OS

Сервисный аккаунт: `pepino-pick-bot@peak-plasma-467720-i8.iam.gserviceaccount.com`
Credentials: `/home/roman/openclaw/google-credentials.json`

## Pepino Pick OS — центральная таблица

**ID:** `1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc`
**URL:** https://docs.google.com/spreadsheets/d/1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc

```
const PEPINO_OS_ID = '1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc';
```

## Листы и их структура (актуально — 2026-03-19)

| Лист (точное имя)          | Агент       | Назначение                          | Ключевые колонки                                                                                                     |
| -------------------------- | ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `📊 P&L`                   | finance     | Финансы: доходы, расходы, P&L       | Дата, Категория, Тип, Сумма(ARS), Описание, Агент, Подтверждено                                                      |
| `🌿 Производство`          | agro        | Агрономия: урожай, посевы, события  | Дата, Культура, Партия, Событие, Кол-во(кг), EC, pH, Зона, Примечание                                                |
| `📦 Склад`                 | logistics   | Склад: остатки, приёмка, отгрузка   | Дата, Тип, Товар, Кол-во(кг), Клиент/Поставщик, Статус                                                               |
| `🛒 Продажи`               | sales       | Продажи: клиенты, заказы, выручка   | Дата, Клиент, Продукт, Кол-во, Сумма(ARS), Канал, Примечание                                                         |
| `👥 Клиенты`               | sales       | CRM: реестр клиентов, тиры, статусы | Клиент, Тир, Статус, ARS/мес, Контакт, Последний заказ                                                               |
| `🚚 Закупки`               | procurement | Закупки: поставщики, заказы, SLA    | Дата, Поставщик, Материал, Кол-во, Цена(ARS), Статус, Ссылка                                                         |
| `💱 Курсы валют`           | finance     | FX: курсы ARS/USD (oficial/blue)    | Дата, Oficial, Blue, CCL, Источник                                                                                   |
| `🏗️ Инвестиции`            | capital     | CAPEX: проекты, ROI, статус         | Проект, CAPEX(ARS), Статус, Payback(мес), NPV                                                                        |
| `🏡 Недвижимость`          | realtor     | Земля/площадки: скоринг, цена       | Объект, Адрес, Цена, Баллы, Статус                                                                                   |
| `📈 Рынок и конкуренты`    | market      | Цены рынка, конкуренты, тренды      | Дата, Продукт, Источник, Цена(ARS), Примечание                                                                       |
| `⚙️ KPI`                   | director    | Дашборд KPI по всей компании        | Метрика, Факт, Таргет, Δ%, Период                                                                                    |
| `🌱 Субстрат и расходники` | agro        | Расход субстрата, мицелия, семян    | Дата, Материал, Кол-во, Остаток, Партия                                                                              |
| `📋 Задачи`                | ops         | Задачи: все отделы, статусы         | Дата, Задача, Отдел, Ответственный, Приоритет, Дедлайн, Статус                                                       |
| `🗂️ Справочник`            | all         | Справочные данные, контакты, коды   | Тип, Название, Значение, Примечание                                                                                  |
| `🕵️ Досье`                 | osint       | Профили: клиенты, партнёры, шефы    | Имя, Тип, Описание, Контакт, Связи                                                                                   |
| `🗃️ Кейсы`                 | dispatcher  | Case log: все кейсы из dispatcher   | case_id, дата, intent, суффикс, навыки, статус, owner, описание, linked_entities, approval_status, результат, закрыт |
| `⚠️ Алерты`                | all         | Алерты: агрономия, финансы, риски   | дата, тип, источник_агент, зона, описание, критичность, статус, ответственный, реакция                               |
| `📜 Решения`               | director    | Лог решений CEO и команды           | дата, case*id, решение, принято*кем, обоснование, затронутые_отделы, дедлайн, статус                                 |

## Использование

```js
import { writeToSheet, appendToSheet, readSheet, clearSheet } from "./sheets.js";

const OS = "1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc";

// Записать урожай
await appendToSheet(
  OS,
  [["2026-03-15", "Огурцы", "B-2026-11", "Сбор урожая", "45", "2.8", "6.1", "Zone-A", ""]],
  "🌿 Производство",
);

// Записать продажу
await appendToSheet(
  OS,
  [["2026-03-15", "Ресторан Аура", "Огурцы", "20", "9000", "Прямая", ""]],
  "🛒 Продажи",
);

// Записать расход
await appendToSheet(
  OS,
  [["2026-03-15", "Закупки", "расход", "15000", "Субстрат солома 50кг", "procurement", "да"]],
  "📊 P&L",
);

// Записать алерт
await appendToSheet(
  OS,
  [
    [
      "2026-03-15 09:30",
      "Агрономический",
      "pepino-agro-ops",
      "Zone-B",
      "Мучнистая роса на огурцах",
      "4",
      "открыт",
      "agro",
      "Обработка фунгицидом",
    ],
  ],
  "⚠️ Алерты",
);

// Записать кейс (dispatcher log)
await appendToSheet(
  OS,
  [
    [
      "CASE-20260315-AGR",
      "2026-03-15",
      "agronomy",
      "AGR",
      "pepino-agro-ops",
      "closed",
      "roman",
      "Дневная проверка зон",
      "",
      "not_required",
      "OK",
      "да",
    ],
  ],
  "🗃️ Кейсы",
);

// Прочитать задачи
const tasks = await readSheet(OS, "📋 Задачи");
```

## Функции

- `writeToSheet(spreadsheetId, data, sheetName)` — записать с A1 (перезаписывает)
- `appendToSheet(spreadsheetId, data, sheetName)` — добавить строки в конец
- `readSheet(spreadsheetId, sheetName)` — прочитать все данные
- `clearSheet(spreadsheetId, sheetName)` — очистить лист

## Важно

- `data` — массив массивов: `[['кол1', 'кол2'], ['знач1', 'знач2']]`
- Таблица должна быть доступна сервисному аккаунту (уже настроено)
- При записи всегда соблюдай порядок колонок из таблицы выше
