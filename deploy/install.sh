#!/usr/bin/env bash
# Installation de HeiphaisBot sur un VPS Debian/Ubuntu (exécuter en root ou avec sudo)
# Usage : curl -fsSL <url>/deploy/install.sh | sudo bash   OU   sudo bash deploy/install.sh
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/heiphaisbot}"
REPO_URL="${REPO_URL:-https://github.com/Heiphaistos/Bot-Discord-Heiphaistos.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-heiphaisbot}"

echo "==> Dépendances système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg build-essential python3 ffmpeg iputils-ping traceroute whois dnsutils procps lm-sensors nmap >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "==> Installation de Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> yt-dlp (musique)"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> Code source dans $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -f "$(dirname "$0")/../package.json" ]; then
  mkdir -p "$INSTALL_DIR"
  cp -r "$(cd "$(dirname "$0")/.." && pwd)/." "$INSTALL_DIR/"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data logs
chmod +x src/cli/heiphais.js
ln -sf "$INSTALL_DIR/src/cli/heiphais.js" /usr/local/bin/heiphais

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^PANEL_SESSION_SECRET=.*/PANEL_SESSION_SECRET=$(openssl rand -hex 32)/" .env
  echo "!!! Éditez $INSTALL_DIR/.env (DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, OWNER_IDS, PANEL_PUBLIC_URL)"
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
# Accès Docker optionnel pour le module sysadmin
if getent group docker >/dev/null; then usermod -aG docker "$SERVICE_USER" || true; fi

echo "==> Service systemd"
sed "s#/opt/heiphaisbot#$INSTALL_DIR#g; s#User=heiphaisbot#User=$SERVICE_USER#; s#Group=heiphaisbot#Group=$SERVICE_USER#" deploy/heiphaisbot.service > /etc/systemd/system/heiphaisbot.service
systemctl daemon-reload
systemctl enable heiphaisbot >/dev/null

cat <<MSG

Installation terminée.
  1. Éditez $INSTALL_DIR/.env
  2. sudo systemctl start heiphaisbot && sudo journalctl -u heiphaisbot -f
  3. Créez un jeton CLI : cd $INSTALL_DIR && sudo -u $SERVICE_USER heiphais token create admin --local --save
  4. Panel : http://<ip-du-vps>:3000 (ou derrière nginx, voir deploy/nginx.conf)
MSG
