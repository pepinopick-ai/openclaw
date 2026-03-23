#!/bin/bash
# provision-system-health-dashboard.sh
# Создает Grafana dashboard "System Health" через API
# Запуск: bash /home/roman/openclaw/skills/pepino-google-sheets/provision-system-health-dashboard.sh

set -euo pipefail

GRAFANA_URL="http://localhost:3000"
GRAFANA_AUTH="pepino:PepinoGrafana2026"
INFINITY_DS_UID="dfgjicgykuxa8b"

# Сначала генерируем начальный health-status.json, если его нет
if [ ! -f /tmp/health-status.json ]; then
  echo "[*] Генерация /tmp/health-status.json..."
  /usr/bin/node /home/roman/openclaw/skills/pepino-google-sheets/health-status.cjs > /tmp/health-status.json 2>&1
fi

echo "[*] Создаю dashboard pepino-system-health..."

curl -s -X POST "${GRAFANA_URL}/api/dashboards/db" \
  -u "${GRAFANA_AUTH}" \
  -H "Content-Type: application/json" \
  -d @- <<'DASHBOARD_JSON'
{
  "overwrite": true,
  "dashboard": {
    "uid": "pepino-system-health",
    "title": "System Health -- Pepino Pick",
    "tags": ["pepino", "system", "health"],
    "timezone": "browser",
    "refresh": "5m",
    "schemaVersion": 39,
    "panels": [
      {
        "type": "row",
        "title": "Сервисы",
        "gridPos": { "h": 1, "w": 24, "x": 0, "y": 0 },
        "collapsed": false
      },
      {
        "id": 1,
        "title": "Sheets API",
        "type": "stat",
        "gridPos": { "h": 4, "w": 6, "x": 0, "y": 1 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "mappings": [
              { "type": "value", "options": { "ok": { "text": "OK", "color": "green", "index": 0 }, "error": { "text": "DOWN", "color": "red", "index": 1 } } }
            ],
            "thresholds": { "mode": "absolute", "steps": [{ "value": null, "color": "green" }] }
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":\"ok\"}]",
          "columns": [{ "selector": "value", "text": "Status", "type": "string" }]
        }]
      },
      {
        "id": 2,
        "title": "Grafana",
        "type": "stat",
        "gridPos": { "h": 4, "w": 6, "x": 6, "y": 1 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "mappings": [
              { "type": "value", "options": { "ok": { "text": "OK", "color": "green", "index": 0 }, "error": { "text": "DOWN", "color": "red", "index": 1 } } }
            ],
            "thresholds": { "mode": "absolute", "steps": [{ "value": null, "color": "green" }] }
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":\"ok\"}]",
          "columns": [{ "selector": "value", "text": "Status", "type": "string" }]
        }]
      },
      {
        "id": 3,
        "title": "n8n",
        "type": "stat",
        "gridPos": { "h": 4, "w": 6, "x": 12, "y": 1 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "mappings": [
              { "type": "value", "options": { "ok": { "text": "OK", "color": "green", "index": 0 }, "error": { "text": "DOWN", "color": "red", "index": 1 } } }
            ],
            "thresholds": { "mode": "absolute", "steps": [{ "value": null, "color": "green" }] }
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":\"ok\"}]",
          "columns": [{ "selector": "value", "text": "Status", "type": "string" }]
        }]
      },
      {
        "id": 4,
        "title": "Контейнеры",
        "type": "stat",
        "gridPos": { "h": 4, "w": 6, "x": 18, "y": 1 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "thresholds": { "mode": "absolute", "steps": [
              { "value": null, "color": "red" },
              { "value": 3, "color": "yellow" },
              { "value": 6, "color": "green" }
            ] },
            "unit": "none"
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":0}]",
          "columns": [{ "selector": "value", "text": "Running", "type": "number" }]
        }]
      },

      {
        "type": "row",
        "title": "Docker-контейнеры",
        "gridPos": { "h": 1, "w": 24, "x": 0, "y": 5 },
        "collapsed": false
      },
      {
        "id": 5,
        "title": "Список контейнеров",
        "type": "table",
        "gridPos": { "h": 8, "w": 24, "x": 0, "y": 6 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {},
          "overrides": [
            { "matcher": { "id": "byName", "options": "state" }, "properties": [
              { "id": "custom.cellOptions", "value": { "type": "color-text" } },
              { "id": "mappings", "value": [
                { "type": "value", "options": { "running": { "text": "running", "color": "green" }, "exited": { "text": "exited", "color": "red" } } }
              ]}
            ]}
          ]
        },
        "options": { "showHeader": true, "sortBy": [{ "displayName": "name", "desc": false }] },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[]",
          "columns": [
            { "selector": "name", "text": "name", "type": "string" },
            { "selector": "state", "text": "state", "type": "string" },
            { "selector": "status", "text": "status", "type": "string" },
            { "selector": "uptime", "text": "uptime", "type": "string" },
            { "selector": "ports", "text": "ports", "type": "string" }
          ]
        }]
      },

      {
        "type": "row",
        "title": "Cron-задачи",
        "gridPos": { "h": 1, "w": 24, "x": 0, "y": 14 },
        "collapsed": false
      },
      {
        "id": 6,
        "title": "Статус Cron-задач",
        "type": "table",
        "gridPos": { "h": 10, "w": 24, "x": 0, "y": 15 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {},
          "overrides": [
            { "matcher": { "id": "byName", "options": "status" }, "properties": [
              { "id": "custom.cellOptions", "value": { "type": "color-text" } },
              { "id": "mappings", "value": [
                { "type": "value", "options": {
                  "ok": { "text": "OK", "color": "green" },
                  "stale": { "text": "STALE", "color": "yellow" },
                  "error": { "text": "ERROR", "color": "red" },
                  "unknown": { "text": "UNKNOWN", "color": "orange" }
                }}
              ]}
            ]}
          ]
        },
        "options": { "showHeader": true, "sortBy": [{ "displayName": "name", "desc": false }] },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[]",
          "columns": [
            { "selector": "name", "text": "name", "type": "string" },
            { "selector": "last_run", "text": "last_run", "type": "string" },
            { "selector": "status", "text": "status", "type": "string" },
            { "selector": "next_run", "text": "next_run", "type": "string" }
          ]
        }]
      },

      {
        "type": "row",
        "title": "Системные ресурсы",
        "gridPos": { "h": 1, "w": 24, "x": 0, "y": 25 },
        "collapsed": false
      },
      {
        "id": 7,
        "title": "Диск %",
        "type": "stat",
        "gridPos": { "h": 4, "w": 8, "x": 0, "y": 26 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "thresholds": { "mode": "absolute", "steps": [
              { "value": null, "color": "green" },
              { "value": 70, "color": "yellow" },
              { "value": 85, "color": "red" }
            ] },
            "min": 0,
            "max": 100
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "area", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":0}]",
          "columns": [{ "selector": "value", "text": "Disk %", "type": "number" }]
        }]
      },
      {
        "id": 8,
        "title": "Память %",
        "type": "stat",
        "gridPos": { "h": 4, "w": 8, "x": 8, "y": 26 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "thresholds": { "mode": "absolute", "steps": [
              { "value": null, "color": "green" },
              { "value": 70, "color": "yellow" },
              { "value": 90, "color": "red" }
            ] },
            "min": 0,
            "max": 100
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "area", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":0}]",
          "columns": [{ "selector": "value", "text": "Memory %", "type": "number" }]
        }]
      },
      {
        "id": 9,
        "title": "CPU Load %",
        "type": "stat",
        "gridPos": { "h": 4, "w": 8, "x": 16, "y": 26 },
        "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "thresholds": { "mode": "absolute", "steps": [
              { "value": null, "color": "green" },
              { "value": 60, "color": "yellow" },
              { "value": 90, "color": "red" }
            ] },
            "min": 0,
            "max": 100
          },
          "overrides": []
        },
        "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "area", "textMode": "auto" },
        "targets": [{
          "refId": "A",
          "datasource": { "type": "yesoreyeram-infinity-datasource", "uid": "dfgjicgykuxa8b" },
          "type": "json",
          "source": "inline",
          "format": "table",
          "data": "[{\"value\":0}]",
          "columns": [{ "selector": "value", "text": "CPU %", "type": "number" }]
        }]
      }
    ]
  }
}
DASHBOARD_JSON

echo ""
echo "[+] Dashboard provisioned. URL: ${GRAFANA_URL}/d/pepino-system-health/system-health-pepino-pick"
