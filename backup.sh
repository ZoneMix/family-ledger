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

echo "Backing up ${TAR_TARGETS[*]} ..."
# --warning=no-file-changed quiets GNU tar's noise about files changing
# mid-read (normal for a live SQLite database). Not every tar supports
# that flag (e.g. macOS's bundled BSD tar), so fall back to a plain
# invocation if it's rejected — either way, success is judged by
# whether a non-empty archive actually landed on disk.
tar --warning=no-file-changed -czf "$ARCHIVE" "${TAR_TARGETS[@]}" 2>/dev/null \
  || tar -czf "$ARCHIVE" "${TAR_TARGETS[@]}" 2>/dev/null \
  || true

if [ ! -s "$ARCHIVE" ]; then
  echo "Backup failed — $ARCHIVE was not created."
  exit 1
fi

echo "Wrote $ARCHIVE"

# Prune to the newest $KEEP backups. Filenames sort chronologically
# (family-ledger-YYYYMMDD-HHMM.tar.gz), so a plain name sort works.
# while-read instead of mapfile: macOS ships bash 3.2, which lacks it.
TOTAL="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz' | wc -l | tr -d ' ')"
if [ "$TOTAL" -gt "$KEEP" ]; then
  REMOVE_COUNT=$((TOTAL - KEEP))
  find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz' | sort | head -n "$REMOVE_COUNT" \
    | while IFS= read -r old; do
        rm -f "$old"
        echo "Removed old backup: $(basename "$old")"
      done
fi

KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'family-ledger-*.tar.gz' | wc -l | tr -d ' ')"
echo "Backup complete. $KEPT backup(s) kept in $BACKUP_DIR."
