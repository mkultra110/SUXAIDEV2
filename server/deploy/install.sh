#!/usr/bin/env bash
#
# install.sh — One-shot VPS setup for SUXAI.
#
# Creates /opt/suxai/ and keeps EVERYTHING related to SUXAI inside it:
#
#   /opt/suxai/
#   ├── app/         # Node.js server code (synced from repo's server/)
#   ├── data/        # users.json and other persisted state  (DATA_DIR)
#   ├── logs/        # server.log (systemd StandardOutput)
#   ├── releases/    # update binaries served by nginx at /releases/
#   └── .env         # configuration (mode 600, owned by suxai)
#
# Safe to re-run. Idempotent. Does NOT touch anything outside /opt/suxai/,
# the `suxai` system user, the suxai-server systemd unit, and the suxai
# nginx site.

set -euo pipefail

# ---- Config ----------------------------------------------------------------
SUXAI_ROOT=${SUXAI_ROOT:-/opt/suxai}
SUXAI_USER=${SUXAI_USER:-suxai}
SUXAI_GROUP=${SUXAI_GROUP:-suxai}
NODE_MAJOR=${NODE_MAJOR:-20}
SERVICE_NAME=suxai-server
NGINX_SITE=${NGINX_SITE:-suxai}

# Where the repo is currently checked out (defaults to $PWD; override when
# running from an unpacked tarball).
REPO_ROOT=${REPO_ROOT:-$(pwd)}
SERVER_SRC=${SERVER_SRC:-"$REPO_ROOT/server"}

# ---- Pre-flight ------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (sudo ./install.sh)." >&2
  exit 1
fi

if [[ ! -f "$SERVER_SRC/package.json" ]]; then
  echo "Cannot find server source at $SERVER_SRC. Set SERVER_SRC=/path/to/server." >&2
  exit 1
fi

echo "==> Target layout: $SUXAI_ROOT"

# ---- System user -----------------------------------------------------------
if ! id -u "$SUXAI_USER" >/dev/null 2>&1; then
  echo "==> Creating system user $SUXAI_USER"
  useradd --system --home-dir "$SUXAI_ROOT" --shell /usr/sbin/nologin "$SUXAI_USER"
fi

# ---- Base packages ---------------------------------------------------------
# rsync is used to sync source into /opt/suxai/app; curl is needed for Node
# repo setup; ca-certificates for TLS. Install whatever's missing.
MISSING_PKGS=()
for pkg in rsync curl ca-certificates; do
  if ! command -v "$pkg" >/dev/null 2>&1 && ! dpkg -s "$pkg" >/dev/null 2>&1; then
    MISSING_PKGS+=("$pkg")
  fi
done
if (( ${#MISSING_PKGS[@]} > 0 )); then
  echo "==> Installing missing packages: ${MISSING_PKGS[*]}"
  apt-get update -y
  apt-get install -y "${MISSING_PKGS[@]}"
fi

# ---- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node.js $NODE_MAJOR via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

# ---- Directory tree --------------------------------------------------------
echo "==> Creating $SUXAI_ROOT structure"
install -d -o "$SUXAI_USER" -g "$SUXAI_GROUP" -m 0750 "$SUXAI_ROOT"
install -d -o "$SUXAI_USER" -g "$SUXAI_GROUP" -m 0750 "$SUXAI_ROOT/app"
install -d -o "$SUXAI_USER" -g "$SUXAI_GROUP" -m 0700 "$SUXAI_ROOT/data"
install -d -o "$SUXAI_USER" -g "$SUXAI_GROUP" -m 0750 "$SUXAI_ROOT/logs"
install -d -o "$SUXAI_USER" -g "$SUXAI_GROUP" -m 0755 "$SUXAI_ROOT/releases"

# ---- Sync server code ------------------------------------------------------
echo "==> Syncing server code to $SUXAI_ROOT/app"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude data \
  "$SERVER_SRC/" "$SUXAI_ROOT/app/"
chown -R "$SUXAI_USER:$SUXAI_GROUP" "$SUXAI_ROOT/app"

# ---- .env ------------------------------------------------------------------
if [[ ! -f "$SUXAI_ROOT/.env" ]]; then
  echo "==> Creating $SUXAI_ROOT/.env (edit it before starting the service!)"
  cp "$SERVER_SRC/.env.example" "$SUXAI_ROOT/.env"

  # Generate a strong JWT_SECRET automatically.
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" "$SUXAI_ROOT/.env"
  sed -i "s|^DATA_DIR=.*|DATA_DIR=${SUXAI_ROOT}/data|" "$SUXAI_ROOT/.env"
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$SUXAI_ROOT/.env"

  chown "$SUXAI_USER:$SUXAI_GROUP" "$SUXAI_ROOT/.env"
  chmod 0600 "$SUXAI_ROOT/.env"
else
  echo "==> Preserving existing $SUXAI_ROOT/.env"
fi

# ---- Install deps + build --------------------------------------------------
echo "==> Installing npm deps + building"
sudo -u "$SUXAI_USER" -H bash -lc "cd '$SUXAI_ROOT/app' && npm ci --omit=dev=false && npm run build"

# ---- systemd unit ----------------------------------------------------------
echo "==> Installing systemd unit"
cp "$SERVER_SRC/deploy/suxai-server.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

# ---- nginx site ------------------------------------------------------------
if command -v nginx >/dev/null 2>&1; then
  echo "==> Installing nginx site"
  cp "$SERVER_SRC/deploy/nginx.conf.example" "/etc/nginx/sites-available/${NGINX_SITE}"
  ln -sf "/etc/nginx/sites-available/${NGINX_SITE}" "/etc/nginx/sites-enabled/${NGINX_SITE}"
  if nginx -t; then
    systemctl reload nginx
  else
    echo "!! nginx config test failed — not reloading. Fix /etc/nginx/sites-available/${NGINX_SITE} and run: sudo nginx -t && sudo systemctl reload nginx" >&2
  fi
else
  echo "(nginx not installed — skipping reverse proxy setup)"
fi

# ---- Start / restart service ----------------------------------------------
echo "==> Starting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}.service"
sleep 1
systemctl --no-pager --full status "${SERVICE_NAME}.service" | head -n 15 || true

cat <<EOF

✔ SUXAI is installed under $SUXAI_ROOT

Next steps:
  1) Edit secrets:  sudo -e $SUXAI_ROOT/.env   (QUATARLY_API_KEY, UPDATE_*)
  2) Reload:        sudo systemctl restart ${SERVICE_NAME}
  3) Logs:          sudo tail -f $SUXAI_ROOT/logs/server.log
  4) Health:        curl -s http://127.0.0.1:4000/health | jq
  5) Upload build:  drop your installer into $SUXAI_ROOT/releases/
                    and set UPDATE_URL=http://<your-host>/releases/<file>

Every SUXAI file lives under $SUXAI_ROOT — nothing else on this VPS is touched.
EOF
