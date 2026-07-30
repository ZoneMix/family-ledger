// src/bank-sync.js — pulls fresh transactions from linked bank connectors
// (SimpleFIN/GoCardless, whatever Actual has configured) and refreshes the
// cache afterward. Runs on its own timer, independent of the cache
// refresh interval — see server.js.

import { api } from './actual.js';

const SYNC_TIMEOUT_MS = 90000;

// Syncs one account with a per-account timeout. Returns a result record
// rather than throwing, so the caller can iterate every account without
// short-circuiting on the first failure.
async function syncOneAccount(acct) {
  const started = Date.now();
  let timeoutId;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('account sync timed out')), SYNC_TIMEOUT_MS);
    });
    await Promise.race([api.runBankSync({ accountId: acct.id }), timeout]);
    return { id: acct.id, name: acct.name, ok: true, durationMs: Date.now() - started };
  } catch (err) {
    return { id: acct.id, name: acct.name, ok: false, error: err.message, durationMs: Date.now() - started };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createBankSyncEngine({ refreshEngine, log }) {
  let syncing = false;

  async function runBankSyncCycle() {
    if (syncing) return { skipped: true };
    syncing = true;
    const cycleStarted = Date.now();
    try {
      log('bank sync cycle started');

      // Manual accounts are safe to call runBankSync on — the SDK no-ops
      // them silently — so we don't pre-filter by connector type; a newly
      // linked account is picked up automatically.
      const accounts = await api.getAccounts();
      const candidates = accounts.filter(a => !a.closed);

      // Sequential, not concurrent: one misbehaving connector can't slow
      // the others, and the log output stays deterministic.
      const results = [];
      for (const acct of candidates) {
        const r = await syncOneAccount(acct);
        results.push(r);
        log(r.ok
          ? `  ✓ ${acct.name} (${r.durationMs}ms)`
          : `  ✗ ${acct.name}: ${r.error}`);
      }

      log('bank sync cycle complete, refreshing cache');
      await refreshEngine.refresh();

      const failed = results.filter(r => !r.ok);
      const succeeded = results.filter(r => r.ok);
      let status;
      if (results.length === 0) status = 'none';
      else if (failed.length === 0) status = 'ok';
      else if (succeeded.length === 0) status = 'failed';
      else status = 'partial';

      refreshEngine.setBankSyncTelemetry({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: status,
        lastSyncError: failed.length > 0
          ? `${failed.length} of ${results.length} failed: ${failed.map(r => r.name).join(', ')}`
          : null,
        lastSyncDurationMs: Date.now() - cycleStarted,
        results,
      });

      return { ok: status === 'ok', status, results };
    } catch (err) {
      // Top-level failure (e.g. getAccounts threw) — distinct from a
      // per-account failure. Mark the whole cycle failed and bail.
      log('bank sync cycle FAILED at top level:', err.message);
      refreshEngine.setBankSyncTelemetry({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: 'failed',
        lastSyncError: err.message,
        lastSyncDurationMs: Date.now() - cycleStarted,
        results: [],
      });
      try {
        await refreshEngine.refresh();
      } catch {
        // already logged inside refresh()
      }
      return { ok: false, status: 'failed', error: err.message };
    } finally {
      syncing = false;
    }
  }

  return { runBankSyncCycle, isSyncing: () => syncing };
}
