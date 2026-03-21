# Pepino Pick Agent OS v2 -- Agent Registry

> Формальный реестр всех 31 агентов системы Pepino Pick.
> Каждый агент описан по единой схеме: назначение, класс, инструменты, данные, границы автономии, SLA и зависимости.

**Версия:** 2.0
**Дата:** 2026-03-21
**Google Sheets ID:** `1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc`

---

## Классификация агентов

| Класс              | Описание                                                               | Примеры                              |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------ |
| **Thinker**        | Анализ, прогнозы, расчёты. Не меняет внешний мир без явного одобрения. | financial-modeling, greenhouse-tech  |
| **Operator**       | Выполняет действия: записи, рассылки, создание контента.               | agro-ops, brand, sales-crm           |
| **Guardian**       | Защита и контроль: QA, risk, compliance, финансовый щит.               | qa-food-safety, climate-guard, legal |
| **Infrastructure** | Служебные навыки: I/O данных, знания, оркестрация.                     | google-sheets, knowledge, dispatcher |

---

## 1. pepino-dispatcher

| Field            | Value                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Purpose          | Front Door Orchestrator -- принимает любой запрос, классифицирует intent, выбирает агентов, запускает их, логирует кейсы |
| Class            | Infrastructure                                                                                                           |
| Tools            | Google Sheets API, NotebookLM MCP, Telegram API                                                                          |
| Reads            | Все листы (для маршрутизации), Кейсы, Алерты                                                                             |
| Writes           | Кейсы, Алерты, Решения                                                                                                   |
| Auto-actions     | Открыть кейс, маршрутизировать запрос, записать case_id, отправить информационное сообщение                              |
| Gated-actions    | Нет собственных gated-actions -- делегирует дочерним агентам                                                             |
| SLA              | < 5 сек на маршрутизацию                                                                                                 |
| Cost tier        | medium (sonnet)                                                                                                          |
| Dependencies     | Все 30 остальных скиллов (вызывает по intent)                                                                            |
| Escalates to     | CEO (Telegram) при severity 4-5, невозможности маршрутизации                                                             |
| Success criteria | 95% кейсов корректно маршрутизированы, 100% кейсов залогированы в Sheets                                                 |

---

## 2. pepino-agro-ops

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Ежедневные агрономические операции -- дневной журнал зон, EC/pH/влажность/температура, диагностика, учёт урожайности |
| Class            | Operator + Guardian                                                                                                  |
| Tools            | Google Sheets API, Telegram API                                                                                      |
| Reads            | Производство, Субстрат и расходники, KPI, Алерты                                                                     |
| Writes           | Производство, Алерты, Задачи                                                                                         |
| Auto-actions     | Записать дневной журнал, зафиксировать урожай, создать алерт при отклонении EC/pH, записать batch_id                 |
| Gated-actions    | Смена режима культуры, остановка зоны, внеплановая обработка пестицидами                                             |
| SLA              | < 2 мин на запись дневного журнала                                                                                   |
| Cost tier        | low (haiku)                                                                                                          |
| Dependencies     | pepino-climate-guard, pepino-google-sheets                                                                           |
| Escalates to     | pepino-climate-guard (отклонение параметров), pepino-qa-food-safety (подозрение на болезнь)                          |
| Success criteria | 100% дней с заполненным журналом, <5% отклонений без зафиксированной реакции                                         |

---

## 3. pepino-agro-cucumber-photos

| Field            | Value                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Фото-осмотр и визуальная диагностика огурцов -- протокол съёмки, анализ фотографий, выявление болезней и вредителей |
| Class            | Guardian + Thinker                                                                                                  |
| Tools            | Vision API (мультимодальный анализ фото), Telegram API                                                              |
| Reads            | Производство (данные о зонах), Алерты (история проблем)                                                             |
| Writes           | Алерты (при выявлении проблемы), Задачи (рекомендации по действиям)                                                 |
| Auto-actions     | Выдать протокол фото-съёмки, провести визуальную диагностику, создать алерт при обнаружении болезни                 |
| Gated-actions    | Рекомендация обработки химпрепаратами, решение об удалении растений                                                 |
| SLA              | < 3 мин на диагностику фото                                                                                         |
| Cost tier        | high (opus) -- мультимодальный анализ                                                                               |
| Dependencies     | pepino-agro-ops, pepino-knowledge (СОПы по болезням)                                                                |
| Escalates to     | pepino-agro-ops (оперативные меры), CEO (критическая контаминация)                                                  |
| Success criteria | >90% точность диагностики vs подтверждённые специалистом, <24ч латентность обнаружения проблемы                     |

---

## 4. pepino-ai-treasury

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Governance AI-расходов -- контроль premium-моделей, prompt compression, бенчмарки моделей, провайдерная устойчивость |
| Class            | Thinker                                                                                                              |
| Tools            | OpenClaw API (логи вызовов), Google Sheets API                                                                       |
| Reads            | AI spend logs, вызовы агентов, кэш-метрики                                                                           |
| Writes           | KPI (AI Control Screen метрики), Алерты (превышение бюджета)                                                         |
| Auto-actions     | Логировать spend, рассчитать cost per case, рекомендовать compression, перенаправить на cheaper model (soft-limit)   |
| Gated-actions    | FREEZE режим (только по решению CEO), смена основного провайдера                                                     |
| SLA              | Ежедневный отчёт к 8:00, мгновенный алерт при soft-limit                                                             |
| Cost tier        | low (haiku)                                                                                                          |
| Dependencies     | pepino-google-sheets                                                                                                 |
| Escalates to     | CEO (превышение еженедельного бюджета AI)                                                                            |
| Success criteria | AI spend <15% от операционных расходов, cheap pass rate >60%                                                         |

