# Upgrading

## The version lockstep rule (read this first)

`docker-compose.yml` pins the Actual Budget server image to an exact tag:

```yaml
image: actualbudget/actual-server:26.9.0
```

`package.json` pins the `@actual-app/api` client library to the matching exact version:

```json
"@actual-app/api": "26.9.0"
```

**These two numbers are a tested pair, not independent settings.** Actual's budget-file format can migrate when the server starts up on a newer version, and that migration is **one-way** — an older API client can't read a file a newer server has already migrated, and a newer client talking to an older server can hit API calls the server doesn't support yet. Bumping either one alone risks:

- The dashboard failing to connect or misreading budget data after a server auto-migration
- `seed-demo.js` or the split-transaction endpoint calling an API method that changed shape between versions

**Never bump the server image tag or the `@actual-app/api` version independently.** Only take an upgrade when both have been updated together and tested — i.e., pull a tagged release of this repo rather than hand-editing one version number.

As of 26.9.0, Actual's server container images moved to Node 24 (32-bit ARM users should use the `:26.9.0-alpine` tag instead); this does not affect the dashboard's own `node:22-alpine` base, since `@actual-app/api` only requires Node >= 20.

## Upgrade procedure

1. **Back up first.** Always, no exceptions — a bad migration is not reversible from inside Actual.

   ```bash
   ./backup.sh
   ```

   This briefly pauses `actual-server` for a consistent snapshot (restarted automatically afterward, even on failure) and tars `actual-data/` (Actual's server-side budget data) and `state/` (this dashboard's net worth snapshot history) into `backups/family-ledger-<timestamp>.tar.gz` — or `.tar.gz.age` if `BACKUP_AGE_RECIPIENT` is set, see [README.md](../README.md#backups).

2. **Pull the new version.** If you're tracking releases:

   ```bash
   git pull
   ```

   Check the diff on `docker-compose.yml` and `package.json` — a real upgrade PR from this project changes the `actualbudget/actual-server` tag and the `@actual-app/api` version together. If you only see one of them change, something's wrong — don't proceed.

3. **Rebuild and restart:**

   ```bash
   docker compose up -d --build
   ```

   (`./update.sh` does steps 2-3 for you, but intentionally does **not** touch the pinned server version on its own — see the comment at the top of `update.sh`.)

4. **Watch the logs on first boot after an upgrade:**

   ```bash
   docker compose logs -f actual-server
   ```

   A version bump that includes a data migration will log it here. Let it finish before opening the dashboard.

## Rollback

Because budget-file migrations are one-way, there is no supported "downgrade the server and keep your data" path. If an upgrade goes wrong:

1. Stop the stack: `docker compose down`
2. Restore the backup taken in step 1: extract `backups/family-ledger-<timestamp>.tar.gz` back over `actual-data/` and `state/`
3. Check out the previous tagged release of this repo (`git checkout <previous-tag>`)
4. `docker compose up -d --build`

If you didn't take a backup before upgrading, your only recourse is Actual's own export/import (gear icon → Settings → Export budget), if you happened to have a recent one, or your `./backup.sh` cron history if the daily 3am job was enabled during `./setup.sh`.
