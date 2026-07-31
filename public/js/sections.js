/* ─────────────────────────────────────────────────────────────
   The Family Ledger — sections.js
   Renderers for the dashboard cards: hero message, goals, accounts,
   category groups, net worth, the monthly report, bank-sync status.
   ───────────────────────────────────────────────────────────── */

import { $, el, fmt, fmtD, maskDigits, maskName, isPrivacy, ymShort, shortDate } from './util.js';
import { state, hiddenPayeeSet } from './state.js';
import { svgLineChart } from './chart.js';

// ── Hero message ───────────────────────────────────────────
// Pacing compares spending progress to calendar progress. When a
// base/discretionary split is configured the caller passes discretionary
// numbers (pre-committed bills firing on day 1 shouldn't read as "hot");
// otherwise it gets the plain totals.
export function heroMessage(spent, budgeted, dayOfMonth, daysInMonth) {
  if (budgeted === 0) return 'The month begins. Nothing set to paper yet.';
  const spentPct = (spent / budgeted) * 100;
  const dayPct   = (dayOfMonth / daysInMonth) * 100;
  const diff = spentPct - dayPct;

  if (dayOfMonth <= 2) return 'A fresh month. All ledgers are clean.';
  if (diff < -15) return 'Running comfortably ahead of pace. Well done.';
  if (diff < -5)  return 'A little under pace for this point in the month.';
  if (diff < 5)   return 'Holding steady — right on pace for the month.';
  if (diff < 15)  return 'A touch over pace. Worth a careful look.';
  return 'Running noticeably hot this month. Time to rein it in.';
}

// ── Masthead: derive issue number from a fixed epoch ───────
export function issueNumber() {
  const epoch = new Date('2026-01-06T00:00:00Z');
  const weeks = Math.max(1, Math.floor((Date.now() - epoch) / (7 * 24 * 3600 * 1000)) + 1);
  return weeks;
}

// ── Sensitive tap-to-reveal system ─────────────────────────
// Net-worth figures are the most sensitive numbers on the page — dollar
// amounts hide behind $•••,••• until tapped (body.reveal-sensitive,
// persisted). Privacy mode still masks the revealed value on top of this.
let sensitiveRevealed = localStorage.getItem('fl-sensitive-revealed') === 'yes';

export function applySensitiveRevealed() {
  document.body.classList.toggle('reveal-sensitive', sensitiveRevealed);
}

function toggleSensitiveReveal() {
  sensitiveRevealed = !sensitiveRevealed;
  localStorage.setItem('fl-sensitive-revealed', sensitiveRevealed ? 'yes' : 'no');
  applySensitiveRevealed();
}

function sensitiveRow(parent, label, amountText, tail, strong) {
  const row = el('div', 'fact-row');
  row.appendChild(el('span', 'fact-row__label', label));
  const v = el('span', 'fact-row__value fact-row__value--sensitive');
  if (strong) v.style.fontWeight = '700';
  v.setAttribute('role', 'button');
  v.setAttribute('tabindex', '0');
  v.setAttribute('aria-label', `${label}; tap to ${sensitiveRevealed ? 'hide' : 'reveal'}`);
  v.appendChild(el('span', 'sensitive-amount__masked', '$•••,•••'));
  v.appendChild(el('span', 'sensitive-amount__value', amountText));
  if (tail) v.appendChild(document.createTextNode(` ${tail}`));
  const toggle = (e) => { e.stopPropagation(); toggleSensitiveReveal(); };
  v.addEventListener('click', toggle);
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
  });
  row.appendChild(v);
  parent.appendChild(row);
}

