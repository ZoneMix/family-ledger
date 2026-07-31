// src/refresh.js — builds the cached /api/budget payload from Actual.
// createRefreshEngine() returns a small stateful object (cache, in-flight
// flag, last error, bank-sync telemetry) rather than module-level `let`s,
// so server.js owns the single instance explicitly instead of relying on
// import-time singletons.

import { api, getAccountBalances, findCategory, getRecentTransactions } from './actual.js';
import { buildNetworth, buildGoals } from './networth.js';

const RECENT_FETCH_LIMIT = 40;
const RECENT_DISPLAY_LIMIT = 20;
const INCOME_LOOKBACK_MONTHS = 3;

// Month string (YYYY-MM) in the configured timezone — avoids UTC rollover bugs.
export function currentMonth(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  return `${year}-${month}`;
}

function localDayInfo(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());
  const y = parseInt(parts.find(p => p.type === 'year').value, 10);
  const m = parseInt(parts.find(p => p.type === 'month').value, 10);
  const d = parseInt(parts.find(p => p.type === 'day').value, 10);
  const daysInMonth = new Date(y, m, 0).getDate();
  return { day: d, daysInMonth, year: y, monthNum: m };
}

export function mapTransaction(t) {
  return {
    id: t.id,
    date: t.date,
    amount: t.amount,
    payee: t['payee.name'],
    categoryId: t.category,
    category: t['category.name'],
    account: t['account.name'],
    isParent: !!t.is_parent,
    // Transfers between accounts can't carry a category in Actual —
    // flagged so the frontend doesn't count them as "uncategorized".
    isTransfer: !!t.transfer_id,
  };
}

// Strip hidden and income groups for the "Where It's Going" spending
// display — income categories shouldn't appear there. Amounts are
// normalized to positive; `balance` stays signed (negative = overspent).
function buildVisibleGroups(budgetMonth) {
  const pos = (v) => Math.abs(v || 0);
  const signed = (v) => v || 0;
  return (budgetMonth.categoryGroups || [])
    .filter(g => !g.hidden && !g.is_income)
    .filter(g => (g.categories || []).some(c => !c.hidden))
    .map(g => ({
      id: g.id,
      name: g.name,
      budgeted: pos(g.budgeted),
      spent: pos(g.spent),
      balance: signed(g.balance),
      categories: (g.categories || [])
        .filter(c => !c.hidden)
        .map(c => ({
          id: c.id,
          name: c.name,
          budgeted: pos(c.budgeted),
          spent: pos(c.spent),
          balance: signed(c.balance),
        })),
    }));
}

// Flat dropdown options for the inline category picker — INCLUDES income
// groups (so a transaction can be recategorized as "Income") unlike
// buildVisibleGroups above.
function buildDropdownGroups(budgetMonth) {
  return (budgetMonth.categoryGroups || [])
    .filter(g => !g.hidden)
    .filter(g => (g.categories || []).some(c => !c.hidden))
    .map(g => ({
      groupName: g.name,
      isIncome: !!g.is_income,
      items: (g.categories || [])
        .filter(c => !c.hidden)
        .map(c => ({ id: c.id, name: c.name })),
    }));
}

// Split spending into "base" (the user's configured fixed/committed
// categories) vs "discretionary" (everything else), only when the deployer
// has opted in via config.json's baseCategories.
function splitBaseDiscretionary(visibleGroups, baseCategories) {
  const baseSet = new Set(baseCategories);
  let baseBudgeted = 0, baseSpent = 0, discretionaryBudgeted = 0, discretionarySpent = 0;
  for (const g of visibleGroups) {
    for (const c of g.categories) {
      if (baseSet.has(c.name)) {
        baseBudgeted += c.budgeted;
        baseSpent += c.spent;
      } else {
        discretionaryBudgeted += c.budgeted;
        discretionarySpent += c.spent;
      }
    }
  }
  return {
    base: { budgeted: baseBudgeted, spent: baseSpent },
    discretionary: { budgeted: discretionaryBudgeted, spent: discretionarySpent },
  };
}

