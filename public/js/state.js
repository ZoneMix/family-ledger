/* ─────────────────────────────────────────────────────────────
   The Family Ledger — state.js
   Shared mutable UI state. A single object so every module reads
   and writes the same live values (ES module `let` exports are
   read-only from the importer's side).
   ───────────────────────────────────────────────────────────── */

export const state = {
  lastData: null,       // last successful /api/budget payload (privacy re-render)
  firstRender: true,    // entrance animations only on initial page load

  // Interaction-preserving render:
  // If the user is mid-interaction with a ledger category <select> (OS
  // picker open on mobile), rebuilding the DOM would orphan-dismiss the
  // picker. Renders are deferred while interacting and applied on blur.
  pendingRenderData: null,
  modalOpen: false,

  // Ledger expand/collapse — expanded shows ALL month transactions
  // (GET /api/transactions/month) instead of the recent slice.
  ledgerExpanded: false,
  expandedTransactions: null,

  // Collapsible sections. Expanded groups tracked by id in a Set so
  // renders don't reset the user's open/closed choices; section-level
  // toggles persist to localStorage.
  expandedGroups: new Set(),
  accountsExpanded: localStorage.getItem('fl-accounts-expanded') === 'yes',
  goalsExpanded: localStorage.getItem('fl-goals-expanded') === 'yes',
  networthExpanded: localStorage.getItem('fl-networth-expanded') === 'yes',
  reportExpanded: localStorage.getItem('fl-report-expanded') === 'yes',
  reportTransactions: null,

  // In-flight flags for the colophon tap targets.
  manualRefreshing: false,
  manualSyncing: false,
};

export function isUserInteracting() {
  if (state.modalOpen) return true;
  const active = document.activeElement;
  if (!active || !active.classList) return false;
  return active.classList.contains('ledger__category-select');
}

// Payees the server considers internal bookkeeping (from app.hiddenPayees).
// Filtered from the ledger and report as a belt-and-suspenders guarantee —
// the server already filters its endpoints.
export function hiddenPayeeSet() {
  const fromServer = state.lastData && state.lastData.app && state.lastData.app.hiddenPayees;
  return new Set(Array.isArray(fromServer) && fromServer.length ? fromServer : ['Starting Balance']);
}
