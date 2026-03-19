# pepino-capital

Управление капиталом и инвестиционной деятельностью Pepino Pick: привлечение финансирования, работа с инвесторами, CAPEX планирование, fundraising, оценка проектов.

## Триггеры

инвестор, инвестиции, капитал, финансирование, кредит, займ, CAPEX, расширение, новый блок, новая теплица, fundraising, оценка бизнеса, valuation, pitch, презентация инвестору, due diligence, акции, доля, equity, долг, debt, ROI проекта, окупаемость расширения, бизнес-план, investor relations

## Режимы работы

### 1. CAPEX ПЛАНИРОВАНИЕ

**Категории капитальных вложений:**

- Расширение производства (новые блоки, теплицы)
- Оборудование (климат-контроль, освещение, ирригация)
- Переработка и ферментация (новые линии)
- Хранение (холодильные камеры, склад)
- IT/автоматизация (сенсоры, мониторинг, ERP)
- Упаковка и лейблинг (оборудование)

**Шаблон CAPEX проекта:**

```
Проект: [название]
Тип: [расширение / оборудование / переработка / хранение / IT]
CAPEX: [сумма ARS]
Источник финансирования: [собственные / кредит / инвестор / гос. программа]
Срок реализации: [N месяцев]
Дополнительная выручка/год: [ARS]
Дополнительные расходы/год: [ARS]
Прирост маржи: [ARS/год]
Payback period: [N месяцев]
NPV (5 лет): [ARS]
IRR: [%]
Риски: [ключевые]
Решение: [одобрен / отклонён / на рассмотрении]
Порог апрува: [CEO / Tier2 / Tier3]
```

**Порог апрува CAPEX:**

- До 1,500,000 ARS → CEO самостоятельно
- До 7,500,000 ARS → CEO + финансовая модель
- Выше 7,500,000 ARS → Board review / инвестор

---

### 2. ИСТОЧНИКИ ФИНАНСИРОВАНИЯ

**A. Собственные средства:**

- Реинвестирование прибыли
- Личный капитал владельца
- Ограничение: не ослаблять cash reserve <600,000 ARS

**B. Банковские кредиты:**

- Préstamo bancario (обеспечение имуществом)
- Línea PyME (для малого бизнеса)
- SGR (Sociedad de Garantía Recíproca) — гарантийное общество
- Условия в Аргентине: ставки привязаны к инфляции (UVA / Badlar / TNA)
- Ключевой вопрос: реальная ставка = TNA минус инфляция

**C. Государственные программы:**

- FONDEP (Fondo Nacional de Desarrollo Productivo)
- BNA / BICE — линии для агропроизводства
- Subsidios provinciales para PyMEs agropecuarias
- Minist. de Agricultura — programas de financiamiento tecnológico

**D. Инвестор (Equity):**

- Ангельский инвестор: 50K-500K USD, доля 10-30%
- Венчур: >500K USD, структурные условия (board, veto rights)
- Family office: гибкие условия, долгосрочный горизонт
- Стратегический партнёр: дистрибутор или ритейлер с вложением

**E. Грантовое финансирование:**

- FONTAR (tecnología agropecuaria)
- INTI (innovación en producción alimentaria)
- Programas de economía circular / sostenibilidad

---

### 3. INVESTOR RELATIONS

**Реестр инвесторов и контактов:**

```
Имя: [ФИО / Фонд]
Тип: [angel / VC / family office / strategic / govt]
Статус: [prospect / in_talks / term_sheet / invested / passed]
Потенциальная сумма: [USD/ARS]
Интерес: [agro / food tech / sustainability / local market]
Контакт: [ФИО, телефон, email]
История взаимодействия: [даты и суть встреч]
Следующий шаг: [действие + дедлайн]
Linked case: [CASE-YYYYMMDD-CAP]
```

**Pipeline инвесторов:**

```
Всего контактов: [N]
├─ Prospect:      [N]
├─ In Talks:      [N]
├─ Due Diligence: [N]
├─ Term Sheet:    [N]
├─ Invested:      [N]
└─ Passed:        [N]
```

---

