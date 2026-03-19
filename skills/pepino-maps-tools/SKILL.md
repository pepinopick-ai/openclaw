---
name: pepino-maps-tools
description: "🗺️ Инструменты карт и веб-парсинга для Pepino Pick — маршруты, расход топлива, поиск поставщиков рядом, скрапинг сайтов. Авто-вызывай при словах маршрут, доставка расстояние, расход топлива, сколько ехать, найди рядом, адрес поставщика, спарси сайт, цены с сайта, найди в интернете."
homepage: https://openstreetmap.org
metadata:
  openclaw:
    emoji: "🗺️"
    requires:
      bins: []
---

# 🗺️ Pepino Maps Tools

Два инструмента доступны через shell в воркспейсе:

```
/home/node/.openclaw/workspace/tools/maps.js    — маршруты и поиск (OpenStreetMap)
/home/node/.openclaw/workspace/tools/scrape.js  — веб-парсинг (Firecrawl)
```

---

## maps.js — Маршруты и геолокация (OpenStreetMap + OSRM)

Бесплатно, без API ключей, реальные дороги Аргентины.

### Маршрут A → B

```bash
node /home/node/.openclaw/workspace/tools/maps.js route "Córdoba, Argentina" "Buenos Aires, Argentina"
# → расстояние, время, повороты, ссылка на карту
```

### Расход топлива Ford Pickup

```bash
node /home/node/.openclaw/workspace/tools/maps.js fuel "Córdoba, Argentina" "Rosario, Argentina" 14
# → километраж, литры, стоимость ARS (туда и обратно)
# 14 = л/100км (Ford Pickup по умолчанию)
```

### Геокодирование (адрес → координаты)

```bash
node /home/node/.openclaw/workspace/tools/maps.js geocode "Av. Colón 1234, Córdoba"
# → lat/lng + ссылка на OpenStreetMap
```

### Поиск рядом (Overpass API)

```bash
node /home/node/.openclaw/workspace/tools/maps.js nearby "Córdoba, Argentina" "ferretería" 10
node /home/node/.openclaw/workspace/tools/maps.js nearby "Córdoba, Argentina" "supermercado" 5
# Ключевые слова: ferretería, supermercado, hospital, banco, farmacia, restaurant
```

### Матрица расстояний от базы

```bash
node /home/node/.openclaw/workspace/tools/maps.js matrix "Rosario|Mendoza|Santa Fe|Mar del Plata" "Córdoba, Argentina"
# → таблица расстояний и времени до каждой точки
```

---

## scrape.js — Веб-парсинг (Firecrawl)

Обходит блокировки, работает с динамическими сайтами.

### Поиск в интернете

```bash
node /home/node/.openclaw/workspace/tools/scrape.js search "hongos ostra precio Córdoba 2026" 5
node /home/node/.openclaw/workspace/tools/scrape.js search "proveedor sustrato paja Córdoba" 5
```

### Содержимое страницы

```bash
node /home/node/.openclaw/workspace/tools/scrape.js page "https://www.zonaprop.com.ar/..."
```

### Извлечь цены с сайта

```bash
node /home/node/.openclaw/workspace/tools/scrape.js prices "https://www.zonaprop.com.ar/..." "terreno"
node /home/node/.openclaw/workspace/tools/scrape.js prices "https://listado.mercadolibre.com.ar/..." "hongos"
```

### Структурированное извлечение

```bash
node /home/node/.openclaw/workspace/tools/scrape.js extract "https://empresa.com.ar/contacto" "nombre, teléfono, email, dirección"
```

---

## Типичные задачи логиста

**Рассчитать стоимость доставки:**

```bash
node /home/node/.openclaw/workspace/tools/maps.js fuel "Córdoba, Argentina" "Palermo, Buenos Aires" 14
```

**Найти ближайшие АЗС:**

```bash
node /home/node/.openclaw/workspace/tools/maps.js nearby "Córdoba, Argentina" "nafta" 3
```

**Проверить цены конкурентов:**

```bash
node /home/node/.openclaw/workspace/tools/scrape.js search "venta hongos ostra gourmet Córdoba precio 2026" 5
```

**Найти поставщика субстрата:**

```bash
node /home/node/.openclaw/workspace/tools/scrape.js search "proveedor paja trigo horticultura Córdoba Argentina" 5
```

---

## Важно

- Инструменты запускаются через **Bash tool** в Claude Code
- В Telegram-агентах: дай агенту знать команду — он выполнит через shell
- Ответ возвращается текстом и сразу готов для анализа
- Время ответа: route/fuel ~3–5 сек, scrape ~5–10 сек
