# VPS deployment (209.99.186.238)

Everything SUXAI-related lives under **one isolated directory**: `/opt/suxai/`.
Nothing else on the VPS is touched.

```
/opt/suxai/
├── app/         # Node.js server code (synced from repo's server/)
├── data/        # users.json + persisted state  (DATA_DIR, mode 0700)
├── logs/        # server.log (systemd StandardOutput)
├── releases/    # update binaries served at /releases/<file>
└── .env         # configuration (mode 0600, owned by suxai)
```

A dedicated unprivileged system user `suxai` owns everything. The
systemd unit is hardened (`ProtectSystem=strict`, `ReadWritePaths` limited
to the three writable subfolders, no new privileges, no suid, etc.).

## One-shot install

From your workstation, upload the repo (or clone it) to the VPS, then:

```bash
# on the VPS, from the project root:
sudo ./server/deploy/install.sh
```

The script is idempotent — you can re-run it safely. It will:

1. Install Node.js 20 (if missing)
2. Create the `suxai` system user
3. Create `/opt/suxai/{app,data,logs,releases}` with correct ownership + modes
4. Copy `server/` → `/opt/suxai/app/`
5. Generate a strong `JWT_SECRET` (first run only) and write `/opt/suxai/.env`
6. Install deps + build
7. Install + enable `suxai-server.service`
8. Install the nginx site (if nginx is present)
9. Start the service

After the first run, edit your secrets:

```bash
sudo -e /opt/suxai/.env
# Set at minimum:
#   QUATARLY_API_KEY=qua-...
#   UPDATE_URL=http://<host>/releases/<installer>
#   UPDATE_VERSION=0.1.0
sudo systemctl restart suxai-server
```

## Pushing updates later

From your workstation:

```bash
./server/deploy/deploy.sh deploy@209.99.186.238
```

This rsyncs `server/`, rebuilds, and restarts the service — nothing else.

## Shipping a client update

1. Build your Electron installer locally.
2. Copy it to the VPS under `/opt/suxai/releases/`:
   ```bash
   scp ./release/SUXAI-Setup-0.2.0.exe deploy@209.99.186.238:/opt/suxai/releases/
   ```
3. Update `/opt/suxai/.env`:
   ```
   UPDATE_VERSION=0.2.0
   UPDATE_URL=http://209.99.186.238/releases/SUXAI-Setup-0.2.0.exe
   UPDATE_SHA256=<sha256 of the file>
   UPDATE_SIZE=<bytes>
   ```
4. Restart: `sudo systemctl restart suxai-server`

The running client will pick it up at next start (or next manual check).

## Useful commands

```bash
sudo systemctl status  suxai-server
sudo systemctl restart suxai-server
sudo systemctl stop    suxai-server
sudo journalctl -u suxai-server -f
sudo tail -f /opt/suxai/logs/server.log

curl -s http://127.0.0.1:4000/health       | jq
curl -s http://127.0.0.1:4000/update/manifest | jq
```

## TLS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.suxai.example
```

## Uninstall (everything)

```bash
sudo systemctl disable --now suxai-server
sudo rm /etc/systemd/system/suxai-server.service
sudo rm /etc/nginx/sites-enabled/suxai /etc/nginx/sites-available/suxai
sudo systemctl reload nginx
sudo rm -rf /opt/suxai
sudo userdel suxai
```
