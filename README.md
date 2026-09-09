# The Family Ledger

![The Family Ledger dashboard](docs/screenshots/dashboard.png)

A friendly self-hosted family dashboard for [Actual Budget](https://actualbudget.org) — envelope budgeting at a glance, on every phone in the house.

## What is this?

Actual Budget is a great envelope-budgeting app, but it's built for one person poking around a full budgeting UI, not for a whole household glancing at "how are we doing this month?" from their phone. The Family Ledger sits in front of your existing Actual server and turns it into a single, simple, phone-friendly screen: where the month stands, what's left in each envelope, and the last few transactions — installable as an app icon on every family member's phone.

It's not a replacement for Actual. It reads (and lightly edits) the same budget data through Actual's own API — Actual is still where you do the real budgeting work.

## Features

- **Month-at-a-glance hero** — a plain-language pacing message ("running a little hot this month") instead of a wall of numbers
- **Envelope / category view** — every budget group and category, budgeted vs. spent vs. remaining
- **Recent entries** — the latest transactions, with tap-to-recategorize and a split-transaction modal for the ones that need it
- **Accounts** — a simple balance sheet across checking, savings, and cards
- **Goals** *(optional)* — savings or debt-payoff cards, configured per household
- **Net worth** *(optional)* — a chart that builds itself month over month, plus manual assets like your house or car
- **Monthly report** — cash flow, over-budget categories, largest expenses, possible duplicate charges, uncategorized spending
- **Privacy mode** — tap the header to mask every number and name before you hand your phone to a houseguest
- **Optional password login**, separate from your Actual server password
- **Manual refresh and bank-sync buttons** right in the footer
- **Installable as a PWA** — add it to your home screen like a real app

## What you need

- A computer that stays on at home — a Raspberry Pi, an old laptop, a small NAS box, whatever you've got
- No spare computer? It runs just as well on your everyday machine with [Docker Desktop](https://docs.docker.com/desktop/) — the dashboard is simply only reachable while that machine is awake
- [Docker](https://docs.docker.com/engine/install/) and the Docker Compose plugin (setup.sh offers to install these for you on Debian-family Linux)
- About 10 minutes

You do **not** need to know how to program. If you can copy-paste a command into a terminal, you can run this.

## The 10-minute setup

```bash
git clone https://github.com/ZoneMix/family-ledger.git
cd family-ledger
./setup.sh
```

The script walks you through everything:

1. Checks that Docker is installed and running
2. Asks a few basic questions (app title, timezone, ports, an optional dashboard password)
3. Starts Actual Budget and waits for it to come up
4. Has you open Actual in your browser, set a server password, and click "Start fresh" to create your budget
5. Connects the dashboard to that budget automatically (it finds the Sync ID for you — if that fails, it walks you through copying it manually)
6. Builds and starts the dashboard, and offers to schedule a daily automatic backup

When it's done, it prints the URLs for both the dashboard and Actual itself.

Prefer a full visual walkthrough with screenshots? See the companion blog post: [Self-hosting a budget app: a beginner's guide](https://zonemix.tech/blog/self-host-budget-app-beginners-guide/).

## Try it with sample data

Not ready to connect your real accounts yet? Load a realistic fake budget first:

```bash
./seed-demo.sh
```

This seeds a throwaway sample budget with a few months of transactions so you can click around and see what the dashboard looks like before committing your own finances. It refuses to run on a budget that already has real transactions in it, so it's safe to try even after you've started using this for real.

## Put it on your phone

Open the dashboard URL from setup (`http://<your server's LAN IP>:3100`) in your phone's browser while connected to your home Wi-Fi, then use "Add to Home Screen" (Safari on iOS) or the browser's install prompt (Chrome on Android). It behaves like a normal app icon from there — no App Store needed.

## Everyday use

- Tap a category group to expand it and see every category inside
- Tap a transaction's category pill to recategorize it inline; tap its **amount** to split it across multiple categories
- Tap the header/subtitle to toggle privacy mode — every number and name masks instantly
- Use the manual refresh or "sync banks now" buttons in the footer if you don't want to wait for the automatic interval
- Everything updates on its own — the dashboard polls in the background and re-syncs with your bank connections on a schedule

## Configuration

Everything is set through environment variables in `.env` (written for you by `./setup.sh`) plus a few optional JSON files at the repo root for things like goal cards and net worth assets.

| Variable | Required | Description |
|---|---|---|
| `ACTUAL_PASSWORD` | Yes | Your Actual Budget server password |
| `ACTUAL_SYNC_ID` | Yes | The Sync ID of the budget file to display |
| `APP_TITLE` | No | Header/tab title (default: "The Family Ledger") |
| `TZ` | No | Timezone for month/day calculations |
| `DASHBOARD_PORT` / `ACTUAL_PORT` | No | Host ports (defaults: 3100 / 5006) |
| `CURRENCY` / `LOCALE` | No | Number/date formatting |
| `DASHBOARD_PASSWORD` | No | Optional login for the dashboard itself |
| `READ_ONLY` | No | Set `true` to disable bank sync, recategorizing, and splitting |

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full variable table, the optional `config.json` / `goals.json` / `networth.json` files with copy-paste examples, and how the Caddy overlay works.

## Away from home

**This project is designed to run on your home network — not to be exposed directly to the public internet.** For checking the budget while you're out, the recommended approach is [Tailscale](https://tailscale.com/): install it on your server and on your phone, and you get a private, encrypted connection back to your home dashboard with no ports opened to the internet.

If you'd rather put a real domain in front of it with automatic HTTPS (and you understand the tradeoff of exposing it publicly), there's an optional Caddy overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#away-from-home-the-caddy-overlay) for the setup steps.

## Updating

```bash
./backup.sh   # always back up first
./update.sh   # git pull + rebuild the dashboard
```

**Important:** the Actual Budget server version and this dashboard's Actual client library are pinned together on purpose and tested as a pair. `./update.sh` intentionally does not touch the server version. Don't bump one without the other — see [docs/UPGRADING.md](docs/UPGRADING.md) for the full lockstep rule and upgrade procedure.

## Backups

```bash
./backup.sh
```

Tars up your Actual data and dashboard state into `backups/`, keeping the newest 14. Say yes to the daily 3am cron job during `./setup.sh` and this happens automatically. For extra safety, also use Actual's own built-in "Export budget" (gear icon → Settings) now and then — it produces a portable `.zip` independent of this project entirely.

## Troubleshooting

- **"Port already in use"** — something else on your server is using 3100 or 5006. Re-run `./setup.sh` and pick different ports, or free up the ones you want.
- **Wrong password** — the dashboard login (if you set one) is separate from Actual's own server password. Check which one the error is actually about.
- **A "warming up" message / 503** — the dashboard just started and hasn't finished its first data pull yet. Give it a few seconds and refresh.
- **Phone can't connect** — make sure your phone is on the same home Wi-Fi as the server. This dashboard isn't reachable from outside your home network unless you've set up Tailscale or the Caddy overlay (see above).

## FAQ

**Is it private?** Yes. Everything runs on your own hardware, talks only to your own Actual server, and there's no telemetry or external calls of any kind. Your financial data never leaves your network unless you choose to expose it (Tailscale keeps it private even then; a public domain via the Caddy overlay is your call to make).

**What if the project dies / stops being maintained?** Your actual financial data lives in Actual Budget, not in this dashboard — this project only reads and lightly edits it through Actual's API. You can export your full budget anytime from Actual itself (gear icon → Settings → Export budget) as a portable file, independent of whether this dashboard exists at all.

## Credits

Built on top of [Actual Budget](https://actualbudget.org), an excellent open-source budgeting app. This project is **not affiliated with or endorsed by** the Actual Budget team — it's an independent dashboard that talks to Actual's API.

## Using with Claude Code

This project includes a `CLAUDE.md` that gives Claude Code full architectural context — the module map, the `/api/budget` payload shape, and the cents-vs-dollars convention.

```bash
claude    # Start Claude Code — reads CLAUDE.md automatically
```

## License

MIT — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
