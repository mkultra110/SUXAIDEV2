# VPS deployment (209.99.186.238)

## One-time setup

```bash
# On the VPS:
sudo useradd -r -m -d /opt/suxai -s /bin/bash suxai
sudo mkdir -p /opt/suxai/server
sudo chown -R suxai:suxai /opt/suxai

# Install Node 20 (Nodesource or nvm — your choice):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
```

## Deploy the server

```bash
# From the project root on your workstation:
rsync -avz --delete server/ suxai@209.99.186.238:/opt/suxai/server/

# On the VPS:
cd /opt/suxai/server
cp .env.example .env
$EDITOR .env   # set JWT_SECRET + QUATARLY_API_KEY + UPDATE_*
npm ci --omit=dev
npm run build
mkdir -p data
chmod 700 data
```

## Install systemd + nginx

```bash
sudo cp /opt/suxai/server/deploy/suxai-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now suxai-server
sudo systemctl status suxai-server

sudo cp /opt/suxai/server/deploy/nginx.conf.example /etc/nginx/sites-available/suxai
sudo ln -sf /etc/nginx/sites-available/suxai /etc/nginx/sites-enabled/suxai
sudo nginx -t && sudo systemctl reload nginx
```

## Verify

```bash
curl -s http://209.99.186.238/health | jq
curl -s http://209.99.186.238/update/manifest | jq
```

## TLS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.suxai.example
```
