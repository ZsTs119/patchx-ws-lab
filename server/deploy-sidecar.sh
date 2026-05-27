#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${WS_LAB_AUTH_SERVICE_NAME:-patchx-ws-lab-auth}"
HOST="${WS_LAB_AUTH_HOST:-127.0.0.1}"
PORT="${WS_LAB_AUTH_PORT:-8787}"
RUN_USER="${WS_LAB_AUTH_RUN_USER:-}"
USERS_FILE="${WS_LAB_AUTH_USERS_FILE:-$ROOT_DIR/server/users.json}"
EXAMPLE_USERS_FILE="$ROOT_DIR/server/users.example.json"
ENV_FILE="${WS_LAB_AUTH_ENV_FILE:-/etc/patchx-ws-lab-auth.env}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SERVER_SCRIPT="$ROOT_DIR/server/ws-lab-auth-server.js"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo bash server/deploy-sidecar.sh" >&2
  exit 1
fi

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "Cannot find $SERVER_SCRIPT" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found. Install Node.js first, then rerun this script." >&2
  exit 1
fi

if [[ -z "$RUN_USER" ]]; then
  if id caddy >/dev/null 2>&1; then
    RUN_USER="caddy"
  else
    RUN_USER="$(id -un)"
  fi
fi

if [[ ! -f "$USERS_FILE" ]]; then
  if [[ ! -f "$EXAMPLE_USERS_FILE" ]]; then
    echo "Cannot find users file or example file." >&2
    exit 1
  fi
  cp "$EXAMPLE_USERS_FILE" "$USERS_FILE"
  echo "Created $USERS_FILE from users.example.json. Replace placeholder passwords before sharing."
fi

if [[ ! -f "$ENV_FILE" ]]; then
  SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
WS_LAB_AUTH_HOST=$HOST
WS_LAB_AUTH_PORT=$PORT
WS_LAB_AUTH_USERS_FILE=$USERS_FILE
WS_LAB_AUTH_SESSION_SECRET=$SECRET
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE"
else
  grep -q '^WS_LAB_AUTH_HOST=' "$ENV_FILE" || echo "WS_LAB_AUTH_HOST=$HOST" >> "$ENV_FILE"
  grep -q '^WS_LAB_AUTH_PORT=' "$ENV_FILE" || echo "WS_LAB_AUTH_PORT=$PORT" >> "$ENV_FILE"
  grep -q '^WS_LAB_AUTH_USERS_FILE=' "$ENV_FILE" || echo "WS_LAB_AUTH_USERS_FILE=$USERS_FILE" >> "$ENV_FILE"
  if ! grep -q '^WS_LAB_AUTH_SESSION_SECRET=' "$ENV_FILE"; then
    echo "WS_LAB_AUTH_SESSION_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
fi

if id "$RUN_USER" >/dev/null 2>&1; then
  chown "$RUN_USER:$RUN_USER" "$USERS_FILE" || true
  chmod 600 "$USERS_FILE" || true
fi

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=PatchX WS Lab Auth Sidecar
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $SERVER_SCRIPT
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

sleep 0.5
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,12p'

echo
echo "Local auth health:"
curl -fsS "http://${HOST}:${PORT}/api/ws-lab-auth/health"
echo
echo
echo "Done. Make sure Caddy proxies /api/ws-lab-auth* to ${HOST}:${PORT}."