---

## 5. pepino-argentina-finance

| Field            | Value                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Аргентинский финансовый щит -- FX-мониторинг (Blue/Oficial/MEP/CCL), триггеры арбитража, динамическое ценообразование с поправкой на инфляцию |
| Class            | Thinker + Operator                                                                                                                            |
| Tools            | dolarapi.com, bluelytics.com.ar, pepino-finance-tools, Google Sheets API                                                                      |
| Reads            | Курсы валют, Финансы, Продажи, KPI                                                                                                            |
| Writes           | Курсы валют (обновление курсов), Алерты (FX alert), KPI (маржа реальная)                                                                      |
| Auto-actions     | Обновить курсы в Sheets, создать FX-алерт при спреде >5%, рассчитать реальную маржу                                                           |
| Gated-actions    | Рекомендация конвертации валюты, изменение прайс-листа, ускорение/задержка закупок                                                            |
| SLA              | Курсы обновляются каждые 30 мин, FX-алерт в течение 5 мин                                                                                     |
| Cost tier        | low (haiku)                                                                                                                                   |
| Dependencies     | pepino-finance-tools, pepino-google-sheets                                                                                                    |
| Escalates to     | pepino-profit-engine (пересмотр цен), CEO (экстремальная FX волатильность)                                                                    |
| Success criteria | Реальная маржа не падает ниже целевой из-за задержки реакции на FX                                                                            |

---

## 6. pepino-brand

| Field            | Value                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Purpose          | Бренд и контент -- Instagram посты, контент-план, тексты для шефов, этикетки, WhatsApp скрипты, PR материалы |
| Class            | Operator                                                                                                     |
| Tools            | Telegram API, Google Sheets API                                                                              |
| Reads            | Продажи (для кейсов успеха), Производство (для behind-the-scenes), Клиенты                                   |
| Writes           | Задачи (контент-план), Решения (утверждённый контент)                                                        |
| Auto-actions     | Сгенерировать черновик поста, составить контент-план, подготовить WhatsApp-скрипт, создать описание продукта |
| Gated-actions    | Публикация контента от имени бренда, PR-заявления, этикетки с юридической информацией                        |
| SLA              | Черновик контента < 10 мин, контент-план < 30 мин                                                            |
| Cost tier        | medium (sonnet)                                                                                              |
| Dependencies     | pepino-chef-network (коллаборации), pepino-innovation-lab (сенсорные профили)                                |
| Escalates to     | CEO (финальное одобрение публикации)                                                                         |
| Success criteria | 3 поста/неделю по плану, >5% engagement rate                                                                 |

---

## 7. pepino-capital

| Field            | Value                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Управление капиталом -- привлечение финансирования, CAPEX планирование, fundraising, оценка инвестпроектов, работа с инвесторами |
| Class            | Thinker + Guardian                                                                                                               |
| Tools            | Google Sheets API, pepino-finance-tools (NPV/IRR), NotebookLM MCP                                                                |
| Reads            | Инвестиции, Финансы, KPI, Стратегия                                                                                              |
| Writes           | Инвестиции (проекты CAPEX), Решения (инвестиционные решения)                                                                     |
| Auto-actions     | Рассчитать NPV/IRR/payback, подготовить CAPEX-карточку, сравнить источники финансирования                                        |
| Gated-actions    | Подача заявки на кредит, контакт с инвестором, решения CAPEX >1,500,000 ARS                                                      |
| SLA              | CAPEX-анализ < 1 час, инвестиционная записка < 4 часа                                                                            |
| Cost tier        | medium (sonnet)                                                                                                                  |
| Dependencies     | pepino-financial-modeling, pepino-finance-tools, pepino-legal                                                                    |
| Escalates to     | CEO (решения CAPEX >1.5M ARS), Board (CAPEX >7.5M ARS)                                                                           |
| Success criteria | 100% CAPEX-проектов с NPV/payback перед одобрением                                                                               |

---

## 8. pepino-ceo-coach

| Field            | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose          | Личный коуч CEO -- мотивация, энергия, фокус, привычки, баланс работа/жизнь, рефлексия, антивыгорание |
| Class            | Thinker                                                                                               |
| Tools            | Telegram API (диалоговый)                                                                             |
| Reads            | Задачи (нагрузка CEO), Кейсы (количество решений), KPI                                                |
| Writes           | Нет прямых записей в Sheets                                                                           |
| Auto-actions     | Выдать совет, провести рефлексию, предложить расписание, оценить энергию, напомнить о перерыве        |
| Gated-actions    | Нет (только рекомендательный агент)                                                                   |
| SLA              | Моментальный ответ на запрос                                                                          |
| Cost tier        | medium (sonnet)                                                                                       |
| Dependencies     | pepino-shadow-ceo (контекст нагрузки)                                                                 |
| Escalates to     | Нет -- это финальный адвайзор                                                                         |
| Success criteria | CEO не уходит в burnout, еженедельная рефлексия проводится                                            |

