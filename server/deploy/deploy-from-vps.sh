#!/usr/bin/env bash
#
# deploy-from-vps.sh — Deploy the latest SUXAI server code from the VPS itself.
#
# Use this when you're already SSH'd into the VPS (e.g. after a fresh install)
# and don't have the repo cloned on a local machine handy. Requires a GitHub
# Personal Access Token because the repo is private.
#
# Pre-requisites:
#   - Run as root or via sudo (the script writes /opt/suxai/app and restarts
#     the systemd unit).
#   - install.sh has already been run once (suxai user + /opt/suxai/ exist).
#   - The repo `mkultra110/suxaidev2` is reachable with the provided token.
#
# Usage:
#   GHTOKEN='ghp_xxx' BRANCH='claude/french-greeting-lGwbV' \
#     bash server/deploy/deploy-from-vps.sh
#
#   Or paste the env vars + curl one-liner shown in the project README.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
GHUSER=${GHUSER:-mkultra110}
GHREPO=${GHREPO:-suxaidev2}
GHTOKEN=${GHTOKEN:-}
BRANCH=${BRANCH:-claude/french-greeting-lGwbV}
SUXAI_ROOT=${SUXAI_ROOT:-/opt/suxai}

if [[ -z "$GHTOKEN" ]]; then
  echo "Error: GHTOKEN env var is required (GitHub PAT with repo:read)." >&2
  echo "Generate one at https://github.com/settings/tokens?type=beta" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null; then
  echo "Error: must run as root or have sudo available." >&2
  exit 1
fi

SUDO=$([[ $EUID -eq 0 ]] && echo "" || echo "sudo")

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! id suxai >/dev/null 2>&1; then
  echo "Error: 'suxai' user not found — run install.sh first." >&2
  exit 1
fi
if [[ ! -d "$SUXAI_ROOT" ]]; then
  echo "Error: $SUXAI_ROOT not found — run install.sh first." >&2
  exit 1
fi

# ── Clone the repo (shallow, single branch) ─────────────────────────────────
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Cloning $GHUSER/$GHREPO branch=$BRANCH (shallow)"
git clone --quiet --depth 1 -b "$BRANCH" \
  "https://${GHUSER}:${GHTOKEN}@github.com/${GHUSER}/${GHREPO}.git" "$TMP/repo"

if [[ ! -d "$TMP/repo/server" ]]; then
  echo "Error: cloned repo has no server/ directory." >&2
  exit 1
fi

# ── Sync to /opt/suxai/app/ ─────────────────────────────────────────────────
echo "==> Syncing server/ → $SUXAI_ROOT/app/"
$SUDO rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude data \
  "$TMP/repo/server/" "$SUXAI_ROOT/app/"

$SUDO chown -R suxai:suxai "$SUXAI_ROOT/app"

# ── Install deps + build ────────────────────────────────────────────────────
echo "==> Installing deps + building (as 'suxai' user)"
# Drop to the suxai user. `sudo -u suxai` works whether the script runs as
# root or via sudo; `runuser` is the no-sudo fallback (always present in
# Debian's util-linux). We need an array form because `$SUDO -u suxai ...`
# breaks when $SUDO is empty (the leading space makes bash try to execute
# `-u` as a command).
if command -v sudo >/dev/null; then
  AS_SUXAI=(sudo -u suxai -H bash -lc)
else
  AS_SUXAI=(runuser -u suxai -- bash -lc)
fi
if [[ -f "$SUXAI_ROOT/app/package-lock.json" ]]; then
  "${AS_SUXAI[@]}" "cd $SUXAI_ROOT/app && npm ci && npm run build"
else
  "${AS_SUXAI[@]}" "cd $SUXAI_ROOT/app && npm install --no-audit --no-fund && npm run build"
fi

# ── Restart systemd unit ────────────────────────────────────────────────────
echo "==> Restarting suxai-server"
if [[ -f "$SUXAI_ROOT/app/deploy/suxai-server.service" ]]; then
  $SUDO cp "$SUXAI_ROOT/app/deploy/suxai-server.service" /etc/systemd/system/suxai-server.service
  $SUDO systemctl daemon-reload
fi
$SUDO systemctl restart suxai-server

# ── Health check ────────────────────────────────────────────────────────────
echo "==> Healthcheck"
sleep 2
if curl -sf http://127.0.0.1:4000/health >/dev/null; then
  curl -s http://127.0.0.1:4000/health
  echo
  echo "✔ Deploy complete"
else
  echo "✗ Health check failed — check journalctl -u suxai-server -n 50" >&2
  exit 1
fi
