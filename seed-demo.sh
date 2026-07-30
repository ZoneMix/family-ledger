#!/bin/bash
# seed-demo.sh — load deterministic sample data into a FRESH Actual
# budget so you can try the dashboard before connecting your real
# finances. Runs the dashboard image in a throwaway container with
# its own scratch data directory, so it never touches your real
# dashboard cache. Pass --force to seed on top of a non-empty budget.
set -o errexit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "No .env found — run ./setup.sh first so ACTUAL_SERVER_URL/PASSWORD/SYNC_ID are set."
  exit 1
fi

DASHBOARD_PORT="$(sed -n 's/^DASHBOARD_PORT=//p' "$SCRIPT_DIR/.env" | tail -n1 | tr -d '"')"
DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"

echo "Seeding demo data (this only touches a throwaway data dir, not your real cache)..."
docker compose run --rm -e ACTUAL_DATA_DIR=/tmp/seed dashboard node scripts/seed-demo.js "$@"

# Give the Goals panel demo data too. This must happen HOST-side (the
# seeder runs in a throwaway container) and needs a rebuild, because the
# dashboard bakes optional config files into its image at build time.
COPIED_GOALS=0
if [ -f "$SCRIPT_DIR/goals.example.json" ] && [ ! -f "$SCRIPT_DIR/goals.json" ]; then
  cp "$SCRIPT_DIR/goals.example.json" "$SCRIPT_DIR/goals.json"
  COPIED_GOALS=1
  echo "Copied goals.example.json -> goals.json (Goals panel gets demo data)."
fi

if [ "$COPIED_GOALS" = "1" ]; then
  echo "Rebuilding the dashboard so it picks up goals.json..."
  docker compose up -d --build dashboard
  echo "Done. Open the dashboard to see the sample budget."
elif curl -fsS -X POST "http://localhost:${DASHBOARD_PORT}/api/refresh" >/dev/null 2>&1; then
  echo "Refreshing the dashboard..."
  echo "Done. Open the dashboard to see the sample budget."
else
  echo "Seeded, but couldn't reach the dashboard to trigger an immediate refresh."
  echo "It'll pick up the new data on its next scheduled refresh, or restart it with:"
  echo "  docker compose restart dashboard"
fi