### 4. ИНВЕСТИЦИОННАЯ ДОКУМЕНТАЦИЯ

**Pitch Deck (структура):**

```
1. Problem: что не так на рынке (дефицит свежих грибов, premium сегмент)
2. Solution: Pepino Pick — urban farming, ферментация, прямые поставки
3. Market: размер рынка premium продуктов питания BA
4. Product: ассортимент, дифференциация, Tsitsak / ферментация
5. Traction: выручка, клиенты (Tier 1 рестораны), рост
6. Business Model: unit economics, маржа, scalability
7. Team: CEO и ключевые люди
8. Financials: P&L, cash flow, forecast 3-5 лет
9. Ask: сколько ищем, на что, структура сделки
10. Use of Funds: детализация куда пойдут деньги
```

**Financial Model для инвестора:**

```
Базовые сценарии: conservative / base / optimistic
Горизонт: 5 лет
Включает:
  - Выручка по SKU
  - Себестоимость и валовая маржа
  - OPEX (зарплата, аренда, электричество, маркетинг)
  - EBITDA и Net Income
  - CAPEX план
  - Cash Flow (monthly первые 2 года, quarterly далее)
  - Точка безубыточности
  - ROI и IRR для инвестора
  - Exit options (buyback, strategic sale)
```

**Term Sheet (ключевые пункты):**

```
- Сумма инвестиции
- Valuation (pre-money / post-money)
- Доля инвестора
- Инструмент (equity / convertible note / SAFE)
- Board representation
- Veto rights (и на что)
- Anti-dilution protection
- Liquidation preference
- Lock-up период
- Reporting requirements
- Exit options и timeline
```

---

### 5. ОЦЕНКА БИЗНЕСА (VALUATION)

**Методы оценки:**

**A. Revenue Multiple (для early-stage):**

- MRR × 12 = ARR
- Valuation = ARR × 2-4x (food/agro, Argentina discount)
- Учитываем: growth rate, margin, defensibility

**B. DCF (для зрелой стадии):**

- Прогноз Cash Flow на 5 лет
- WACC с учётом аргентинского риска (Country Risk Premium)
- Terminal Value = FCF5 / (WACC - growth rate)
- NPV = PV всех CF + Terminal Value

**C. Comparable Companies:**

- Food tech стартапы LATAM
- Urban farming компании (поправка на размер и стадию)

**Факторы, влияющие на оценку Pepino Pick:**

- ✅ Уникальный продукт (ферментация + микрозелень)
- ✅ Прямые контракты с Tier 1 ресторанами
- ✅ Operational excellence, систематизация
- ⚠️ Аргентинская экономика (страновой риск)
- ⚠️ Зависимость от ключевого человека (CEO)
- ⚠️ Малый масштаб (пока)

---

## Интеграция

| Навык                       | Когда                              |
| --------------------------- | ---------------------------------- |
| `pepino-financial-modeling` | CAPEX оценка, P&L forecast, DCF    |
| `pepino-controller`         | Текущие финансы для investor deck  |
| `pepino-finance-tools`      | ARS/USD расчёты, реальные ставки   |
| `pepino-risk`               | Риски для investor due diligence   |
| `pepino-legal`              | Term sheet, договоры с инвесторами |
| `pepino-shadow-ceo`         | Стратегические решения по раундам  |
| `pepino-realtor`            | CAPEX на новые площадки            |

## Апрув инвестиционных решений

```
CAPEX < 1.5M ARS    → CEO самостоятельно
CAPEX 1.5-7.5M ARS  → CEO + финансовая модель + pepino-controller
CAPEX > 7.5M ARS    → Board / Investor sign-off
Привлечение equity  → CEO + юридическое сопровождение (pepino-legal)
Convertible note    → CEO + финансовый советник
```

## Формат ответа

```
case_id: CASE-[YYYYMMDD]-CAP
intent: capital_[capex|sources|investor_relations|docs|valuation]

[результат]

funding_status: [self-funded / seeking / closed]
next_capital_event: [дата и тип]
linked_agents: [...]
next_actions:
  - [действие] — [owner] — [срок]
```
