# The Family Ledger

**Version:** 1.0.0 | **Port:** 3100 (dashboard) / 5006 (Actual) | **Stack:** Node 22 + Express + @actual-app/api, vanilla-JS PWA frontend (no build step)

## What

A self-hosted dashboard that sits in front of [Actual Budget](https://actualbudget.org) and turns it into a phone-friendly, glance-and-go family budget screen: month pacing, envelopes, recent transactions, net worth, goals.

## Quick Start

```bash
./setup.sh              # First-time setup (interactive, see setup.sh for the full flow)
npm start                # Run the dashboard alone (needs ACTUAL_SERVER_URL/PASSWORD/SYNC_ID in .env, reachable actual-server)
node scripts/dev/css-audit.mjs   # Fails if styles.css has selectors unused by any HTML/JS
```

## Commands

```bash
npm install              # Install dependencies
npm start                # Start the dashboard (node server.js)
node --check <file>      # Syntax-check a single JS file (no test suite; used in CI)

# Docker (the real way this runs)
./setup.sh                            # first-time: brings up actual-server, dashboard, prompts for .env
docker compose up -d --build          # rebuild after code changes
./update.sh                           # git pull + rebuild dashboard only (actual-server stays pinned)
./backup.sh                           # tar actual-data/ + state/ into backups/, keep newest 14
./seed-demo.sh                        # load fake sample data into a throwaway data dir
```

## Architecture

```
server.js                    # bootstrap: config -> connect Actual -> refresh/bank-sync loops -> Express app
src/
  config.js                  # reads env + optional config.json/goals.json/networth.json — the ONLY module touching process.env
  actual.js                  # thin @actual-app/api wrapper: connection lifecycle, query helpers
  refresh.js                 # builds the cached /api/budget payload (the one big object the frontend polls)
  bank-sync.js                # periodic bank-connector sync, independent timer from refresh
  auth.js                     # optional DASHBOARD_PASSWORD cookie gate (HMAC token, no session store)
  read-only.js                # optional READ_ONLY guard — 403s sync/recategorize/split routes
  routes.js                   # Express app: static PWA, manifest, login, /api/budget, /api/health, /api/refresh, /api/sync
  transactions-routes.js      # /api/transactions/month, inline category PATCH, transaction split
  networth.js                 # net worth snapshotting (state/networth-snapshots.json) + goal-card funding
public/
  index.html, login.html, styles.css, sw.js
  js/{util,state,chart,sections,ledger,main}.js  # ES modules, no bundler — loaded directly by the browser
scripts/
  seed-demo.js                # deterministic (seeded PRNG) fake budget for trying the app
  dev/css-audit.mjs           # dead-CSS check, wired into CI
```

`server.js` wires everything; each `src/*.js` file owns one concern. The frontend polls `GET /api/budget` every 30s and re-renders from that one payload — there's no other API surface it depends on for read paths.

## Key Files

- `server.js` — process bootstrap, shutdown handling, unhandled-rejection guard
- `src/refresh.js` — assembles the full `/api/budget` cache object; read this first to understand data shape
- `src/config.js` — every env var and optional JSON config, with defaults, in one place
- `docker-compose.yml` — the two-container stack (`actual-server` + `dashboard`) and the version pin
- `public/js/main.js` — frontend entry point: fetch/render loop, service worker registration

## `/api/budget` payload (cache shape)

`month, dayOfMonth, daysInMonth, year, monthNum, updatedAt, app{title,currency,locale,baseSplitEnabled,hiddenPayees}, totals{budgeted,spent,income,toBudget,base,discretionary}, categoryGroups, accounts, recentTransactions, categoryOptions, incomePrediction, networth, goals, bankSync`

**Units convention:** everything is **integer cents** (`totals`, `categoryGroups`, `accounts`, `recentTransactions`) **except** `networth` and `goals`, which are **dollars** (floats). This split exists because networth/goals do their own rounding in `src/networth.js` — don't "fix" it into cents.

## Conventions

- Panels hide client-side when their optional config is absent (`config.json`, `goals.json`, `networth.json`) — never make a panel error when the file is missing.
- `actualbudget/actual-server` image tag and `@actual-app/api` npm pin are a **tested pair** — never bump one without the other (see `docs/UPGRADING.md`).
- No heredocs in shell scripts or commands (OPSEC — see `CONTRIBUTING.md`).

## Configuration

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full env-var table and JSON config examples.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
