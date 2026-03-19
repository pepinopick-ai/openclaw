---
name: pepino-finance-tools
description: "💰 Финансовые инструменты Pepino Pick — курсы ARS/USD (Blue/Oficial/все), юнит-экономика продуктов, NPV, маржа, точка безубыточности, сценарный анализ. Авто-вызывай при словах курс доллара, blue dollar, перевести ARS в USD, маржа, себестоимость, NPV, окупаемость, точка безубыточности, сколько зарабатываем, финансовый анализ, сценарий цены."
homepage: https://dolarapi.com
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
---

# 💰 Pepino Finance Tools

Финансовые расчёты в реальном времени для аргентинского рынка.

```
/home/node/.openclaw/workspace/tools/finance.js
```

Данные курсов: **dolarapi.com** (обновляется каждые 30 минут, кэш локальный)

---

## Команды

### Курсы валют (реальное время)

```bash
node /home/node/.openclaw/workspace/tools/finance.js rates
# → Oficial, Blue, Bolsa, CCL, Cripto, Tarjeta + premium Blue vs Oficial
```

### Конвертация ARS ↔ USD

```bash
node /home/node/.openclaw/workspace/tools/finance.js convert 500000 ARS USD
node /home/node/.openclaw/workspace/tools/finance.js convert 350 USD ARS
# → три варианта: Blue, Oficial, Tarjeta
```

### Юнит-экономика продукта

```bash
node /home/node/.openclaw/workspace/tools/finance.js unit veshyonka
node /home/node/.openclaw/workspace/tools/finance.js unit microgreens
node /home/node/.openclaw/workspace/tools/finance.js unit pepino
# → COGS / маржа ARS / маржа USD / сценарный анализ цен
```

### NPV и окупаемость инвестиции

```bash
node /home/node/.openclaw/workspace/tools/finance.js npv 2000000 15 800000,900000,1000000,1100000,1200000
# Аргументы: инвестиция_ARS ставка_% CF_год1,CF_год2,...
# → таблица PV / NPV / ROI / срок окупаемости
```

### Маржинальность P&L

```bash
node /home/node/.openclaw/workspace/tools/finance.js margin 3000000 1500000 600000
# Аргументы: выручка COGS OPEX (все в ARS/мес)
# → валовая маржа / EBITDA / EBITDA% / USD-эквивалент
```

### Точка безубыточности

```bash
node /home/node/.openclaw/workspace/tools/finance.js breakeven 800000 23000 8000
# Аргументы: постоянные_затраты цена_ед переменные_ед (ARS)
# → объём / выручка / таблица сценариев
```

### Сценарный анализ

```bash
node /home/node/.openclaw/workspace/tools/finance.js scenario 1000000 "цена_субстрата" +20
# → таблица Pessimistic/Base/Optimistic + твой сценарий
```

---

## Типичные задачи CFO

**Утренний дашборд:**

```bash
node finance.js rates && node finance.js margin 2500000 1100000 500000
```

**Оценить расширение до 4 теплиц:**

```bash
node finance.js npv 8000000 20 2000000,2500000,3000000,3500000,4000000
```

**Что будет если поставщик поднимет цену субстрата на 30%?**

```bash
node finance.js scenario 1200000 "субстрат" +30
node finance.js unit veshyonka  # пересчитает COGS
```

**Перевести дневную выручку в USD:**

```bash
node finance.js convert 350000 ARS USD
```

---

## Источники данных (бесплатные API без ключей)

| API                | Данные                                     | Обновление     |
| ------------------ | ------------------------------------------ | -------------- |
| dolarapi.com       | Oficial, Blue, Bolsa, CCL, Cripto, Tarjeta | Каждые часы    |
| bluelytics.com.ar  | Blue avg/buy/sell                          | Каждые 30 мин  |
| OpenStreetMap/OSRM | Маршруты и расстояния                      | Реальное время |

---

## Почему НЕ нужны Xero / Figured / Airtable сейчас

| Инструмент | Стоимость  | Когда нужен                                  |
| ---------- | ---------- | -------------------------------------------- |
| Xero       | $35–70/мес | При >50 транзакций/день или найме бухгалтера |
| Figured    | $200+/мес  | При >3 теплицах с кредитным финансированием  |
| Airtable   | $20+/мес   | Google Sheets уже закрывает те же задачи     |
| QuickBooks | $30–60/мес | Когда нужна официальная отчётность для банка |

**Вывод:** Google Sheets + finance.js покрывают 95% потребностей Pepino Pick на текущем этапе.
