#!/bin/bash
# Запуск Langfuse для Pepino Pick Agent OS
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker не найден" >&2
  exit 1
fi

docker compose up -d

echo ""
echo "Langfuse запущен на http://localhost:3001"
echo "Первый визит: создай admin-аккаунт через веб-интерфейс"
echo ""
echo "Проверка статуса: docker compose -f $(pwd)/docker-compose.yml ps"
echo "Логи:            docker compose -f $(pwd)/docker-compose.yml logs -f langfuse"
