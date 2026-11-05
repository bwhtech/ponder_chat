#!/usr/bin/env bash
# Nightly backup of the Ponder Chat database (ponder-chat-backup.timer).
# - A custom-format pg_dump in /var/backups/ponder-chat, the last 14 kept.
# - Off-site, if BACKUP_RCLONE_REMOTE is set: encrypted with age for BACKUP_AGE_RECIPIENT
#   (the copy elsewhere is unreadable without the private key, which is not on this server).
# - On Sundays, a restore test: the dump goes into a scratch database and is counted.
set -euo pipefail
set -a; . /etc/ponder-chat/env; set +a
DIR=/var/backups/ponder-chat
STAMP=$(date -u +%Y%m%d-%H%M)
FILE=$DIR/ponder_chat-$STAMP.dump

sudo -u postgres pg_dump -Fc -d ponder_chat -f "$FILE"
sudo -u postgres pg_restore --list "$FILE" >/dev/null   # the archive is readable
echo "Backup: $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t $DIR/ponder_chat-*.dump | tail -n +15 | xargs -r rm -f

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
	[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || { echo "BACKUP_AGE_RECIPIENT is not set: refusing to send an unencrypted backup off-site." >&2; exit 1; }
	age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE.age" "$FILE"
	rclone copy "$FILE.age" "$BACKUP_RCLONE_REMOTE" && rm -f "$FILE.age"
	echo "Off-site: $BACKUP_RCLONE_REMOTE"
fi

if [ "$(date -u +%u)" = 7 ] || [ "${RESTORE_TEST:-}" = 1 ]; then
	sudo -u postgres dropdb --if-exists ponder_chat_restore_test
	sudo -u postgres createdb ponder_chat_restore_test
	sudo -u postgres pg_restore --no-owner -d ponder_chat_restore_test "$FILE"
	THREADS=$(sudo -u postgres psql -Atd ponder_chat_restore_test -c "select count(*) from threads")
	sudo -u postgres dropdb ponder_chat_restore_test
	echo "Restore test: OK, $THREADS threads"
	date -u +%FT%TZ > $DIR/last-restore-test
fi
date -u +%FT%TZ > $DIR/last-backup
