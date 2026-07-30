// scripts/seed-demo.js — deterministic demo data for The Family Ledger.
//
// Seeds a FRESH Actual budget with 3 months of realistic transactions
// (current month + 2 prior) so screenshots and walkthroughs are
// reproducible. Refuses to touch a budget that already has
// transactions unless --force is passed. Uses a seeded PRNG
// (mulberry32, seed 42) so re-running produces identical output.
//
// Usage:  node scripts/seed-demo.js [--force]
// Env:    ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID,
//         ACTUAL_DATA_DIR (defaults to /tmp/seed — a throwaway dir,
//         never the live dashboard cache)
//
// The 8 payees named in the project spec (Grocery Mart, Gas & Go,
// Corner Coffee, Streamflix, City Water & Power, Rent — Oakwood Apts,
// The Pizza Place, Thrift & Thread) all appear below. Three more
// (NetStream Internet, Wireless Plus, SafeDrive Insurance) were added
// for the Internet/Phone/Car Insurance bills, which the spec's
// payee list didn't cover but the category list requires.

import api from '@actual-app/api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FORCE = process.argv.includes('--force');

const PAYCHECK_PAYEE = 'Brightside Design Co';
const PAYCHECK_CENTS = 240000; // $2,400.00

// Sums to $4,800 — exactly two paychecks — so prior months land at
// exactly $0 To Budget. Everyday-category amounts are set well above
// what addRandomSpend() can actually generate (see its call sites),
// so no category overspends in a prior month and nothing rolls
// forward to corrupt the next month's numbers.
const FULLY_ASSIGNED_BUDGETS = {
  Rent: 1450, Electric: 95, Internet: 60, Phone: 45, 'Car Insurance': 110,
  Groceries: 600, Gas: 200, 'Eating Out': 150, 'Fun Money': 250, Clothes: 140,
  'Emergency Fund': 1000, Vacation: 400, Christmas: 300,
};

// Same as above but $150 less (Vacation trimmed), so the current
// month's own To Budget lands at exactly +$150.
const CURRENT_MONTH_BUDGETS = { ...FULLY_ASSIGNED_BUDGETS, Vacation: 250 };

const SPENDING_GROUPS = [
  { name: 'Bills', categories: ['Rent', 'Electric', 'Internet', 'Phone', 'Car Insurance'] },
  { name: 'Everyday', categories: ['Groceries', 'Gas', 'Eating Out', 'Fun Money', 'Clothes'] },
  { name: 'Goals', categories: ['Emergency Fund', 'Vacation', 'Christmas'] },
];

// ─── deterministic PRNG (mulberry32, fixed seed) ────────────────
function mulberry32(seed) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const cents = (dollars) => Math.round(dollars * 100);

// ─── date helpers — relative to "today" so the demo always looks current ──
function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function monthLabel(date) {
  return date.toISOString().slice(0, 7);
}
function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}
function onDay(monthStart, day) {
  const daysInMonth = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(day, daysInMonth))
  );
}

// ─── safety check ────────────────────────────────────────────────
async function ensureFreshBudget(force) {
  const accounts = await api.getAccounts();
  let total = 0;
  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id, '2000-01-01', '2100-01-01');
    total += txns.length;
  }
  if (total > 0 && !force) {
    console.error(`This budget already has ${total} transaction(s) — seeding is for FRESH budgets.`);
    console.error('Use --force to override (this adds to, not replaces, existing data).');
    return false;
  }
  return true;
}

// ─── accounts ──────────────────────────────────────────────────
async function setupAccounts() {
  const checkingId = await api.createAccount(
    { name: 'Checking', type: 'checking', offbudget: false },
    cents(2143.67)
  );
  const savingsId = await api.createAccount(
    { name: 'Savings', type: 'savings', offbudget: false },
    cents(5000.0)
  );
  const creditCardId = await api.createAccount(
    { name: 'Credit Card', type: 'credit', offbudget: false },
    cents(-486.22)
  );
  return {
    checkingId,
    savingsId,
    creditCardId,
    summary: ['Checking $2,143.67', 'Savings $5,000.00', 'Credit Card -$486.22'],
  };
}

