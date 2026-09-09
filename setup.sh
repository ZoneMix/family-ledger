#!/bin/bash
# setup.sh — one-shot installer for The Family Ledger.
#
# Brings up Actual Budget, walks you through creating a budget file,
# figures out the values Docker needs to connect to it, then starts
# the dashboard. Safe to re-run — it will offer to reuse an existing
# .env instead of starting over.
set -o errexit

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env"
UUID_REGEX='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# ─── small helpers ──────────────────────────────────────────

# Prompts "$1 [Y/n] " and returns success (0) unless the user typed
# something starting with n/N. Empty input (just pressing Enter) means
# yes, matching the [Y/n] convention shown in the prompt.
confirm_yes() {
  local prompt="$1" ans
  read -r -p "$prompt [Y/n] " ans
  case "$ans" in
    [Nn]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Wraps a value in double quotes for writing into .env, escaping any
# backslashes/quotes inside it. Keeps passwords or titles that contain
# spaces, '#', or other special characters intact — docker compose's
# .env parser otherwise treats a bare '#' as starting a comment.
env_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# Reads a single KEY=value out of .env, stripping one layer of the
# double quotes env_quote() adds. Plain grep/sed — no jq required.
env_get() {
  local key="$1" val
  [ -f "$ENV_FILE" ] || return 0
  val="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1)"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
  esac
  printf '%s' "$val"
}

# True (exit 0) if something is already listening on 127.0.0.1:$1.
# Pure bash via /dev/tcp — no nc/ncat dependency.
port_is_listening() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3>&- 3<&- 2>/dev/null || true
    return 0
  fi
  return 1
}

detect_lan_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="localhost"
  fi
  printf '%s' "$ip"
}

detect_timezone() {
  local tz=""
  if [ -f /etc/timezone ]; then
    tz="$(cat /etc/timezone 2>/dev/null || true)"
  fi
  if [ -z "$tz" ] && [ -e /etc/localtime ]; then
    tz="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p')"
  fi
  if [ -z "$tz" ]; then
    tz="UTC"
  fi
  printf '%s' "$tz"
}

# Polls a URL with curl until it responds with a 2xx, or times out.
# Returns 1 (not 0) on timeout so callers can print their own hint.
wait_for_health() {
  local url="$1" timeout="$2" waited=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
    printf '.'
  done
  return 0
}

# ─── banner ──────────────────────────────────────────────────

echo "=================================================================="
echo "  The Family Ledger — setup"
echo "=================================================================="
echo

# ─── prerequisite checks ────────────────────────────────────

# Installs Docker from Docker's official apt repository (keyring + source
# list, no piped installer scripts). Debian/Raspberry Pi OS/Ubuntu only —
# anything else gets pointed at the docs.
install_docker_apt() {
  local codename repo_os
  # shellcheck source=/dev/null
  repo_os="$(. /etc/os-release && printf '%s' "$ID")"
  case "$repo_os" in
    ubuntu) repo_os="ubuntu" ;;
    *) repo_os="debian" ;;  # debian + raspbian both use the debian repo (64-bit)
  esac
  # shellcheck source=/dev/null
  codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"

  echo "Installing Docker from Docker's official repository..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL "https://download.docker.com/linux/${repo_os}/gpg" -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$repo_os" "$codename" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  sudo systemctl enable --now docker 2>/dev/null || sudo service docker start 2>/dev/null || true

  if ! docker info >/dev/null 2>&1; then
    local current_user
    current_user="$(id -un)"  # $USER can be unset in non-login shells
    echo
    echo "Docker is installed. Your user needs to join the 'docker' group"
    echo "before it can use it:"
    sudo usermod -aG docker "$current_user"
    echo "  done — added $current_user to the docker group."
    echo
    echo "Log out and back in (or close and reopen your SSH connection),"
    echo "then run ./setup.sh again to continue."
    exit 0
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed yet — it's the tool that runs the apps."
  if command -v apt-get >/dev/null 2>&1 && [ -r /etc/os-release ]; then
    if confirm_yes "Install it now from Docker's official repository?"; then
      install_docker_apt
    else
      echo "Install it yourself first: https://docs.docker.com/engine/install/"
      exit 1
    fi
  else
    echo "Install it first: https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The 'docker compose' plugin (Compose v2) isn't available."
  echo "Update Docker, or on Linux install the compose-plugin package:"
  echo "  https://docs.docker.com/compose/install/linux/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the Docker daemon isn't reachable."
  echo "Is Docker actually running? On Linux you may need:"
  echo "  sudo systemctl start docker"
  echo "and your user may need to be in the 'docker' group:"
  echo "  sudo usermod -aG docker \$USER   (then log out and back in)"
  exit 1
fi

LAN_IP="$(detect_lan_ip)"

# ─── .env: reuse or (re)configure ───────────────────────────

NEED_FULL_SETUP=1

