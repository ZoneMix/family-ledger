/* ─────────────────────────────────────────────────────────────
   The Family Ledger — ledger.js
   Recent Entries: the transaction list with inline category
   re-assignment, full-month expand, and the split-transaction modal.
   ───────────────────────────────────────────────────────────── */

import {
  $, el, fmt, maskName, setText, showError, hideError,
  parseAmountToCents, MONTH_NAMES_SHORT,
} from './util.js';
import { state, hiddenPayeeSet } from './state.js';
import { load, render } from './main.js';

// ── Ledger entries ─────────────────────────────────────────
export function renderLedger(transactions, categoryOptions) {
  const list = $('#ledger-list');
  list.replaceChildren();

  // Skip internal bookkeeping transactions (server-configured payees) —
  // they shouldn't appear in the human-facing feed. The server already
  // filters its endpoints; this is belt-and-suspenders.
  const hidden = hiddenPayeeSet();

  // In recent mode, show 14. In expanded mode, show all month txns.
  const limit = state.ledgerExpanded ? Number.POSITIVE_INFINITY : 14;
  const visible = (transactions || [])
    .filter(t => !hidden.has(t.payee))
    .slice(0, limit);

  for (const t of visible) {
    const li = el('li', 'ledger__entry');
    if (t.isParent) li.classList.add('ledger__entry--split');

    const dateCell = el('div', 'ledger__date');
    if (t.date) {
      const parts = t.date.split('-');
      const mIdx = parseInt(parts[1], 10) - 1;
      const dayNum = parseInt(parts[2], 10);
      dateCell.appendChild(el('strong', '', String(dayNum)));
      dateCell.appendChild(el('span', '', MONTH_NAMES_SHORT[mIdx] || ''));
    } else {
      dateCell.appendChild(el('strong', '', '—'));
    }
    li.appendChild(dateCell);

    const detail = el('div', 'ledger__detail');
    detail.appendChild(el('span', 'ledger__payee', maskName(t.payee || 'Unknown')));

    // Category slot — split parents get a static label (v1 edits existing
    // splits in the Actual UI); everything else gets the inline picker,
    // including uncategorized rows (italic faded pill, same picker).
    if (t.isParent) {
      detail.appendChild(el('span', 'ledger__category-split', '↔ split across categories'));
    } else {
      detail.appendChild(buildCategorySelect(t, categoryOptions));
    }
    li.appendChild(detail);

    // Amount is a real <button> — tapping it opens the split modal.
    const amtBtn = document.createElement('button');
    amtBtn.type = 'button';
    amtBtn.className = 'ledger__amount';
    if (t.isParent) amtBtn.classList.add('ledger__amount--is-split');
    const isPositive = (t.amount || 0) > 0;
    amtBtn.textContent = fmt(Math.abs(t.amount || 0));
    if (isPositive) amtBtn.classList.add('ledger__amount--positive');
    amtBtn.setAttribute('aria-label',
      t.isParent
        ? `Already split; open Actual Budget to edit — ${fmt(Math.abs(t.amount || 0))}`
        : `Split this transaction — ${fmt(Math.abs(t.amount || 0))}`
    );
    amtBtn.addEventListener('click', () => {
      if (t.isParent) {
        showError('This transaction is already split. Edit it in the Actual Budget UI.');
        setTimeout(hideError, 3500);
        return;
      }
      openSplitModal(t, categoryOptions);
    });
    li.appendChild(amtBtn);

    list.appendChild(li);
  }

  if (visible.length === 0) {
    const empty = el('li', 'ledger__entry');
    empty.style.textAlign = 'center';
    empty.style.fontStyle = 'italic';
    empty.style.color = 'var(--ink-faded)';
    empty.textContent = 'No recent entries to show.';
    list.appendChild(empty);
  }
}

