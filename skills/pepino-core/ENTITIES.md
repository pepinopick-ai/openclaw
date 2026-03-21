# Pepino Pick Agent OS v2 -- Canonical Entity Schemas

> **Single source of truth** for ALL business entities.
> Every agent MUST conform to these schemas when creating, reading, or modifying data.
> Last updated: 2026-03-21

---

## Table of Contents

1. [SKU (Product)](#1-sku-product)
2. [Customer](#2-customer)
3. [Supplier](#3-supplier)
4. [CropBatch](#4-cropbatch)
5. [SalesOrder](#5-salesorder)
6. [Expense](#6-expense)
7. [Task](#7-task)
8. [Alert / Incident](#8-alert--incident)
9. [CashEvent](#9-cashevent)
10. [GreenhouseBlock](#10-greenhouseblock)
11. [Decision](#11-decision)

---

## Conventions

- **Required** fields are marked with `*` (asterisk).
- **Optional** fields have no marker.
- All dates use ISO 8601 format: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ssZ`.
- All monetary fields ending in `_ars` are Argentine Pesos; fields ending in `_usd` are US Dollars.
- Enum values are lowercase, separated by `|`.
- Array fields use `[]` suffix.
- `null` is acceptable for optional fields that have no value yet.

---

## 1. SKU (Product)

Represents a product that Pepino Pick grows, processes, or sells.

### Google Sheet

**Sheet:** `Catalogo_SKU` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": [
    "sku_id",
    "name_ru",
    "category",
    "unit",
    "default_price_ars",
    "lifecycle_stage",
    "zone"
  ],
  "properties": {
    "sku_id": {
      "type": "string",
      "pattern": "^[A-Z0-9-]+$",
      "description": "Уникальный идентификатор. Формат: PRODUCT-VARIETY-WEIGHT, например OYSTER-GRIS-500G",
      "examples": ["OYSTER-GRIS-500G", "SHIITAKE-STD-1KG", "MICROGREEN-PEA-100G"]
    },
    "name_ru": {
      "type": "string",
      "description": "Название на русском"
    },
    "name_es": {
      "type": "string",
      "description": "Название на испанском (для клиентов и маркетинга)"
    },
    "category": {
      "type": "string",
      "enum": ["mushroom", "microgreen", "flower", "fermented", "other"]
    },
    "unit": {
      "type": "string",
      "enum": ["kg", "g", "unit", "bunch"]
    },
    "default_price_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Базовая цена продажи в ARS за единицу"
    },
    "cost_per_unit_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Себестоимость за единицу в ARS"
    },
    "margin_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Расчетная маржа в процентах. Вычисляется: (price - cost) / price * 100"
    },
    "lifecycle_stage": {
      "type": "string",
      "enum": ["pilot", "growth", "mature", "sunset", "killed"],
      "description": "Стадия жизненного цикла продукта"
    },
    "zone": {
      "type": "string",
      "enum": ["A", "B", "C"],
      "description": "Основная зона выращивания"
    },
    "substrate_type": {
      "type": "string",
      "description": "Тип субстрата (солома, опилки, зерно и т.д.)"
    },
    "growth_days": {
      "type": "integer",
      "minimum": 1,
      "description": "Типичный цикл роста от инокуляции до первого урожая"
    },
    "bio_efficiency_target": {
      "type": "number",
      "minimum": 0,
      "maximum": 200,
      "description": "Целевая биологическая эффективность (%). Выход грибов / масса сухого субстрата * 100"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `sku_id` must be uppercase alphanumeric with hyphens, unique across catalog.
- `margin_pct` must be 0-100. If `cost_per_unit_ars` and `default_price_ars` are both set, margin is auto-calculated.
- `bio_efficiency_target` realistic range: 50-150 for most mushrooms.
- `lifecycle_stage` transitions: `pilot -> growth -> mature -> sunset -> killed`. No skipping stages except `killed` (can be reached from any stage).

### Relations

- Referenced by: `CropBatch.sku_id`, `SalesOrder.items[].sku_id`, `GreenhouseBlock.current_crop_sku`

### Access Control

| Agent                | READ | WRITE                                                          |
| -------------------- | ---- | -------------------------------------------------------------- |
| pepino-agro-ops      | yes  | yes (zone, substrate_type, growth_days, bio_efficiency_target) |
| pepino-sales-crm     | yes  | yes (default_price_ars, lifecycle_stage)                       |
| pepino-shadow-ceo    | yes  | yes (lifecycle_stage, notes)                                   |
| pepino-procurement   | yes  | no                                                             |
| pepino-dispatcher    | yes  | no                                                             |
| pepino-knowledge     | yes  | no                                                             |
| pepino-profit-engine | yes  | yes (cost_per_unit_ars, margin_pct)                            |
| ALL other agents     | yes  | no                                                             |

---

## 2. Customer

Represents a buyer of Pepino Pick products.

### Google Sheet

**Sheet:** `Clientes` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["customer_id", "name", "type", "tier", "contact_phone", "delivery_zone"],
  "properties": {
    "customer_id": {
      "type": "string",
      "pattern": "^CUST-[0-9]{4}$",
      "description": "Уникальный ID клиента. Формат: CUST-NNNN",
      "examples": ["CUST-0001", "CUST-0042"]
    },
    "name": {
      "type": "string",
      "description": "Название компании или имя физлица"
    },
    "type": {
      "type": "string",
      "enum": ["restaurant", "hotel", "retail", "wholesale", "direct"]
    },
    "tier": {
      "type": "string",
      "enum": ["A", "B", "C", "D"],
      "description": "A = ключевой клиент, B = регулярный, C = нерегулярный, D = разовый"
    },
    "contact_name": {
      "type": "string",
      "description": "Имя контактного лица"
    },
    "contact_phone": {
      "type": "string",
      "description": "Телефон в международном формате +54..."
    },
    "contact_instagram": {
      "type": "string",
      "description": "Instagram handle без @"
    },
    "address": {
      "type": "string"
    },
    "delivery_zone": {
      "type": "string",
      "description": "Зона доставки (Palermo, CABA Norte, GBA Oeste и т.д.)"
    },
    "payment_terms": {
      "type": "string",
      "enum": ["cash", "transfer", "credit_7d", "credit_14d", "credit_30d"],
      "default": "cash"
    },
    "avg_order_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Средний чек в ARS"
    },
    "avg_order_kg": {
      "type": "number",
      "minimum": 0,
      "description": "Средний объем заказа в кг"
    },
    "order_frequency_days": {
      "type": "integer",
      "minimum": 1,
      "description": "Средняя частота заказов в днях"
    },
    "first_order_date": {
      "type": "string",
      "format": "date"
    },
    "last_order_date": {
      "type": "string",
      "format": "date"
    },
    "churn_risk": {
      "type": "string",
      "enum": ["low", "medium", "high", "churned"],
      "description": "Рассчитывается автоматически. churned = нет заказов > 3x order_frequency_days"
    },
    "lifetime_value_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Суммарная выручка с клиента за всё время"
    },
    "profile_path": {
      "type": "string",
      "description": "Путь к файлу досье клиента (Profiler output)"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `customer_id` must match pattern `CUST-NNNN`, auto-increment.
- `contact_phone` should start with `+` and contain only digits after.
- `churn_risk` auto-calculated: `low` if ordered within 1x frequency, `medium` if 1-2x, `high` if 2-3x, `churned` if >3x.
- `tier` reassessed monthly based on `avg_order_ars` and `order_frequency_days`.
- `payment_terms` of `credit_*` requires `tier` A or B.

### Relations

- Referenced by: `SalesOrder.customer_id`, `CashEvent.counterparty`
- References: profile from Profiler system via `profile_path`

### Access Control

| Agent                | READ                                       | WRITE                                               |
| -------------------- | ------------------------------------------ | --------------------------------------------------- |
| pepino-sales-crm     | yes                                        | yes (all fields)                                    |
| pepino-shadow-ceo    | yes                                        | yes (tier, notes)                                   |
| pepino-dispatcher    | yes                                        | no                                                  |
| pepino-profit-engine | yes                                        | yes (avg_order_ars, lifetime_value_ars, churn_risk) |
| pepino-knowledge     | yes                                        | no                                                  |
| ALL other agents     | yes (name, type, tier, delivery_zone only) | no                                                  |

---

## 3. Supplier

Represents a vendor providing inputs, services, or logistics.

### Google Sheet

**Sheet:** `Proveedores` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["supplier_id", "name", "category", "contact_phone", "reliability_score"],
  "properties": {
    "supplier_id": {
      "type": "string",
      "pattern": "^SUP-[0-9]{4}$",
      "description": "Уникальный ID поставщика. Формат: SUP-NNNN",
      "examples": ["SUP-0001", "SUP-0015"]
    },
    "name": {
      "type": "string"
    },
    "category": {
      "type": "string",
      "enum": ["substrate", "seeds", "packaging", "chemicals", "equipment", "logistics", "services"]
    },
    "contact_name": {
      "type": "string"
    },
    "contact_phone": {
      "type": "string"
    },
    "address": {
      "type": "string"
    },
    "payment_terms": {
      "type": "string",
      "description": "Условия оплаты (текст, например: предоплата 50%, остаток при доставке)"
    },
    "reliability_score": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5,
      "description": "1 = ненадежный, 5 = безупречный. Пересматривается ежемесячно"
    },
    "concentration_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Доля расходов на этого поставщика от общих закупок категории. >60% = риск зависимости"
    },
    "last_delivery_date": {
      "type": "string",
      "format": "date"
    },
    "avg_delivery_days": {
      "type": "number",
      "minimum": 0,
      "description": "Среднее время доставки от заказа до получения"
    },
    "monthly_spend_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Средние месячные расходы на этого поставщика"
    },
    "contract_end_date": {
      "type": "string",
      "format": "date",
      "description": "Дата окончания контракта (null если нет контракта)"
    },
    "risk_level": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "low = надежный с альтернативами, high = монопоставщик без замены"
    },
    "alternative_suppliers": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Массив supplier_id альтернативных поставщиков"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `supplier_id` must match `SUP-NNNN`, auto-increment.
- `reliability_score` integer 1-5. Updated after each delivery event.
- `concentration_pct` > 60 triggers a procurement diversification alert.
- `risk_level` auto-calculated: `high` if `concentration_pct` > 60 AND `alternative_suppliers` is empty.
- `contract_end_date` within 30 days triggers renewal reminder.

### Relations

- Referenced by: `Expense.vendor` (by name or supplier_id), `CashEvent.counterparty`
- References: other Suppliers via `alternative_suppliers[]`

### Access Control

| Agent                | READ                                    | WRITE                                      |
| -------------------- | --------------------------------------- | ------------------------------------------ |
| pepino-procurement   | yes                                     | yes (all fields)                           |
| pepino-shadow-ceo    | yes                                     | yes (risk_level, notes)                    |
| pepino-profit-engine | yes                                     | yes (monthly_spend_ars, concentration_pct) |
| pepino-sales-crm     | yes (name, category only)               | no                                         |
| ALL other agents     | yes (name, category, reliability_score) | no                                         |

---

## 4. CropBatch

Represents a single growing cycle -- from inoculation to final harvest or discard.

### Google Sheet

**Sheet:** `Lotes_Produccion` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["batch_id", "sku_id", "zone", "substrate_kg", "inoculation_date", "status"],
  "properties": {
    "batch_id": {
      "type": "string",
      "pattern": "^BATCH-[0-9]{8}-[A-Z0-9]+-[A-Z0-9]+$",
      "description": "Формат: BATCH-YYYYMMDD-SKU_SHORT-ZONE_RACK, например BATCH-20260321-OG-A1",
      "examples": ["BATCH-20260321-OG-A1", "BATCH-20260315-SH-B3"]
    },
    "sku_id": {
      "type": "string",
      "description": "Ссылка на SKU из Catalogo_SKU"
    },
    "zone": {
      "type": "string",
      "enum": ["A", "B", "C"]
    },
    "substrate_kg": {
      "type": "number",
      "minimum": 0,
      "description": "Масса субстрата в кг"
    },
    "inoculation_date": {
      "type": "string",
      "format": "date"
    },
    "primordia_date": {
      "type": "string",
      "format": "date",
      "description": "Дата появления примордий (зачатков плодовых тел)"
    },
    "first_harvest_date": {
      "type": "string",
      "format": "date"
    },
    "last_harvest_date": {
      "type": "string",
      "format": "date"
    },
    "total_yield_kg": {
      "type": "number",
      "minimum": 0,
      "description": "Суммарный урожай в кг"
    },
    "bio_efficiency_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 200,
      "description": "Фактическая биоэффективность. total_yield_kg / substrate_kg_dry * 100"
    },
    "status": {
      "type": "string",
      "enum": [
        "inoculated",
        "colonizing",
        "fruiting",
        "harvesting",
        "completed",
        "contaminated",
        "discarded"
      ]
    },
    "quality_grade": {
      "type": "string",
      "enum": ["A", "B", "C", "rejected"],
      "description": "A = премиум, B = стандарт, C = переработка, rejected = брак"
    },
    "contamination_type": {
      "type": "string",
      "description": "Тип контаминации если обнаружена (trichoderma, cobweb, bacterial и т.д.)"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `batch_id` globally unique, generated at inoculation time.
- `sku_id` must exist in `Catalogo_SKU`.
- Status transitions: `inoculated -> colonizing -> fruiting -> harvesting -> completed`. Terminal states: `completed`, `contaminated`, `discarded`. From `inoculated|colonizing|fruiting` can go to `contaminated` or `discarded`.
- `bio_efficiency_pct` calculated only when `status` is `completed`.
- `primordia_date` must be >= `inoculation_date`.
- `first_harvest_date` must be >= `primordia_date`.
- `last_harvest_date` must be >= `first_harvest_date`.
- `contamination_type` required when `status` is `contaminated`.

### Relations

- References: `SKU.sku_id`, `GreenhouseBlock` (via zone + rack)
- Referenced by: `GreenhouseBlock.current_batch_id`

### Access Control

| Agent                | READ                              | WRITE                                   |
| -------------------- | --------------------------------- | --------------------------------------- |
| pepino-agro-ops      | yes                               | yes (all fields)                        |
| pepino-shadow-ceo    | yes                               | no                                      |
| pepino-sales-crm     | yes (status, total_yield_kg only) | no                                      |
| pepino-profit-engine | yes                               | no                                      |
| climate-guard        | yes                               | yes (status, contamination_type, notes) |
| ALL other agents     | yes (batch_id, sku_id, status)    | no                                      |

---

## 5. SalesOrder

Represents a single sale transaction.

### Google Sheet

**Sheet:** `Pedidos` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": [
    "order_id",
    "date",
    "customer_id",
    "items",
    "total_ars",
    "payment_status",
    "delivery_status",
    "channel"
  ],
  "properties": {
    "order_id": {
      "type": "string",
      "pattern": "^ORD-[0-9]{8}-[0-9]{3}$",
      "description": "Формат: ORD-YYYYMMDD-NNN (порядковый номер дня)",
      "examples": ["ORD-20260321-001", "ORD-20260321-012"]
    },
    "date": {
      "type": "string",
      "format": "date"
    },
    "customer_id": {
      "type": "string",
      "description": "Ссылка на Customer.customer_id"
    },
    "items": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["sku_id", "qty_kg", "price_per_kg", "total_ars"],
        "properties": {
          "sku_id": {
            "type": "string",
            "description": "Ссылка на SKU.sku_id"
          },
          "qty_kg": {
            "type": "number",
            "minimum": 0.01,
            "description": "Количество в кг (или единицах для unit/bunch SKU)"
          },
          "price_per_kg": {
            "type": "number",
            "minimum": 0,
            "description": "Цена за кг/единицу в ARS"
          },
          "total_ars": {
            "type": "number",
            "minimum": 0,
            "description": "qty_kg * price_per_kg"
          }
        }
      }
    },
    "total_ars": {
      "type": "number",
      "minimum": 0,
      "description": "Сумма total_ars всех items"
    },
    "total_usd": {
      "type": "number",
      "minimum": 0,
      "description": "Эквивалент в USD по курсу дня (для аналитики)"
    },
    "payment_method": {
      "type": "string",
      "description": "cash, transfer, card, etc."
    },
    "payment_status": {
      "type": "string",
      "enum": ["pending", "paid", "overdue"]
    },
    "delivery_date": {
      "type": "string",
      "format": "date"
    },
    "delivery_status": {
      "type": "string",
      "enum": ["pending", "in_transit", "delivered", "returned"]
    },
    "channel": {
      "type": "string",
      "enum": ["direct", "instagram", "whatsapp", "telegram", "marketplace"]
    },
    "invoice_number": {
      "type": "string",
      "description": "Номер factura (если выставлен)"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `order_id` must be unique. Sequential counter resets daily.
- `customer_id` must exist in `Clientes`.
- Each `items[].sku_id` must exist in `Catalogo_SKU`.
- `total_ars` must equal sum of `items[].total_ars` (tolerance: 0.01 ARS).
- Each `items[].total_ars` must equal `qty_kg * price_per_kg` (tolerance: 0.01 ARS).
- `payment_status` becomes `overdue` automatically if `pending` for longer than customer's `payment_terms`.
- `delivery_date` must be >= `date`.

### Relations

- References: `Customer.customer_id`, `SKU.sku_id` (in items)
- Referenced by: `CashEvent` (via order_id in reference_doc)

### Access Control

| Agent                | READ                                             | WRITE                                |
| -------------------- | ------------------------------------------------ | ------------------------------------ |
| pepino-sales-crm     | yes                                              | yes (all fields)                     |
| pepino-shadow-ceo    | yes                                              | no                                   |
| pepino-profit-engine | yes                                              | yes (total_usd, payment_status)      |
| pepino-dispatcher    | yes                                              | yes (delivery_status, delivery_date) |
| pepino-agro-ops      | yes (items, date only)                           | no                                   |
| ALL other agents     | yes (order_id, date, total_ars, delivery_status) | no                                   |

---

## 6. Expense

Represents a single expenditure.

### Google Sheet

**Sheet:** `Gastos` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["expense_id", "date", "category", "description", "amount_ars", "payment_method"],
  "properties": {
    "expense_id": {
      "type": "string",
      "pattern": "^EXP-[0-9]{8}-[0-9]{3}$",
      "description": "Формат: EXP-YYYYMMDD-NNN",
      "examples": ["EXP-20260321-001"]
    },
    "date": {
      "type": "string",
      "format": "date"
    },
    "category": {
      "type": "string",
      "enum": [
        "substrate",
        "seeds",
        "packaging",
        "chemicals",
        "equipment",
        "utilities",
        "rent",
        "salary",
        "transport",
        "marketing",
        "legal",
        "ai_costs",
        "other"
      ]
    },
    "description": {
      "type": "string",
      "description": "Краткое описание расхода"
    },
    "amount_ars": {
      "type": "number",
      "minimum": 0
    },
    "amount_usd": {
      "type": "number",
      "minimum": 0,
      "description": "Эквивалент в USD (для расходов, оплаченных в USD)"
    },
    "payment_method": {
      "type": "string",
      "enum": ["cash", "transfer", "card", "crypto"]
    },
    "vendor": {
      "type": "string",
      "description": "Имя поставщика или supplier_id"
    },
    "receipt_url": {
      "type": "string",
      "description": "Ссылка на фото чека/факtuры (Google Drive URL)"
    },
    "approved_by": {
      "type": "string",
      "description": "Кто одобрил расход (roman, agent_name)"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `expense_id` must be unique. Sequential counter resets daily.
- `amount_ars` > 50000 requires `approved_by` to be `roman` (manual approval).
- `category` must match one of the defined enums.
- `vendor` should reference a known `Supplier.name` or `Supplier.supplier_id` when applicable.

### Relations

- References: `Supplier` (via vendor field)
- Referenced by: `CashEvent` (via expense_id in reference_doc)

### Access Control

| Agent                | READ                                           | WRITE                               |
| -------------------- | ---------------------------------------------- | ----------------------------------- |
| pepino-profit-engine | yes                                            | yes (all fields)                    |
| pepino-procurement   | yes                                            | yes (all fields except approved_by) |
| pepino-shadow-ceo    | yes                                            | yes (approved_by, notes)            |
| pepino-sales-crm     | yes (summary only: date, category, amount_ars) | no                                  |
| ALL other agents     | no                                             | no                                  |

---

## 7. Task

Represents a work item tracked by the agent system.

### Google Sheet

**Sheet:** `Tareas` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["task_id", "created_date", "title", "category", "priority", "status"],
  "properties": {
    "task_id": {
      "type": "string",
      "pattern": "^TASK-[0-9]{5}$",
      "description": "Формат: TASK-NNNNN (глобальный инкремент)",
      "examples": ["TASK-00001", "TASK-00142"]
    },
    "created_date": {
      "type": "string",
      "format": "date"
    },
    "title": {
      "type": "string",
      "maxLength": 120
    },
    "description": {
      "type": "string"
    },
    "category": {
      "type": "string",
      "enum": [
        "agronomy",
        "finance",
        "sales",
        "logistics",
        "legal",
        "qa",
        "hr",
        "maintenance",
        "marketing",
        "strategy"
      ]
    },
    "assignee": {
      "type": "string",
      "description": "agent_name или roman"
    },
    "priority": {
      "type": "string",
      "enum": ["P1", "P2", "P3", "P4"],
      "description": "P1 = критический (реакция 1ч), P2 = срочный (24ч), P3 = плановый (неделя), P4 = когда-нибудь"
    },
    "deadline": {
      "type": "string",
      "format": "date"
    },
    "status": {
      "type": "string",
      "enum": [
        "created",
        "triaged",
        "planned",
        "approved",
        "in_progress",
        "blocked",
        "done",
        "verified",
        "archived"
      ]
    },
    "blocked_by": {
      "type": "string",
      "description": "task_id блокирующей задачи"
    },
    "case_id": {
      "type": "string",
      "description": "ID связанного кейса (для группировки задач)"
    },
    "source_agent": {
      "type": "string",
      "description": "Агент, создавший задачу"
    },
    "completed_date": {
      "type": "string",
      "format": "date"
    },
    "verification_notes": {
      "type": "string",
      "description": "Заметки по верификации выполнения"
    }
  }
}
```

### Validation Rules

- `task_id` globally unique, auto-increment.
- Status transitions (see STATE_MACHINE.md for full graph):
  `created -> triaged -> planned -> approved -> in_progress -> done -> verified -> archived`.
  From any active state can go to `blocked`. From `blocked` returns to previous state.
- `deadline` required for P1 and P2 tasks.
- `blocked_by` must reference a valid `task_id` when `status` is `blocked`.
- `completed_date` auto-set when `status` transitions to `done`.
- P1 tasks without status change in 1 hour trigger escalation alert.

### Relations

- Self-referencing: `blocked_by` -> `Task.task_id`
- Referenced by: `Alert.linked_case_id`, `Decision.linked_cases[]`

### Access Control

| Agent                | READ            | WRITE                                   |
| -------------------- | --------------- | --------------------------------------- |
| pepino-dispatcher    | yes             | yes (all fields)                        |
| pepino-shadow-ceo    | yes             | yes (priority, status, assignee, notes) |
| pepino-agro-ops      | yes             | yes (own tasks: status, notes)          |
| pepino-sales-crm     | yes             | yes (own tasks: status, notes)          |
| pepino-procurement   | yes             | yes (own tasks: status, notes)          |
| pepino-profit-engine | yes             | yes (own tasks: status, notes)          |
| ALL other agents     | yes (own tasks) | yes (own tasks: status only)            |

---

## 8. Alert / Incident

Represents an anomaly, emergency, or event requiring attention.

### Google Sheet

**Sheet:** `Alertas` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["alert_id", "date", "type", "source", "description", "severity", "status"],
  "properties": {
    "alert_id": {
      "type": "string",
      "pattern": "^ALERT-[0-9]{8}-[0-9]{3}$",
      "description": "Формат: ALERT-YYYYMMDD-NNN",
      "examples": ["ALERT-20260321-001"]
    },
    "date": {
      "type": "string",
      "format": "date-time",
      "description": "Время возникновения (ISO 8601 с таймзоной)"
    },
    "type": {
      "type": "string",
      "enum": [
        "disease",
        "equipment",
        "quality",
        "financial",
        "climate",
        "compliance",
        "security",
        "supplier"
      ]
    },
    "source": {
      "type": "string",
      "enum": ["sensor", "manual", "agent", "cron"],
      "description": "Источник алерта"
    },
    "zone": {
      "type": "string",
      "enum": ["A", "B", "C"],
      "description": "Зона теплицы (если применимо)"
    },
    "description": {
      "type": "string"
    },
    "severity": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5,
      "description": "1 = информационный, 2 = внимание, 3 = предупреждение, 4 = критический, 5 = аварийный"
    },
    "status": {
      "type": "string",
      "enum": ["open", "acknowledged", "investigating", "mitigating", "resolved", "false_alarm"]
    },
    "assignee": {
      "type": "string"
    },
    "response_deadline": {
      "type": "string",
      "format": "date-time",
      "description": "Дедлайн реакции. Автоматически: sev1-2=1ч, sev3=4ч, sev4=24ч, sev5=немедленно"
    },
    "resolution_notes": {
      "type": "string"
    },
    "linked_case_id": {
      "type": "string",
      "description": "ID связанного case/task"
    },
    "escalated_to": {
      "type": "string",
      "description": "Кому эскалирован (roman, external_expert и т.д.)"
    }
  }
}
```

### Validation Rules

- `alert_id` unique per day, sequential.
- `severity` 4-5 auto-escalates to `roman` via Telegram notification.
- `severity` 5 requires `response_deadline` within 15 minutes.
- Status transitions: `open -> acknowledged -> investigating -> mitigating -> resolved`. Can go to `false_alarm` from `open|acknowledged|investigating`.
- `resolution_notes` required when `status` transitions to `resolved` or `false_alarm`.
- Unacknowledged alerts with `severity` >= 3 re-notify every 30 minutes.

### Relations

- References: `Task` (via linked_case_id), `GreenhouseBlock` (via zone)
- Referenced by: `Decision.linked_cases[]`

### Access Control

| Agent                | READ | WRITE                                          |
| -------------------- | ---- | ---------------------------------------------- |
| pepino-dispatcher    | yes  | yes (all fields)                               |
| pepino-shadow-ceo    | yes  | yes (status, assignee, escalated_to)           |
| pepino-agro-ops      | yes  | yes (type=disease/climate/quality: all fields) |
| climate-guard        | yes  | yes (type=climate: create and update)          |
| pepino-profit-engine | yes  | yes (type=financial: create and update)        |
| pepino-procurement   | yes  | yes (type=supplier: create and update)         |
| ALL other agents     | yes  | no                                             |

---

## 9. CashEvent

Represents a single cash flow event (money in or out).

### Google Sheet

**Sheet:** `Flujo_Caja` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["event_id", "date", "type", "amount_ars", "category", "payment_method"],
  "properties": {
    "event_id": {
      "type": "string",
      "pattern": "^CF-[0-9]{8}-[0-9]{3}$",
      "description": "Формат: CF-YYYYMMDD-NNN",
      "examples": ["CF-20260321-001"]
    },
    "date": {
      "type": "string",
      "format": "date"
    },
    "type": {
      "type": "string",
      "enum": ["income", "expense", "investment", "loan", "refund"]
    },
    "amount_ars": {
      "type": "number",
      "description": "Сумма в ARS. Положительное для всех типов (direction определяется type)"
    },
    "amount_usd": {
      "type": "number",
      "minimum": 0,
      "description": "Эквивалент в USD"
    },
    "fx_rate": {
      "type": "number",
      "minimum": 0,
      "description": "Курс ARS/USD на момент операции"
    },
    "counterparty": {
      "type": "string",
      "description": "customer_id, supplier_id, или текст (для прочих)"
    },
    "category": {
      "type": "string",
      "description": "Категория: для income -- канал продаж; для expense -- категория расхода"
    },
    "payment_method": {
      "type": "string",
      "enum": ["cash", "transfer", "card", "crypto"]
    },
    "reference_doc": {
      "type": "string",
      "description": "ID связанного документа (order_id, expense_id, invoice_number)"
    },
    "reconciled": {
      "type": "boolean",
      "default": false,
      "description": "Сверено с банковской выпиской"
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `event_id` unique per day, sequential.
- `amount_ars` must be > 0.
- `type` determines cash flow direction: `income|refund` = inflow, `expense|investment|loan` = outflow.
- If `amount_usd` is set, `fx_rate` must also be set (and vice versa).
- `reconciled` should be flipped to `true` only during monthly reconciliation process.
- `reference_doc` should link to source document whenever possible.

### Relations

- References: `Customer.customer_id`, `Supplier.supplier_id` (via counterparty), `SalesOrder.order_id`, `Expense.expense_id` (via reference_doc)

### Access Control

| Agent                | READ                    | WRITE                      |
| -------------------- | ----------------------- | -------------------------- |
| pepino-profit-engine | yes                     | yes (all fields)           |
| pepino-shadow-ceo    | yes                     | yes (reconciled, notes)    |
| pepino-sales-crm     | yes (type=income only)  | yes (create income events) |
| pepino-procurement   | yes (type=expense only) | no                         |
| ALL other agents     | no                      | no                         |

---

## 10. GreenhouseBlock

Represents a physical growing space in the greenhouse.

### Google Sheet

**Sheet:** `Infraestructura` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": ["block_id", "zone", "rack_number", "capacity_blocks", "equipment_status"],
  "properties": {
    "block_id": {
      "type": "string",
      "pattern": "^ZONE-[A-C]-RACK-[0-9]+$",
      "description": "Формат: ZONE-X-RACK-N",
      "examples": ["ZONE-A-RACK-1", "ZONE-B-RACK-12"]
    },
    "zone": {
      "type": "string",
      "enum": ["A", "B", "C"]
    },
    "rack_number": {
      "type": "integer",
      "minimum": 1
    },
    "capacity_blocks": {
      "type": "integer",
      "minimum": 1,
      "description": "Максимальное количество блоков субстрата на этом стеллаже"
    },
    "current_occupancy": {
      "type": "integer",
      "minimum": 0,
      "description": "Текущее количество занятых позиций"
    },
    "current_crop_sku": {
      "type": "string",
      "description": "SKU текущей культуры (null если пусто)"
    },
    "current_batch_id": {
      "type": "string",
      "description": "ID текущего batch (null если пусто)"
    },
    "temp_target_c": {
      "type": "number",
      "description": "Целевая температура в градусах Цельсия"
    },
    "humidity_target_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100,
      "description": "Целевая влажность в %"
    },
    "co2_target_ppm": {
      "type": "number",
      "minimum": 0,
      "description": "Целевой уровень CO2 в ppm"
    },
    "light_schedule": {
      "type": "string",
      "description": "Расписание освещения, например 12/12 или 16/8 (часы свет/темнота)"
    },
    "last_maintenance_date": {
      "type": "string",
      "format": "date"
    },
    "equipment_status": {
      "type": "string",
      "enum": ["operational", "maintenance", "offline"]
    },
    "notes": {
      "type": "string"
    }
  }
}
```

### Validation Rules

- `block_id` must be unique, derived from `zone` and `rack_number`.
- `current_occupancy` must be <= `capacity_blocks`.
- `current_crop_sku` must reference a valid `SKU.sku_id` if set.
- `current_batch_id` must reference a valid `CropBatch.batch_id` if set.
- `temp_target_c` typical range: 10-30 for mushrooms. Outside this range triggers alert.
- `humidity_target_pct` typical range: 60-95 for mushrooms.
- `co2_target_ppm` typical range: 400-2000. Fruiting usually needs < 800 ppm.
- `equipment_status` = `offline` for > 24h triggers P1 alert.

### Relations

- References: `SKU.sku_id` (via current_crop_sku), `CropBatch.batch_id` (via current_batch_id)
- Referenced by: `Alert` (via zone), `CropBatch` (logical link via zone)

### Access Control

| Agent             | READ                                    | WRITE                                                                      |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| pepino-agro-ops   | yes                                     | yes (all fields)                                                           |
| climate-guard     | yes                                     | yes (temp_target_c, humidity_target_pct, co2_target_ppm, equipment_status) |
| pepino-shadow-ceo | yes                                     | no                                                                         |
| pepino-dispatcher | yes (block_id, zone, equipment_status)  | no                                                                         |
| ALL other agents  | yes (block_id, zone, current_occupancy) | no                                                                         |

---

## 11. Decision

Represents a business decision logged for traceability and review.

### Google Sheet

**Sheet:** `Decisiones` (tab in main Pepino Spreadsheet)

### JSON Schema

```json
{
  "type": "object",
  "required": [
    "decision_id",
    "date",
    "title",
    "domain",
    "decided_by",
    "rationale",
    "approval_tier",
    "status"
  ],
  "properties": {
    "decision_id": {
      "type": "string",
      "pattern": "^DEC-[0-9]{5}$",
      "description": "Формат: DEC-NNNNN (глобальный инкремент)",
      "examples": ["DEC-00001", "DEC-00023"]
    },
    "date": {
      "type": "string",
      "format": "date"
    },
    "title": {
      "type": "string",
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "description": "Подробное описание решения и контекста"
    },
    "domain": {
      "type": "string",
      "enum": ["strategy", "finance", "product", "operations", "hr", "legal", "marketing"]
    },
    "decided_by": {
      "type": "string",
      "description": "Кто принял решение (roman, pepino-shadow-ceo, комитет)"
    },
    "rationale": {
      "type": "string",
      "description": "Обоснование решения"
    },
    "alternatives_considered": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Какие альтернативы рассматривались"
    },
    "impact_assessment": {
      "type": "string",
      "description": "Оценка влияния на бизнес"
    },
    "risk_level": {
      "type": "string",
      "enum": ["low", "medium", "high"]
    },
    "approval_tier": {
      "type": "integer",
      "minimum": 1,
      "maximum": 3,
      "description": "1 = агент автономно, 2 = Shadow CEO, 3 = только Roman"
    },
    "status": {
      "type": "string",
      "enum": ["proposed", "approved", "rejected", "executed", "reviewed"]
    },
    "review_date": {
      "type": "string",
      "format": "date",
      "description": "Дата ревью результатов решения"
    },
    "outcome_notes": {
      "type": "string",
      "description": "Что получилось по факту (заполняется при ревью)"
    },
    "linked_cases": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Связанные task_id, alert_id, order_id"
    }
  }
}
```

### Validation Rules

- `decision_id` globally unique, auto-increment.
- `approval_tier` determines who can set `status` to `approved`:
  - Tier 1: any authorized agent.
  - Tier 2: only `pepino-shadow-ceo` or `roman`.
  - Tier 3: only `roman`.
- `risk_level` = `high` forces `approval_tier` >= 2.
- Financial decisions with `amount` equivalent > 100,000 ARS force `approval_tier` = 3.
- `review_date` auto-set to `date` + 30 days if not specified.
- `status` transitions: `proposed -> approved -> executed -> reviewed`. From `proposed` can go to `rejected`. No transition from `rejected`.
- `alternatives_considered` recommended for tier 2 and required for tier 3.
- `outcome_notes` required when `status` transitions to `reviewed`.

### Relations

- References: `Task`, `Alert`, `SalesOrder` (via linked_cases[])
- Referenced by: none (terminal entity in the graph)

### Access Control

| Agent                | READ                                     | WRITE                                                       |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| pepino-shadow-ceo    | yes                                      | yes (all fields)                                            |
| pepino-dispatcher    | yes                                      | yes (create proposed, update status to approved for tier 1) |
| pepino-profit-engine | yes                                      | yes (create proposed for domain=finance)                    |
| pepino-agro-ops      | yes                                      | yes (create proposed for domain=operations/product)         |
| pepino-sales-crm     | yes                                      | yes (create proposed for domain=marketing)                  |
| ALL other agents     | yes (decision_id, title, status, domain) | no                                                          |

---

## Entity Relationship Summary

```
SKU <------ CropBatch ------> GreenhouseBlock
 |              |
 |              v
 |          (yield data)
 |
 +-------> SalesOrder.items[]
                |
                v
            Customer ----------> CashEvent (income)
                                     ^
                                     |
Supplier -------> Expense -------> CashEvent (expense)

Task <------> Alert/Incident
  |               |
  +-------+-------+
          |
          v
       Decision
```

## Sheet Tab Summary

| Entity          | Sheet Tab          | ID Pattern                     |
| --------------- | ------------------ | ------------------------------ |
| SKU             | `Catalogo_SKU`     | `OYSTER-GRIS-500G` (free-form) |
| Customer        | `Clientes`         | `CUST-NNNN`                    |
| Supplier        | `Proveedores`      | `SUP-NNNN`                     |
| CropBatch       | `Lotes_Produccion` | `BATCH-YYYYMMDD-XX-YY`         |
| SalesOrder      | `Pedidos`          | `ORD-YYYYMMDD-NNN`             |
| Expense         | `Gastos`           | `EXP-YYYYMMDD-NNN`             |
| Task            | `Tareas`           | `TASK-NNNNN`                   |
| Alert           | `Alertas`          | `ALERT-YYYYMMDD-NNN`           |
| CashEvent       | `Flujo_Caja`       | `CF-YYYYMMDD-NNN`              |
| GreenhouseBlock | `Infraestructura`  | `ZONE-X-RACK-N`                |
| Decision        | `Decisiones`       | `DEC-NNNNN`                    |

---

## Versioning

- **Schema version:** 2.0.0
- **Breaking changes** require version bump and migration plan.
- **Additive changes** (new optional fields) are backward-compatible.
- All agents must check schema version on startup and refuse to operate if incompatible.
