#!/usr/bin/env bash
# Sets up a NeuroFlow worker (and its Docker sandbox) on a fresh Ubuntu VM, e.g. Oracle Cloud's
# Always Free Ampere instance. Safe to re-run: it updates the checkout, rebuilds and restarts.
#
#   curl -fsSL https://raw.githubusercontent.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system/master/infra/scripts/setup-worker-vm.sh | bash
#
# First run creates /etc/neuroflow/worker.env from a template and stops so you can fill it in
# (DATABASE_URL, REDIS_URL, GROQ_API_KEY, SECRETS_KEY, SESSION_SECRET). Run it again afterwards.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system.git}"
BRANCH="${BRANCH:-master}"
APP_DIR="${APP_DIR:-/opt/neuroflow}"
DATA_DIR="${DATA_DIR:-/var/lib/neuroflow/code}"
ENV_FILE=/etc/neuroflow/worker.env
SERVICE=/etc/systemd/system/neuroflow-worker.service
RUN_USER="${SUDO_USER:-$USER}"
PNPM_VERSION=9.15.4
SANDBOX_IMAGES=(node:22-bookworm-slim python:3.12-slim golang:1.23-bookworm rust:1-slim-bookworm)

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "System packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker
if ! id -nG "$RUN_USER" | grep -qw docker; then
  sudo usermod -aG docker "$RUN_USER"
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

log "Pre-pulling sandbox images (first commands start fast)"
for image in "${SANDBOX_IMAGES[@]}"; do sudo docker pull -q "$image"; done

log "Directories"
sudo mkdir -p "$APP_DIR" "$DATA_DIR" /etc/neuroflow
sudo chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE — fill it in, then run this script again"
  sudo tee "$ENV_FILE" >/dev/null <<EOF
NODE_ENV=production
# Same values as the API service:
DATABASE_URL=
REDIS_URL=
SECRETS_KEY=
SESSION_SECRET=
# Models
GROQ_API_KEY=
GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b
# disabled = models run only with workspaces' own keys (match the API)
PLATFORM_MODEL_KEYS=enabled
# Local paths and queues
CODE_DATA_DIR=${DATA_DIR}
WORKER_QUEUES=runs,workspace,evals
LOG_LEVEL=info
# Optional: error tracking (same DSN as the API)
SENTRY_DSN=
EOF
  sudo chmod 600 "$ENV_FILE"
  echo "Edit it with:  sudo nano $ENV_FILE"
  exit 0
fi

for key in DATABASE_URL REDIS_URL SECRETS_KEY GROQ_API_KEY; do
  if ! sudo grep -Eq "^${key}=.+" "$ENV_FILE"; then
    echo "error: $key is empty in $ENV_FILE" >&2
    exit 1
  fi
done

log "Fetching the code ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

log "Building the worker"
cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm --filter @neuroflow/worker build

log "Installing the systemd service"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=NeuroFlow worker
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=${RUN_USER}
SupplementaryGroups=docker
WorkingDirectory=${APP_DIR}/apps/worker
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) dist/main.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable neuroflow-worker
sudo systemctl restart neuroflow-worker

log "Done"
sleep 3
sudo systemctl --no-pager --lines=8 status neuroflow-worker || true
echo
echo "Follow the logs with:  journalctl -u neuroflow-worker -f"
echo "Expect: \"model gateway ready\" and \"worker started\" with queues runs, workspace, evals."