---

## 9. pepino-chef-network

| Field            | Value                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Purpose          | Управление сетью шефов и ресторанов -- реестр контактов, дегустации, сенсорные профили, Chef PR и коллаборации |
| Class            | Operator + Thinker                                                                                             |
| Tools            | Google Sheets API, Telegram API, Firecrawl (парсинг ресторанов)                                                |
| Reads            | Клиенты, Продажи, Досье                                                                                        |
| Writes           | Клиенты (карточки шефов), Задачи (follow-up), Досье (профили)                                                  |
| Auto-actions     | Создать карточку шефа, обновить статус, создать задачу follow-up, подготовить tasting-лист                     |
| Gated-actions    | Отправка приглашения на дегустацию, коммерческие предложения шефам, PR-коллаборации                            |
| SLA              | Карточка шефа < 5 мин, подготовка к дегустации < 30 мин                                                        |
| Cost tier        | low (haiku)                                                                                                    |
| Dependencies     | pepino-sales-crm, pepino-brand, pepino-innovation-lab                                                          |
| Escalates to     | pepino-sales-crm (конвертация в клиента), CEO (tier-1 шефы)                                                    |
| Success criteria | >80% дегустаций с follow-up в течение 48ч, pipeline шефов растёт                                               |

---

## 10. pepino-climate-guard

| Field            | Value                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Purpose          | Мониторинг микроклимата теплицы -- температура, влажность, CO2, PPFD, точка росы, алерты отклонений, корректирующие меры |
| Class            | Guardian                                                                                                                 |
| Tools            | Google Sheets API, сенсоры теплицы (ручные замеры), Telegram API                                                         |
| Reads            | Производство (параметры зон), Алерты (история), KPI                                                                      |
| Writes           | Алерты (WARNING/CRITICAL), Задачи (корректирующие действия)                                                              |
| Auto-actions     | Принять показания, сверить с целевыми, вычислить отклонение, создать алерт, вывести диагноз                              |
| Gated-actions    | Включение/выключение систем HVAC, экстренная эвакуация продукции                                                         |
| SLA              | Экспресс-замер < 30 сек, полный отчёт < 2 мин                                                                            |
| Cost tier        | low (haiku)                                                                                                              |
| Dependencies     | pepino-agro-ops, pepino-greenhouse-tech                                                                                  |
| Escalates to     | CEO (CRITICAL -- T >32C огурцы, RH >92%), pepino-agro-ops (оперативная реакция)                                          |
| Success criteria | 0 инцидентов критичного уровня без алерта, <15 мин время реакции                                                         |

---

## 11. pepino-controller

| Field            | Value                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Финансовый контроллер -- бюджет vs факт, маржинальный контроль, P&L мониторинг, юнит-экономика, алерты при отклонениях |
| Class            | Guardian + Thinker                                                                                                     |
| Tools            | Google Sheets API, pepino-finance-tools                                                                                |
| Reads            | P&L, Финансы, Стратегия (бюджет), KPI                                                                                  |
| Writes           | KPI (отклонения), Алерты (финансовые), Решения (рекомендации)                                                          |
| Auto-actions     | Рассчитать budget vs actual, вывести P&L-отчёт, создать алерт при отклонении >10%, обновить unit economics             |
| Gated-actions    | Рекомендация сокращения расходов, предложение пересмотра бюджета                                                       |
| SLA              | Еженедельный P&L к понедельнику, алерт при >20% отклонении в течение дня                                               |
| Cost tier        | low (haiku)                                                                                                            |
| Dependencies     | pepino-finance-tools, pepino-google-sheets, pepino-argentina-finance                                                   |
| Escalates to     | CEO (CRITICAL: нетто <-500K ARS, маржа <-10pp от плана), pepino-shadow-ceo                                             |
| Success criteria | Все отклонения >10% зафиксированы, weekly P&L всегда актуален                                                          |

---

## 12. pepino-demand-oracle

| Field            | Value                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Прогноз спроса и производственное планирование -- недельный/месячный forecast, план производства, сезонность, балансировка запасов |
| Class            | Thinker                                                                                                                            |
| Tools            | Google Sheets API, API Gateway (GET /sales, /production)                                                                           |
| Reads            | Продажи (4+ недель истории), Производство, Склад, KPI, Клиенты (pipeline)                                                          |
| Writes           | KPI (прогнозные метрики), Задачи (производственный план)                                                                           |
| Auto-actions     | Рассчитать прогноз спроса с сезонным коэффициентом, вывести производственный план, определить over/under supply                    |
| Gated-actions    | Решение о посадке новых партий, изменение объёмов производства                                                                     |
| SLA              | Прогноз < 5 мин, производственный план < 15 мин                                                                                    |
| Cost tier        | medium (sonnet)                                                                                                                    |
| Dependencies     | pepino-sales-crm, pepino-agro-ops, pepino-google-sheets                                                                            |
| Escalates to     | pepino-agro-ops (план посадок), CEO (стратегический pivot по ассортименту)                                                         |
| Success criteria | Прогноз спроса отклоняется от факта <20%, 0 случаев stockout                                                                       |