// ── Goals section ──────────────────────────────────────────
export function buildGoalNode({ label, leftText, rightText, pct, fillClass, captionLeft, captionRight }) {
  const goal = el('div', 'goal');

  const header = el('div', 'goal__header');
  header.appendChild(el('span', 'goal__name', label));
  const amt = el('span', 'goal__amount');
  if (leftText) {
    amt.appendChild(el('span', 'goal__current', leftText));
    if (rightText) {
      amt.appendChild(el('span', 'goal__slash', ' / '));
      amt.appendChild(document.createTextNode(rightText));
    }
  } else if (rightText) {
    amt.appendChild(document.createTextNode(rightText));
  }
  header.appendChild(amt);
  goal.appendChild(header);

  const bar = el('div', 'goal__bar');
  const fill = el('div', `goal__bar-fill ${fillClass || ''}`.trim());
  bar.appendChild(fill);
  goal.appendChild(bar);

  const caption = el('p', 'goal__caption');
  caption.appendChild(el('span', '', captionLeft || ''));
  if (captionRight) caption.appendChild(el('strong', '', captionRight));
  goal.appendChild(caption);

  if (state.firstRender) {
    requestAnimationFrame(() => {
      setTimeout(() => { fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; }, 50);
    });
  } else {
    fill.style.transition = 'width 0.3s ease';
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  return goal;
}

// Config-driven goal cards (goals.json → server-resolved). Cards whose
// source is missing in Actual resolve to funded=null and are skipped.
// NOTE: goal values arrive in DOLLARS → fmtD, not fmt/fmtW.
// With no goals configured the whole section hides.
export function renderGoals(goals) {
  const container = $('#goals-container');
  if (!container) return;
  const section = container.closest('.section');
  const cards = (goals || []).filter(g => g.funded != null && g.target);
  if (cards.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';
  container.replaceChildren();

  for (const g of cards) {
    const pct = (g.funded / g.target) * 100;
    const caption = g.note || `${pct.toFixed(0)}% there`;
    container.appendChild(buildGoalNode({
      label: g.name,
      leftText: fmtD(g.funded),
      rightText: fmtD(g.target),
      pct,
      fillClass: pct >= 100 ? 'goal__bar-fill--forest' : '',
      captionLeft: isPrivacy() ? maskDigits(caption) : caption,
      captionRight: g.targetDate ? `by ${ymShort(g.targetDate)}` : null,
    }));
  }
}

// ── Accounts section ───────────────────────────────────────
const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];

const RETIREMENT_RE = /retirement|401\s*k|ira\b|roth|pension/i;
const MORTGAGE_RE   = /mortgage/i;

const isRetirement = (a) => RETIREMENT_RE.test(a.name || '');
const isMortgage   = (a) => MORTGAGE_RE.test(a.name || '');

function classifyAccount(acct) {
  if (acct.offbudget) return 'offbudget';
  if (/card|credit/i.test(acct.name || '')) return 'credit';
  return 'checking';
}

function accountSubtitle(acct) {
  if (acct.offbudget) {
    if (isRetirement(acct)) return 'off-budget · retirement';
    if (isMortgage(acct))   return 'off-budget · liability';
    if (acct.balance < 0)   return 'off-budget · debt owed';
    return 'off-budget · reserve';
  }
  const c = classifyAccount(acct);
  if (c === 'credit') return 'credit · balance owed';
  return 'on-budget · cash';
}

export function renderAccounts(accounts) {
  const container = $('#accounts-container');
  container.replaceChildren();

  // Zero-balance on-budget accounts are noise; off-budget accounts stay
  // visible even at zero (they usually represent something deliberate).
  const visible = (accounts || []).filter(a => a.balance !== 0 || a.offbudget);

  const checking = [];
  const credit = [];
  const offbudget = [];
  for (const a of visible) {
    const cls = classifyAccount(a);
    if (cls === 'credit') credit.push(a);
    else if (cls === 'offbudget') offbudget.push(a);
    else checking.push(a);
  }

  checking.sort((a, b) => b.balance - a.balance);
  credit.sort((a, b) => a.balance - b.balance);
  offbudget.sort((a, b) => b.balance - a.balance);

  let markIdx = 0;
  const addHeader = (label) => {
    container.appendChild(el('p', 'accounts__subheader', label));
  };

  const addRow = (acct) => {
    const row = el('div', 'account');
    row.appendChild(el('span', 'account__mark', ROMAN[markIdx++] || '—'));

    const nameWrap = el('div', 'account__name', maskName(acct.name));
    nameWrap.appendChild(el('small', '', accountSubtitle(acct)));
    row.appendChild(nameWrap);

    const bal = el('span', 'account__balance');
    bal.textContent = fmt(Math.abs(acct.balance));
    if (acct.balance < 0) {
      bal.classList.add('account__balance--negative');
      bal.textContent = '−' + bal.textContent;
    }
    if (acct.offbudget) bal.classList.add('account__balance--offbudget');
    row.appendChild(bal);

    container.appendChild(row);
  };

  if (checking.length > 0)  { addHeader('Cash & Checking');       checking.forEach(addRow); }
  if (credit.length > 0)    { addHeader('Credit Cards');          credit.forEach(addRow); }
  if (offbudget.length > 0) { addHeader('Off-Budget & Reserves'); offbudget.forEach(addRow); }

  // Grand total — liquid assets (cash + reserves + retirement at face).
  // Excludes only mortgage-like liabilities: long-horizon debt, not
  // cash-on-hand.
  const liquid = visible
    .filter(a => !isMortgage(a))
    .reduce((sum, a) => sum + a.balance, 0);

  const total = el('div', 'accounts__total');
  total.appendChild(el('span', 'accounts__total-label', 'Liquid cash & reserves'));
  const totalVal = el('span', 'accounts__total-value');
  const liquidValueText = fmt(Math.abs(liquid));
  totalVal.textContent = liquid < 0 ? '−' + liquidValueText : liquidValueText;
  total.appendChild(totalVal);
  container.appendChild(total);
}

// ── Groups section ─────────────────────────────────────────
export function renderGroups(groups) {
  const container = $('#groups-container');
  container.replaceChildren();

  // Everything that exists in Actual (minus hidden) is shown, even at
  // $0/$0 — parity with the user's Actual category list, not just
  // "active" categories.
  const sorted = [...(groups || [])].sort((a, b) => {
    const aActive = a.spent > 0 || a.budgeted > 0;
    const bActive = b.spent > 0 || b.budgeted > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) return (b.spent - a.spent) || (b.budgeted - a.budgeted);
    return a.name.localeCompare(b.name);
  });

  for (const group of sorted) {
    const wrap = el('div', 'group');
    if (group.budgeted === 0 && group.spent === 0) wrap.classList.add('group--empty');

    const isExpanded = state.expandedGroups.has(group.id);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'group__header';
    header.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    if (isExpanded) header.classList.add('is-expanded');
    header.appendChild(el('span', 'group__name', group.name));

    const amt = el('span', 'group__amount');
    amt.appendChild(document.createTextNode(fmt(group.spent) + ' '));
    amt.appendChild(el('span', 'group__amount--of', `of ${fmt(group.budgeted)}`));
    header.appendChild(amt);

    const chevron = el('span', 'group__chevron', '⌄');
    chevron.setAttribute('aria-hidden', 'true');
    header.appendChild(chevron);

    wrap.appendChild(header);

    const pct = group.budgeted > 0 ? (group.spent / group.budgeted) * 100 : 0;
    if (group.budgeted > 0 || group.spent > 0) {
      const bar = el('div', 'group__bar');
      const fill = el('div', 'group__bar-fill');
      if (pct > 100)      fill.classList.add('group__bar-fill--over');
      else if (pct > 90)  fill.classList.add('group__bar-fill--warn');
      bar.appendChild(fill);
      wrap.appendChild(bar);

      if (state.firstRender) {
        requestAnimationFrame(() => {
          setTimeout(() => { fill.style.width = `${Math.min(100, pct)}%`; }, 100);
        });
      } else {
        fill.style.transition = 'width 0.3s ease';
        fill.style.width = `${Math.min(100, pct)}%`;
      }
    }

    const lineItems = [...group.categories].sort((a, b) => {
      const aActive = a.spent > 0 || a.budgeted > 0;
      const bActive = b.spent > 0 || b.budgeted > 0;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (aActive) return (b.spent - a.spent) || (b.budgeted - a.budgeted);
      return a.name.localeCompare(b.name);
    });

    if (lineItems.length > 0) {
      // Collapsible wrapper using the grid-template-rows 0fr/1fr trick
      // for smooth slide-down without knowing content height in advance.
      const collapsibleWrap = el('div', 'group__categories-wrap');
      if (isExpanded) collapsibleWrap.classList.add('is-expanded');
      const inner = el('div', 'group__categories-inner');
      const ul = el('ul', 'group__categories');
      for (const c of lineItems) {
        const li = el('li', 'group__category');
        if (c.budgeted === 0 && c.spent === 0) li.classList.add('group__category--empty');
        li.appendChild(el('span', 'group__category-name', c.name));

        const catAmt = el('span', 'group__category-amount');
        catAmt.textContent = fmt(c.spent);
        catAmt.appendChild(el('small', '', ` / ${fmt(c.budgeted)}`));
        if (c.budgeted > 0 && c.spent > c.budgeted) {
          catAmt.classList.add('group__category-amount--over');
        }
        li.appendChild(catAmt);
        ul.appendChild(li);
      }
      inner.appendChild(ul);
      collapsibleWrap.appendChild(inner);
      wrap.appendChild(collapsibleWrap);

      header.addEventListener('click', () => {
        if (state.expandedGroups.has(group.id)) {
          state.expandedGroups.delete(group.id);
          header.classList.remove('is-expanded');
          collapsibleWrap.classList.remove('is-expanded');
          header.setAttribute('aria-expanded', 'false');
        } else {
          state.expandedGroups.add(group.id);
          header.classList.add('is-expanded');
          collapsibleWrap.classList.add('is-expanded');
          header.setAttribute('aria-expanded', 'true');
        }
      });
    } else {
      header.classList.add('group__header--no-children');
    }

    container.appendChild(wrap);
  }
}

