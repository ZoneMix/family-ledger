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
# So a failure partway through a pipe (tar | age, in particular) is
# reported through the failing command's own exit status instead of
# being masked by whatever runs after it succeeding on truncated input.
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
KEEP="${KEEP:-14}"   # override with KEEP=N ./backup.sh to keep more/fewer
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
# few seconds tar needs avoids reading it mid-write. Actual is only
# stopped if it was actually running under docker compose — a plain
# `docker compose stop` is a no-op on an already-stopped container, but
# unconditionally "starting" it back up afterward would undo a household
# member deliberately taking it down (e.g. during maintenance), every
# time cron fires this script. The trap only restarts Actual if THIS
# run is the one that stopped it, and fires on any EXIT (normal
# completion, a verification failure, or Ctrl-C alike) so it never
# stays down because of this script. The dashboard container (if
# running) keeps serving its in-memory cache while Actual is paused —
# its own refresh/sync log lines will show connection errors for those
# few seconds, which is expected and harmless.
ACTUAL_WAS_RUNNING=0
if command -v docker >/dev/null 2>&1; then
  RUNNING_SERVICES="$(docker compose ps --status running --services 2>/dev/null)" && DOCKER_QUERY_OK=1 || DOCKER_QUERY_OK=0
else
  DOCKER_QUERY_OK=0
fi
if [ "$DOCKER_QUERY_OK" = 1 ] && printf '%s\n' "$RUNNING_SERVICES" | grep -qx actual-server; then
  ACTUAL_WAS_RUNNING=1
fi

if [ "$ACTUAL_WAS_RUNNING" = 1 ]; then
  if docker compose stop actual-server >/dev/null 2>&1; then
    trap 'docker compose start actual-server >/dev/null 2>&1 || true' EXIT
    echo "Paused actual-server for a consistent snapshot (will restart it before this script exits)."
  else
    echo "WARNING: actual-server is running but couldn't be stopped — this backup is a snapshot of a LIVE database."
  fi
elif [ "$DOCKER_QUERY_OK" = 1 ]; then
  echo "actual-server isn't running — nothing to pause; backing up its data as it sits on disk."
else
  echo "WARNING: couldn't check actual-server's state (docker compose unavailable) — this backup may be a snapshot of a LIVE database."
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
  # Streamed straight into age — never touches disk unencrypted. With
  # pipefail (set above), a tar failure here fails this whole pipeline
  # even though age itself still "succeeds" encrypting whatever partial
  # (or empty) input it got — so we still need to clean up the file the
  # redirect already created before reporting the failure.
  if ! tar -czf - "${TAR_TARGETS[@]}" 2>/dev/null | age -r "$BACKUP_AGE_RECIPIENT" > "$FINAL_ARCHIVE"; then
    rm -f "$FINAL_ARCHIVE"
    echo "Backup failed — could not create $FINAL_ARCHIVE."
    exit 1
  fi
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
