// src/transactions-routes.js — the transaction-mutation surface: the
// full-month ledger list, inline category reassignment, and splitting a
// transaction into multiple allocations.

import express from 'express';
import { api, getMonthTransactions } from './actual.js';
import { currentMonth, mapTransaction } from './refresh.js';
import { readOnlyGuard } from './read-only.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTransactionsRouter({ config, refreshEngine, log }) {
  const router = express.Router();

  // Full-month transaction list for the "expand ledger" view — /api/budget
  // only returns the most recent 20. Query: ?month=YYYY-MM (default: now).
  router.get('/api/transactions/month', async (req, res) => {
    const monthParam = (req.query.month || currentMonth(config.tz)).toString();
    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const [y, m] = monthParam.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const start = `${monthParam}-01`;
    const end = `${monthParam}-${String(lastDay).padStart(2, '0')}`;

    try {
      const rows = await getMonthTransactions(start, end);
      const hiddenPayees = new Set(config.app.hiddenPayees);
      const transactions = rows
        .filter(t => !t.is_child)
        .filter(t => !hiddenPayees.has(t['payee.name']))
        .map(mapTransaction);
      res.json({ month: monthParam, count: transactions.length, transactions });
    } catch (err) {
      log('month transactions query failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Category reassignment from the inline dropdown in the ledger. Only
  // `category` is mutable via this endpoint. UUID shape-checked so
  // obviously bad ids never reach the SDK layer.
  router.patch('/api/transactions/:id', readOnlyGuard(config), async (req, res) => {
    const { id } = req.params;
    const { category } = req.body || {};
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid transaction id' });
    }
    if (category !== null && !UUID_RE.test(category || '')) {
      return res.status(400).json({ error: 'invalid category id' });
    }
    try {
      await api.updateTransaction(id, { category });
      log(`mutated transaction ${id} category → ${category}`);
      // Not awaited — the client re-fetches /api/budget after this PATCH
      // returns, which races the refresh harmlessly.
      refreshEngine.refresh().catch(err => log('post-mutation refresh failed:', err.message));
      res.json({ status: 'updated', id, category });
    } catch (err) {
      log('mutate transaction failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Split a transaction into multiple child allocations.
  // Body: { splits: [{ category: "<uuid>|null", amount: <int cents>, notes: "..." }, ...] }
  // Rules: at least 2 splits, integer-cent amounts, sum must equal the
  // parent amount exactly, and the parent must not already be a split.
  router.post('/api/transactions/:id/split', readOnlyGuard(config), async (req, res) => {
    const { id } = req.params;
    const { splits } = req.body || {};

    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid transaction id' });
    }
    if (!Array.isArray(splits) || splits.length < 2) {
      return res.status(400).json({ error: 'at least 2 splits required' });
    }
    for (const s of splits) {
      if (typeof s.amount !== 'number' || !Number.isInteger(s.amount)) {
        return res.status(400).json({ error: 'split amount must be integer cents' });
      }
      if (s.category != null && !UUID_RE.test(s.category)) {
        return res.status(400).json({ error: 'invalid split category id' });
      }
    }

    try {
      // @actual-app/api 26.0-26.7 couldn't convert an existing transaction
      // into a split via updateTransaction (it silently orphaned the
      // children); upstream fixed this in 26.8.0 (actualbudget/actual PR
      // #8467, "Fix updateTransaction crash when converting a transaction
      // to a split"). Re-tested directly against 26.9.0 on 2026-09-09 —
      // updateTransaction now correctly produces one parent + N children,
      // preserves imported_id/payee/date/cleared, and survives sync() and
      // a fresh downloadBudget — so the native path replaces the old
      // delete + addTransactions workaround this comment used to describe.
      const q = api.q('transactions')
        .filter({ id })
        .select(['id', 'amount', 'is_parent'])
        .limit(1);
      const parentResult = await api.runQuery(q);
      const parent = parentResult.data && parentResult.data[0];
      if (!parent) {
        return res.status(404).json({ error: 'transaction not found' });
      }
      if (parent.is_parent) {
        return res.status(409).json({ error: 'transaction is already split; edit in the Actual UI' });
      }

      const splitSum = splits.reduce((acc, s) => acc + s.amount, 0);
      if (splitSum !== parent.amount) {
        return res.status(400).json({
          error: `split sum (${splitSum}) must equal parent amount (${parent.amount})`,
          splitSum,
          parentAmount: parent.amount,
        });
      }

      await api.updateTransaction(id, {
        subtransactions: splits.map(s => ({
          amount: s.amount,
          category: s.category || null,
          notes: (s.notes || '').slice(0, 200) || null,
        })),
      });
      await api.sync(); // awaited — surface failures rather than swallow them

      log(`split transaction ${id} into ${splits.length} parts`);
      res.json({ status: 'split', count: splits.length });
    } catch (err) {
      log('split transaction failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