---

## 13. pepino-fermentation

| Field            | Value                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Purpose          | Управление ферментацией -- партии кимчи/соусов/лакто, контроль pH/соли/температуры, трассировка батчей, waste-to-value |
| Class            | Operator + Guardian                                                                                                    |
| Tools            | Google Sheets API, Telegram API                                                                                        |
| Reads            | Производство (сырьё), Склад (остатки), Субстрат и расходники                                                           |
| Writes           | Производство (батчи ферментации), Алерты (отклонение pH/температуры), Задачи                                           |
| Auto-actions     | Создать батч, записать замеры pH/соли/температуры, перевести статус батча, создать алерт при отклонении                |
| Gated-actions    | Выпуск партии (release) -- только через pepino-qa-food-safety с одобрением CEO                                         |
| SLA              | Запись батча < 2 мин, алерт при отклонении < 5 мин                                                                     |
| Cost tier        | low (haiku)                                                                                                            |
| Dependencies     | pepino-qa-food-safety, pepino-agro-ops, pepino-google-sheets                                                           |
| Escalates to     | pepino-qa-food-safety (проблема качества), CEO (выпуск партии)                                                         |
| Success criteria | 100% батчей с полной трассировкой, 0 партий выпущены без QA-проверки                                                   |

---

## 14. pepino-finance-tools

| Field            | Value                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Purpose          | Финансовые инструменты -- курсы ARS/USD в реальном времени, юнит-экономика, NPV, маржа, точка безубыточности |
| Class            | Thinker                                                                                                      |
| Tools            | dolarapi.com API, Node.js CLI (finance.js), Google Sheets API                                                |
| Reads            | Курсы валют, P&L, Продажи                                                                                    |
| Writes           | Нет прямых записей (инструментальный агент)                                                                  |
| Auto-actions     | Получить курсы, рассчитать конвертацию, вычислить NPV/ROI/break-even, построить unit economics               |
| Gated-actions    | Нет (чистый калькулятор)                                                                                     |
| SLA              | Курсы < 2 сек, расчёт < 5 сек                                                                                |
| Cost tier        | low (haiku)                                                                                                  |
| Dependencies     | Нет (базовый инструмент)                                                                                     |
| Escalates to     | Нет -- вызывается другими агентами                                                                           |
| Success criteria | Курсы актуальны (кэш <30 мин), расчёты корректны                                                             |

---

## 15. pepino-financial-modeling

| Field            | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Purpose          | Финансовое моделирование -- сценарный P&L (base/bull/bear), 12-месячный прогноз, break-even, DCF, годовой бюджет |
| Class            | Thinker                                                                                                          |
| Tools            | Google Sheets API, pepino-finance-tools                                                                          |
| Reads            | Финансы, Стратегия (бюджет), KPI, Производство, Продажи                                                          |
| Writes           | Стратегия (сценарии), KPI (прогнозные)                                                                           |
| Auto-actions     | Построить сценарный P&L, рассчитать runway, вывести 12-месячную проекцию, инфляционная корректировка             |
| Gated-actions    | Утверждение годового бюджета, стратегические решения на основе модели                                            |
| SLA              | Сценарный анализ < 15 мин, годовой бюджет < 2 часа                                                               |
| Cost tier        | medium (sonnet)                                                                                                  |
| Dependencies     | pepino-finance-tools, pepino-argentina-finance, pepino-controller                                                |
| Escalates to     | CEO (сценарии с отрицательным runway), pepino-capital (потребность в финансировании)                             |
| Success criteria | Прогноз vs факт отклонение <15% через 3 месяца, все решения основаны на модели                                   |

---

## 16. pepino-google-sheets

| Field            | Value                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Purpose          | Инфраструктурный слой I/O -- запись, чтение, append и clear данных в центральной Google Sheets таблице (18 листов) |
| Class            | Infrastructure                                                                                                     |
| Tools            | Google Sheets API (сервисный аккаунт), sheets.js, sheets-api.js                                                    |
| Reads            | Все 18 листов (read/get)                                                                                           |
| Writes           | Все 18 листов (append/write/clear)                                                                                 |
| Auto-actions     | Любая операция чтения/записи по запросу агента-вызывателя                                                          |
| Gated-actions    | Массовое удаление (clearSheet) -- только с явным подтверждением                                                    |
| SLA              | < 1 сек на операцию                                                                                                |
| Cost tier        | low (haiku) -- минимальная LLM-нагрузка, в основном API                                                            |
| Dependencies     | Нет (базовая инфраструктура)                                                                                       |
| Escalates to     | Нет -- сервисный слой                                                                                              |
| Success criteria | 99.9% uptime API, 0 потерянных записей                                                                             |

---

## 17. pepino-greenhouse-tech

