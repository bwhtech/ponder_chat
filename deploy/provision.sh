#!/usr/bin/env bash
# Sets up a fresh Ubuntu server (24.04 or later) for Seva Chat. Run once as root:
#   DOMAIN=chat.example.org DEPLOY_KEY="ssh-ed25519 ..." bash provision.sh
# Safe to run again: each step checks what is there first.
set -euo pipefail

DOMAIN=${DOMAIN:?Set DOMAIN, such as chat.example.org (or <ip>.sslip.io until DNS is ready)}
DEPLOY_KEY=${DEPLOY_KEY:?Set DEPLOY_KEY to the public SSH key that deploys}
APP=seva-chat
DB=seva_chat
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n== %s\n' "$*"; }

step "Packages"
apt-get update -q
apt-get install -yq ca-certificates curl gnupg unzip jq ufw fail2ban unattended-upgrades rsync git build-essential python3 age rclone

step "Swap (4 GB) if there is none"
if ! swapon --show | grep -q .; then
	fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
	grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
	sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf
fi

step "Users: deploy (SSH, sudo) and $APP (runs the service, no login)"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy && chmod 440 /etc/sudoers.d/90-deploy
id $APP >/dev/null 2>&1 || adduser --system --group --home /var/lib/$APP --shell /usr/sbin/nologin $APP
usermod -aG $APP deploy

step "SSH: keys only, no root login"
cat > /etc/ssh/sshd_config.d/90-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
sshd -t && systemctl reload ssh

step "Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
systemctl enable --now fail2ban

step "Security updates, with a reboot at 04:30 when one needs it (replies survive restarts)"
cat > /etc/apt/apt.conf.d/52seva-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF
systemctl enable --now unattended-upgrades

step "Logs: kept across reboots, at most 1 GB"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=1G\n' > /etc/systemd/journald.conf.d/90-seva.conf
systemctl restart systemd-journald

step "Node.js 24"
if ! node --version 2>/dev/null | grep -q '^v24'; then
	curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
	apt-get install -yq nodejs
fi

step "Deno 2 and uv (the Python sandbox)"
command -v deno >/dev/null || curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y --no-modify-path
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

step "PostgreSQL 18 with pgvector, on localhost only"
if [ ! -f /etc/apt/sources.list.d/pgdg.sources ]; then
	install -d /usr/share/postgresql-common/pgdg
	curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
	. /etc/os-release
	cat > /etc/apt/sources.list.d/pgdg.sources <<SRC
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
SRC
	apt-get update -q
fi
apt-get install -yq postgresql-18 postgresql-18-pgvector
# Memory settings from the server's RAM: a quarter for shared buffers.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
cat > /etc/postgresql/18/main/conf.d/90-seva.conf <<CONF
listen_addresses = 'localhost'
shared_buffers = $((MEM_MB / 4))MB
effective_cache_size = $((MEM_MB * 3 / 4))MB
work_mem = 16MB
maintenance_work_mem = 256MB
max_connections = 100
timezone = 'UTC'
CONF
systemctl restart postgresql
if [ ! -f /etc/$APP/env ]; then
	DB_PASSWORD=$(openssl rand -hex 24)
	sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create role $DB login password '$DB_PASSWORD'" || true
	sudo -u postgres createdb -O $DB $DB || true
	sudo -u postgres psql -d $DB -c "create extension if not exists vector"

	step "App settings in /etc/$APP/env (fill in the secrets marked FILL_IN)"
	install -d -m 750 -o root -g $APP /etc/$APP
	cat > /etc/$APP/env <<CONF
NODE_ENV=production
HOST=127.0.0.1
PORT=3500
DATABASE_URL=postgres://$DB:$DB_PASSWORD@127.0.0.1:5432/$DB
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
WORKFLOW_POSTGRES_URL=postgres://$DB:$DB_PASSWORD@127.0.0.1:5432/$DB
WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1
SEVA_HOSTS=$DOMAIN
SEVA_DENO=/usr/local/bin/deno
SEVA_DENO_DIR=/var/cache/$APP/deno
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
OPENROUTER_API_KEY=FILL_IN
# Sign-in emails (Cloudflare Email Service). Without them, links only go to the log.
SEVA_EMAIL_FROM=FILL_IN
CLOUDFLARE_ACCOUNT_ID=FILL_IN
CLOUDFLARE_EMAIL_TOKEN=FILL_IN
CHAT_DAILY_CREDITS=100
CHAT_CREDITS_PER_USD=1000
PYTHON_MAX_RUNS=3
# Monitoring (deploy/sentinel.sh): an ntfy topic URL, such as https://ntfy.sh/<long random name>.
NOTIFY_URL=
SPEND_ALERT_USD=10
# Off-site backups (deploy/backup.sh): an rclone remote and an age public key. Both optional.
BACKUP_RCLONE_REMOTE=
BACKUP_AGE_RECIPIENT=
CONF
	chmod 640 /etc/$APP/env && chown root:$APP /etc/$APP/env
fi

step "Caddy (HTTPS from Let's Encrypt)"
if ! command -v caddy >/dev/null; then
	curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -q && apt-get install -yq caddy
fi
install -d -o caddy -g caddy -m 755 /var/log/caddy

step "Folders for releases and backups"
install -d -m 755 -o deploy -g deploy /srv/$APP /srv/$APP/releases
install -d -m 750 -o postgres -g postgres /var/backups/$APP
echo "$DOMAIN" > /srv/$APP/domain

echo
echo "Done. Next: fill in FILL_IN values in /etc/$APP/env, then run deploy/deploy.sh from the build machine."
