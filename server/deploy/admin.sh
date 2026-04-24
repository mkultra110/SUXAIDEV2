#!/usr/bin/env bash
#
# admin.sh — owner-only helpers for managing SUXAI users and licenses.
#
# Usage:
#   sudo /opt/suxai/app/deploy/admin.sh list-users
#   sudo /opt/suxai/app/deploy/admin.sh grant-pro <username|email>
#   sudo /opt/suxai/app/deploy/admin.sh revoke-pro <username|email>
#   sudo /opt/suxai/app/deploy/admin.sh new-license [note]
#   sudo /opt/suxai/app/deploy/admin.sh list-licenses
#   sudo /opt/suxai/app/deploy/admin.sh reset-quota <username|email>
#
# Talks directly to /opt/suxai/data/{users,licenses}.json so the server
# doesn't need to be taught new admin endpoints. All files are owned by
# the \`suxai\` user.

set -euo pipefail

DATA_DIR=${DATA_DIR:-/opt/suxai/data}
USERS="$DATA_DIR/users.json"
LICENSES="$DATA_DIR/licenses.json"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 ..." >&2
  exit 1
fi

ensure_files() {
  [[ -f "$USERS"     ]] || { echo "[]" > "$USERS";     chown suxai:suxai "$USERS";     chmod 600 "$USERS"; }
  [[ -f "$LICENSES"  ]] || { echo "[]" > "$LICENSES";  chown suxai:suxai "$LICENSES";  chmod 600 "$LICENSES"; }
}

# find a user row by username OR email (case-insensitive)
resolve_user() {
  local ident=$1
  node -e "
    const users = require('$USERS');
    const match = users.find(u =>
      u.username?.toLowerCase() === '${ident,,}' ||
      u.email?.toLowerCase()    === '${ident,,}'
    );
    if (!match) { process.exit(2); }
    console.log(JSON.stringify(match));
  "
}

case "${1:-}" in
  list-users)
    ensure_files
    node -e "
      const users = require('$USERS');
      if (users.length === 0) { console.log('No users yet.'); return; }
      console.log(users.map(u => ({
        username:       u.username,
        email:          u.email,
        tier:           u.tier,
        dailyUsageMs:   u.dailyUsageMs,
        dailyUsageDate: u.dailyUsageDate,
        createdAt:      u.createdAt,
      })));
    "
    ;;

  grant-pro|revoke-pro)
    ensure_files
    ident=${2:-}
    if [[ -z "$ident" ]]; then
      echo "Usage: $0 $1 <username|email>" >&2
      exit 1
    fi
    tier="free"; [[ "$1" == "grant-pro" ]] && tier="pro"
    node -e "
      const fs = require('fs');
      const p = '$USERS';
      const users = require(p);
      const idx = users.findIndex(u =>
        u.username?.toLowerCase() === '${ident,,}' ||
        u.email?.toLowerCase()    === '${ident,,}'
      );
      if (idx < 0) { console.error('User not found: $ident'); process.exit(2); }
      users[idx].tier = '$tier';
      users[idx].updatedAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(users, null, 2));
      console.log('Updated', users[idx].username, '->', users[idx].tier);
    "
    chown suxai:suxai "$USERS"
    chmod 600 "$USERS"
    systemctl restart suxai-server 2>/dev/null || true
    ;;

  reset-quota)
    ensure_files
    ident=${2:-}
    if [[ -z "$ident" ]]; then
      echo "Usage: $0 reset-quota <username|email>" >&2
      exit 1
    fi
    node -e "
      const fs = require('fs');
      const p = '$USERS';
      const users = require(p);
      const idx = users.findIndex(u =>
        u.username?.toLowerCase() === '${ident,,}' ||
        u.email?.toLowerCase()    === '${ident,,}'
      );
      if (idx < 0) { console.error('User not found: $ident'); process.exit(2); }
      users[idx].dailyUsageMs = 0;
      users[idx].dailyUsageDate = '';
      users[idx].updatedAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(users, null, 2));
      console.log('Quota reset for', users[idx].username);
    "
    chown suxai:suxai "$USERS"
    chmod 600 "$USERS"
    ;;

  new-license)
    ensure_files
    note=${2:-}
    # Same key format as the server: SUXAI-XXXX-XXXX-XXXX
    KEY=$(node -e "
      const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const r = require('crypto').randomBytes(12);
      let s = '';
      for (const b of r) s += a[b % a.length];
      console.log('SUXAI-' + s.slice(0,4) + '-' + s.slice(4,8) + '-' + s.slice(8,12));
    ")
    node -e "
      const fs = require('fs');
      const p = '$LICENSES';
      const lic = require(p);
      lic.push({
        key: '$KEY',
        tier: 'pro',
        createdAt: new Date().toISOString(),
        note: '${note//\'/\\\'}' || undefined,
      });
      fs.writeFileSync(p, JSON.stringify(lic, null, 2));
    "
    chown suxai:suxai "$LICENSES"
    chmod 600 "$LICENSES"
    echo "License key: $KEY"
    echo "Give this key to the user — they paste it into the IDE to upgrade to pro."
    ;;

  list-licenses)
    ensure_files
    node -e "
      const lic = require('$LICENSES');
      if (lic.length === 0) { console.log('No licenses yet.'); return; }
      console.log(lic);
    "
    ;;

  *)
    cat <<EOF
Usage:
  sudo $0 list-users
  sudo $0 grant-pro <username|email>
  sudo $0 revoke-pro <username|email>
  sudo $0 new-license [note]
  sudo $0 list-licenses
  sudo $0 reset-quota <username|email>
EOF
    exit 1
    ;;
esac