| Field            | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Purpose          | Инженерные расчёты теплицы -- освещение PPFD/DLI, HVAC/CO2, ирригация, энергоаудит, подбор оборудования |
| Class            | Thinker                                                                                                 |
| Tools            | Формулы расчётов (встроенные), Google Sheets API                                                        |
| Reads            | Производство (текущие параметры), KPI, Субстрат и расходники                                            |
| Writes           | Задачи (рекомендации по оборудованию), Инвестиции (ROI замены оборудования)                             |
| Auto-actions     | Рассчитать PPFD/DLI, теплопотери, расход воды/электричества, ROI замены ламп                            |
| Gated-actions    | Заказ нового оборудования, изменение системы ирригации                                                  |
| SLA              | Расчёт < 5 мин, полный энергоаудит < 1 час                                                              |
| Cost tier        | low (haiku)                                                                                             |
| Dependencies     | pepino-climate-guard, pepino-capital (для CAPEX)                                                        |
| Escalates to     | pepino-capital (закупка оборудования), CEO (решения по модернизации)                                    |
| Success criteria | Расчёты соответствуют физике, ROI-прогнозы подтверждаются практикой                                     |

---

## 18. pepino-innovation-lab

| Field            | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Purpose          | Лаборатория инноваций -- High-Margin R&D, Waste-to-Value, сенсорные профили, новые SKU, путь от пилота к продажам |
| Class            | Operator + Thinker                                                                                                |
| Tools            | Google Sheets API, NotebookLM MCP, Telegram API                                                                   |
| Reads            | Производство (избытки), Продажи (спрос), Склад (остатки), Клиенты                                                 |
| Writes           | Производство (pilot batch), Задачи (R&D кейсы), KPI (маржа нового SKU)                                            |
| Auto-actions     | Открыть R&D кейс, рассчитать waste-to-value ROI, составить сенсорный профиль, предложить pilot batch              |
| Gated-actions    | Запуск commercial batch, выделение площади под новый SKU, бюджет R&D >100K ARS                                    |
| SLA              | R&D кейс < 30 мин, waste-to-value предложение < 15 мин                                                            |
| Cost tier        | medium (sonnet)                                                                                                   |
| Dependencies     | pepino-fermentation, pepino-chef-network, pepino-product-manager, pepino-profit-engine                            |
| Escalates to     | pepino-product-manager (commercialization gate), CEO (бюджет R&D)                                                 |
| Success criteria | >1 новый SKU в квартал, waste-to-value >30% использования отходов                                                 |

---

## 19. pepino-knowledge

| Field            | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Purpose          | Институциональная память -- СОПы, уроки, архив решений, Obsidian vault, knowledge search, захват знаний |
| Class            | Infrastructure                                                                                          |
| Tools            | Google Sheets API, Obsidian vault (файловая система), NotebookLM MCP                                    |
| Reads            | Решения, Задачи, все листы (для контекста), Obsidian vault                                              |
| Writes           | Obsidian vault (СОПы, мемо), Решения (фиксация), Задачи (знаниевые задачи)                              |
| Auto-actions     | Найти СОП по запросу, сохранить урок в vault, обновить версию регламента, поиск по базе                 |
| Gated-actions    | Удаление/supersede критического СОПа, публикация внешних инструкций                                     |
| SLA              | Поиск < 5 сек, создание СОПа < 15 мин                                                                   |
| Cost tier        | low (haiku)                                                                                             |
| Dependencies     | pepino-google-sheets                                                                                    |
| Escalates to     | Нет -- сервисный слой знаний                                                                            |
| Success criteria | Каждый повторяющийся процесс задокументирован, 0 случаев "мы забыли как это делать"                     |

---

## 20. pepino-legal

| Field            | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Purpose          | Юридическое сопровождение -- договоры, SENASA/ANMAT, compliance, трудовое право, лейблинг, регуляторика          |
| Class            | Guardian                                                                                                         |
| Tools            | Google Sheets API, NotebookLM MCP (регуляторный notebook)                                                        |
| Reads            | Клиенты (контрагенты), Закупки (договоры), P&L (суммы контрактов)                                                |
| Writes           | Задачи (юридические), Алерты (истечение договоров), Решения (юридические заключения)                             |
| Auto-actions     | Создать карточку договора, алерт за 30/7 дней до истечения, проверить compliance чеклист, подготовить шаблон NDA |
| Gated-actions    | Подписание любого договора, юридические претензии, контакт с регулятором, решения >500K ARS                      |
| SLA              | Алерт истечения -- автоматический, драфт договора < 2 часа                                                       |
| Cost tier        | medium (sonnet)                                                                                                  |
| Dependencies     | pepino-google-sheets, pepino-knowledge (шаблоны)                                                                 |
| Escalates to     | CEO (все подписания), внешний юрист (сложные вопросы, суд)                                                       |
| Success criteria | 0 просроченных договоров без алерта, 100% compliance с SENASA                                                    |

---

## 21. pepino-maps-tools

| Field            | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Purpose          | Инструменты карт и парсинга -- маршруты доставки, расход топлива, геокодирование, поиск рядом, веб-скрапинг |
| Class            | Thinker                                                                                                     |
| Tools            | OpenStreetMap/OSRM (maps.js), Firecrawl (scrape.js), Overpass API                                           |
| Reads            | Клиенты (адреса), Закупки (адреса поставщиков)                                                              |
| Writes           | Нет прямых записей (инструментальный агент)                                                                 |
| Auto-actions     | Построить маршрут, рассчитать расход топлива, геокодировать адрес, спарсить сайт                            |
| Gated-actions    | Нет (чистый инструмент)                                                                                     |
| SLA              | Маршрут < 5 сек, парсинг < 30 сек                                                                           |
| Cost tier        | low (haiku)                                                                                                 |
| Dependencies     | Нет (базовый инструмент)                                                                                    |
| Escalates to     | Нет -- вызывается другими агентами                                                                          |
| Success criteria | Маршруты корректны, парсинг возвращает структурированные данные                                             |

