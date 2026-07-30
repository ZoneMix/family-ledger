/* ─────────────────────────────────────────────────────────────
   The Family Ledger — main.js
   Entry point: fetch cycle, render dispatch, wire-up, service worker.
   ───────────────────────────────────────────────────────────── */

import {
  $, setText, fmt, isPrivacy, setPrivacy, configureFormatters,
  showError, hideError, MONTH_NAMES_FULL, MONTH_NAMES_SHORT,
  REFRESH_MS, RETRY_MS,
} from './util.js';
import { state, isUserInteracting } from './state.js';
import {
  heroMessage, issueNumber, applySensitiveRevealed,
  renderGoals, renderAccounts, renderGroups, renderNetworth,
  renderReport, loadReport, renderBankSyncStatus,
} from './sections.js';
import { renderLedger, toggleLedgerExpand, wireSplitModal } from './ledger.js';

let refreshTimer = null;
let retryTimer   = null;
let appConfigApplied = false;
let currentLocale = 'en-US';

// ── App config (title / currency / locale from the server) ─
function applyAppConfig(app) {
  if (!app || appConfigApplied) return;
  appConfigApplied = true;
  if (app.locale) currentLocale = app.locale;
  configureFormatters(app.locale || 'en-US', app.currency || 'USD');
  if (app.title) {
    document.title = app.title;
    setText('#masthead-title', app.title);
  }
}

// ── Fetch with retry ───────────────────────────────────────
async function fetchBudget() {
  const res = await fetch('/api/budget', {
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
  });
  if (res.status === 401) {
    // Dashboard password is enabled and this session isn't signed in.
    window.location.href = '/login.html';
    throw new Error('signed out');
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'warming up');
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// ── Rendering ──────────────────────────────────────────────
export function render(data) {
  // If the user is mid-interaction (OS category picker open, split modal
  // up), defer the render — replacing the DOM now would orphan-dismiss
  // the picker. The stash applies on blur / modal close.
  if (isUserInteracting()) {
    state.pendingRenderData = data;
    return;
  }
  state.pendingRenderData = null;

  hideError();
  state.lastData = data;
  applyAppConfig(data.app);

  // Masthead
  setText('#masthead-edition', `${MONTH_NAMES_FULL[data.monthNum - 1].toUpperCase()} EDITION`);
  setText('#issue-number', String(issueNumber()).padStart(2, '0'));

  // Hero
  setText('#hero-month', MONTH_NAMES_SHORT[data.monthNum - 1]);
  setText('#hero-year', `'${String(data.year).slice(-2)}`);
  setText('#day-of-month', data.dayOfMonth);
  setText('#days-in-month', data.daysInMonth);
  setText('#total-spent', fmt(data.totals.spent));
  setText('#total-budgeted', fmt(data.totals.budgeted));

  // Base vs discretionary breakdown — only when the user configured
  // baseCategories (config.json). Without it the dashboard runs in
  // single-bucket mode: the breakdown rows hide and pacing uses totals.
  const baseSplit = !!(data.app && data.app.baseSplitEnabled
    && data.totals.base && data.totals.discretionary);
  const breakdown = $('.hero__breakdown');
  if (breakdown) breakdown.style.display = baseSplit ? '' : 'none';
  if (baseSplit) {
    setText('#base-spent', fmt(data.totals.base.spent));
    setText('#base-budgeted', fmt(data.totals.base.budgeted));
    setText('#disc-spent', fmt(data.totals.discretionary.spent));
    setText('#disc-budgeted', fmt(data.totals.discretionary.budgeted));
  }

  // Pacing source: discretionary when split is on (pre-committed bills
  // firing on day 1 shouldn't read as "running hot"), totals otherwise.
  const pace = baseSplit ? data.totals.discretionary : data.totals;
  const dayPct = Math.min(100, (data.dayOfMonth / data.daysInMonth) * 100);
  const spentPct = pace.budgeted > 0
    ? Math.min(100, (pace.spent / pace.budgeted) * 100)
    : 0;

  setText('#hero-message', heroMessage(
    pace.spent, pace.budgeted,
    data.dayOfMonth, data.daysInMonth
  ));

  // Hero progress bars — animated on first render, smooth on subsequent
  if (state.firstRender) {
    requestAnimationFrame(() => {
      $('#month-progress').style.width = `${spentPct}%`;
      const tick = $('#month-tick');
      tick.style.left = `${dayPct}%`;
      setTimeout(() => tick.classList.add('is-visible'), 1600);
    });
  } else {
    const mp = $('#month-progress');
    mp.style.transition = 'width 0.3s ease';
    mp.style.width = `${spentPct}%`;
    const tick = $('#month-tick');
    tick.style.transition = 'left 0.3s ease';
    tick.style.left = `${dayPct}%`;
    tick.classList.add('is-visible');
  }

  renderGoals(data.goals);
  renderNetworth(data.networth);
  renderAccounts(data.accounts);
  renderGroups(data.categoryGroups);

  // Recent ledger entries (with inline category editing). If expanded to
  // full-month view, render the cached expanded dataset instead.
  const ledgerData = (state.ledgerExpanded && state.expandedTransactions)
    ? state.expandedTransactions
    : data.recentTransactions;
  renderLedger(ledgerData, data.categoryOptions || []);

  if (state.firstRender) state.firstRender = false;

  // Footer timestamp
  const updated = new Date(data.updatedAt);
  setText('#updated-time', updated.toLocaleString(currentLocale, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  }));

  renderBankSyncStatus(data.bankSync);
}

