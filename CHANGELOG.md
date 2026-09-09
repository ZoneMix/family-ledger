# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-09-09

Response to an external security review. No breaking changes for an existing install — every new
setting is off by default. See [docs/UPGRADING.md](docs/UPGRADING.md#100--110) for the upgrade steps.

### Security

- Bumped `actualbudget/actual-server` and `@actual-app/api` to 26.9.0 (exact pin, kept in lockstep
  per [docs/UPGRADING.md](docs/UPGRADING.md)) and added an `overrides.qs` pin to `^6.16.0`, clearing
  all 7 npm audit advisories (3 high, 4 moderate) that came from express's transitive `qs` dependency.
- `/api/health` now returns only `{"ok": true|false}`. The fields it used to expose
  (`refreshing`, `syncing`, `updatedAt`, `lastError`, `bankSync`) were reachable without
  authentication and are no longer sent there — that detail now lives on `/api/budget`, which
  sits behind the login gate.
- Every `/api/*` response now carries `Cache-Control: private, no-store`, so a shared browser,
  proxy, or device cache never holds onto budget data.
- The session cookie is marked `Secure` automatically when the dashboard is reached over HTTPS
  (Caddy overlay, Tailscale Serve); plain-HTTP LAN logins are unaffected.
- Added `TRUST_PROXY` (default: private ranges only) so the login rate limiter can't be fooled by
  a spoofed `X-Forwarded-*` header from outside the LAN, while a legitimate reverse proxy is
  still trusted.
- Added `BIND_ADDR` to restrict which network interface the published ports listen on — e.g.
  `127.0.0.1` behind the Caddy overlay, or a Tailscale IP to publish on the tailnet only.
- The dashboard now warns loudly at startup when `DASHBOARD_PASSWORD` is unset, and refuses to
  start if it's set but shorter than 12 characters. `setup.sh`'s prompt re-asks until the
  password is empty or 12+ characters.
- `setup.sh` now writes `.env` with `0600` permissions (umask + `chmod`, covering a pre-existing
  file too) instead of default permissions.
- Added `ACTUAL_FILE_PASSWORD` (and `ACTUAL_FILE_PASSWORD_FILE`) so an end-to-end-encrypted
  Actual budget can be read. Every secret variable — `ACTUAL_PASSWORD`, `DASHBOARD_PASSWORD`,
  `ACTUAL_FILE_PASSWORD` — now also accepts a `<NAME>_FILE` path (the Docker secrets convention);
  the direct variable wins if both are set.
- `public/index.html` no longer loads fonts from `fonts.googleapis.com` — Fraunces and Figtree
  are now bundled and served from this project, so the browser makes zero requests off the host
  machine to render the page. The README's "no telemetry or external calls of any kind" claim is
  now literally true.

### Added

- `READ_ONLY=true` turns the dashboard into a viewer: automatic and manual bank sync,
  recategorizing, and splitting are disabled, both in the UI (the sync button hides, category
  pills and split amounts become inert) and at the API (403 on the affected routes).
- `backup.sh` now stops `actual-server` before archiving, for a consistent snapshot of its live
  SQLite database, and restarts it afterward via an `EXIT` trap — but only if this run is the one
  that stopped it, so a deliberately-stopped Actual instance stays stopped.
- Every backup archive is now verified before the script reports success (`gzip -t` + `tar -tzf`
  for a plain archive, an age-header check for an encrypted one); a failed verification deletes
  the bad archive and exits with an error instead of leaving a silently-corrupt backup behind.
- Added `BACKUP_AGE_RECIPIENT`: set it to an [age](https://github.com/FiloSottile/age) public key
  and `backup.sh` streams straight into `age`, writing `family-ledger-<timestamp>.tar.gz.age`
  instead of a plain tarball.
- `backup.sh` now reads `KEEP` from the shell environment (`KEEP=30 ./backup.sh`) to override how
  many backups it keeps, instead of a hardcoded 14.

### Changed

- Transaction splitting now uses `@actual-app/api`'s native `updateTransaction(id, { subtransactions })`
  (fixed upstream in Actual 26.8.0, [actualbudget/actual#8467](https://github.com/actualbudget/actual/pull/8467))
  instead of this project's delete-and-recreate workaround. Verified live against 26.9.0: one call
  now produces the parent plus N children correctly, preserves `imported_id`/payee/date/cleared,
  and survives `sync()` and a fresh `downloadBudget`.

### Fixed

- `backup.sh` no longer unconditionally restarts `actual-server` — it only restarts what it
  itself stopped, so a household member's deliberate downtime survives the next cron backup.
- Added `set -o pipefail` to `backup.sh` so a `tar` failure on the age-encryption path is no
  longer masked by `age` itself "succeeding" on partial input; the script now deletes the partial
  archive and exits with an error.
- Rewrote the backup-pruning loop to avoid piping through `head`, which could trigger a `SIGPIPE`
  in the upstream `sort` under `pipefail` and make a successful backup report failure to cron.

## [1.0.0] - 2026-07-31

Initial release.