---

## 22. pepino-procurement

| Field            | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Purpose          | Закупки и поставщики -- реестр поставщиков, заказы материалов, SLA, риск концентрации, сравнение цен      |
| Class            | Operator + Guardian                                                                                       |
| Tools            | Google Sheets API, Firecrawl (поиск поставщиков), Telegram API                                            |
| Reads            | Закупки, Субстрат и расходники, Склад, Курсы валют                                                        |
| Writes           | Закупки (заказы), Алерты (SLA нарушения, концентрация), Задачи (follow-up)                                |
| Auto-actions     | Обновить карточку поставщика, создать заказ на материал, алерт при концентрации >50%, отследить lead time |
| Gated-actions    | Смена поставщика, заказ >250K ARS, новый поставщик без due diligence, оплата в USD                        |
| SLA              | Заказ < 5 мин, поиск альтернативного поставщика < 1 час                                                   |
| Cost tier        | low (haiku)                                                                                               |
| Dependencies     | pepino-finance-tools (конвертация), pepino-legal (договоры), pepino-maps-tools (логистика)                |
| Escalates to     | CEO (крупные заказы >250K ARS), pepino-risk (концентрация поставщиков)                                    |
| Success criteria | 0 простоев из-за отсутствия материалов, lead time в рамках SLA                                            |

---

## 23. pepino-product-manager

| Field            | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Purpose          | Управление жизненным циклом продуктов -- портфельный анализ, запуск SKU, roadmap, GTM, ценовая эластичность |
| Class            | Thinker                                                                                                     |
| Tools            | API Gateway (/products, /sales, /production, /kpi), Google Sheets API                                       |
| Reads            | Производство, Продажи, KPI, Склад, Клиенты                                                                  |
| Writes           | KPI (продуктовые метрики), Задачи (roadmap), Стратегия (портфельные решения)                                |
| Auto-actions     | Построить Product Health Matrix, определить lifecycle stage, рассчитать cannibalization risk                |
| Gated-actions    | Решение kill/launch SKU, изменение product mix, утверждение roadmap                                         |
| SLA              | Портфельный дашборд < 10 мин, GTM-план < 2 часа                                                             |
| Cost tier        | medium (sonnet)                                                                                             |
| Dependencies     | pepino-profit-engine, pepino-sales-crm, pepino-demand-oracle                                                |
| Escalates to     | CEO (kill/launch решения), pepino-innovation-lab (новые SKU)                                                |
| Success criteria | Product health matrix обновляется еженедельно, 0 "zombie" SKU без решения >30 дней                          |

---

## 24. pepino-profit-engine

| Field            | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Purpose          | Управление рентабельностью -- маржа/м2, Winner/Watch/Loser классификация, Kill/Iterate/Scale эксперименты |
| Class            | Thinker + Guardian                                                                                        |
| Tools            | API Gateway (/products, /sales, /production, /expenses, /pnl), Google Sheets API                          |
| Reads            | Продажи, Производство, P&L, KPI, Расходы                                                                  |
| Writes           | KPI (маржинальные метрики), Алерты (Loser-продукты), Задачи (эксперименты)                                |
| Auto-actions     | Рассчитать profit/m2, классифицировать продукты, создать алерт на Loser, трекинг экспериментов            |
| Gated-actions    | Рекомендация изменения цены (L2), решение Kill продукта, масштабирование SKU                              |
| SLA              | Дашборд рентабельности < 10 мин, еженедельный отчёт                                                       |
| Cost tier        | medium (sonnet)                                                                                           |
| Dependencies     | pepino-finance-tools, pepino-argentina-finance, pepino-sales-crm                                          |
| Escalates to     | CEO (Kill/Scale решения), pepino-product-manager (lifecycle implications)                                 |
| Success criteria | Портфель маржинален >40% в целом, 0 Loser-продуктов без action plan >2 недель                             |

---

## 25. pepino-qa-food-safety

| Field            | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Purpose          | QA и пищевая безопасность -- управление партиями, HACCP/CCP, трассировка, hold/release, аудит, инциденты качества |
| Class            | Guardian                                                                                                          |
| Tools            | Google Sheets API, Telegram API                                                                                   |
| Reads            | Производство (батчи), Склад (отгрузки), Алерты, Закупки (сырьё)                                                   |
| Writes           | Производство (статус батча), Алерты (QA инциденты), Задачи (корректирующие действия)                              |
| Auto-actions     | Проверить статус партии, поставить на hold при подозрении, провести трассировку, создать аудит-чеклист            |
| Gated-actions    | Выпуск партии (release) -- ТРЕБУЕТ одобрения CEO, отзыв продукции с рынка                                         |
| SLA              | Hold -- немедленно, трассировка < 15 мин, release < 4ч (с одобрением)                                             |
| Cost tier        | low (haiku)                                                                                                       |
| Dependencies     | pepino-agro-ops, pepino-fermentation, pepino-google-sheets                                                        |
| Escalates to     | CEO (release решения, отзыв продукции), pepino-legal (инциденты с клиентами)                                      |
| Success criteria | 100% партий проходят QA перед отгрузкой, 0 инцидентов пищевой безопасности                                        |

