# Configuration

The Family Ledger is configured two ways: environment variables (`.env`, required + basic settings) and optional JSON files at the repo root (richer, per-household customization). Both are read once, at container startup — restart the `dashboard` container after changing either.

## Environment variables

`./setup.sh` writes `.env` for you interactively. This table is for reference, or for anyone configuring by hand. Defaults shown are what the app falls back to if a variable is unset.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACTUAL_PASSWORD` | Yes | — | Password for your Actual Budget server. |
| `ACTUAL_SYNC_ID` | Yes | — | The Sync ID (a UUID) of the specific budget file the dashboard should read. Find it in Actual: gear icon → Settings → Show advanced settings → Sync ID. |
| `ACTUAL_FILE_PASSWORD` | No | — | Password of an end-to-end-encrypted budget file. Leave unset for unencrypted files. |
| `APP_TITLE` | No | `The Family Ledger` | Shown in the header, browser tab, and PWA install name. |
| `TZ` | No | `America/Chicago` | IANA timezone (e.g. `America/New_York`, `Europe/London`) — used for "today" and month-boundary calculations. |
| `DASHBOARD_PORT` | No | `3100` | **Host** port the dashboard is published on (Docker only — see `docker-compose.yml`). |
| `ACTUAL_PORT` | No | `5006` | **Host** port Actual's own server is published on. |
| `CURRENCY` | No | `USD` | Currency code used for number formatting. |
| `LOCALE` | No | `en-US` | Locale used for number/date formatting. |
| `REFRESH_INTERVAL_MS` | No | `300000` (5 min) | How often the server re-reads budget data from Actual. Floored at `60000` (1 min) — anything lower is silently raised to the floor. |
| `AUTO_SYNC_INTERVAL_MS` | No | `7200000` (2 hr) | How often the server asks Actual to run a bank sync. Set to `0` to disable automatic bank sync entirely (manual sync via the footer button still works). |
| `DASHBOARD_PASSWORD` | No | *(none — login disabled)* | Optional password gate on the dashboard itself. Must be 12+ characters if set — the server refuses to start otherwise. See below. |
| `READ_ONLY` | No | (unset — read-write) | Set to `true` to make the dashboard a viewer: bank sync (automatic and the footer button), recategorizing, and splitting are disabled and the API returns 403 for those routes. `POST /api/refresh` still works. |
| `BIND_ADDR` | No | `0.0.0.0` | Host network interface the published ports bind to (Docker only — see `docker-compose.yml`). Default publishes on every interface; set to `127.0.0.1` when a reverse proxy fronts the stack, or a Tailscale IP to expose it on the tailnet only. |
| `TRUST_PROXY` | No | `loopback, linklocal, uniquelocal` | Which upstream addresses may set `X-Forwarded-*` headers. Private ranges by default, so a reverse proxy on the LAN or in the compose network is trusted, but internet clients can't spoof the login rate limiter's IP. |
| `BACKUP_AGE_RECIPIENT` | No | — | Public key (`age1...`) from an [age](https://github.com/FiloSottile/age) keypair. When set, `backup.sh` encrypts backups and writes `family-ledger-<timestamp>.tar.gz.age` instead of a plain tarball. |

A few more variables exist for advanced/internal use and are set automatically inside the Docker containers — you generally never need to touch them: `PORT` (internal container port, `3000`), `ACTUAL_DATA_DIR` (`/cache`), `ACTUAL_SERVER_URL` (points at the `actual-server` container), `STATE_DIR` (`/state`, where net worth snapshot history lives).

### Secret files

Every secret variable — `ACTUAL_PASSWORD`, `DASHBOARD_PASSWORD`, and `ACTUAL_FILE_PASSWORD` — also accepts a `<NAME>_FILE` path instead of the value itself (e.g. `ACTUAL_PASSWORD_FILE=/run/secrets/actual_password`), the Docker secrets convention. The direct variable wins if both are set. See the commented-out example in `docker-compose.yml`.

### `DASHBOARD_PASSWORD` behavior

- Leave it empty for no login — appropriate for a trusted home network where Actual's own server password is already the real gate. The server logs a startup warning when this is the case.
- When set, every page and every `/api/*` route (except `/login.html`, `/api/login`, and `/api/health`) requires a valid session cookie. `/api/health` stays open but only ever returns `{"ok":true|false}` — nothing else is exposed unauthenticated.
- The session cookie (`fl_session`) is a deterministic HMAC of a fixed message keyed by the password — there's no session store on disk. It's valid for **30 days**.
- The session cookie is marked `Secure` automatically when the dashboard is reached over HTTPS (Caddy overlay, Tailscale Serve); over plain HTTP on the LAN it is not, by design.
- **Changing `DASHBOARD_PASSWORD` invalidates every existing session immediately** (the HMAC no longer matches), which effectively logs everyone out at once. Useful if a shared device is lost or a household member should lose access.
- Login attempts are rate-limited to 5 per minute per IP.

## Optional JSON configs

All three files live at the **repo root** (same level as `docker-compose.yml`), are **gitignored**, and ship with a `*.example.json` you can copy from. Every one of them is optional — the corresponding dashboard panel simply doesn't render when the file is absent, and a malformed file is logged as a warning and treated as absent rather than crashing the server.

After adding or editing any of these, rebuild/restart the dashboard container so it picks up the change:

```bash
docker compose up -d --build
```

### `config.json` — base/discretionary split + hidden payees

```bash
cp config.example.json config.json
```

```json
{
  "baseCategories": ["Rent", "Electric", "Internet", "Phone", "Car Insurance"],
  "hiddenPayees": ["Starting Balance"]
}
```

- `baseCategories` — category names (must match your Actual category names exactly) treated as fixed/committed spending. When this array is non-empty, the month hero splits into "base" vs. "discretionary" totals instead of one combined number — useful because a rent payment landing on day 1 shouldn't read as "spending fast."
- `hiddenPayees` — payee names filtered out of the recent-entries feed and the full-month ledger (e.g. Actual's own "Starting Balance" bookkeeping entries). Defaults to `["Starting Balance"]` if the file is absent.

### `goals.json` — savings/debt goal cards

```bash
cp goals.example.json goals.json
```

```json
[
  {
    "id": "emergency-fund",
    "name": "Emergency Fund",
    "target": 5000,
    "source": "category",
    "category": "Emergency Fund",
    "targetDate": null,
    "note": "3 months of essential expenses — funded from the matching Actual category balance"
  },
  {
    "id": "vacation",
    "name": "Vacation",
    "target": 2000,
    "source": "static",
    "funded": 450,
    "targetDate": "2026-12-01",
    "note": "Tracked manually — update the `funded` field as you save"
  }
]
```

An array of goal cards. `target` and `funded` are **dollars**, not cents. `source` controls how "funded" is calculated:

- `"category"` — funded = the current balance of the named Actual `category` (must match a real category name).
- `"static"` — funded = the literal `funded` value you maintain by hand in this file.
- `"account-paydown"` — funded = `target` minus the remaining balance of the named `account` (for debt-payoff goals; requires an `account` field with the account name).

The whole Goals section hides if `goals.json` is absent or resolves to an empty array.

### `networth.json` — manual assets for the net worth panel

```bash
cp networth.example.json networth.json
```

```json
{
  "homeValue": 250000,
  "cars": [
    { "name": "Family Car", "value": 12000 }
  ],
  "asof": "2026-01-01"
}
```

Net worth is computed automatically from every open Actual account (on-budget + off-budget), plus whatever manual assets you list here — Actual doesn't track a house or a car, so this file lets those show up in the total. All values are **dollars**. The panel still renders with just your Actual accounts if this file is absent; `homeValue`/`cars` just won't be included. Net worth history accumulates automatically over time as a monthly snapshot (`state/networth-snapshots.json`) — there's no bundled history, so the chart starts from whenever you first ran the app.

## Away from home: the Caddy overlay

By default, this stack is plain HTTP on your home network — no domain, no certificate. If you want a real domain with automatic HTTPS in front of it (instead of using Tailscale, which is the recommended approach for phone access away from home — see the README), there's an optional Caddy overlay:

1. Copy the example Caddyfile and fill in your own domain(s):

   ```bash
   cp Caddyfile.example Caddyfile
   ```

   Edit `Caddyfile` and replace the two placeholder domains (`ledger.example.com`, `budget.example.com`) with domains you actually own and can point at this machine.

2. Start the stack with both compose files:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
   ```

This only works if you own the domain(s) and ports 80/443 are reachable from the internet (port-forwarded, or this machine sits behind something that forwards them) — Caddy needs that to issue a certificate. If you're only ever accessing the dashboard from inside your home network, skip this entirely and just use `http://<this machine's LAN IP>:3100`.
