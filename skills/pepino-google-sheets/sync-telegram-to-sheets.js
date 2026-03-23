#!/usr/bin/env node
/**
 * Telegram → Google Sheets Bridge
 *
 * Monitors Telegram group messages via Bot API (getUpdates with offset tracking)
 * and writes parsed data to Google Sheets via sheets-api.
 *
 * Works alongside openclaw-gateway (which uses polling) by using
 * a separate getUpdates call with its own offset tracking.
 *
 * NOTE: Telegram only allows ONE consumer via getUpdates/polling.
 * Since openclaw-gateway already uses polling, this script uses
 * a different approach: periodic Telegram API forwarding via
 * getUpdates with a read-only peek (no offset confirmation).
 *
 * ACTUAL APPROACH: This script reads messages from openclaw's local
 * memory files + BACKUP_RAW.txt and syncs them to Google Sheets.
 * Additionally, it provides a POST /ingest endpoint for real-time writes.
 *
 * Usage: node sync-telegram-to-sheets.js
 * Cron: Run every 15 minutes
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  readSheet,
  appendToSheet,
  PEPINO_SHEETS_ID,
} from "./sheets.js";

const METRICS_DB = "/home/roman/.openclaw/workspace/metrics/data/metrics_db.json";
const BACKUP_RAW = "/home/roman/.openclaw/workspace/memory/BACKUP_RAW.txt";
const SYNC_STATE = "/home/roman/.openclaw/workspace/metrics/data/sheets_sync_state.json";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadSyncState() {
  try {
    return JSON.parse(readFileSync(SYNC_STATE, "utf-8"));
  } catch {
    return { lastSyncDate: "", syncedDates: [], backupLines: 0 };
  }
}

function saveSyncState(state) {
  writeFileSync(SYNC_STATE, JSON.stringify(state, null, 2));
}

function loadMetricsDb() {
  try {
    let content = readFileSync(METRICS_DB, "utf-8");
    // Fix broken JSON: array closed then continued
    content = content.replace(/\]\s*,\s*\{/g, ", {");
    return JSON.parse(content);
  } catch (e) {
    console.error("Cannot parse metrics_db.json:", e.message);
    return { daily_logs: [] };
  }
}

function loadBackupRaw() {
  try {
    return readFileSync(BACKUP_RAW, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getExistingDates(sheetName) {
  try {
    const rows = await readSheet(PEPINO_SHEETS_ID, sheetName);
    return new Set(rows.slice(1).map((r) => r[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function syncProduction() {
  const db = loadMetricsDb();
  const logs = db.daily_logs || [];
  const existingDates = await getExistingDates("🌿 Производство");
  let synced = 0;

  for (const log of logs) {
    const date = log.date;
    if (!date || existingDates.has(date)) continue;

    const harvest = log.harvest || {};
    const cucumbers = harvest.cucumbers_kg;
    const morning = harvest.morning_kg;
    const evening = harvest.evening_kg;

    // Only sync if there's actual harvest data
    if (!cucumbers && !morning && !evening) continue;

    const totalKg = cucumbers || ((morning || 0) + (evening || 0));
    if (totalKg <= 0) continue;

    const row = [
      date,
      "Огурец",
      "", // block
      "", // substrate
      "", // inoculation
      "", // fruiting
      totalKg,
      "", // bioefficiency
      "сбор",
      "Теплица 1",
      harvest.notes || "",
    ];

    try {
      await appendToSheet(PEPINO_SHEETS_ID, [row], "🌿 Производство");
      existingDates.add(date);
      synced++;
      console.log(`  ✅ Production: ${date} → ${totalKg}кг`);
    } catch (e) {
      console.error(`  ❌ Production ${date}: ${e.message}`);
    }
  }

  return synced;
}

async function syncSales() {
  const db = loadMetricsDb();
  const logs = db.daily_logs || [];
  const existingDates = await getExistingDates("🛒 Продажи");
  let synced = 0;

  for (const log of logs) {
    const date = log.date;
    if (!date) continue;

    const revenue = log.revenue || {};
    const ars = revenue.ars;
    const usd = revenue.usd;

    // Only sync if there's revenue data
    if (!ars && !usd) continue;
    if (existingDates.has(date)) continue;

    const row = [
      date,
      "", // client (unknown from metrics)
      "Огурец", // product
      "", // qty
      "", // price per kg
      ars || "",
      usd || "",
      "", // channel
      "", // payment
      "записано", // status
      "", // delivery
      revenue.notes || "",
    ];

    try {
      await appendToSheet(PEPINO_SHEETS_ID, [row], "🛒 Продажи");
      existingDates.add(date);
      synced++;
      console.log(`  ✅ Sales: ${date} → ${ars || "?"} ARS / ${usd || "?"} USD`);
    } catch (e) {
      console.error(`  ❌ Sales ${date}: ${e.message}`);
    }
  }

  return synced;
}

async function syncBackupRaw() {
  const lines = loadBackupRaw();
  const state = loadSyncState();
  const newLines = lines.slice(state.backupLines || 0);
  let synced = 0;

  for (const line of newLines) {
    // Parse: "2026-03-20 02:11 UTC | HARVEST | Огурец: 20 кг"
    const match = line.match(
      /^(\d{4}-\d{2}-\d{2})\s+[\d:]+\s+UTC\s+\|\s+(\w+)\s+\|\s+(.+)$/,
    );
    if (!match) continue;

    const [, date, type, detail] = match;

    if (type === "HARVEST") {
      // Already handled by syncProduction from metrics_db
      continue;
    }

    if (type === "SALE" || type === "REVENUE") {
      const amountMatch = detail.match(/(\d[\d,.]+)\s*(?:ARS|ars)/);
      const kgMatch = detail.match(/(\d[\d,.]+)\s*(?:кг|kg)/i);
      const row = [
        date,
        "", // client
        detail,
        kgMatch ? kgMatch[1] : "",
        "",
        amountMatch ? amountMatch[1] : "",
        "",
        "",
        "",
        "записано",
        "",
        line,
      ];

      try {
        await appendToSheet(PEPINO_SHEETS_ID, [row], "🛒 Продажи");
        synced++;
        console.log(`  ✅ Backup→Sales: ${date} → ${detail}`);
      } catch (e) {
        console.error(`  ❌ Backup→Sales: ${e.message}`);
      }
    }

    if (type === "EXPENSE") {
      const amountMatch = detail.match(/(\d[\d,.]+)/);
      const row = [date, "", detail, amountMatch ? amountMatch[1] : "", "", line];
      try {
        await appendToSheet(PEPINO_SHEETS_ID, [row], "💰 Расходы");
        synced++;
        console.log(`  ✅ Backup→Expense: ${date} → ${detail}`);
      } catch (e) {
        console.error(`  ❌ Backup→Expense: ${e.message}`);
      }
    }
  }

  // Update sync state
  state.backupLines = lines.length;
  state.lastSyncDate = today();
  saveSyncState(state);

  return synced;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Syncing openclaw data → Google Sheets...`);

  const prodSynced = await syncProduction();
  console.log(`Production: ${prodSynced} new entries`);

  const salesSynced = await syncSales();
  console.log(`Sales: ${salesSynced} new entries`);

  const backupSynced = await syncBackupRaw();
  console.log(`Backup: ${backupSynced} new entries`);

  const total = prodSynced + salesSynced + backupSynced;
  console.log(`\nTotal synced: ${total} entries`);
  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