---

## 26. pepino-realtor

| Field            | Value                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Purpose          | Поиск земли для расширения -- парсинг ZonaProp/Argenprop/ML, оценка по 40+ критериям, скоринг лотов |
| Class            | Thinker                                                                                             |
| Tools            | Firecrawl (парсинг), Google Sheets API, pepino-maps-tools                                           |
| Reads            | Недвижимость (история просмотров), Инвестиции (бюджет)                                              |
| Writes           | Недвижимость (карточки лотов, скоринг), Задачи (запланировать визит)                                |
| Auto-actions     | Спарсить площадки, рассчитать скоринг, создать карточку лота, построить маршрут до CABA             |
| Gated-actions    | Запланировать визит (через CEO), подать оффер, юридическая проверка                                 |
| SLA              | Парсинг + скоринг < 30 мин, полный отчёт по лоту < 1 час                                            |
| Cost tier        | medium (sonnet)                                                                                     |
| Dependencies     | pepino-maps-tools, pepino-legal, pepino-capital                                                     |
| Escalates to     | CEO (визит, оффер), pepino-legal (проверка документов)                                              |
| Success criteria | Все лоты >70 баллов просмотрены CEO, pipeline площадок актуален                                     |

---

## 27. pepino-risk

| Field            | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose          | Управление рисками -- реестр рисков, мониторинг EWI, митигация, кризисные сценарии, contingency plans |
| Class            | Guardian + Thinker                                                                                    |
| Tools            | Google Sheets API, NotebookLM MCP                                                                     |
| Reads            | Все листы (агрономические, финансовые, операционные данные), Алерты                                   |
| Writes           | Алерты (risk alerts), Задачи (митигации), Решения (кризисные)                                         |
| Auto-actions     | Обновить реестр рисков, рассчитать вероятность/импакт, мониторить EWI, создать алерт при триггере     |
| Gated-actions    | Активация contingency plan, стратегические решения по рискам                                          |
| SLA              | EWI-алерт -- в течение 1 часа, кризисный сценарий < 30 мин                                            |
| Cost tier        | medium (sonnet)                                                                                       |
| Dependencies     | pepino-controller, pepino-argentina-finance, pepino-agro-ops, pepino-procurement                      |
| Escalates to     | CEO (кризисные решения), pepino-shadow-ceo (комплексные риски)                                        |
| Success criteria | Реестр рисков актуален, 0 "чёрных лебедей" без contingency plan                                       |

---

## 28. pepino-sales-crm

| Field            | Value                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Purpose          | B2B продажи -- pipeline ресторанов/шефов, КП, ценообразование, retention, churn alerts                                       |
| Class            | Operator                                                                                                                     |
| Tools            | Google Sheets API, Telegram API                                                                                              |
| Reads            | Клиенты, Продажи, P&L (выручка vs цель), Задачи                                                                              |
| Writes           | Клиенты (статусы, pipeline), Продажи (заказы), Задачи (follow-up), Алерты (churn risk)                                       |
| Auto-actions     | Обновить pipeline, создать follow-up задачу (>7 дней без контакта), перевести клиента в at_risk (>14 дней), логировать заказ |
| Gated-actions    | Отправка КП, изменение цены для клиента, предоставление скидки, переговоры с tier-1                                          |
| SLA              | Pipeline-обзор < 5 мин, КП < 30 мин                                                                                          |
| Cost tier        | low (haiku)                                                                                                                  |
| Dependencies     | pepino-chef-network, pepino-profit-engine (ценообразование), pepino-google-sheets                                            |
| Escalates to     | CEO (tier-1 клиенты, скидки >10%), pepino-profit-engine (ценовые решения)                                                    |
| Success criteria | Churn rate <10%/мес, pipeline всегда актуален, 100% follow-up в срок                                                         |

---

## 29. pepino-shadow-ceo

| Field            | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Purpose          | Shadow CEO -- decision guardrails, fatigue detection, blocked decisions, operating rhythm, delegation map |
| Class            | Guardian                                                                                                  |
| Tools            | Google Sheets API, Telegram API                                                                           |
| Reads            | Кейсы (количество/скорость решений), Задачи (нагрузка), Алерты (необработанные), KPI                      |
| Writes           | Задачи (напоминания), Решения (blocked decisions review), Алерты (перегрузка CEO)                         |
| Auto-actions     | Детектировать fatigue (>8 решений/день), выявить blocked decisions, предложить operating rhythm           |
| Gated-actions    | Нет (чисто рекомендательный + контрольный)                                                                |
| SLA              | Утренний briefing к 8:00, blocked review каждый понедельник                                               |
| Cost tier        | medium (sonnet)                                                                                           |
| Dependencies     | pepino-weekly-review (данные), pepino-ceo-coach (wellbeing)                                               |
| Escalates to     | CEO (всегда -- это адвайзор CEO)                                                                          |
| Success criteria | CEO принимает <6 решений/день, 0 blocked decisions >5 дней                                                |

---

## 30. pepino-team-ops

