// src/networth.js — net worth snapshotting + goal cards.
//
// Snapshots accumulate one entry per month (upserted on every refresh, so
// a closed month's value is whatever the last refresh of that month saw)
// and are the ONLY source of the net worth series — there is no bundled
// history, so the series simply starts wherever the app starts running.

import fs from 'fs';
import path from 'path';

const SNAPSHOT_FILENAME = 'networth-snapshots.json';

let cachedSnapshots = null; // lazy-loaded [{ym, ts, total, liquid, components}]

function snapshotFilePath(stateDir) {
  return path.join(stateDir, SNAPSHOT_FILENAME);
}

export function loadSnapshots(stateDir) {
  if (cachedSnapshots) return cachedSnapshots;
  try {
    cachedSnapshots = JSON.parse(fs.readFileSync(snapshotFilePath(stateDir), 'utf8'));
  } catch {
    cachedSnapshots = [];
  }
  return cachedSnapshots;
}

// Upsert keyed by ym. Atomic tmp+rename so a crash mid-write can't corrupt
// the snapshot file.
export function upsertSnapshot(entry, stateDir, log) {
  const snaps = loadSnapshots(stateDir);
  const idx = snaps.findIndex(s => s.ym === entry.ym);
  cachedSnapshots = idx === -1
    ? [...snaps, entry]
    : snaps.map((s, i) => (i === idx ? entry : s));
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const target = snapshotFilePath(stateDir);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cachedSnapshots, null, 1));
    fs.renameSync(tmp, target);
    if (idx === -1) log(`networth snapshot opened for ${entry.ym}`);
  } catch (err) {
    log('networth snapshot write failed (non-fatal):', err.message);
  }
}

// Actual already carries the whole balance sheet as accounts, so total net
// worth = every account balance + optional manual assets (home, cars) from
// networth.json. `liquid` is on-budget accounts only.
export function buildNetworth({ accountsRaw, accountBalances, month, manualAssets, stateDir, log }) {
  let onBudget = 0, offAssets = 0, offDebts = 0;
  for (const a of accountsRaw) {
    if (a.closed) continue;
    const bal = (accountBalances[a.id] || 0) / 100;
    if (!a.offbudget) onBudget += bal;
    else if (bal >= 0) offAssets += bal;
    else offDebts += bal;
  }
  const home = manualAssets?.homeValue || 0;
  const cars = (manualAssets?.cars || []).reduce((s, c) => s + (c.value || 0), 0);
  const total = +(onBudget + offAssets + offDebts + home + cars).toFixed(2);
  const liquid = +onBudget.toFixed(2);
  const components = {
    onBudget: +onBudget.toFixed(2),
    offAssets: +offAssets.toFixed(2),
    offDebts: +offDebts.toFixed(2),
    home,
    cars,
  };

  upsertSnapshot({ ym: month, ts: new Date().toISOString(), total, liquid, components }, stateDir, log);

  const series = loadSnapshots(stateDir)
    .map(s => ({ ym: s.ym, total: s.total, liquid: s.liquid, source: 'snapshot' }))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1));

  return { total, liquid, components, series, manualAsof: manualAssets?.asof || null };
}

// Goal cards, funded three different ways depending on `source`:
//  - 'category': funded = the matching Actual category's saved balance
//  - 'account-paydown': funded = target minus the remaining debt balance
//  - 'static': funded = the literal `funded` field (hand-maintained)
export function buildGoals({ goalsConfig, findCat, accountsRaw, accountBalances }) {
  const acctBal = (name) => {
    const a = accountsRaw.find(x => x.name === name && !x.closed);
    return a ? (accountBalances[a.id] || 0) / 100 : null;
  };
  return (goalsConfig || []).map(g => {
    let funded = null;
    if (g.source === 'category') {
      const cat = findCat(g.category);
      funded = cat ? Math.max(0, (cat.balance || 0) / 100) : null;
    } else if (g.source === 'account-paydown') {
      const bal = acctBal(g.account);
      funded = bal === null ? null : Math.max(0, g.target - Math.abs(bal));
    } else if (g.source === 'static') {
      funded = g.funded ?? null;
    }
    return {
      id: g.id,
      name: g.name,
      target: g.target,
      funded: funded === null ? null : +funded.toFixed(2),
      targetDate: g.targetDate || null,
      note: g.note || null,
    };
  });
}
