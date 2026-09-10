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
case "$KEEP" in
  ''|*[!0-9]*)
    echo "KEEP must be a positive integer (got: '$KEEP')" >&2
    exit 1
    ;;
esac
if [ "$KEEP" -eq 0 ]; then
  echo "KEEP=0 would delete the archive this run is about to write — refusing. Use KEEP=1 or higher." >&2
  exit 1
fi
STAMP="$(date +%Y%m%d-%H%M)"
ARCHIVE="$BACKUP_DIR/family-ledger-${STAMP}.tar.gz"
BACKUP_DONE=0   # set to 1 once $FINAL_ARCHIVE is written AND verified

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

ACTUAL_STOPPED_BY_US=0
ACTUAL_RESTART_DONE=0

# Runs exactly once no matter how the script exits — normal completion,
# a verification failure's own `exit 1`, or a signal. Idempotent (guarded
# by $ACTUAL_RESTART_DONE) because the `exit 130` in the INT/TERM trap
# below deliberately unwinds through this same EXIT trap, so it can
# legitimately run via two different trigger paths for one process exit.
restart_actual() {
  if [ "$ACTUAL_RESTART_DONE" = 1 ]; then
    return
  fi
  ACTUAL_RESTART_DONE=1
  if [ "$ACTUAL_STOPPED_BY_US" = 1 ]; then
    docker compose start actual-server >/dev/null 2>&1 || true
  fi
  # A signal mid-tar/mid-age leaves a partial file at $ARCHIVE or
  # $ARCHIVE.age — remove it. Never touches a FINISHED archive: that
  # only happens once $BACKUP_DONE is set, right after verification
  # passes, further down the script.
  if [ "$BACKUP_DONE" != 1 ]; then
    rm -f "$ARCHIVE" "$ARCHIVE.age"
  fi
}

if [ "$ACTUAL_WAS_RUNNING" = 1 ]; then
  # Registered before the stop call (not after it succeeds) so a Ctrl-C
  # in the gap between "docker compose stop" completing and a trap line
  # running can't leave Actual down with no trap left to bring it back.
  # restart_actual only restarts once $ACTUAL_STOPPED_BY_US is 1, set
  # right after the stop call actually succeeds below — never on a
  # failed/interrupted one. INT/TERM explicitly `exit` instead of
  # merely running a handler and resuming — bash does NOT terminate a
  # script on a trapped INT/TERM unless the handler itself exits, so
  # without this a Ctrl-C would restart Actual but let the backup keep
  # running to completion. The explicit exit unwinds through the EXIT
  # trap above, so Ctrl-C both restores Actual and actually aborts.
  trap restart_actual EXIT
  trap 'exit 130' INT TERM
  if docker compose stop actual-server >/dev/null 2>&1; then
    ACTUAL_STOPPED_BY_US=1
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

# Past this point the archive is finished and verified — restart_actual's
# cleanup must never remove it, however the script later exits.
BACKUP_DONE=1

echo "Wrote $FINAL_ARCHIVE"

# Prune to the newest $KEEP backups. Filenames sort chronologically
# (family-ledger-YYYYMMDD-HHMM.tar.gz[.age]), so a plain name sort works.
# The glob covers both plain and age-encrypted archives.
# while-read instead of mapfile: macOS ships bash 3.2, which lacks it.
# No `head` in this pipeline: with pipefail (set above), a downstream
# reader exiting early (like `head -n N`) after upstream `sort` still
# has buffered output makes `sort` catch SIGPIPE, which counts as the
# pipeline's own failure and would abort the script via errexit — after
# the backup was already written and pruned correctly, so a cron run
# would falsely report failure. Instead the while loop reads every
# line to EOF (so nothing upstream ever gets SIGPIPE) and only acts on
# the first $REMOVE_COUNT of them, via a counter.
TOTAL="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | wc -l | tr -d ' ')"
if [ "$TOTAL" -gt "$KEEP" ]; then
  REMOVE_COUNT=$((TOTAL - KEEP))
  find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | sort \
    | { PRUNE_INDEX=0
        while IFS= read -r old; do
          PRUNE_INDEX=$((PRUNE_INDEX + 1))
          if [ "$PRUNE_INDEX" -le "$REMOVE_COUNT" ]; then
            rm -f "$old"
            echo "Removed old backup: $(basename "$old")"
          fi
        done
      }
fi

KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz*' | wc -l | tr -d ' ')"
if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
  echo "Backup complete (age-encrypted). $KEPT backup(s) kept in $BACKUP_DIR."
else
  echo "Backup complete (plain). $KEPT backup(s) kept in $BACKUP_DIR."
fi
echo "Remember to copy $BACKUP_DIR somewhere off this machine — a backup on the same disk doesn't survive a dead disk."
