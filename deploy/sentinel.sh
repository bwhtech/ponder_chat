#!/usr/bin/env bash
# Ponder Chat's watchman. Every 5 minutes (ponder-chat-sentinel.timer) it checks the server
# and the app, and sends an alert to NOTIFY_URL (an ntfy topic) when something is wrong:
# again every 6 hours while it stays wrong, and once when it is fixed.
# With --daily (ponder-chat-daily.timer) it sends a summary of the last day instead.
# Without NOTIFY_URL, it writes to the journal only: journalctl -u ponder-chat-sentinel
set -uo pipefail
set -a; . "${PONDER_ENV:-/etc/ponder-chat/env}"; set +a
STATE=${SENTINEL_STATE:-/var/lib/ponder-chat-sentinel}
mkdir -p $STATE
DOMAIN=$(cat /srv/ponder-chat/domain 2>/dev/null || echo "")
HOSTNAME_SHORT=$(hostname -s)
REPEAT_SECONDS=$((6 * 3600))

notify() { # title, message, priority
	echo "[$1] $2"
	[ -n "${NOTIFY_URL:-}" ] || return 0
	curl -fsS --max-time 10 -H "Title: $1" -H "Priority: ${3:-default}" -H "Tags: ponder-chat" -d "$2" "$NOTIFY_URL" >/dev/null || echo "notify failed"
}
sql() { sudo -u postgres psql -Atd ponder_chat -c "$1" 2>/dev/null; }

# alert KEY "message": a problem. ok KEY: no problem.
alert() {
	local file=$STATE/$1
	if [ ! -f "$file" ] || [ $(( $(date +%s) - $(stat -c %Y "$file") )) -ge $REPEAT_SECONDS ]; then
		notify "Ponder Chat: $1 ($HOSTNAME_SHORT)" "$2" high
		touch "$file"
	fi
}
ok() {
	if [ -f "$STATE/$1" ]; then
		notify "Ponder Chat: $1 resolved ($HOSTNAME_SHORT)" "Back to normal." low
		rm -f "$STATE/$1"
	fi
}
check() { # KEY CONDITION-COMMAND MESSAGE : alerts when the command fails
	if eval "$2"; then ok "$1"; else alert "$1" "$3"; fi
}