// ── Net worth section ──────────────────────────────────────
// data.networth: {total, liquid, components, series} — total/liquid and
// component values in DOLLARS. The series accumulates from the server's
// monthly snapshots, so a fresh install grows its own chart over time;
// networth.json optionally adds manual assets (home, vehicles…).
export function renderNetworth(nw) {
  const container = $('#networth-container');
  if (!container) return;
  const section = container.closest('.section');
  if (!nw) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';
  container.replaceChildren();

  const head = el('div', 'goal goal--info');
  sensitiveRow(head, 'Total', fmtD(nw.total), null, true);
  sensitiveRow(head, 'Liquid', fmtD(nw.liquid), null, true);
  container.appendChild(head);

  const c = nw.components || {};
  const comp = el('div', 'goal goal--info');
  if (c.onBudget != null) sensitiveRow(comp, 'Cash accounts', fmtD(c.onBudget), '(checking · credit cards)');
  if (c.offAssets != null && c.offAssets !== 0) sensitiveRow(comp, 'Held assets', fmtD(c.offAssets), '(savings · investments)');
  const manual = c.manual != null ? c.manual : (c.home || 0) + (c.cars || 0);
  if (manual !== 0) sensitiveRow(comp, 'Other assets', fmtD(manual), '(from networth.json)');
  if (c.offDebts != null && c.offDebts !== 0) sensitiveRow(comp, 'All debts', `−${fmtD(Math.abs(c.offDebts))}`, '(loans & liabilities)');
  container.appendChild(comp);

  if (nw.series && nw.series.length > 1) {
    const wrap = el('div', 'hh-chart');
    const snapPts = nw.series.filter(s => s.source === 'snapshot').map(s => ({ ym: s.ym, v: s.total }));
    const otherPts = nw.series.filter(s => s.source !== 'snapshot').map(s => ({ ym: s.ym, v: s.total }));
    const series = [];
    if (otherPts.length) series.push({ points: otherPts, cls: 'hh-chart__line--networth' });
    if (snapPts.length) series.push({ points: snapPts, cls: 'hh-chart__line--networth', dots: true });
    const chart = svgLineChart({ series, height: 200, sensitiveY: true });
    if (chart) {
      wrap.appendChild(chart);
      container.appendChild(wrap);
    }
  }
}

