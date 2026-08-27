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

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
previous_image=''
migrations='[]'

compose() {
  docker compose -f "$compose_file" "$@"
}

health_status() {
  docker inspect --format '{{.State.Health.Status}}' "$1"
}

wait_for_healthy() {
  container_id=$1
  elapsed=0

  while [ "$elapsed" -le "$health_timeout" ]; do
    status=$(health_status "$container_id") || return 1
    if [ "$status" = healthy ]; then
      return 0
    fi

    elapsed=$((elapsed + health_poll))
    [ "$elapsed" -le "$health_timeout" ] || break
    sleep "$health_poll"
  done

  return 1
}

migrations_for_release() {
  compose exec -T postgres psql -X -q -A -t \
    -U "$VALSTARA_DB_USER" -d valstara_waitlist \
    -v ON_ERROR_STOP=1 \
    -c "SELECT COALESCE(json_agg(filename ORDER BY filename), '[]'::json)::text FROM migration_ledger WHERE applied_by_release = '$release';"
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
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  umask 077
  mkdir -p "$(dirname -- "$audit_file")"
  printf '{"started_at":"%s","completed_at":"%s","image":"%s","release":"%s","previous_image":%s,"migrations":%s,"outcome":"%s"}\n' \
    "$started_at" "$completed_at" "$target_image" "$release" \
    "$(json_string_or_null "$previous_image")" "$migrations" "$outcome" \
    >>"$audit_file"
  sync "$audit_file"
}

capture_migrations_for_release() {
  recorded_migrations=$(migrations_for_release 2>/dev/null) || return 1
  migrations=$recorded_migrations
}

if ! current_container=$(compose ps -q app); then
  record current_container_lookup_failed
  fail 'The current app container could not be identified; deployment aborted.'
fi

if [ -z "$current_container" ]; then
  record no_serving_container
  fail 'No currently serving app container was found; deployment aborted.'
fi

if ! previous_image=$(docker inspect --format '{{.Config.Image}}' "$current_container"); then
  record previous_image_lookup_failed
  fail 'The current app image could not be identified; deployment aborted.'
fi

if [ -z "$previous_image" ]; then
  record previous_image_lookup_failed
  fail 'The current app image could not be identified; deployment aborted.'
fi

if ! wait_for_healthy "$current_container"; then
  record current_health_failed
  fail 'The current app is not healthy; deployment aborted to preserve the serving release.'
fi

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

if ! compose pull app migrate; then
  record image_pull_failed
  fail 'Image pull failed; the serving app was not restarted.'
fi

if ! compose run --rm migrate; then
  capture_migrations_for_release || migrations='null'
  record migration_failed
  fail 'Migration failed; the serving app was not restarted.'
fi

if ! capture_migrations_for_release; then
  migrations='null'
  record migration_audit_query_failed
  fail 'Migration audit query failed; the serving app was not restarted.'
fi

if ! compose run -d --no-deps --name "$candidate_name" app >/dev/null; then
  record candidate_start_failed
  fail 'Candidate could not be started; the serving app was not restarted.'
fi
candidate_created=true

if ! wait_for_healthy "$candidate_name"; then
  record candidate_health_failed
  fail 'Candidate health check failed; the previous app remains serving.'
fi

if ! docker rm -f "$candidate_name" >/dev/null; then
  record candidate_cleanup_failed
  fail 'Candidate cleanup failed; the serving app was not restarted.'
fi
candidate_created=false

if ! compose up -d --no-deps --force-recreate app; then
  record restart_command_failed
  DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
    "$project_root/infra/deploy/rollback.sh" || true
  fail 'App restart command failed; rollback was attempted.'
fi

if ! current_container=$(compose ps -q app); then
  record restart_container_lookup_failed
  DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
    "$project_root/infra/deploy/rollback.sh" || true
  fail 'Restarted app container could not be identified; rollback was attempted.'
fi

if [ -z "$current_container" ]; then
  record restart_container_lookup_failed
  DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
    "$project_root/infra/deploy/rollback.sh" || true
  fail 'Restarted app container could not be identified; rollback was attempted.'
fi

if ! wait_for_healthy "$current_container"; then
  record restart_health_failed
  DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
    "$project_root/infra/deploy/rollback.sh" || true
  fail 'Restart health check failed; rollback was attempted.'
fi

record "$success_outcome"
printf 'Deploy succeeded: %s\n' "$target_image"