| Field            | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Purpose          | Управление командой -- задачи, делегирование, HR, онбординг, расписание, встречи, нагрузка, OKR |
| Class            | Operator + Guardian                                                                             |
| Tools            | Google Sheets API, Telegram API                                                                 |
| Reads            | Задачи, Стратегия (OKR), P&L (зарплаты), HR-данные                                              |
| Writes           | Задачи (назначения), Решения (встречи), HR-данные (карточки сотрудников)                        |
| Auto-actions     | Назначить задачу по нагрузке, создать встречу, обновить статус задачи, рассчитать нагрузку      |
| Gated-actions    | Найм/увольнение, изменение зарплаты, OKR-цели, контракт подрядчика                              |
| SLA              | Назначение задачи < 2 мин, HR-карточка < 10 мин                                                 |
| Cost tier        | low (haiku)                                                                                     |
| Dependencies     | pepino-google-sheets, pepino-shadow-ceo (делегирование CEO)                                     |
| Escalates to     | CEO (найм/увольнение, зарплаты, tier-1 задачи)                                                  |
| Success criteria | <10% просроченных задач, нагрузка распределена равномерно                                       |

---

## 31. pepino-weekly-review

| Field            | Value                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Purpose          | Еженедельный executive review -- агрегация всех операционных данных в единый дайджест с KPI, проблемами и успехами |
| Class            | Infrastructure                                                                                                     |
| Tools            | Google Sheets API (все 18 листов), Telegram API                                                                    |
| Reads            | Все листы (Производство, Финансы, Продажи, Задачи, Алерты, Закупки, Решения, KPI)                                  |
| Writes           | KPI (еженедельные итоги), Решения (фиксация итогов недели)                                                         |
| Auto-actions     | Собрать данные за неделю, рассчитать KPI, определить TOP-3 проблемы/успехи, сформировать дайджест                  |
| Gated-actions    | Нет (отчётный агент)                                                                                               |
| SLA              | Еженедельный дайджест к понедельнику 8:00                                                                          |
| Cost tier        | medium (sonnet)                                                                                                    |
| Dependencies     | pepino-google-sheets (все листы), pepino-controller (P&L данные)                                                   |
| Escalates to     | CEO (финальная доставка дайджеста), pepino-shadow-ceo (blocked items)                                              |
| Success criteria | 100% понедельников с доставленным дайджестом, CEO тратит <15 мин на обзор                                          |

---

## Сводная таблица

| #   | Агент                       | Класс             | Cost tier | SLA         |
| --- | --------------------------- | ----------------- | --------- | ----------- |
| 1   | pepino-dispatcher           | Infrastructure    | medium    | <5 сек      |
| 2   | pepino-agro-ops             | Operator+Guardian | low       | <2 мин      |
| 3   | pepino-agro-cucumber-photos | Guardian+Thinker  | high      | <3 мин      |
| 4   | pepino-ai-treasury          | Thinker           | low       | daily 8:00  |
| 5   | pepino-argentina-finance    | Thinker+Operator  | low       | 30 мин цикл |
| 6   | pepino-brand                | Operator          | medium    | <10 мин     |
| 7   | pepino-capital              | Thinker+Guardian  | medium    | <1 час      |
| 8   | pepino-ceo-coach            | Thinker           | medium    | instant     |
| 9   | pepino-chef-network         | Operator+Thinker  | low       | <5 мин      |
| 10  | pepino-climate-guard        | Guardian          | low       | <30 сек     |
| 11  | pepino-controller           | Guardian+Thinker  | low       | weekly      |
| 12  | pepino-demand-oracle        | Thinker           | medium    | <5 мин      |
| 13  | pepino-fermentation         | Operator+Guardian | low       | <2 мин      |
| 14  | pepino-finance-tools        | Thinker           | low       | <2 сек      |
| 15  | pepino-financial-modeling   | Thinker           | medium    | <15 мин     |
| 16  | pepino-google-sheets        | Infrastructure    | low       | <1 сек      |
| 17  | pepino-greenhouse-tech      | Thinker           | low       | <5 мин      |
| 18  | pepino-innovation-lab       | Operator+Thinker  | medium    | <30 мин     |
| 19  | pepino-knowledge            | Infrastructure    | low       | <5 сек      |
| 20  | pepino-legal                | Guardian          | medium    | <2 часа     |
| 21  | pepino-maps-tools           | Thinker           | low       | <5 сек      |
| 22  | pepino-procurement          | Operator+Guardian | low       | <5 мин      |
| 23  | pepino-product-manager      | Thinker           | medium    | <10 мин     |
| 24  | pepino-profit-engine        | Thinker+Guardian  | medium    | <10 мин     |
| 25  | pepino-qa-food-safety       | Guardian          | low       | immediate   |
| 26  | pepino-realtor              | Thinker           | medium    | <30 мин     |
| 27  | pepino-risk                 | Guardian+Thinker  | medium    | <1 час      |
| 28  | pepino-sales-crm            | Operator          | low       | <5 мин      |
| 29  | pepino-shadow-ceo           | Guardian          | medium    | daily 8:00  |
| 30  | pepino-team-ops             | Operator+Guardian | low       | <2 мин      |
| 31  | pepino-weekly-review        | Infrastructure    | medium    | weekly Mon  |
