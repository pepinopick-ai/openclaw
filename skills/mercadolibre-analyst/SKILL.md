---
name: mercadolibre-analyst
description: Анализ Mercado Libre — мониторинг цен конкурентов, исследование категорий, анализ продавцов, выгрузка в Google Sheets. Авто-вызывай при словах "mercado libre", "ML", "конкуренты ML", "цены на ML", "мониторинг ML", "анализ продавца", "категория ML", "листинг".
homepage: https://api.mercadolibre.com
metadata: { "openclaw": { "emoji": "🛒", "requires": { "bins": [] } } }
---

# Mercado Libre Analyst

API базовый URL: https://api.mercadolibre.com (токен не нужен для публичных данных)
Страны: MLA=Аргентина, MLB=Бразилия, MLM=Мексика, MLC=Чили, MCO=Колумбия

---

## /mercadolibre-analyst search [запрос] [страна]

Поиск товаров и анализ цен конкурентов.

```bash
curl -s "https://api.mercadolibre.com/sites/MLA/search?q=ЗАПРОС&limit=20" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('results', [])
print(f'Найдено: {data[\"paging\"][\"total\"]} товаров\n')
print(f'{\"Название\":<50} {\"Цена\":>10} {\"Продано\":>8}')
print('-'*70)
for i in items:
    print(f'{i[\"title\"][:49]:<50} {i[\"price\"]:>10.0f} {i.get(\"sold_quantity\",0):>8}')
"
```

## /mercadolibre-analyst item [ITEM_ID]

Детальный анализ конкретного товара.

```bash
curl -s "https://api.mercadolibre.com/items/ITEM_ID" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Название:    {d[\"title\"]}')
print(f'Цена:        {d[\"price\"]} {d[\"currency_id\"]}')
print(f'Состояние:   {d[\"condition\"]}')
print(f'Продано:     {d.get(\"sold_quantity\", 0)}')
print(f'Остаток:     {d.get(\"available_quantity\", 0)}')
print(f'Листинг:     {d[\"listing_type_id\"]}')
print(f'Продавец ID: {d[\"seller_id\"]}')
print(f'URL:         {d[\"permalink\"]}')
"
# Актуальная цена
curl -s "https://api.mercadolibre.com/items/ITEM_ID/prices"
```

## /mercadolibre-analyst seller [SELLER_ID]

Анализ продавца — репутация, продажи, листинги.

```bash
curl -s "https://api.mercadolibre.com/users/SELLER_ID" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
rep = d.get('seller_reputation', {})
print(f'Ник:         {d[\"nickname\"]}')
print(f'Уровень:     {rep.get(\"level_id\", \"N/A\")}')
print(f'Транзакций:  {rep.get(\"transactions\", {}).get(\"total\", 0)}')
ratings = rep.get('transactions', {}).get('ratings', {})
pos = ratings.get('positive', 0)
print(f'Позитивных:  {pos*100:.0f}%')
print(f'Регистрация: {d.get(\"registration_date\",\"\")[:10]}')
"
# Все товары продавца
curl -s "https://api.mercadolibre.com/users/SELLER_ID/items/search?limit=50" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('Всего товаров:', d['paging']['total']); print('IDs:', d['results'][:10])"
```

## /mercadolibre-analyst category [CATEGORY_ID]

Топ товары категории, диапазон цен, лидеры продаж.

```bash
curl -s "https://api.mercadolibre.com/sites/MLA/search?category=CATEGORY_ID&sort=sold_quantity_desc&limit=10" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data['results']
prices = [i['price'] for i in items]
print(f'Мин. цена:  {min(prices):.0f}')
print(f'Макс. цена: {max(prices):.0f}')
print(f'Средн:      {sum(prices)/len(prices):.0f}\n')
for i in items:
    print(f'{i[\"title\"][:45]:<45} {i[\"price\"]:>8.0f}  продано: {i.get(\"sold_quantity\",0)}')
"
```

## /mercadolibre-analyst monitor [ID1,ID2,ID3]

Мониторинг цен нескольких товаров, сохранение истории.

```bash
mkdir -p docs/ml-data
echo "=== $(date) ===" >> docs/ml-data/monitor-log.md
for ID in $(echo "ID1 ID2 ID3"); do
  curl -s "https://api.mercadolibre.com/items/$ID" | \
    python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'{d[\"title\"][:40]:<40} {d[\"price\"]:>10.0f} {d[\"currency_id\"]} | продано: {d.get(\"sold_quantity\",0)}')
" | tee -a docs/ml-data/monitor-log.md
done
```

## /mercadolibre-analyst export-sheets [запрос]

Поиск + экспорт в Google Sheets через MCP.

1. Выполни поиск через API
2. Сформируй таблицу: Título | Precio | Moneda | Vendidos | Seller ID | URL | Fecha
3. Используй Google Sheets MCP для записи
4. Добавь строку с датой обновления

---

## Примеры использования

"Найди топ конкурентов по iPhone 15 в Аргентине"
→ search "iphone 15" MLA → таблица по продажам
"Проверь репутацию продавца 123456"
→ seller 123456 → уровень, процент позитивных, история
"Мониторинг цен у этих 5 товаров"
→ monitor MLA1,MLA2,MLA3,MLA4,MLA5 → сохрани в docs/ml-data/
"Выгрузи топ-20 в мою таблицу Google Sheets"
→ search → export-sheets

---

## Сохранение между сессиями

Все результаты пиши в docs/ml-data/:

- monitor-log.md — история цен с датами
- competitors.md — список отслеживаемых конкурентов
- categories.md — заметки по категориям
