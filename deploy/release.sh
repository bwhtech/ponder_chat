#!/usr/bin/env bash
# Runs on the server as `deploy`, from deploy/deploy.sh. Builds one release and makes it live.
set -euo pipefail
RELEASE=${1:?release name}
ROOT=/srv/seva-chat
DIR=$ROOT/releases/$RELEASE
PREVIOUS=$(readlink -f $ROOT/current 2>/dev/null || true)
step() { printf '\n== %s\n' "$*"; }
cd "$DIR"

step "Install packages"
npm ci --no-audit --no-fund --loglevel=error

step "Python sandbox"
# Reuse the previous release's packages when the sandbox's package lists did not change.
SANDBOX_HASH=$(cat sandbox/pyodide/package-lock.json sandbox/pyodide/packages.ts sandbox/pyodide/setup.sh | sha256sum | cut -c1-16)
if [ -n "$PREVIOUS" ] && [ "$(cat "$PREVIOUS/sandbox/pyodide/.hash" 2>/dev/null)" = "$SANDBOX_HASH" ]; then
	cp -a "$PREVIOUS/sandbox/pyodide/node_modules" "$PREVIOUS/sandbox/pyodide/vendor" sandbox/pyodide/
	echo "Reused from $(basename "$PREVIOUS")"
else
	sandbox/pyodide/setup.sh
fi
echo "$SANDBOX_HASH" > sandbox/pyodide/.hash

step "Build"
npm run build --silent

step "Database migrations (the workflow tables; the app's own run at start-up)"
set -a; . /etc/seva-chat/env; set +a
npx --no-install bootstrap

step "Server config: systemd units, Caddy"
sudo install -m 644 deploy/seva-chat.service deploy/seva-chat-backup.service deploy/seva-chat-backup.timer \
	deploy/seva-chat-sentinel.service deploy/seva-chat-sentinel.timer deploy/seva-chat-daily.service deploy/seva-chat-daily.timer /etc/systemd/system/
sudo install -m 755 deploy/backup.sh deploy/sentinel.sh /usr/local/bin/
sed "s/{\$DOMAIN}/$(cat $ROOT/domain)/" deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
# As the caddy user: validating opens the log file, and a file that root opens first is closed to Caddy.
sudo install -d -o caddy -g caddy /var/log/caddy
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now seva-chat-backup.timer seva-chat-sentinel.timer seva-chat-daily.timer >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

step "Switch to $RELEASE and restart"
ln -sfn "$DIR" $ROOT/current
sudo systemctl enable seva-chat >/dev/null
sudo systemctl restart seva-chat

healthy() {
	for _ in $(seq 1 60); do
		curl -fsS --max-time 3 http://127.0.0.1:3500/health >/dev/null 2>&1 && return 0
		sleep 1
	done
	return 1
}
if healthy; then
	echo "Healthy. $RELEASE is live."
else
	echo "Not healthy after 60 seconds. The last log lines:"
	sudo journalctl -u seva-chat -n 30 --no-pager
	if [ -n "$PREVIOUS" ]; then
		echo "Rolling back to $(basename "$PREVIOUS")"
		ln -sfn "$PREVIOUS" $ROOT/current
		sudo systemctl restart seva-chat
		healthy && echo "Rolled back; the old release is healthy." || echo "The old release is not healthy either."
	fi
	exit 1
fi

step "Keep the last 5 releases"
ls -1dt $ROOT/releases/*/ | tail -n +6 | xargs -r rm -rf
