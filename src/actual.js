// src/actual.js — thin wrapper around @actual-app/api: connection
// lifecycle plus the handful of query helpers shared by refresh.js,
// bank-sync.js, and routes.js. Anything endpoint-specific (splits,
// mutations) stays in routes.js and calls `api` directly.

import api from '@actual-app/api';

export async function initActual(config) {
  await api.init({
    dataDir: config.actualDataDir,
    serverURL: config.actualServerUrl,
    password: config.actualPassword,
  });
  await api.downloadBudget(config.actualSyncId);
}

export async function shutdownActual() {
  try {
    await api.shutdown();
  } catch {
    // best-effort on process exit — nothing left to recover into
  }
}

// Actual's getAccountBalance() only returns a value for accounts synced by
// a bank connector; manually-created accounts need the balance derived
// from a transaction sum instead, so we always compute it ourselves.
export async function getAccountBalances(accountsRaw) {
  const balances = {};
  for (const acct of accountsRaw) {
    const query = api.q('transactions')
      .filter({ account: acct.id })
      .calculate({ $sum: '$amount' });
    const r = await api.runQuery(query);
    balances[acct.id] = r.data || 0;
  }
  return balances;
}

export function findCategory(budgetMonth, name) {
  for (const g of budgetMonth.categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.name === name) return c;
    }
  }
  return null;
}

// Newest-first transactions with joined payee/category/account labels.
// `is_parent`/`is_child` let callers hide split children so the ledger
// shows one row per whole transaction.
const TRANSACTION_FIELDS = [
  'id', 'date', 'amount',
  'payee.name', 'category', 'category.name', 'account.name',
  'is_parent', 'is_child',
];

// splits: 'all' is load-bearing: ActualQL's default ('inline') OMITS split
// parents and returns only the children — combined with the !is_child
// filter above, a split transaction would vanish from the ledger entirely.
// 'all' returns parent AND children as rows; callers keep the parent.
export async function getRecentTransactions(limit) {
  const q = api.q('transactions')
    .options({ splits: 'all' })
    .select(TRANSACTION_FIELDS)
    .orderBy({ date: 'desc' })
    .orderBy({ amount: 'desc' })
    .limit(limit);
  const r = await api.runQuery(q);
  return r.data || [];
}

export async function getMonthTransactions(start, end) {
  // Dates come back as "YYYY-MM-DD" strings so lexicographic comparison
  // via $gte/$lte is correct.
  const q = api.q('transactions')
    .options({ splits: 'all' })
    .filter({ date: { $gte: start, $lte: end } })
    .select(TRANSACTION_FIELDS)
    .orderBy({ date: 'desc' })
    .orderBy({ amount: 'desc' });
  const r = await api.runQuery(q);
  return r.data || [];
}

export { api };
