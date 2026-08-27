#!/bin/sh

set -eu

if [ "${PGBACKREST_SCHEDULE_ENABLED:-false}" = 'true' ] && [ "$1" = 'postgres' ]; then
  /usr/local/bin/pgbackrest-schedule.sh &
fi

exec /usr/local/bin/docker-entrypoint-base.sh "$@"
