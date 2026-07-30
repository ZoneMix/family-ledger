#!/bin/bash
# update.sh — pull the latest dashboard code and rebuild it.
#
# The Actual Budget server image is intentionally version-pinned in
# docker-compose.yml (client/server version lockstep matters — see
# docs/UPGRADING.md) so this script does NOT touch it. It only
# rebuilds the dashboard container from the latest source.
set -o errexit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed (or isn't on your PATH)."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The 'docker compose' plugin (Compose v2) isn't available."
  exit 1
fi

if [ -d "$SCRIPT_DIR/.git" ]; then
  echo "Pulling the latest changes..."
  git pull
else
  echo "This directory isn't a git checkout — skipping git pull."
  echo "(If you downloaded a zip, grab the latest release instead.)"
fi

echo "Rebuilding and restarting the dashboard..."
docker compose up -d --build

echo
echo "Update complete."
echo "Actual Budget's server version stays pinned in docker-compose.yml on"
echo "purpose and does not change here — see docs/UPGRADING.md to upgrade it."
