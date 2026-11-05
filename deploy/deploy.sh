#!/usr/bin/env bash
# Deploys the working tree to the server:  deploy/deploy.sh deploy@<server>
# Copies the code to a new release folder, then runs deploy/release.sh there, which
# builds, migrates, switches and checks health, and rolls back if the check fails.
set -euo pipefail
HOST=${1:?Usage: deploy/deploy.sh deploy@<server>}
KEY=${SSH_KEY:-$HOME/.ssh/ponder_chat_deploy}
cd "$(dirname "$0")/.."
RELEASE=$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
DIRTY=$(git status --porcelain 2>/dev/null | wc -l)
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
# rsync needs an IPv6 address in brackets: deploy@[2401:db8::1]:/path. ssh needs it without.
USER_PART=${HOST%@*}; ADDR=${HOST#*@}
[[ $ADDR == *:* ]] && RSYNC_HOST="$USER_PART@[$ADDR]" || RSYNC_HOST=$HOST

echo "Release $RELEASE ($DIRTY uncommitted files) to $HOST"
rsync -az --delete -e "$SSH" \
	--exclude .git --exclude node_modules --exclude .output --exclude .nitro --exclude dist \
	--exclude 'sandbox/pyodide/node_modules' --exclude 'sandbox/pyodide/vendor' --exclude 'sandbox/pyodide/.deno' \
	--exclude .devtools --exclude data \
	./ "$RSYNC_HOST:/srv/ponder-chat/releases/$RELEASE/"
$SSH "$HOST" "bash /srv/ponder-chat/releases/$RELEASE/deploy/release.sh $RELEASE"