if [ "${1:-}" = "--daily" ]; then
	USERS=$(sql "select count(distinct \"user\") from runs where created_at > now() - interval '1 day' and function_id = 'chat'")
	# Model calls that finished: charged_runs leaves out the attempts a crash, an error or Stop cut short. COST below keeps them, as OpenRouter billed them.
	CALLS=$(sql "select count(*) from charged_runs where created_at > now() - interval '1 day' and function_id = 'chat'")
	REPLIES=$(sql "select count(*) from workflow.workflow_runs where created_at > now() - interval '1 day'")
	FAILED=$(sql "select count(*) from workflow.workflow_runs where created_at > now() - interval '1 day' and status = 'failed'")
	COST=$(sql "select to_char(coalesce(sum(cost_usd), 0), 'FM990.00') from runs where created_at > now() - interval '1 day'")
	TOP=$(sql "select string_agg(format('%s \$%s', coalesce(u.email, r.\"user\"), to_char(r.cost, 'FM990.000')), ', ') from (select \"user\", sum(cost_usd) cost from runs where created_at > now() - interval '1 day' group by 1 order by 2 desc nulls last limit 3) r left join users u on u.id = r.\"user\"")
	# The limits are in the app's tables (server/settings.ts, server/credits.ts): the default, each person's own, and today's extra credits.
	# charged_runs (server/telemetry/store.ts) holds the rule for what costs credits.
	OUT_OF_CREDITS=$(sql "with s as (select default_daily_credits, credits_per_usd from settings where id = 1),
		spent as (select \"user\", sum(cost_usd) * (select credits_per_usd from s) credits from charged_runs
			where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' group by 1),
		extra as (select user_id, sum(credits) credits from credit_grants where day = (now() at time zone 'utc')::date group by 1)
		select count(*) from spent left join credit_limits l on l.user_id = spent.\"user\" left join extra e on e.user_id = spent.\"user\"
		where spent.credits >= coalesce(l.daily_credits, (select default_daily_credits from s)) + coalesce(e.credits, 0)")
	REQUESTS=$(sql "select count(*) from credit_requests where status = 'pending'")
	INVITED=$(sql "select count(*) from allowed_emails")
	SIGNED_UP=$(sql "select count(*) from users")
	DISK=$(df --output=pcent / | tail -1 | tr -d ' ')
	BACKUP=$(cat /var/backups/ponder-chat/last-backup 2>/dev/null || echo never)
	RESTORE=$(cat /var/backups/ponder-chat/last-restore-test 2>/dev/null || echo never)
	notify "Ponder Chat: daily summary" "Last 24 hours: $USERS people, $REPLIES replies ($FAILED failed), $CALLS model calls, \$$COST on OpenRouter.
Top: ${TOP:-none}
Out of credits today: $OUT_OF_CREDITS. Requests for more credits waiting: ${REQUESTS:-0}. Invited: $INVITED, signed up: $SIGNED_UP.
Disk $DISK. Last backup $BACKUP, last restore test $RESTORE." low
	exit 0
fi

# The server
for unit in ponder-chat caddy postgresql; do
	check "service-$unit" "systemctl is-active --quiet $unit" "$unit is not running. sudo journalctl -u $unit -n 50"
done
check health "curl -fsS --max-time 5 http://127.0.0.1:3500/health >/dev/null" "The app does not answer /health on 127.0.0.1:3500."
[ -n "$DOMAIN" ] && check public "curl -fsS --max-time 10 https://$DOMAIN/health >/dev/null" "https://$DOMAIN/health does not answer: Caddy, DNS or the certificate."
check disk "[ \$(df --output=pcent / | tail -1 | tr -dc 0-9) -lt 85 ]" "The disk is $(df --output=pcent / | tail -1 | tr -d ' ') full."
check memory "[ \$(awk '/MemAvailable/ {a=\$2} /MemTotal/ {t=\$2} END {print int(a*100/t)}' /proc/meminfo) -ge 10 ]" "Less than 10% of memory is free."
check backup "[ -f /var/backups/ponder-chat/last-backup ] && [ \$(( \$(date +%s) - \$(date -d \"\$(cat /var/backups/ponder-chat/last-backup)\" +%s) )) -lt 93600 ]" "No backup in the last 26 hours. sudo journalctl -u ponder-chat-backup"

# The app
FAILED=$(sql "select count(*) from workflow.workflow_runs where status = 'failed' and updated_at > now() - interval '15 minutes'")
check failed-replies "[ \"${FAILED:-0}\" -eq 0 ]" "$FAILED replies failed in the last 15 minutes. npx workflow inspect runs --backend @workflow/world-postgres"
STUCK=$(sql "select count(*) from thread_runs where finished_at is null and started_at < now() - interval '15 minutes'")
check stuck-replies "[ \"${STUCK:-0}\" -eq 0 ]" "$STUCK replies have been running for over 15 minutes."
# A reply written without memory, connectors, skills or trusted pages (server/workflow/context-step.ts).
DEGRADED=$(journalctl -u ponder-chat --since "-15min" --no-pager -q 2>/dev/null | grep -c "reply degraded:")
check degraded-replies "[ \"${DEGRADED:-0}\" -eq 0 ]" "$DEGRADED replies were written without memory, connectors, skills or trusted pages in the last 15 minutes. sudo journalctl -u ponder-chat --since -15min | grep 'reply degraded'"
QUEUE=$(sql "select count(*) from graphile_worker._private_jobs where attempts >= 3 and last_error is not null")
check queue-errors "[ \"${QUEUE:-0}\" -eq 0 ]" "$QUEUE workflow jobs failed 3 times or more."
SPENT=$(sql "select coalesce(sum(cost_usd), 0)::numeric(10,2) from runs where created_at >= date_trunc('day', now() at time zone 'utc')")
check spend "awk -v s=\"${SPENT:-0}\" -v l=\"${SPEND_ALERT_USD:-10}\" 'BEGIN {exit !(s < l)}'" "OpenRouter spend today is \$$SPENT (alert at \$${SPEND_ALERT_USD:-10})."
exit 0
