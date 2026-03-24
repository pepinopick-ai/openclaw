---
name: trading-monitor
description: Мониторинг крипто-торгового бота — проверяет работает ли процесс, читает PnL, статистику сделок и отправляет алерты в Telegram если бот упал или идёт просадка. Вызывай при словах "как бот", "статус бота", "что с ботом", "проверь бота", "trading bot", "крипто бот".
homepage: https://pepinopick.com
metadata: { "openclaw": { "emoji": "🤖", "requires": { "bins": ["python3", "sqlite3"] } } }
---

# Trading Monitor — Мониторинг крипто-бота

Этот skill следит за торговым ботом запущенным на сервере пользователя.

## Конфигурация

- **Процесс:** `python3 trading_daemon.py`
- **Лог:** `/home/roman/.openclaw/workspace/memory/trading_bot.log`
- **БД:** `/home/roman/.openclaw/workspace/memory/trading_daemon.db`
- **Scalper БД:** `/home/roman/.openclaw/workspace/memory/scalper.db`
- **Telegram токен:** из `.env.trading` или переменная `TELEGRAM_TOKEN`
- **Telegram chat:** `7270238070`
- **Env file:** `/home/roman/.openclaw/workspace/scripts/.env.trading`
- **Start script:** `/home/roman/.openclaw/workspace/start_bot.sh`

## Команды

### `/bot status` — полный статус

Показывает: работает ли процесс, PnL за сегодня, открытые позиции, последние сделки, win rate.

### `/bot check` — быстрая проверка

Только: процесс жив? PnL? Нет ли аномалий?

### `/bot restart` — перезапуск

Убивает старый процесс и запускает заново через `start_bot.sh`.

### `/bot log [N]` — последние N строк лога

По умолчанию 30 строк.

### `/bot trades` — история сделок

Последние 10 закрытых сделок из scalper.db.

### `/bot alert on/off` — включить/выключить авто-мониторинг

Запускает фоновую проверку каждые 15 минут.

## Алерты (автоматические)

Skill должен проверять и предупреждать если:

- 🔴 **Процесс не запущен** — бот упал, нужен перезапуск
- 🔴 **Просадка > 3%** от капитала за день — достигнут лимит
- 🟡 **Нет сделок > 2 часа** — возможно проблема с сигналами
- 🟡 **Win rate < 35%** за последние 20 сделок — стратегия не работает
- 🟢 **Все ОК** — ежечасный тихий чек

## Диагностика БД

Scalper БД (`scalper.db`) содержит таблицы:

- `trades` — закрытые сделки: symbol, direction, entry, exit, pnl_usd, pnl_pct, duration_min, status
- `signals` — все сигналы (в т.ч. пропущенные)

Trading Daemon БД (`trading_daemon.db`) содержит:

- `arb_positions` — открытые арб-позиции
- `daily_pnl` — PnL по дням

## Что делать при падении бота

1. Проверить лог на ошибку: `/bot log 50`
2. Если ошибка понятна — исправить код
3. Перезапустить: `/bot restart`
4. Если падает повторно — отправить алерт в Telegram

## Примеры команд

```
как бот?
проверь торгового бота
что с ботом сегодня?
покажи последние сделки
бот упал — перезапусти
win rate за неделю
сколько заработал бот?
```