// ── Monthly Reckoning (report) section ─────────────────────
// A digest: cash flow (income / spent / net), over-budget categories,
// the month's largest expenses, possible duplicate transactions, and the
// uncategorized tally. Cash-flow + over-budget come from cached budget
// data; the rest needs the full month list (fetched lazily).
export function renderReport() {
  const container = $('#report-container');
  if (!container || !state.lastData) return;
  container.replaceChildren();

  const hidden = hiddenPayeeSet();
  const txns = (state.reportTransactions || []).filter(t => !hidden.has(t.payee));
  const haveTxns = state.reportTransactions !== null;

  const head = (text) => container.appendChild(el('p', 'report__head', text));
  const caption = (text) => container.appendChild(el('p', 'report__caption', text));
  const row = (label, valueText, opts = {}) => {
    const r = el('div', 'report__row' + (opts.total ? ' report__row--total' : ''));
    r.appendChild(el('span', 'report__label', label));
    const v = el('span', 'report__val', valueText);
    if (opts.neg) v.classList.add('report__val--neg');
    if (opts.pos) v.classList.add('report__val--pos');
    r.appendChild(v);
    container.appendChild(r);
  };

  const data = state.lastData;
  const income = data.totals.income || 0;
  const spent = data.totals.spent || 0;
  const net = income - spent;
  head('Cash Flow');
  row('Income', fmt(income), { pos: income > 0 });
  if (data.incomePrediction && data.incomePrediction.predicted > 0) {
    const p = data.incomePrediction;
    row('Predicted (month end)', fmt(p.predicted), { pos: true });
    caption(p.basis);
  }
  row('Spent', fmt(spent));
  row('Net', (net < 0 ? '−' : '') + fmt(Math.abs(net)), { total: true, neg: net < 0, pos: net > 0 });
  if (data.app && data.app.baseSplitEnabled && data.totals.base && data.totals.discretionary) {
    caption(`Base ${fmt(data.totals.base.spent)} · Discretionary ${fmt(data.totals.discretionary.spent)}`);
  }

  const over = [];
  for (const g of data.categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.budgeted > 0 && c.spent > c.budgeted) over.push(c);
    }
  }
  over.sort((a, b) => (b.spent - b.budgeted) - (a.spent - a.budgeted));
  head('Over Budget');
  if (over.length === 0) {
    caption('Every category within budget.');
  } else {
    for (const c of over.slice(0, 8)) {
      row(c.name, `${fmt(c.spent)} of ${fmt(c.budgeted)}`, { neg: true });
    }
  }

  if (!haveTxns) { caption('Loading the month’s entries…'); return; }

  const expenses = txns.filter(t => (t.amount || 0) < 0)
    .sort((a, b) => a.amount - b.amount).slice(0, 6);
  head('Largest This Month');
  if (expenses.length === 0) caption('No expenses recorded yet.');
  for (const t of expenses) {
    row(`${shortDate(t.date)} · ${maskName(t.payee || 'Unknown')}`, fmt(Math.abs(t.amount)), { neg: true });
  }

  // Possible duplicates — same date + amount (expenses only)
  const byKey = {};
  for (const t of txns) {
    if ((t.amount || 0) >= 0) continue;
    const k = `${t.date}|${t.amount}`;
    (byKey[k] = byKey[k] || []).push(t);
  }
  const dups = Object.values(byKey).filter(g => g.length > 1);
  head('Possible Duplicates');
  if (dups.length === 0) {
    caption('None found — clean.');
  } else {
    for (const g of dups) {
      row(`${shortDate(g[0].date)} · ${maskName(g[0].payee || 'Unknown')}`,
        `${fmt(Math.abs(g[0].amount))} ×${g.length}`, { neg: true });
    }
  }

  // Split parents are categorized through their children, and transfers
  // can't carry a category at all — neither belongs in this nag count.
  const uncat = txns.filter(t => (t.amount || 0) < 0 && !t.categoryId && !t.isParent && !t.isTransfer);
  const uncatTotal = uncat.reduce((s, t) => s + Math.abs(t.amount || 0), 0);
  caption(`${uncat.length} uncategorized · ${fmt(uncatTotal)}`);
}