// ─── category groups + categories ───────────────────────────────
// Actual auto-creates exactly one income category group per budget
// ("only one income group ever exists") — reuse it instead of making
// a second one, and reuse its default category if it already looks
// like an income category (e.g. named "Income").
async function setupCategories() {
  const categoryIds = {};
  const groups = [];

  const existingGroups = await api.getCategoryGroups();
  const incomeGroup = existingGroups.find((g) => g.is_income);
  const incomeGroupId = incomeGroup
    ? incomeGroup.id
    : await api.createCategoryGroup({ name: 'Income', is_income: true });
  groups.push('Income');

  const existingIncomeCat = (incomeGroup?.categories || []).find((c) =>
    /paycheck|income/i.test(c.name)
  );
  categoryIds.Paycheck = existingIncomeCat
    ? existingIncomeCat.id
    : await api.createCategory({ name: 'Paycheck', group_id: incomeGroupId, is_income: true });
  let categoryCount = 1;

  for (const group of SPENDING_GROUPS) {
    const groupId = await api.createCategoryGroup({ name: group.name });
    groups.push(group.name);
    for (const catName of group.categories) {
      categoryIds[catName] = await api.createCategory({ name: catName, group_id: groupId });
      categoryCount += 1;
    }
  }

  return { categoryIds, summary: { groups, categoryCount } };
}

// ─── transaction helpers ─────────────────────────────────────────
async function addPaycheck(accountId, month, day, categoryId) {
  await api.addTransactions(accountId, [
    {
      account: accountId,
      date: ymd(onDay(month, day)),
      amount: PAYCHECK_CENTS,
      payee_name: PAYCHECK_PAYEE,
      category: categoryId,
      cleared: true,
    },
  ]);
}

async function addFixedBill(accountId, month, day, categoryId, payeeName, dollars) {
  await api.addTransactions(accountId, [
    {
      account: accountId,
      date: ymd(onDay(month, day)),
      amount: -cents(dollars),
      payee_name: payeeName,
      category: categoryId,
      cleared: true,
    },
  ]);
}

// N transactions on random days, each a random dollar amount in
// [minDollars, maxDollars]. Returns the total spent, in cents, so
// callers can check it against a category's budget.
async function addRandomSpend(accountId, month, categoryId, payeeName, count, minDollars, maxDollars) {
  let totalCents = 0;
  for (let i = 0; i < count; i++) {
    const day = 2 + Math.floor(rand() * 26);
    const dollars = minDollars + rand() * (maxDollars - minDollars);
    const amountCents = cents(dollars);
    await api.addTransactions(accountId, [
      {
        account: accountId,
        date: ymd(onDay(month, day)),
        amount: -amountCents,
        payee_name: payeeName,
        category: categoryId,
        cleared: true,
      },
    ]);
    totalCents += amountCents;
  }
  return totalCents;
}

// Transfers use Actual's auto-created "transfer payee" for the target
// account, not a plain payee_name — see docs/api/reference for
// `transfer_acct` and the `runTransfers` option.
async function addCreditCardPayment(checkingId, creditCardId, month, day, dollars) {
  const payees = await api.getPayees();
  const transferPayee = payees.find((p) => p.transfer_acct === creditCardId);
  if (!transferPayee) {
    throw new Error('Could not find the Credit Card transfer payee');
  }
  await api.addTransactions(
    checkingId,
    [
      {
        account: checkingId,
        date: ymd(onDay(month, day)),
        amount: -cents(dollars),
        payee: transferPayee.id,
        cleared: true,
      },
    ],
    { runTransfers: true }
  );
}

// Required demo state: one NEW split transaction, SuperMart $84.12 =
// Groceries $61.40 + Clothes $22.72. Created fresh (not by editing an
// existing transaction) — addTransactions handles subtransactions
// fine; it's *updating* an existing transaction into a split that's
// unreliable in this API version.
async function addSplitSuperMart(accountId, month, day, groceriesId, clothesId) {
  await api.addTransactions(accountId, [
    {
      account: accountId,
      date: ymd(onDay(month, day)),
      amount: -cents(84.12),
      payee_name: 'SuperMart',
      cleared: true,
      subtransactions: [
        { amount: -cents(61.4), category: groceriesId, notes: 'Groceries' },
        { amount: -cents(22.72), category: clothesId, notes: 'Clothes' },
      ],
    },
  ]);
}

// Required demo state: current-month Eating Out overspent by exactly
// $23.45 (budget minus spending = -23.45). The baseline Corner
// Coffee + Pizza Place spend above is always well under the $150
// budget, so this top-up amount is always positive.
async function topUpEatingOutOverspend(accountId, month, categoryId, spentSoFarCents, budgetDollars, overspendDollars) {
  const targetCents = cents(budgetDollars) + cents(overspendDollars);
  const remainingCents = targetCents - spentSoFarCents;
  if (remainingCents <= 0) return;
  await api.addTransactions(accountId, [
    {
      account: accountId,
      date: ymd(onDay(month, 27)),
      amount: -remainingCents,
      // A big family dinner reads plausibly at ~$100+; a coffee shop
      // charge that size would look absurd in tutorial screenshots.
      payee_name: 'The Pizza Place',
      category: categoryId,
      cleared: true,
      notes: 'seed adjustment to hit demo overspend target',
    },
  ]);
}