// Predicted month-end income: average of the last N full months of
// "Income"-categorized transactions. Non-fatal — the field is just absent
// if there's no Income category or the query fails.
async function buildIncomePrediction({ findCat, month, log }) {
  try {
    const incomeCat = findCat('Income');
    if (!incomeCat) return null;
    const [py, pm] = month.split('-').map(Number);
    const s = new Date(py, pm - 1 - INCOME_LOOKBACK_MONTHS, 1);
    const startStr = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-01`;
    const iq = api.q('transactions')
      .filter({ category: incomeCat.id, date: { $gte: startStr } })
      .select(['date', 'amount']);
    const ir = await api.runQuery(iq);
    const priorSum = (ir.data || [])
      .filter(t => t.date < `${month}-01`)
      .reduce((acc, t) => acc + (t.amount || 0), 0);
    const avg3 = Math.round(priorSum / INCOME_LOOKBACK_MONTHS);
    return { predicted: avg3, avg3, basis: `avg of the last ${INCOME_LOOKBACK_MONTHS} months` };
  } catch (err) {
    log('income prediction failed (non-fatal):', err.message);
    return null;
  }
}

export function createRefreshEngine({ config, log }) {
  let cache = null;
  let refreshing = false;
  let lastError = null;
  let bankSyncTelemetry = {
    lastSyncAt: null,
    lastSyncStatus: 'none',
    lastSyncError: null,
    lastSyncDurationMs: null,
    results: [],
  };

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const started = Date.now();
    try {
      log('refresh started');
      await api.sync();

      const month = currentMonth(config.tz);
      const day = localDayInfo(config.tz);

      const budgetMonth = await api.getBudgetMonth(month);
      const accountsRaw = await api.getAccounts();
      const accountBalances = await getAccountBalances(accountsRaw);
      const findCat = (name) => findCategory(budgetMonth, name);

      const recent = await getRecentTransactions(RECENT_FETCH_LIMIT);
      const recentFiltered = recent.filter(t => !t.is_child).slice(0, RECENT_DISPLAY_LIMIT);

      const visibleGroups = buildVisibleGroups(budgetMonth);
      const dropdownGroups = buildDropdownGroups(budgetMonth);

      const totals = {
        budgeted: Math.abs(budgetMonth.totalBudgeted || 0),
        spent: Math.abs(budgetMonth.totalSpent || 0),
        income: Math.abs(budgetMonth.totalIncome || 0),
        toBudget: budgetMonth.toBudget || 0, // can legitimately be negative
      };
      const baseSplitEnabled = config.app.baseCategories.length > 0;
      if (baseSplitEnabled) {
        const split = splitBaseDiscretionary(visibleGroups, config.app.baseCategories);
        totals.base = split.base;
        totals.discretionary = split.discretionary;
      } else {
        totals.base = null;
        totals.discretionary = null;
      }

      const incomePrediction = await buildIncomePrediction({ findCat, month, log });

      let networth = null;
      try {
        networth = buildNetworth({
          accountsRaw, accountBalances, month,
          manualAssets: config.networth, stateDir: config.stateDir, log,
        });
      } catch (err) {
        log('networth build failed (non-fatal):', err.message);
      }

      const goals = buildGoals({ goalsConfig: config.goals, findCat, accountsRaw, accountBalances });

      cache = {
        month,
        dayOfMonth: day.day,
        daysInMonth: day.daysInMonth,
        year: day.year,
        monthNum: day.monthNum,
        updatedAt: new Date().toISOString(),
        app: {
          title: config.appTitle,
          currency: config.currency,
          locale: config.locale,
          baseSplitEnabled,
          hiddenPayees: config.app.hiddenPayees,
        },
        totals,
        categoryGroups: visibleGroups,
        accounts: accountsRaw
          .filter(a => !a.closed)
          .map(a => ({ id: a.id, name: a.name, offbudget: a.offbudget, balance: accountBalances[a.id] || 0 })),
        recentTransactions: recentFiltered.map(mapTransaction),
        categoryOptions: dropdownGroups,
        incomePrediction,
        networth,
        goals,
        bankSync: { ...bankSyncTelemetry },
      };

      lastError = null;
      log(`refresh complete in ${Date.now() - started}ms (${visibleGroups.length} groups, ${cache.recentTransactions.length} recent txns)`);
    } catch (err) {
      lastError = err.message;
      log('refresh FAILED:', err.message);
    } finally {
      refreshing = false;
    }
  }

  return {
    refresh,
    getCache: () => cache,
    isRefreshing: () => refreshing,
    getLastError: () => lastError,
    getBankSyncTelemetry: () => bankSyncTelemetry,
    setBankSyncTelemetry: (telemetry) => { bankSyncTelemetry = telemetry; },
  };
}
