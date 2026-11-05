# Deploy: one Ubuntu VM

Ponder Chat runs on one VM: Caddy, the Node server (with the workflow worker in the same process), and PostgreSQL. Python runs in Deno processes that the server starts.

```
Internet ──443──▶ Caddy ──127.0.0.1:3500──▶ ponder-chat (Node, systemd) ──▶ PostgreSQL 18 (localhost)
                   │                          ├─ workflow worker (graphile-worker, same DB)
                   └─ blocks /.well-known/workflow/*   └─ deno: Python sandbox, one process per run
```

| File | Job |
| --- | --- |
| `provision.sh` | Sets up a fresh server once, as root. Can run again. |
| `deploy.sh` | Runs on the build machine. Copies the code and runs `release.sh` on the server. |
| `release.sh` | Builds a release, migrates, switches, checks health, rolls back if the check fails. |
| `ponder-chat.service` | The systemd unit. |
| `Caddyfile` | HTTPS, the blocked workflow route, and requests held during a restart. |
| `backup.sh` + timer | A nightly dump, encrypted off-site copy, restore test on Sundays. |
| `sentinel.sh` + timers | Checks every 5 minutes and a daily summary, sent to a phone through ntfy. |

## First time

1. Create the server (Ubuntu 24.04 or later). Add the deploy key to root.
2. Point DNS at it. Until DNS is ready, use `<ip>.sslip.io` as the domain.
3. Copy and run the setup:

   ```bash
   scp deploy/provision.sh root@<ip>:
   ssh root@<ip> 'DOMAIN=chat.example.org DEPLOY_KEY="$(cat ~/.ssh/authorized_keys | head -1)" bash provision.sh'
   ```

   After this, root cannot log in over SSH. Use `deploy@<ip>`.
4. Fill in the `FILL_IN` values in `/etc/ponder-chat/env`: the OpenRouter key and the email settings. Add `NOTIFY_URL` for alerts. For the OpenRouter key, you can instead leave `OPENROUTER_API_KEY` empty and paste the key in `/admin`, Settings, after you sign in as an admin. There it is saved encrypted.
5. Deploy: `deploy/deploy.sh deploy@<ip>`.
6. Invite people:

   ```bash
   ssh deploy@<ip>
   cd /srv/ponder-chat/current && set -a && . /etc/ponder-chat/env && set +a
   npx tsx scripts/invite.ts add someone@example.org "Pilot group 1"
   ```

## Deploy and roll back

`deploy/deploy.sh deploy@<ip>` deploys the working tree, including files that are not committed (the script says how many). A deploy:

1. Copies the code to `/srv/ponder-chat/releases/<time>-<commit>/`.
2. Runs `npm ci`. Sets up the Python sandbox, or reuses the previous release's when its package lists did not change. Builds.
3. Runs the workflow migrations. The app runs its own migrations when it starts.
4. Installs the units, the scripts and the Caddyfile from the release.
5. Points `/srv/ponder-chat/current` at the release and restarts the service.
6. Waits up to 60 seconds for `/health`. If it fails, points `current` back at the previous release and restarts that one.

To roll back by hand: `ln -sfn /srv/ponder-chat/releases/<old> /srv/ponder-chat/current && sudo systemctl restart ponder-chat`. A release whose database migration changed tables may not run against the newer tables.

## What survives what

| Event | What people see |
| --- | --- |
| A deploy or `systemctl restart` | The server finishes the step in progress for up to 10 seconds, then stops. Caddy holds new requests until the new server answers (up to 30 seconds). A reply that was being written goes on, and the page reconnects to it. |
| The server crashes | systemd starts it again in 2 seconds. It releases the jobs that the crashed process held, and the cut-off step runs again. The page drops the partial text of that step. |
| The VM reboots (security updates at 04:30 when needed) | The same as a crash, after the boot. |
| The browser's connection drops | The page reconnects and keeps the reply. Reconnects wait up to 30 seconds for the server. |
| The model fails 3 times | The reply ends with what it wrote so far. The run is marked finished, and the person can retry. |
| PostgreSQL stops | `/health` answers 503 and an alert goes out. systemd restarts PostgreSQL if it crashes. |
| The disk fails, or the VM is lost | Restore the latest off-site backup on a new VM (below). Everything since that backup is lost. |

## Monitoring

`sentinel.sh` runs every 5 minutes. It sends an alert to `NOTIFY_URL` (an ntfy topic) when a check fails, again every 6 hours while it fails, and once when it is fixed.

| Check | Alerts when |
| --- | --- |
| Services | `ponder-chat`, `caddy` or `postgresql` is not running |
| Health | `/health` fails on 127.0.0.1, or on `https://<domain>` (Caddy, DNS, certificate) |
| Disk, memory | The disk is 85% full; less than 10% of memory is free |
| Backup | No backup in 26 hours |
| Replies | Any reply failed in the last 15 minutes; a reply has run for over 15 minutes |
| Queue | A workflow job failed 3 times |
| Spend | OpenRouter spend today is over `SPEND_ALERT_USD` (default $10) |

Every morning at 09:00 IST it sends a summary: people, replies, failures, spend, the top 3 spenders, people out of credits, requests for more credits that wait for an answer, invites, disk and backups.

The app also sends to `NOTIFY_URL` when a person asks for more credits. The message has their name and today's credits, and a link to `/admin/requests`.

The VM cannot report that it is down. Add a free external uptime check on `https://<domain>/health`, such as UptimeRobot or Better Stack.

To set up alerts, install the ntfy app on a phone and subscribe to a long random topic name. Set `NOTIFY_URL=https://ntfy.sh/<that name>`. Anyone who knows the name can read the alerts, and they have no chat content.

Logs: `journalctl -u ponder-chat -f`; Caddy's are in `/var/log/caddy/`. Workflow runs: `npx workflow inspect runs --backend @workflow/world-postgres` in `/srv/ponder-chat/current` with the env loaded.

## Backups and restore

Every night at 02:15 UTC, `backup.sh` makes a `pg_dump` in `/var/backups/ponder-chat` and keeps 14. The database holds everything: accounts, chats, attached files, Python state and workflow runs.

Off-site copies need `BACKUP_RCLONE_REMOTE` (an rclone remote, such as a Hetzner Storage Box or a bucket, set up with `sudo rclone config`) and `BACKUP_AGE_RECIPIENT` (an `age` public key). The script refuses to send a copy that is not encrypted. Keep the age private key off this server.

On Sundays, it restores the dump into a scratch database and counts the threads. To run that now: `sudo RESTORE_TEST=1 /usr/local/bin/backup.sh`.

To restore on a new server, provision it, then:

```bash
age -d -i key.txt ponder_chat-<time>.dump.age > ponder_chat.dump
sudo systemctl stop ponder-chat
sudo -u postgres dropdb ponder_chat && sudo -u postgres createdb -O ponder_chat ponder_chat
sudo -u postgres pg_restore --no-owner --role=ponder_chat -d ponder_chat ponder_chat.dump
sudo systemctl start ponder-chat
```

## Security

- SSH: keys only, no root login, fail2ban. The firewall allows only 22, 80 and 443.
- PostgreSQL and the app listen only on localhost. Caddy refuses `/.well-known/workflow/*`, which has no authentication.
- The service runs as `ponder-chat`, with a read-only system and no home folder. It can write only `/var/cache/ponder-chat`.
- Secrets are in `/etc/ponder-chat/env` (root:ponder-chat, mode 640).
- The `deploy` user has passwordless sudo, so that deploys run unattended. Protect its key.
- The pilot is invite-only (`scripts/invite.ts`).
