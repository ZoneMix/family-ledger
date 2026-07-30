// server.js — Family Ledger backend bootstrap.
// Loads config, connects to Actual Budget, starts the refresh and
// bank-sync loops, and serves the Express app. All real logic lives in
// src/ — this file only wires the pieces together.

import { loadConfig } from './src/config.js';
import { initActual, shutdownActual } from './src/actual.js';
import { createRefreshEngine } from './src/refresh.js';
import { createBankSyncEngine } from './src/bank-sync.js';
import { createApp } from './src/routes.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function main() {
  const config = loadConfig();

  log('initializing @actual-app/api');
  await initActual(config);
  log('budget ready');

  const refreshEngine = createRefreshEngine({ config, log });
  const bankSyncEngine = createBankSyncEngine({ refreshEngine, log });

  await refreshEngine.refresh();
  setInterval(() => refreshEngine.refresh(), config.refreshIntervalMs);

  if (config.autoSyncIntervalMs > 0) {
    log(`auto bank sync interval: ${Math.round(config.autoSyncIntervalMs / 60000)} min`);
    setInterval(() => {
      bankSyncEngine.runBankSyncCycle().catch(err => log('auto sync cycle failed:', err.message));
    }, config.autoSyncIntervalMs);
    // One extra run ~10s after startup so the PWA sees fresh bank data
    // soon after launch instead of waiting a full interval.
    setTimeout(() => {
      bankSyncEngine.runBankSyncCycle().catch(err => log('initial bank sync failed:', err.message));
    }, 10000);
  } else {
    log('auto bank sync disabled (AUTO_SYNC_INTERVAL_MS=0)');
  }

  const app = createApp({ config, refreshEngine, bankSyncEngine, log });
  app.listen(config.port, '0.0.0.0', () => {
    log(`${config.appTitle} listening on :${config.port}`);
    log(`refresh interval: ${Math.round(config.refreshIntervalMs / 60000)} min`);
    log(`timezone: ${config.tz}`);
  });
}

// Startup failures print a plain-English hint for the common causes, then
// wait before exiting. Docker's restart policy will retry — the delay stops
// a bad config from hot-looping into Actual's login rate limiter (which
// would lock out even CORRECT credentials for a while and make the real
// problem much harder to see).
const FATAL_RETRY_DELAY_MS = 30000;

function startupHint(message) {
  if (/not found/i.test(message) && /budget/i.test(message)) {
    return 'Check ACTUAL_SYNC_ID in .env — it must be the "Sync ID" from Actual\'s Settings → Show advanced settings (not the Budget ID).';
  }
  if (/too-many-requests/i.test(message)) {
    return 'Actual is rate-limiting logins (usually after repeated failed starts). It clears on its own in a few minutes; fix .env first if credentials or the Sync ID were wrong.';
  }
  if (/invalid.?password|authentication failed/i.test(message)) {
    return 'Check ACTUAL_PASSWORD in .env — it must match the Actual server password.';
  }
  if (/ECONNREFUSED|fetch failed|network/i.test(message)) {
    return 'The Actual server is not reachable — is the actual-server container running? (docker compose ps)';
  }
  return null;
}

main().catch(err => {
  console.error('fatal:', err.message || err);
  const hint = startupHint(String(err.message || err));
  if (hint) console.error('hint:', hint);
  console.error(`retrying in ${FATAL_RETRY_DELAY_MS / 1000}s...`);
  setTimeout(() => process.exit(1), FATAL_RETRY_DELAY_MS);
});

const shutdown = async (sig) => {
  log(`${sig} received, shutting down`);
  await shutdownActual();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A single bad SimpleFIN/GoCardless connector can leak an unhandled
// rejection from the SDK's internal Promise.all — log it rather than
// crashing the whole server over one stale bank token.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('unhandled rejection (non-fatal):', msg);
});
