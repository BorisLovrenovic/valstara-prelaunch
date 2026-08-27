#!/bin/sh

set -eu

stanza='valstara'
state_file="${PGBACKREST_SCHEDULE_STATE_FILE:-/var/lib/pgbackrest/.valstara-last-backup-date}"

while :; do
  utc_day=$(date -u +%F)
  utc_hour=$(date -u +%H)
  utc_weekday=$(date -u +%u)

  if [ "$utc_hour" = '02' ] && [ "$(cat "$state_file" 2>/dev/null || true)" != "$utc_day" ]; then
    backup_type='diff'
    if [ "$utc_weekday" = '7' ]; then
      backup_type='full'
    fi

    if runuser --preserve-environment --user postgres -- \
      pgbackrest --stanza="$stanza" stanza-create \
      && runuser --preserve-environment --user postgres -- \
        pgbackrest --stanza="$stanza" --type="$backup_type" backup; then
      printf '%s\n' "$utc_day" >"$state_file"
    else
      printf '%s\n' "pgBackRest $backup_type backup failed; it will retry while this UTC hour remains." >&2
    fi
  fi

  if [ "${PGBACKREST_SCHEDULE_ONCE:-false}" = 'true' ]; then
    break
  fi

  sleep 60
done