// Fetch the month transactions for the report's transaction-derived
// sections, then re-render. Best-effort: on failure the cache-based parts
// still show.
export async function loadReport() {
  if (!state.reportExpanded) return;
  try {
    const res = await fetch('/api/transactions/month', {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      state.reportTransactions = body.transactions || [];
    }
  } catch (err) {
    console.warn('report month fetch failed:', err.message);
  }
  renderReport();
}

// ── Bank-sync status line (colophon) ───────────────────────
// Distinct from cache.updatedAt — this is when the bank connectors last
// pulled fresh transactions. 'ok' (normal), 'partial' (some accounts
// failed; rest is fresh), 'failed' (nothing succeeded).
export function renderBankSyncStatus(bankSync) {
  const labelEl = $('#sync-label');
  const timeEl = $('#sync-time');
  const syncBtn = $('#sync-button');
  if (!labelEl || !timeEl || !syncBtn) return;

  // Don't override the syncing state — the manual-sync handler owns it
  // until the request settles.
  if (state.manualSyncing) return;

  syncBtn.classList.remove('is-stale', 'is-partial');

  if (!bankSync || !bankSync.lastSyncAt) {
    labelEl.textContent = 'Banks · not yet synced';
    timeEl.textContent = 'tap to pull';
    return;
  }

  const ageMin = Math.floor((Date.now() - new Date(bankSync.lastSyncAt).getTime()) / 60000);
  let humanAge;
  if (ageMin < 1)         humanAge = 'just now';
  else if (ageMin < 60)   humanAge = `${ageMin}m ago`;
  else if (ageMin < 1440) humanAge = `${Math.floor(ageMin / 60)}h ago`;
  else                    humanAge = `${Math.floor(ageMin / 1440)}d ago`;

  const status = bankSync.lastSyncStatus;
  const failedNames = (bankSync.results || []).filter(r => !r.ok).map(r => r.name);

  if (status === 'failed') {
    labelEl.textContent = 'Banks · last sync failed';
    timeEl.textContent = humanAge;
    syncBtn.classList.add('is-stale');
    syncBtn.setAttribute('aria-label',
      `Last bank sync failed: ${bankSync.lastSyncError || 'unknown error'}. Tap to retry.`);
    return;
  }

  if (status === 'partial') {
    const failList = failedNames.length > 0
      ? `${failedNames.length === 1 ? '' : `${failedNames.length} of ${bankSync.results.length} accts: `}${failedNames.join(', ')}`
      : '';
    labelEl.textContent = failedNames.length === 1
      ? `Banks synced · ${failList} stuck`
      : `Banks · ${failList} stuck`;
    timeEl.textContent = humanAge;
    syncBtn.classList.add('is-partial');
    syncBtn.setAttribute('aria-label',
      `Banks synced ${humanAge}, but ${failedNames.join(', ')} failed: ${bankSync.lastSyncError || ''}. Tap to retry.`);
    return;
  }

  labelEl.textContent = 'Banks last synced';
  timeEl.textContent = humanAge;
  // Older than 6 hours feels stale given the default 2h auto interval.
  if (ageMin > 360) syncBtn.classList.add('is-stale');
  syncBtn.setAttribute('aria-label',
    `Banks last synced ${humanAge}. Tap to pull fresh transactions now.`);
}
