---
name: greenhouse-sheets
description: Google Sheets для тепличного хозяйства — запись производства, продаж, склада, P&L, инженерных расчётов, рыночных цен. Используй при словах "записать в таблицу", "обновить sheets", "внести данные", "Google таблица", "лог производства", "записать продажу", "обновить остатки", "P&L в таблицу", "экспорт в sheets".
homepage: https://docs.google.com/spreadsheets
metadata:
  openclaw:
    emoji: "📊"
    requires:
      bins: []
---

# Greenhouse Sheets

Сервисный аккаунт: `pepino-pick-bot@peak-plasma-467720-i8.iam.gserviceaccount.com`
Credentials: `/home/roman/openclaw/google-credentials.json`
sheets.js: `/home/roman/openclaw/skills/greenhouse-sheets/sheets.js`

## ID таблиц

```
Продажи:     1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc
Производство: (создать → /greenhouse-sheets setup production)
Склад:        (создать → /greenhouse-sheets setup inventory)
P&L:          (создать → /greenhouse-sheets setup pnl)
Инженерия:   (создать → /greenhouse-sheets setup engineering)
```

Таблица **должна быть расшарена** на email сервисного аккаунта как **Редактор**.

---

## Как использовать в скрипте

```js
import {
  writeToSheet,
  appendToSheet,
  readSheet,
  clearSheet,
  logProduction,
  logSale,
  logInventoryMove,
  logEngCalc,
  GREENHOUSE_SHEETS,
} from "/home/roman/openclaw/skills/greenhouse-sheets/sheets.js";

// Записать продажу
await logSale("2026-03-13", "Ресторан Аура", "Вешенка", 2.5, 8.0, "Первый заказ");

// Записать производство
await logProduction("2026-03-13", "Микрозелень подсолнечник", "B-2026-11", 5.0, 4.8, "");

// Обновить склад
await logInventoryMove("2026-03-13", "remove", "Субстрат солома", 15, "Партия B-2026-11");

// Записать произвольные данные
await appendToSheet("SHEET_ID", [["col1", "col2", "col3"]], "Лист1");
```

---

## Команды

### /greenhouse-sheets setup [модуль]

Создание структуры таблицы. Модули: `production` / `sales` / `inventory` / `pnl` / `engineering` / `all`

**Структуры листов:**

**Производство** (`production`):

```
Дата | Культура | Партия | Площадь м² | План кг | Факт кг | BE% | Волна | Клим T°C | Клим RH% | Клим CO2 | Примечание
```

**Продажи** (`sales`):

```
Дата | Клиент | Продукт | Кг | Цена/кг | Сумма | Канал | Доставка | Примечание
```

**Склад** (`inventory`):

```
[Лист "Движения"]: Дата | Операция | Товар | Кол-во | Ед.изм | Баланс | Оператор
[Лист "Остатки"]:  Товар | Текущий остаток | Ед.изм | Мин. запас | Статус | Поставщик | Цена/ед
```

**P&L** (`pnl`):

```
[Лист "Доходы"]:   Дата | Источник | Категория | Сумма | Примечание
[Лист "Расходы"]:  Дата | Категория | Статья | Сумма | Поставщик | Примечание
[Лист "P&L"]:      Месяц | Выручка | COGS | Валов.маржа | OPEX | EBITDA | EBITDA%
```

**Инженерия** (`engineering`):

```
Дата | Система | Параметры | Результат | Статус | Примечание
[Лист "Мониторинг"]: Дата | Зона | T°C | RH% | CO2 ppm | EC | pH | Оператор
```

---

### /greenhouse-sheets log-production [данные]

Записать производственный отчёт дня.

```js
import { logProduction } from "/home/roman/openclaw/skills/greenhouse-sheets/sheets.js";

// Пример
await logProduction(
  new Date().toLocaleDateString("ru-RU"), // дата
  "Микрозелень редис", // культура
  "BATCH-2026-031", // ID партии
  3.0, // план кг
  2.9, // факт кг
  "Небольшое снижение из-за влажности", // примечание
);
```

---

### /greenhouse-sheets log-sale [данные]

Записать продажу/отгрузку.

```js
import { logSale } from "/home/roman/openclaw/skills/greenhouse-sheets/sheets.js";

await logSale(
  new Date().toLocaleDateString("ru-RU"),
  "Ресторан Паладар",
  "Вешенка свежая",
  3.5, // кг
  7.5, // цена/кг
  "Еженедельная поставка",
);
```

---

### /greenhouse-sheets log-inventory [действие] [товар] [кол-во]

Движение по складу.

```js
import { logInventoryMove } from "/home/roman/openclaw/skills/greenhouse-sheets/sheets.js";

// add = приход, remove = расход, adjust = корректировка
await logInventoryMove("2026-03-13", "add", "Субстрат кокос", 25, "Поставка Agro-Mar");
await logInventoryMove("2026-03-13", "remove", "Семена подсолнечник", 0.3, "Посев партии B-031");
```

---

### /greenhouse-sheets weekly-pnl

Недельный P&L — собирает из листа Продажи и Расходы, записывает сводку в P&L.

---

### /greenhouse-sheets dashboard

Обновить дашборд в Google Sheets с ключевыми показателями недели.

**KPI дашборд (лист "Dashboard"):**

```
ПРОИЗВОДСТВО:  урожай неделя / месяц / план%
ФИНАНСЫ:       выручка / маржа / расходы / EBITDA
СКЛАД:         остатки по ключевым позициям / алерты
КЛИЕНТЫ:       активных / новых / возвратов
РЫНОК:         средняя цена конкурентов (из мониторинга)
```