// Build the inline category picker using an OVERLAY pattern: a visible
// <span> shows the current category name and a caret, with a native
// <select> absolutely-positioned on top at opacity: 0. (A native select
// with width: fit-content sizes to the LONGEST option, not the selected
// one — the overlay lets the visible text size itself perfectly while the
// invisible select covers the tap target.) The select keeps the class
// `ledger__category-select` so the defer-render focus logic still works.
function buildCategorySelect(t, categoryOptions) {
  const wrap = document.createElement('span');
  wrap.className = 'ledger__category-pill';
  if (!t.categoryId) wrap.classList.add('ledger__category-pill--uncategorized');

  const display = document.createElement('span');
  display.className = 'ledger__category-display';
  display.textContent = t.category || '— uncategorized —';

  const caret = document.createElement('span');
  caret.className = 'ledger__category-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';

  const select = document.createElement('select');
  select.className = 'ledger__category-select';
  select.setAttribute('aria-label', `Category for ${t.payee || 'transaction'}`);

  // Sentinel for uncategorized — verb form when there's a category to
  // clear, status form when the row is already uncategorized.
  const uncat = document.createElement('option');
  uncat.value = '';
  uncat.textContent = t.categoryId ? '— uncategorize —' : '— uncategorized —';
  select.appendChild(uncat);

  if (Array.isArray(categoryOptions)) {
    for (const group of categoryOptions) {
      const og = document.createElement('optgroup');
      og.label = group.groupName;
      for (const item of group.items || []) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.name;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
  }

  select.value = t.categoryId || '';
  const prevValue = select.value;

  select.addEventListener('change', async (e) => {
    const newValue = e.target.value;
    select.disabled = true;
    wrap.classList.add('is-saving');
    // Optimistic display update so the user sees the new category
    // immediately, before the server round-trip completes.
    const selectedOpt = select.options[select.selectedIndex];
    if (selectedOpt) display.textContent = selectedOpt.textContent;
    wrap.classList.toggle('ledger__category-pill--uncategorized', !newValue);
    try {
      const res = await fetch(`/api/transactions/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: newValue || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `http ${res.status}`);
      }
      await load();
    } catch (err) {
      console.warn('category update failed:', err.message);
      showError(`Could not update category: ${err.message}`);
      select.value = prevValue;
      const revertOpt = select.options[select.selectedIndex];
      if (revertOpt) display.textContent = revertOpt.textContent;
      wrap.classList.toggle('ledger__category-pill--uncategorized', !prevValue);
    } finally {
      select.disabled = false;
      wrap.classList.remove('is-saving');
    }
  });

  wrap.appendChild(display);
  wrap.appendChild(caret);
  wrap.appendChild(select);
  return wrap;
}

// ── Ledger expand/collapse ─────────────────────────────────
export async function toggleLedgerExpand() {
  const btn = $('#ledger-expand');
  if (!btn || btn.disabled) return;

  if (state.ledgerExpanded) {
    state.ledgerExpanded = false;
    state.expandedTransactions = null;
    btn.setAttribute('aria-expanded', 'false');
    if (state.lastData) {
      renderLedger(state.lastData.recentTransactions || [], state.lastData.categoryOptions || []);
    }
    setText('#ledger-expand-label', 'Show all entries this month');
    btn.classList.remove('is-expanded');
    return;
  }

  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const res = await fetch('/api/transactions/month', {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `http ${res.status}`);
    }
    const body = await res.json();
    state.expandedTransactions = body.transactions || [];
    state.ledgerExpanded = true;
    btn.setAttribute('aria-expanded', 'true');
    renderLedger(state.expandedTransactions, (state.lastData && state.lastData.categoryOptions) || []);
    setText('#ledger-expand-label', `Show recent only (${body.count} this month)`);
    btn.classList.add('is-expanded');
  } catch (err) {
    console.warn('ledger expand failed:', err.message);
    showError(`Could not load month: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

// ── Split transaction modal ────────────────────────────────
// Opened by tapping the amount in a ledger entry. Lets the user carve a
// single transaction into (category, amount) allocations that must sum to
// the parent total. Backed by POST /api/transactions/:id/split.

let splitModalTransaction = null;
let splitModalCategoryOptions = null;

function buildSplitCategorySelect() {
  const select = document.createElement('select');
  select.className = 'split-row__category';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— pick a category —';
  select.appendChild(blank);
  if (Array.isArray(splitModalCategoryOptions)) {
    for (const group of splitModalCategoryOptions) {
      const og = document.createElement('optgroup');
      og.label = group.groupName;
      for (const item of group.items || []) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.name;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
  }
  return select;
}

function buildSplitRow(defaultAmountCents = 0, defaultCategoryId = '') {
  const row = el('div', 'split-row');

  const catSelect = buildSplitCategorySelect();
  if (defaultCategoryId) catSelect.value = defaultCategoryId;
  catSelect.addEventListener('change', updateSplitTotals);
  row.appendChild(catSelect);

  const amtInput = document.createElement('input');
  amtInput.type = 'text';
  amtInput.inputMode = 'decimal';
  amtInput.pattern = '-?[0-9]*(\\.[0-9]{1,2})?';
  amtInput.className = 'split-row__amount';
  amtInput.placeholder = '0.00';
  amtInput.value = defaultAmountCents ? (defaultAmountCents / 100).toFixed(2) : '';
  amtInput.setAttribute('aria-label', 'Split amount');
  amtInput.addEventListener('input', updateSplitTotals);
  row.appendChild(amtInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'split-row__remove';
  removeBtn.setAttribute('aria-label', 'Remove this split row');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateSplitTotals();
  });
  row.appendChild(removeBtn);

  return row;
}

function currentSplitRows() {
  return Array.from(document.querySelectorAll('#split-modal-rows .split-row'));
}

function readSplitRow(row) {
  const catEl = row.querySelector('.split-row__category');
  const amtEl = row.querySelector('.split-row__amount');
  const categoryId = catEl && catEl.value ? catEl.value : null;
  const amountCents = amtEl ? parseAmountToCents(amtEl.value) : null;
  return { categoryId, amountCents };
}

function updateSplitTotals() {
  if (!splitModalTransaction) return;
  const parentAmount = splitModalTransaction.amount;  // signed cents
  const parentSign = parentAmount < 0 ? -1 : 1;
  const rows = currentSplitRows();

  let allocatedAbs = 0;
  let anyInvalid = false;
  let anyMissingCategory = false;

  for (const row of rows) {
    const { categoryId, amountCents } = readSplitRow(row);
    if (amountCents === null || amountCents === 0) {
      anyInvalid = true;
      continue;
    }
    if (!categoryId) anyMissingCategory = true;
    allocatedAbs += Math.abs(amountCents);
  }

  const parentAbs = Math.abs(parentAmount);
  const remainingAbs = parentAbs - allocatedAbs;

  const allocatedEl = $('#split-allocated');
  const remainingEl = $('#split-remaining');
  if (allocatedEl) allocatedEl.textContent = fmt(allocatedAbs * parentSign);
  if (remainingEl) {
    if (remainingAbs === 0) {
      remainingEl.textContent = '· balanced';
      remainingEl.className = 'split-modal__totals-remaining is-ok';
    } else if (remainingAbs > 0) {
      remainingEl.textContent = `· ${fmt(remainingAbs)} remaining`;
      remainingEl.className = 'split-modal__totals-remaining';
    } else {
      remainingEl.textContent = `· ${fmt(Math.abs(remainingAbs))} over`;
      remainingEl.className = 'split-modal__totals-remaining is-over';
    }
  }

  const saveBtn = $('#split-modal-save');
  if (saveBtn) {
    const canSave = !anyInvalid && !anyMissingCategory
      && remainingAbs === 0 && rows.length >= 2;
    saveBtn.disabled = !canSave;
  }
}

function openSplitModal(transaction, categoryOptions) {
  splitModalTransaction = transaction;
  splitModalCategoryOptions = categoryOptions;
  state.modalOpen = true;

  setText('#split-parent-payee', maskName(transaction.payee || 'Unknown'));
  setText('#split-parent-date', transaction.date || '—');
  setText('#split-parent-amount', fmt(transaction.amount || 0));

  const rowsContainer = $('#split-modal-rows');
  rowsContainer.replaceChildren();
  // Seed with two empty rows — a split almost always starts at 2.
  rowsContainer.appendChild(buildSplitRow());
  rowsContainer.appendChild(buildSplitRow());

  updateSplitTotals();

  const modal = $('#split-modal');
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

export function closeSplitModal() {
  const modal = $('#split-modal');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');

  splitModalTransaction = null;
  splitModalCategoryOptions = null;
  state.modalOpen = false;

  // Apply any render that was deferred while the modal was open
  if (state.pendingRenderData) {
    const data = state.pendingRenderData;
    state.pendingRenderData = null;
    render(data);
  }
}

export async function submitSplit() {
  if (!splitModalTransaction) return;
  const parentAmount = splitModalTransaction.amount;
  const parentSign = parentAmount < 0 ? -1 : 1;

  const splits = currentSplitRows().map(row => {
    const { categoryId, amountCents } = readSplitRow(row);
    return {
      category: categoryId,
      // User types positive amounts; preserve the parent's sign
      amount: amountCents !== null ? Math.abs(amountCents) * parentSign : null,
    };
  });

  const saveBtn = $('#split-modal-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const res = await fetch(
      `/api/transactions/${splitModalTransaction.id}/split`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splits }),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `http ${res.status}`);
    }
    closeSplitModal();
    await load();
  } catch (err) {
    console.warn('split failed:', err.message);
    showError(`Could not split: ${err.message}`);
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save splits';
  }
}

// Wire the modal's static buttons; called once from main.js on DOM ready.
export function wireSplitModal() {
  const splitClose = $('#split-modal-close');
  const splitCancel = $('#split-modal-cancel');
  const splitBackdrop = $('#split-modal-backdrop');
  const splitAdd = $('#split-modal-add');
  const splitSave = $('#split-modal-save');
  if (splitClose)    splitClose.addEventListener('click', closeSplitModal);
  if (splitCancel)   splitCancel.addEventListener('click', closeSplitModal);
  if (splitBackdrop) splitBackdrop.addEventListener('click', closeSplitModal);
  if (splitAdd) {
    splitAdd.addEventListener('click', () => {
      const rows = $('#split-modal-rows');
      rows.appendChild(buildSplitRow());
      updateSplitTotals();
    });
  }
  if (splitSave) splitSave.addEventListener('click', submitSplit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalOpen) closeSplitModal();
  });
}