// ── Load cycle ─────────────────────────────────────────────
export async function load() {
  clearTimeout(retryTimer);
  try {
    const data = await fetchBudget();
    // If the ledger is expanded, re-fetch the full month list too so
    // inline edits applied to expanded rows stay in sync. Best-effort.
    if (state.ledgerExpanded) {
      try {
        const monthRes = await fetch('/api/transactions/month', {
          cache: 'no-store',
          headers: { 'Accept': 'application/json' },
        });
        if (monthRes.ok) {
          const body = await monthRes.json();
          state.expandedTransactions = body.transactions || [];
        }
      } catch (err) {
        console.warn('month fetch failed:', err.message);
      }
    }
    render(data);
    if (state.reportExpanded) loadReport();
  } catch (err) {
    if (err.message === 'signed out') return;
    console.warn('fetch failed:', err.message);
    showError(err.message === 'warming up'
      ? 'Warming up the presses. Back shortly.'
      : `Could not fetch figures: ${err.message}`);
    retryTimer = setTimeout(load, RETRY_MS);
  }
}

// ── Manual refresh / bank sync (colophon taps) ─────────────
async function manualRefresh() {
  if (state.manualRefreshing) return;
  state.manualRefreshing = true;
  const btn = $('#refresh-button');
  btn?.classList.add('is-refreshing');
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    });
    // 202 = already refreshing server-side, fall through to reload
    if (!res.ok && res.status !== 202) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `http ${res.status}`);
    }
    await load();
  } catch (err) {
    console.warn('manual refresh failed:', err.message);
    showError(`Could not refresh: ${err.message}`);
  } finally {
    btn?.classList.remove('is-refreshing');
    state.manualRefreshing = false;
  }
}

async function manualBankSync() {
  if (state.manualSyncing) return;
  state.manualSyncing = true;
  const btn = $('#sync-button');
  btn?.classList.add('is-syncing');
  btn?.classList.remove('is-stale');
  // Optimistic label — shouldn't read "X hours ago" while actively syncing.
  setText('#sync-label', 'Banks');
  setText('#sync-time', 'pulling fresh data');
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok && res.status !== 202) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `http ${res.status}`);
    }
    await load();
  } catch (err) {
    console.warn('manual bank sync failed:', err.message);
    showError(`Bank sync failed: ${err.message}`);
  } finally {
    btn?.classList.remove('is-syncing');
    state.manualSyncing = false;
    if (state.lastData && state.lastData.bankSync) renderBankSyncStatus(state.lastData.bankSync);
  }
}

