// src/config.js — environment parsing, startup validation, and optional
// JSON config files (config.json, goals.json, networth.json). This is the
// only module that reads process.env or the app-root JSON files, so every
// other module receives a plain, already-validated config object.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');

const DEFAULT_PORT = 3000;
const DEFAULT_REFRESH_MS = 300000; // 5 min
const MIN_REFRESH_MS = 60000; // sanity floor — anything lower hammers Actual
const DEFAULT_AUTO_SYNC_MS = 7200000; // 2 hours
const DEFAULT_TZ = 'America/Chicago';
const DEFAULT_ACTUAL_DATA_DIR = '/cache';
const DEFAULT_STATE_DIR = '/state';
const DEFAULT_APP_TITLE = 'The Family Ledger';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_LOCALE = 'en-US';
const DEFAULT_HIDDEN_PAYEES = ['Starting Balance'];

// Reads a JSON file from the app root. Missing file → null (silently, this
// is the expected steady state for every optional config). Malformed JSON
// → a warning + null, so a typo in a hand-edited config can never crash
// the server.
function readJsonFile(filename) {
  const filePath = path.join(APP_ROOT, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[config] failed to parse ${filename} (${err.message}) — treating as absent`);
    return null;
  }
}

function loadAppConfig() {
  const raw = readJsonFile('config.json');
  return {
    baseCategories: Array.isArray(raw?.baseCategories) ? raw.baseCategories : [],
    hiddenPayees: Array.isArray(raw?.hiddenPayees) ? raw.hiddenPayees : DEFAULT_HIDDEN_PAYEES,
  };
}

function loadGoalsConfig() {
  const raw = readJsonFile('goals.json');
  return Array.isArray(raw) ? raw : [];
}

function loadNetworthConfig() {
  const raw = readJsonFile('networth.json');
  return raw && typeof raw === 'object' ? raw : null;
}

// Required env vars fail fast with a friendly message — no stack trace,
// no silent default, since a missing password means the server can't do
// anything useful anyway.
function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} — ${hint}`);
    process.exit(1);
  }
  return value;
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`[config] ${name}=${raw} is not a number — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function loadConfig() {
  const setupHint = 'run ./setup.sh or edit .env';
  const actualPassword = requireEnv('ACTUAL_PASSWORD', setupHint);
  const actualSyncId = requireEnv('ACTUAL_SYNC_ID', setupHint);

  let refreshIntervalMs = parseIntEnv('REFRESH_INTERVAL_MS', DEFAULT_REFRESH_MS);
  if (refreshIntervalMs < MIN_REFRESH_MS) {
    console.warn(`[config] REFRESH_INTERVAL_MS ${refreshIntervalMs} is below the ${MIN_REFRESH_MS}ms sanity floor — using the floor`);
    refreshIntervalMs = MIN_REFRESH_MS;
  }

  return {
    port: parseIntEnv('PORT', DEFAULT_PORT),
    refreshIntervalMs,
    autoSyncIntervalMs: parseIntEnv('AUTO_SYNC_INTERVAL_MS', DEFAULT_AUTO_SYNC_MS),
    tz: process.env.TZ || DEFAULT_TZ,
    actualDataDir: process.env.ACTUAL_DATA_DIR || DEFAULT_ACTUAL_DATA_DIR,
    actualServerUrl: process.env.ACTUAL_SERVER_URL,
    actualPassword,
    actualSyncId,
    stateDir: process.env.STATE_DIR || DEFAULT_STATE_DIR,
    appTitle: process.env.APP_TITLE || DEFAULT_APP_TITLE,
    currency: process.env.CURRENCY || DEFAULT_CURRENCY,
    locale: process.env.LOCALE || DEFAULT_LOCALE,
    dashboardPassword: process.env.DASHBOARD_PASSWORD || null,
    app: loadAppConfig(),
    goals: loadGoalsConfig(),
    networth: loadNetworthConfig(),
  };
}