async function setMonthBudgets(ym, categoryIds, budgets) {
  for (const [name, dollars] of Object.entries(budgets)) {
    await api.setBudgetAmount(ym, categoryIds[name], cents(dollars));
  }
}

// ─── one month of activity ────────────────────────────────────────
async function seedMonth(checkingId, creditCardId, categoryIds, month, isCurrent) {
  let count = 0;

  await addPaycheck(checkingId, month, 1, categoryIds.Paycheck);
  await addPaycheck(checkingId, month, 15, categoryIds.Paycheck);
  count += 2;

  await addFixedBill(checkingId, month, 1, categoryIds.Rent, 'Rent — Oakwood Apts', 1450);
  await addFixedBill(checkingId, month, 3, categoryIds.Electric, 'City Water & Power', 95);
  await addFixedBill(checkingId, month, 5, categoryIds.Internet, 'NetStream Internet', 60);
  await addFixedBill(checkingId, month, 6, categoryIds.Phone, 'Wireless Plus', 45);
  await addFixedBill(checkingId, month, 8, categoryIds['Car Insurance'], 'SafeDrive Insurance', 110);
  count += 5;

  await addRandomSpend(checkingId, month, categoryIds.Groceries, 'Grocery Mart', 3, 40, 140);
  await addRandomSpend(checkingId, month, categoryIds.Gas, 'Gas & Go', 3, 20, 55);
  await addRandomSpend(checkingId, month, categoryIds['Fun Money'], 'Streamflix', 1, 15.99, 15.99);
  await addRandomSpend(checkingId, month, categoryIds.Clothes, 'Thrift & Thread', 1, 15, 45);
  count += 8;

  const eatingOutSpent =
    (await addRandomSpend(checkingId, month, categoryIds['Eating Out'], 'Corner Coffee', 1, 4, 9)) +
    (await addRandomSpend(checkingId, month, categoryIds['Eating Out'], 'The Pizza Place', 1, 18, 34));
  count += 2;

  await addCreditCardPayment(checkingId, creditCardId, month, 20, 150);
  count += 1;

  const ym = monthLabel(month);
  if (isCurrent) {
    await addSplitSuperMart(checkingId, month, 10, categoryIds.Groceries, categoryIds.Clothes);
    await topUpEatingOutOverspend(checkingId, month, categoryIds['Eating Out'], eatingOutSpent, 150, 23.45);
    count += 2;
    await setMonthBudgets(ym, categoryIds, CURRENT_MONTH_BUDGETS);
  } else {
    await setMonthBudgets(ym, categoryIds, FULLY_ASSIGNED_BUDGETS);
  }

  return count;
}

// NOTE: goals.example.json -> goals.json copying happens in seed-demo.sh
// on the HOST, not here — this script runs inside a throwaway container
// (--rm), so a copy made here would vanish with it, and the dashboard
// bakes config files into its image at build time anyway.

function printSummary({ accountSummary, categorySummary, txnCount, monthCount }) {
  console.log();
  console.log('Demo data seeded:');
  console.log(`  Accounts:        ${accountSummary.join(', ')}`);
  console.log(`  Category groups: ${categorySummary.groups.join(', ')}`);
  console.log(`  Categories:      ${categorySummary.categoryCount}`);
  console.log(`  Months seeded:   ${monthCount} (current + ${monthCount - 1} prior)`);
  console.log(`  Transactions:    ${txnCount}`);
  console.log();
  console.log('Restart or refresh the dashboard to see it.');
}

async function main() {
  console.log('The Family Ledger — demo seeder');
  const dataDir = process.env.ACTUAL_DATA_DIR || '/tmp/seed';
  fs.mkdirSync(dataDir, { recursive: true });  // api.init requires it to exist
  await api.init({
    dataDir,
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  if (!(await ensureFreshBudget(FORCE))) {
    await api.shutdown();
    process.exit(1);
  }

  const { checkingId, creditCardId, summary: accountSummary } = await setupAccounts();
  const { categoryIds, summary: categorySummary } = await setupCategories();

  const months = [monthsAgo(2), monthsAgo(1), monthsAgo(0)];
  let txnCount = 0;
  for (let mi = 0; mi < months.length; mi++) {
    const isCurrent = mi === months.length - 1;
    txnCount += await seedMonth(checkingId, creditCardId, categoryIds, months[mi], isCurrent);
  }

  await api.sync();
  await api.shutdown();

  printSummary({ accountSummary, categorySummary, txnCount, monthCount: months.length });
}

main().catch(async (err) => {
  console.error('Seeding failed:', err && err.message ? err.message : err);
  try {
    await api.shutdown();
  } catch {
    // already down / never started — nothing to clean up
  }
  process.exit(1);
});
