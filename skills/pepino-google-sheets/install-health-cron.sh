#!/bin/bash
# install-health-cron.sh -- Добавляет cron-задачу для health-status.cjs
# Запуск: bash /home/roman/openclaw/skills/pepino-google-sheets/install-health-cron.sh

set -euo pipefail

CRON_LINE="*/10 * * * * /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/health-status.cjs > /tmp/health-status.json 2>&1"

# Проверяем, нет ли уже такой записи
if crontab -l 2>/dev/null | grep -qF "health-status.cjs"; then
  echo "[*] Cron для health-status.cjs уже установлен, пропускаю."
  exit 0
fi

# Добавляем запись
(crontab -l 2>/dev/null; echo "# System Health мониторинг (каждые 10 минут)"; echo "${CRON_LINE}") | crontab -

echo "[+] Cron установлен: ${CRON_LINE}"
echo "[*] Проверка: crontab -l | grep health-status"
crontab -l | grep health-status
