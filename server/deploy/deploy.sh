#!/usr/bin/env bash
#
# deploy.sh — Re-deploy the latest server code to an already-installed VPS.
#
# Assumes install.sh has been run once. Pushes the local server/ code,
# rebuilds, and restarts the systemd unit. Only touches /opt/suxai/.
#
# Usage from the repo root:
#   server/deploy/deploy.sh <user>@<host>
#   server/deploy/deploy.sh deploy@209.99.186.238

set -euo pipefail

TARGET=${1:-}
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <ssh-user>@<host>" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
SUXAI_ROOT=${SUXAI_ROOT:-/opt/suxai}
REMOTE_TMP=/tmp/suxai-deploy-$$

echo "==> Uploading server code to $TARGET:$REMOTE_TMP"
ssh "$TARGET" "mkdir -p $REMOTE_TMP"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  --exclude .env \
  "$SERVER_DIR/" "$TARGET:$REMOTE_TMP/"

echo "==> Installing on remote"
ssh "$TARGET" bash -s <<EOF
set -euo pipefail
sudo rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude data \
  "$REMOTE_TMP/" "$SUXAI_ROOT/app/"
sudo chown -R suxai:suxai "$SUXAI_ROOT/app"
sudo -u suxai -H bash -lc "cd $SUXAI_ROOT/app && npm ci --omit=dev=false && npm run build"
sudo cp "$SUXAI_ROOT/app/deploy/suxai-server.service" /etc/systemd/system/suxai-server.service
sudo systemctl daemon-reload
sudo systemctl restart suxai-server
rm -rf "$REMOTE_TMP"
EOF

echo "==> Checking health"
ssh "$TARGET" "curl -sf http://127.0.0.1:4000/health && echo"
echo "✔ Deploy complete"
