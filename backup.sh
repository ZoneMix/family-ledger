#!/bin/bash
# backup.sh — snapshot Actual's data directory + dashboard state into
# a timestamped tarball under backups/, then prune old ones.
#
# This backs up the raw data files docker-compose.yml mounts
# (./actual-data and ./state). For a belt-and-suspenders copy, also
# use Actual's own built-in "Export budget" (gear icon -> Settings)
# every so often — that produces a portable .zip independent of this
# script.
set -o errexit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
KEEP=14
STAMP="$(date +%Y%m%d-%H%M)"
ARCHIVE="$BACKUP_DIR/family-ledger-${STAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

if [ ! -d "$SCRIPT_DIR/actual-data" ]; then
  echo "No ./actual-data directory found — nothing to back up yet."
  echo "(Run ./setup.sh first, or make sure you're running this from the repo root.)"
  exit 1
fi

TAR_TARGETS=(actual-data)
if [ -d "$SCRIPT_DIR/state" ]; then
  TAR_TARGETS+=(state)
fi

# Stop Actual for a consistent snapshot --------------------------------
# actual-data holds a live SQLite database; pausing the server for the
# few seconds tar needs avoids reading it mid-write. The dashboard
# container (if running) keeps serving its in-memory cache while
# Actual is down — its own refresh/sync log lines will show connection
# errors for those few seconds, which is expected and harmless. The
# trap restarts Actual on EXIT (normal completion, a verification
# failure, or Ctrl-C alike) so it never stays down because of this
# script.
if command -v docker >/dev/null 2>&1 && docker compose stop actual-server >/dev/null 2>&1; then
  trap 'docker compose start actual-server >/dev/null 2>&1 || true' EXIT
else
  echo "WARNING: couldn't stop actual-server (docker compose unavailable, or the container isn't running) — this backup is a snapshot of a LIVE database."
fi

# Optional age encryption ------------------------------------------------
# BACKUP_AGE_RECIPIENT wins from the environment; otherwise read it out
# of .env with the same sed pattern setup.sh's env_get() uses.
if [ -z "$BACKUP_AGE_RECIPIENT" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  BACKUP_AGE_RECIPIENT="$(sed -n 's/^BACKUP_AGE_RECIPIENT=//p' "$SCRIPT_DIR/.env" | tail -n1)"
  case "$BACKUP_AGE_RECIPIENT" in
    \"*\") BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT#\"}"; BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT%\"}" ;;
  esac
fi

if [ -n "$BACKUP_AGE_RECIPIENT" ] && ! command -v age >/dev/null 2>&1; then
  echo "BACKUP_AGE_RECIPIENT is set but 'age' is not installed"
  exit 1
fi

echo "Backing up ${TAR_TARGETS[*]} ..."
if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
  FINAL_ARCHIVE="$ARCHIVE.age"
  # Streamed straight into age — never touches disk unencrypted.
  tar -czf - "${TAR_TARGETS[@]}" 2>/dev/null | age -r "$BACKUP_AGE_RECIPIENT" > "$FINAL_ARCHIVE"
else
  FINAL_ARCHIVE="$ARCHIVE"
  # --warning=no-file-changed quiets GNU tar's noise about files changing
  # mid-read (normal for a live SQLite database). Not every tar supports
  # that flag (e.g. macOS's bundled BSD tar), so fall back to a plain
  # invocation if it's rejected — either way, success is judged by
  # whether a non-empty archive actually landed on disk.
  tar --warning=no-file-changed -czf "$FINAL_ARCHIVE" "${TAR_TARGETS[@]}" 2>/dev/null \
    || tar -czf "$FINAL_ARCHIVE" "${TAR_TARGETS[@]}" 2>/dev/null \
    || true
fi

if [ ! -s "$FINAL_ARCHIVE" ]; then
  echo "Backup failed — $FINAL_ARCHIVE was not created."
  exit 1
fi

# Verify the archive is actually readable before trusting it -----------
if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
  # Can't decrypt without the private key to confirm the tar inside is
  # intact, so settle for confirming it's non-empty (checked above) and
  # starts with age's own file header.
  if [ "$(head -c 22 "$FINAL_ARCHIVE")" != "age-encryption.org/v1" ]; then
    rm -f "$FINAL_ARCHIVE"
    echo "Backup FAILED verification"
    exit 1
  fi
else
  if ! gzip -t "$FINAL_ARCHIVE" 2>/dev/null || ! tar -tzf "$FINAL_ARCHIVE" >/dev/null 2>&1; then
    rm -f "$FINAL_ARCHIVE"
    echo "Backup FAILED verification"
    exit 1
  fi
fi

echo "Wrote $FINAL_ARCHIVE"

# Prune to the newest $KEEP backups. Filenames sort chronologically
# (family-ledger-YYYYMMDD-HHMM.tar.gz[.age]), so a plain name sort works.
# The glob covers both plain and age-encrypted archives.
# while-read instead of mapfile: macOS ships bash 3.2, which lacks it.
TOTAL="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | wc -l | tr -d ' ')"
if [ "$TOTAL" -gt "$KEEP" ]; then
  REMOVE_COUNT=$((TOTAL - KEEP))
  find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | sort | head -n "$REMOVE_COUNT" \
    | while IFS= read -r old; do
        rm -f "$old"
        echo "Removed old backup: $(basename "$old")"
      done
fi

KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | wc -l | tr -d ' ')"
if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
  echo "Backup complete (age-encrypted). $KEPT backup(s) kept in $BACKUP_DIR."
else
  echo "Backup complete (plain). $KEPT backup(s) kept in $BACKUP_DIR."
fi
echo "Remember to copy $BACKUP_DIR somewhere off this machine — a backup on the same disk doesn't survive a dead disk."
