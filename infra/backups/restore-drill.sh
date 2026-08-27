#!/bin/sh

set -eu

compose_file='infra/compose/docker-compose.yml'
stanza='valstara'
repository_volume='valstara-prelaunch_pgbackrest-repository'
scratch_volume="valstara-backup-restore-$$-$(date +%s)"
scratch_container="valstara-backup-restore-$$"
image='valstara-postgres-pgbackrest:local'

# Local-only default, identical to the one in infra/compose/docker-compose.yml.
# The two MUST match or the restore cannot decrypt the repository. Production
# supplies the real passphrase from outside the host — that is E12-04's.
PGBACKREST_REPO1_CIPHER_PASS="${PGBACKREST_REPO1_CIPHER_PASS:-pgbackrest-local-only}"
export PGBACKREST_REPO1_CIPHER_PASS

compose() {
  docker compose -f "$compose_file" "$@"
}

cleanup() {
  if [ "${RESTORE_DRILL_KEEP_SCRATCH:-0}" = '1' ]; then
    return
  fi

  docker rm --force "$scratch_container" >/dev/null 2>&1 || true
  docker volume rm "$scratch_volume" >/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

# A previous run killed with SIGKILL cannot have run its trap, so sweep any
# scratch containers it left behind before starting.
docker ps --all --quiet --filter 'name=^valstara-backup-restore-' \
  | xargs --no-run-if-empty docker rm --force >/dev/null 2>&1 || true

query_ledger() {
  compose exec -T postgres sh -c \
    'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --field-separator "|" --command "SELECT filename, checksum FROM migration_ledger ORDER BY filename"'
}

wait_for_scratch_database() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if docker exec "$scratch_container" pg_isready --username postgres --dbname valstara_waitlist >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  docker logs "$scratch_container" >&2 || true
  return 1
}

started_ns=$(date +%s%N)
expected_ledger=$(query_ledger)
source_db_user=$(compose exec -T postgres printenv POSTGRES_USER)

if [ -z "$expected_ledger" ]; then
  printf '%s\n' 'The source database has no migration ledger rows to verify.' >&2
  exit 1
fi

if ! repository_check=$(compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" check 2>&1); then
  case "$repository_check" in
    *'unable to load info file'*)
      printf '%s\n' 'Removing unreadable local pgBackRest stanza metadata before the drill.' >&2
      compose exec -T --user postgres postgres rm -rf \
        "/var/lib/pgbackrest/archive/$stanza" \
        "/var/lib/pgbackrest/backup/$stanza"
      ;;
    *'does not exist'*)
      ;;
    *)
      printf '%s\n' "$repository_check" >&2
      exit 1
      ;;
  esac
fi

compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" stanza-create
compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" check
compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" --type=full backup
compose exec -T postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT pg_switch_wal()" >/dev/null'
compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" check
compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" --type=diff backup

backup_info=$(compose exec -T --user postgres postgres pgbackrest --stanza="$stanza" info)
printf '%s\n' "$backup_info" | grep -F 'cipher: aes-256-cbc' >/dev/null
printf '%s\n' "$backup_info" | grep -F 'full backup:' >/dev/null
printf '%s\n' "$backup_info" | grep -F 'diff backup:' >/dev/null
printf '%s\n' "$backup_info" | grep -F 'wal archive min/max' >/dev/null

docker volume create "$scratch_volume" >/dev/null

# The image is built by Compose, so it carries com.docker.compose.* labels.
# A container run from it inherits them and looks like a member of the stack,
# which breaks any query that lists Compose services. Override them explicitly.
docker run --detach --name "$scratch_container" --network none \
  --label com.docker.compose.project=valstara-backup-drill \
  --label com.docker.compose.service=backup-restore-scratch \
  --user postgres \
  --entrypoint sh \
  --env "PGBACKREST_REPO1_CIPHER_PASS=$PGBACKREST_REPO1_CIPHER_PASS" \
  --volume "$repository_volume:/var/lib/pgbackrest:ro" \
  --volume "$scratch_volume:/var/lib/postgresql/data" \
  "$image" \
  -c "set -eu; pgbackrest --stanza=$stanza restore; exec postgres -D /var/lib/postgresql/data" \
  >/dev/null

wait_for_scratch_database
restored_ledger=$(docker exec "$scratch_container" psql --username "$source_db_user" --dbname valstara_waitlist --tuples-only --no-align --field-separator '|' --command 'SELECT filename, checksum FROM migration_ledger ORDER BY filename')

if [ "$restored_ledger" != "$expected_ledger" ]; then
  printf '%s\n' 'The restored migration ledger does not match the source database.' >&2
  exit 1
fi

finished_ns=$(date +%s%N)
elapsed_ms=$(( (finished_ns - started_ns) / 1000000 ))

printf '%s\n' 'pgBackRest local restore drill passed.'
printf '%s\n' 'Verified source and restored migration ledger rows, full and differential backups, and WAL archiving.'
printf '%s\n' "Local restore timing: ${elapsed_ms} ms (floor only; not the production RTO)."

if [ "${RESTORE_DRILL_KEEP_SCRATCH:-0}" = '1' ]; then
  printf '%s\n' "Scratch restore container: ${scratch_container}"
  printf '%s\n' "Scratch restore volume: ${scratch_volume}"
  printf '%s\n' "Restored database user: ${source_db_user}"
fi
