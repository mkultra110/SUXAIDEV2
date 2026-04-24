#!/usr/bin/env bash
#
# setup-github-deploy.sh — One-shot: configure SSH access so GitHub Actions
# can upload new installers to /opt/suxai/releases/ and restart the service.
#
# Run this ONCE on the VPS as root:
#
#   sudo /root/suxaidev2/server/deploy/setup-github-deploy.sh
#
# It:
#   1. Generates a dedicated ed25519 keypair for GitHub Actions at
#      /root/.ssh/suxai-gh-deploy[.pub]
#   2. Appends the public key to /root/.ssh/authorized_keys
#   3. Prints the 3 values you need to add to GitHub
#      (repo Settings → Secrets and variables → Actions → New repository secret):
#         VPS_HOST             = the VPS IP / hostname
#         VPS_USER             = root (or whatever user this script ran as)
#         VPS_SSH_KEY          = the PRIVATE key content (copy entire block)
#         VPS_PUBLIC_URL_BASE  = https://suxai.209-99-186-238.sslip.io
#   4. chmods /opt/suxai to 0755 so Caddy (user `caddy`) can traverse
#      into /opt/suxai/releases/ to serve downloads.
#
# After that, every push to the dev branch triggers a build + deploy
# automatically. The IDE picks up the new version on next launch.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

KEY_PATH=${KEY_PATH:-/root/.ssh/suxai-gh-deploy}
VPS_USER=${SUDO_USER:-$(whoami)}
VPS_PUBLIC_URL_BASE=${VPS_PUBLIC_URL_BASE:-https://suxai.209-99-186-238.sslip.io}

# 1) Generate the deploy keypair if missing.
if [[ ! -f "$KEY_PATH" ]]; then
  echo "==> Generating SSH deploy keypair at $KEY_PATH"
  mkdir -p "$(dirname "$KEY_PATH")"
  chmod 700 "$(dirname "$KEY_PATH")"
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "suxai-github-deploy"
else
  echo "==> Reusing existing keypair at $KEY_PATH"
fi

# 2) Authorise the public key for SSH login.
AUTH_KEYS=/root/.ssh/authorized_keys
mkdir -p "$(dirname "$AUTH_KEYS")"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
if ! grep -qxF "$(cat "$KEY_PATH.pub")" "$AUTH_KEYS"; then
  echo "==> Adding public key to $AUTH_KEYS"
  cat "$KEY_PATH.pub" >> "$AUTH_KEYS"
else
  echo "==> Public key already authorised"
fi

# 3) Ensure /opt/suxai is traversable by Caddy.
if [[ -d /opt/suxai ]]; then
  echo "==> Relaxing /opt/suxai to 0755 so Caddy can serve /releases/"
  chmod 0755 /opt/suxai
fi

# 4) Allow passwordless sudo for the deploy commands we need.
#    We scope this tightly: only sed on .env, chown/chmod on releases,
#    and systemctl restart suxai-server.
SUDOERS=/etc/sudoers.d/suxai-deploy
cat > "$SUDOERS" <<'SUDO'
# Installed by setup-github-deploy.sh
root ALL=(ALL) NOPASSWD: /bin/sed -i s|^UPDATE_* /opt/suxai/.env
root ALL=(ALL) NOPASSWD: /bin/chown suxai\:suxai /opt/suxai/releases/*
root ALL=(ALL) NOPASSWD: /bin/chmod 0644 /opt/suxai/releases/*
root ALL=(ALL) NOPASSWD: /bin/systemctl restart suxai-server
SUDO
chmod 440 "$SUDOERS"

# 5) Print the secrets to add to GitHub.
cat <<EOF

=======================================================================
  GITHUB REPO SECRETS TO ADD
=======================================================================
Go to:
  https://github.com/mkultra110/suxaidev2/settings/secrets/actions

Click "New repository secret" FOUR times and add:

  Name:  VPS_HOST
  Value: $(hostname -I | awk '{print $1}')

  Name:  VPS_USER
  Value: root

  Name:  VPS_PUBLIC_URL_BASE
  Value: $VPS_PUBLIC_URL_BASE

  Name:  VPS_SSH_KEY
  Value: (the ENTIRE block below, including the BEGIN/END lines)
---------------- VPS_SSH_KEY value starts ----------------
$(cat "$KEY_PATH")
---------------- VPS_SSH_KEY value ends ------------------

=======================================================================

Once added, any push to claude/french-greeting-lGwbV will:
  - build the Windows .exe on a GitHub runner
  - upload it to $VPS_PUBLIC_URL_BASE/releases/
  - bump /opt/suxai/.env
  - restart suxai-server

Your IDE will pick up the update on next launch (or within an hour).
EOF
