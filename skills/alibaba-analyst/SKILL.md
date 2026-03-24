---
name: alibaba-analyst
description: Парсинг и анализ Alibaba — поиск товаров, цены, MOQ, поставщики, сравнение, экспорт в Google Sheets. Авто-вызывай при словах "alibaba", "алибаба", "поставщик", "supplier", "MOQ", "оптовая цена", "китайский поставщик", "sourcing".
homepage: https://alibaba-scraper.omkar.cloud
metadata: { "openclaw": { "emoji": "🏭", "requires": { "bins": [] } } }
---

# Alibaba Analyst

## Настройка

API: https://alibaba-scraper.omkar.cloud
Бесплатно: 5000 запросов/месяц
Получи ключ: https://omkar.cloud (регистрация 2 минуты)
Сохрани ключ: export ALIBABA*API_KEY="твой*ключ"
Также работает через Firecrawl MCP если нет ключа — используй как fallback.

---

## /alibaba-analyst search [запрос]

Поиск товаров с ценами, MOQ и данными поставщика.

```bash
curl -s "https://alibaba-scraper.omkar.cloud/alibaba/products/search?search_query=ЗАПРОС&page=1" \
  -H "API-Key: $ALIBABA_API_KEY" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Всего товаров: {data[\"count\"]}')
print(f'Страниц: {data[\"total_pages\"]}\n')
print(f'{\"Название\":<50} {\"Цена (USD)\":>12} {\"Gold\":>5} {\"TA\":>5}')
print('-'*75)
for p in data['products']:
    s = p['supplier']
    gold = '✓' if s.get('is_gold_supplier') else '-'
    ta = '✓' if s.get('has_trade_assurance') else '-'
    price = p['pricing']['range_formatted']
    print(f'{p[\"title\"][:49]:<50} {price:>12} {gold:>5} {ta:>5}')
    print(f'  └ {s[\"name\"][:60]} | {s[\"country\"]}')
"
```

## /alibaba-analyst product [PRODUCT_ID]

Детальная информация о конкретном товаре.

```bash
# ID берётся из результатов поиска (поле product_id)
# Или из URL: alibaba.com/product-detail/_1601422779481.html → ID: 1601422779481
curl -s "https://alibaba-scraper.omkar.cloud/alibaba/products/PRODUCT_ID" \
  -H "API-Key: $ALIBABA_API_KEY" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Название:     {d[\"title\"]}')
print(f'Цена:         {d[\"pricing\"][\"range_formatted\"]}')
print(f'MOQ:          {d.get(\"moq\", \"N/A\")}')
print(f'Поставщик:    {d[\"supplier\"][\"name\"]}')
print(f'Gold:         {d[\"supplier\"][\"is_gold_supplier\"]}')
print(f'Trade Assur.: {d[\"supplier\"][\"has_trade_assurance\"]}')
print(f'Верифицирован:{d[\"supplier\"].get(\"is_verified\", False)}')
print(f'Страна:       {d[\"supplier\"][\"country\"]}')
print()
# Ценовые тиры по объёму
tiers = d.get('volume_pricing', [])
if tiers:
    print('Объёмное ценообразование:')
    for t in tiers:
        print(f'  {t[\"min_quantity\"]}+ шт → {t[\"price\"]}')
"
```

## /alibaba-analyst compare [запрос] [количество_штук]

Сравнение поставщиков по цене за указанный объём.

```bash
QUERY="$1"
QTY="${2:-100}"
curl -s "https://alibaba-scraper.omkar.cloud/alibaba/products/search?search_query=$QUERY" \
  -H "API-Key: $ALIBABA_API_KEY" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Сравнение поставщиков: $QUERY (объём: $QTY шт)\n')
print(f'{\"Название\":<45} {\"Мин.цена\":>10} {\"Gold\":>5} {\"TA\":>5} {\"Страна\":<10}')
print('-'*80)
items = sorted(data['products'], key=lambda x: x['pricing']['range'].split('-')[0])
for p in items[:15]:
    s = p['supplier']
    gold = '★' if s.get('is_gold_supplier') else ' '
    ta = '✓' if s.get('has_trade_assurance') else ' '
    price = p['pricing']['range_formatted']
    print(f'{p[\"title\"][:44]:<45} {price:>10} {gold:>5} {ta:>5} {s[\"country\"]:<10}')
"
```

## /alibaba-analyst monitor [список запросов через ;]

Мониторинг цен на несколько товаров, сохранение истории.

```bash
mkdir -p docs/alibaba-data
echo "=== $(date '+%Y-%m-%d %H:%M') ===" >> docs/alibaba-data/price-log.md
for QUERY in $(echo "ЗАПРОС1;ЗАПРОС2;ЗАПРОС3" | tr ';' '\n'); do
  echo "\n## $QUERY" >> docs/alibaba-data/price-log.md

  curl -s "https://alibaba-scraper.omkar.cloud/alibaba/products/search?search_query=$QUERY" \
    -H "API-Key: $ALIBABA_API_KEY" | \
    python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data['products'][:5]
for p in items:
    print(f'{p[\"title\"][:45]:<45} {p[\"pricing\"][\"range_formatted\"]:>12}')
" | tee -a docs/alibaba-data/price-log.md
done
echo "\nМониторинг сохранён в docs/alibaba-data/price-log.md"
```

## /alibaba-analyst export-sheets [запрос]

Поиск + экспорт в Google Sheets через MCP.Выполни поиск через API (limit 20)

- Сформируй таблицу с колонками: Título | Precio Min | Precio Max | MOQ | Supplier | Gold | Trade Assurance | País | URL | Fecha
- Запиши через Google Sheets MCP в указанную таблицу
- Добавь строку-заголовок с датой обновления## /alibaba-analyst firecrawl [URL страницы поиска]
  Парсинг через Firecrawl MCP (fallback без API ключа).URL формат: https://www.alibaba.com/trade/search?keywords=ЗАПРОС
  Используй Firecrawl MCP для получения страницы. Извлеки из HTML: названия товаров, цены, поставщиков, MOQ. Выведи структурированную таблицу.---

## Быстрые примеры

**"Найди поставщиков наушников до $3 за штуку"**
→ search "wireless earbuds" → отфильтруй по цене → покажи Gold поставщиков
**"Сравни поставщиков для заказа 500 штук телефонных чехлов"**
→ compare "phone case" 500 → отсортируй по объёмной цене
**"Мониторинг цен на мои 3 товара"**
→ monitor "product1;product2;product3" → сохрани в docs/alibaba-data/
**"Выгрузи топ поставщиков в мою таблицу"**
→ search → export-sheets → Google Sheets MCP
**"Проверь конкретного поставщика"**
→ product ID → проверь Gold, Trade Assurance, верификацию, ценовые тиры

---

## Флаги качества поставщика

★ Gold Supplier — платная верификация, работает на платформе 1+ год
✓ Trade Assurance — защита платежа через Alibaba
✓ Assessed — физическая проверка производства
✓ Verified — проверка бизнес-лицензии
Минимально надёжный поставщик: Gold + Trade Assurance + Verified

---

## Сохранение данных между сессиями

docs/alibaba-data/
├── price-log.md ← история цен с датами
├── suppliers.md ← список проверенных поставщиков
└── comparisons.md ← сравнения по категориям