if [ -f "$ENV_FILE" ]; then
  if confirm_yes "A .env file already exists. Keep it and skip setup prompts?"; then
    EXISTING_PASSWORD="$(env_get ACTUAL_PASSWORD)"
    EXISTING_SYNC_ID="$(env_get ACTUAL_SYNC_ID)"
    if [ -n "$EXISTING_PASSWORD" ] && [ -n "$EXISTING_SYNC_ID" ]; then
      NEED_FULL_SETUP=0
      DASHBOARD_PORT="$(env_get DASHBOARD_PORT)"
      DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
      ACTUAL_PORT="$(env_get ACTUAL_PORT)"
      ACTUAL_PORT="${ACTUAL_PORT:-5006}"
    else
      echo "Your existing .env is missing ACTUAL_PASSWORD or ACTUAL_SYNC_ID."
      echo "Running full setup instead."
    fi
  fi
fi

if [ "$NEED_FULL_SETUP" = "1" ]; then
  DEFAULT_TZ="$(detect_timezone)"

  echo
  read -r -p "App title [The Family Ledger]: " APP_TITLE
  APP_TITLE="${APP_TITLE:-The Family Ledger}"

  read -r -p "Timezone [$DEFAULT_TZ]: " TZ_VALUE
  TZ_VALUE="${TZ_VALUE:-$DEFAULT_TZ}"

  while :; do
    read -r -p "Dashboard port [3100]: " DASHBOARD_PORT
    DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"
    if [[ "$DASHBOARD_PORT" =~ ^[0-9]+$ ]] && [ "$DASHBOARD_PORT" -ge 1 ] && [ "$DASHBOARD_PORT" -le 65535 ]; then
      break
    fi
    echo "Please enter a valid port number (1-65535)."
  done

  while :; do
    read -r -p "Actual Budget port [5006]: " ACTUAL_PORT
    ACTUAL_PORT="${ACTUAL_PORT:-5006}"
    if [[ "$ACTUAL_PORT" =~ ^[0-9]+$ ]] && [ "$ACTUAL_PORT" -ge 1 ] && [ "$ACTUAL_PORT" -le 65535 ] && [ "$ACTUAL_PORT" != "$DASHBOARD_PORT" ]; then
      break
    fi
    echo "Please enter a valid port number (1-65535), different from the dashboard port."
  done

  while :; do
    read -r -s -p "Dashboard password (recommended, 12+ characters; leave empty for no login): " DASHBOARD_PASSWORD
    echo
    if [ -z "$DASHBOARD_PASSWORD" ] || [ "${#DASHBOARD_PASSWORD}" -ge 12 ]; then
      break
    fi
    echo "That's only ${#DASHBOARD_PASSWORD} characters — use 12+ (or leave it empty to disable login)."
  done

  if port_is_listening "$DASHBOARD_PORT"; then
    echo "Port ${DASHBOARD_PORT} is already in use on this machine."
    echo "Stop whatever is using it, or re-run this script and pick a different port."
    exit 1
  fi
  if port_is_listening "$ACTUAL_PORT"; then
    echo "Port ${ACTUAL_PORT} is already in use on this machine."
    echo "Stop whatever is using it, or re-run this script and pick a different port."
    exit 1
  fi

  # .env holds the Actual server password — umask restricts the file
  # permissions at creation time, and chmod below covers the case where
  # it already existed with looser permissions from before this change.
  (
    umask 077
    {
      printf '%s\n' "# The Family Ledger — generated by setup.sh on $(date '+%Y-%m-%d %H:%M %Z')"
      printf 'APP_TITLE=%s\n' "$(env_quote "$APP_TITLE")"
      printf 'TZ=%s\n' "$(env_quote "$TZ_VALUE")"
      printf 'DASHBOARD_PORT=%s\n' "$DASHBOARD_PORT"
      printf 'ACTUAL_PORT=%s\n' "$ACTUAL_PORT"
      printf 'DASHBOARD_PASSWORD=%s\n' "$(env_quote "$DASHBOARD_PASSWORD")"
      printf '%s\n' '# READ_ONLY=true makes the dashboard view-only (no bank sync, recategorize, or split)'
      printf 'READ_ONLY=false\n'
    } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"

  # Pre-create every bind-mounted directory as the current user. If they
  # don't exist, dockerd creates them owned by ROOT — and the dashboard
  # (which runs as an unprivileged user) can't write its cache, failing
  # with a cryptic "mkdir /cache/..." error on first budget download.
  # (macOS's Docker Desktop masks this; real Linux does not.)
  mkdir -p cache state actual-data backups

  echo
  echo "Starting the Actual Budget server..."
  docker compose up -d actual-server

  printf 'Waiting for it to come up'
  waited=0
  until port_is_listening "$ACTUAL_PORT"; do
    if [ "$waited" -ge 60 ]; then
      echo
      echo "Actual Budget didn't come up within 60 seconds."
      echo "Check what's happening with: docker compose logs actual-server"
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
    printf '.'
  done
  echo " up!"

  echo
  echo "Open this in your browser:  http://${LAN_IP}:${ACTUAL_PORT}"
  echo "  1. Set a server password (you'll enter it again below)"
  echo "  2. Click \"Start fresh\" to create your budget"
  echo
  read -r -p "Press Enter once you've done that... " _

  read -r -s -p "Actual server password: " ACTUAL_PASSWORD
  echo

  TOKEN=""
  if command -v curl >/dev/null 2>&1; then
    LOGIN_BODY="{\"loginMethod\":\"password\",\"password\":\"$(printf '%s' "$ACTUAL_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}"
    LOGIN_RESPONSE="$(curl -fsS -X POST "http://localhost:${ACTUAL_PORT}/account/login" \
      -H 'Content-Type: application/json' \
      --data "$LOGIN_BODY" 2>/dev/null || true)"
    if printf '%s' "$LOGIN_RESPONSE" | grep -q '"status":"ok"'; then
      TOKEN="$(printf '%s' "$LOGIN_RESPONSE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    fi
  fi

  DISCOVERED_ID=""
  DISCOVERED_NAME=""
  if [ -n "$TOKEN" ]; then
    FILES_RESPONSE="$(curl -fsS "http://localhost:${ACTUAL_PORT}/sync/list-user-files" \
      -H "X-ACTUAL-TOKEN: ${TOKEN}" 2>/dev/null || true)"
    FILE_COUNT="$(printf '%s' "$FILES_RESPONSE" | grep -o '"fileId"' | wc -l | tr -d ' ')"
    if [ "$FILE_COUNT" = "1" ]; then
      # The value @actual-app/api needs is the GROUP id — that's what
      # Actual's settings page labels "Sync ID". The fileId is a different
      # identifier and downloadBudget() rejects it.
      DISCOVERED_ID="$(printf '%s' "$FILES_RESPONSE" | sed -n 's/.*"groupId":"\([^"]*\)".*/\1/p' | head -n1)"
      DISCOVERED_NAME="$(printf '%s' "$FILES_RESPONSE" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -n1)"
    fi
  fi

  ACTUAL_SYNC_ID=""
  if [ -n "$DISCOVERED_ID" ] && [[ "$DISCOVERED_ID" =~ $UUID_REGEX ]]; then
    if confirm_yes "Found budget \"${DISCOVERED_NAME}\" — use it?"; then
      ACTUAL_SYNC_ID="$DISCOVERED_ID"
    fi
  fi

  if [ -z "$ACTUAL_SYNC_ID" ]; then
    echo
    echo "Let's grab the Sync ID manually:"
    echo "  1. In Actual, click the gear icon -> Settings"
    echo "  2. Click \"Show advanced settings\""
    echo "  3. Copy the value next to \"Sync ID\""
    echo
    while :; do
      read -r -p "Paste the Sync ID here: " ACTUAL_SYNC_ID
      if [[ "$ACTUAL_SYNC_ID" =~ $UUID_REGEX ]]; then
        break
      fi
      echo "That doesn't look like a Sync ID (expected something like 12345678-1234-1234-1234-123456789abc). Try again."
    done
  fi

  (
    umask 077
    {
      printf 'ACTUAL_PASSWORD=%s\n' "$(env_quote "$ACTUAL_PASSWORD")"
      printf 'ACTUAL_SYNC_ID=%s\n' "$(env_quote "$ACTUAL_SYNC_ID")"
    } >> "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
  echo "Wrote .env (permissions 600)."
fi

# ─── bring up the full stack ────────────────────────────────

echo
echo "Building and starting the dashboard..."
docker compose up -d --build

printf 'Waiting for the dashboard to finish starting'
if wait_for_health "http://localhost:${DASHBOARD_PORT}/api/health" 180; then
  echo " ready!"
else
  echo
  echo "The dashboard didn't respond within 180 seconds."
  echo "Check what's happening with: docker compose logs dashboard"
  exit 1
fi

# ─── optional daily backup ──────────────────────────────────

echo
if command -v crontab >/dev/null 2>&1; then
  if confirm_yes "Set up a daily 3am backup (cron job)?"; then
    CRON_LINE="0 3 * * * cd ${SCRIPT_DIR} && ./backup.sh >> backups/backup.log 2>&1"
    if crontab -l 2>/dev/null | grep -qF "$CRON_LINE"; then
      echo "Daily backup is already scheduled."
    else
      { crontab -l 2>/dev/null; printf '%s\n' "$CRON_LINE"; } | crontab -
      echo "Daily backup scheduled for 3am."
    fi
  fi
else
  echo "No 'crontab' command found here — skipping automatic scheduling."
  echo "You can still run ./backup.sh manually anytime."
fi

# ─── success ─────────────────────────────────────────────────

echo
echo "=================================================================="
echo "  The Family Ledger is ready!"
echo "=================================================================="
echo
echo "  Dashboard:      http://${LAN_IP}:${DASHBOARD_PORT}"
echo "  Actual Budget:  http://${LAN_IP}:${ACTUAL_PORT}"
echo
echo "  On your phone, open the dashboard URL and choose"
echo "  \"Add to Home Screen\" for a native-app-like icon."
echo
echo "  Back up regularly — run ./backup.sh anytime, or say yes next"
echo "  time to the daily 3am backup cron job."
echo
echo "  To try it with sample data first: ./seed-demo.sh"
echo "=================================================================="