// ── Privacy toggle ─────────────────────────────────────────
function togglePrivacy() {
  setPrivacy(!isPrivacy());
  // Re-render with the last fetched data (no network round-trip)
  if (state.lastData) render(state.lastData);
}

// ── Wire up ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  load();
  refreshTimer = setInterval(load, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });

  // Apply any deferred render when the user finishes picking a category.
  // `focusout` bubbles (unlike `blur`), so one listener covers every
  // ledger select.
  document.addEventListener('focusout', (e) => {
    if (e.target && e.target.classList
        && e.target.classList.contains('ledger__category-select')) {
      // Small delay so the change handler's load() runs first and the
      // user's new selection is visually committed before re-render.
      setTimeout(() => {
        if (state.pendingRenderData && !isUserInteracting()) {
          const data = state.pendingRenderData;
          state.pendingRenderData = null;
          render(data);
        }
      }, 250);
    }
  });

  const retry = $('#error-retry');
  if (retry) retry.addEventListener('click', load);

  const refreshBtn = $('#refresh-button');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', manualRefresh);
    refreshBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manualRefresh(); }
    });
  }

  const syncBtn = $('#sync-button');
  if (syncBtn) {
    syncBtn.addEventListener('click', manualBankSync);
    syncBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manualBankSync(); }
    });
  }

  const ledgerExpandBtn = $('#ledger-expand');
  if (ledgerExpandBtn) ledgerExpandBtn.addEventListener('click', toggleLedgerExpand);

  wireSplitModal();

  // Privacy toggle — tap the masthead subtitle
  const privToggle = $('#privacy-toggle');
  if (privToggle) {
    privToggle.addEventListener('click', togglePrivacy);
    privToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePrivacy(); }
    });
  }

  if (isPrivacy()) document.body.classList.add('privacy-on');
  applySensitiveRevealed();

  // Collapsible section toggles — Accounts, Goals, Net Worth, Report.
  // One pattern: aria-expanded + is-expanded classes, persisted per key.
  for (const [toggleId, wrapId, storeKey, stateKey, onExpand] of [
    ['#accounts-toggle', '#accounts-wrap', 'fl-accounts-expanded', 'accountsExpanded', null],
    ['#goals-toggle', '#goals-wrap', 'fl-goals-expanded', 'goalsExpanded', null],
    ['#networth-toggle', '#networth-wrap', 'fl-networth-expanded', 'networthExpanded', null],
    ['#report-toggle', '#report-wrap', 'fl-report-expanded', 'reportExpanded', loadReport],
  ]) {
    const toggle = $(toggleId);
    const wrap = $(wrapId);
    const apply = () => {
      if (toggle) {
        toggle.setAttribute('aria-expanded', state[stateKey] ? 'true' : 'false');
        toggle.classList.toggle('is-expanded', state[stateKey]);
      }
      if (wrap) wrap.classList.toggle('is-expanded', state[stateKey]);
    };
    apply();
    if (state[stateKey] && onExpand) onExpand();
    if (toggle) {
      toggle.addEventListener('click', () => {
        state[stateKey] = !state[stateKey];
        localStorage.setItem(storeKey, state[stateKey] ? 'yes' : 'no');
        apply();
        if (state[stateKey] && onExpand) onExpand();
      });
    }
  }
});

// ── Service worker ─────────────────────────────────────────
// Registration silently no-ops on plain-HTTP LAN setups (no secure
// context); offline caching activates automatically behind HTTPS.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch(() => { /* expected over plain HTTP — no secure context */ });
  });
}
