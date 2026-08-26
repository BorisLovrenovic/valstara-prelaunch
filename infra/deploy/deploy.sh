#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose_file=${DEPLOY_COMPOSE_FILE:-"$project_root/infra/compose/docker-compose.production.yml"}
audit_file=${DEPLOY_AUDIT_FILE:-/var/lib/valstara/deploy-audit.jsonl}
health_timeout=${DEPLOY_HEALTH_TIMEOUT_SECONDS:-60}
health_poll=${DEPLOY_HEALTH_POLL_SECONDS:-2}
success_outcome=${DEPLOY_AUDIT_SUCCESS_OUTCOME:-succeeded}

usage() {
  printf '%s\n' "Usage: $0 <sha-tagged-image>" >&2
  exit 64
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

case ${1:-} in
  '' | -* ) usage ;;
esac

target_image=$1
case $target_image in
  *[!a-z0-9./:@_-]* | *: | *@ )
    fail 'The release image must be a lowercase SHA-tagged image reference.'
    ;;
esac

case $target_image in
  *:* | *@* ) ;;
  * ) fail 'The release image must include an immutable SHA tag or digest.' ;;
esac

release=${target_image##*:}
case $target_image in
  *@* ) release=${target_image##*@} ;;
esac

export VALSTARA_IMAGE=$target_image
export VALSTARA_RELEASE=$release

compose() {
  docker compose -f "$compose_file" "$@"
}

current_container=$(compose ps -q app)
[ -n "$current_container" ] || fail 'No currently serving app container was found; deployment aborted.'
previous_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")
[ -n "$previous_image" ] || fail 'The current app image could not be identified; deployment aborted.'

health_status() {
  docker inspect --format '{{.State.Health.Status}}' "$1"
}

wait_for_healthy() {
  container_id=$1
  elapsed=0

  while [ "$elapsed" -le "$health_timeout" ]; do
    if [ "$(health_status "$container_id")" = healthy ]; then
      return 0
    fi

    elapsed=$((elapsed + health_poll))
    [ "$elapsed" -le "$health_timeout" ] || break
    sleep "$health_poll"
  done

  return 1
}

if ! wait_for_healthy "$current_container"; then
  fail 'The current app is not healthy; deployment aborted to preserve the serving release.'
fi

migrations_for_release() {
  compose exec -T postgres psql -X -q -A -t \
    -U "$VALSTARA_DB_USER" -d valstara_waitlist \
    -v ON_ERROR_STOP=1 -v "release=$release" \
    -c "SELECT COALESCE(json_agg(filename ORDER BY filename), '[]'::json)::text FROM migration_ledger WHERE applied_by_release = :'release';"
}

json_string_or_null() {
  value=$1
  if [ -z "$value" ]; then
    printf 'null'
  else
    printf '"%s"' "$value"
  fi
}

record() {
  outcome=$1
  migrations=$(migrations_for_release)
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  umask 077
  mkdir -p "$(dirname -- "$audit_file")"
  printf '{"started_at":"%s","completed_at":"%s","image":"%s","release":"%s","previous_image":%s,"migrations":%s,"outcome":"%s"}\n' \
    "$started_at" "$completed_at" "$target_image" "$release" \
    "$(json_string_or_null "$previous_image")" "$migrations" "$outcome" \
    >>"$audit_file"
  sync "$audit_file"
}

candidate_name="valstara-deploy-candidate-$(date +%s)"
candidate_created=false

cleanup() {
  status=$?
  if [ "$candidate_created" = true ]; then
    docker rm -f "$candidate_name" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

compose pull app migrate

if ! compose run --rm migrate; then
  record migration_failed
  fail 'Migration failed; the serving app was not restarted.'
fi

compose run -d --no-deps --name "$candidate_name" app >/dev/null
candidate_created=true

if ! wait_for_healthy "$candidate_name"; then
  record candidate_health_failed
  fail 'Candidate health check failed; the previous app remains serving.'
fi

docker rm -f "$candidate_name" >/dev/null
candidate_created=false

compose up -d --no-deps --force-recreate app
current_container=$(compose ps -q app)

if ! wait_for_healthy "$current_container"; then
  record restart_health_failed
  DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
    "$project_root/infra/deploy/rollback.sh" || true
  fail 'Restart health check failed; rollback was attempted.'
fi

record "$success_outcome"
printf 'Deploy succeeded: %s\n' "$target_image"
