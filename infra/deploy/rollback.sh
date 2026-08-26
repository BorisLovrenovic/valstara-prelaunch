#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
audit_file=${DEPLOY_AUDIT_FILE:-/var/lib/valstara/deploy-audit.jsonl}
compose_file=${DEPLOY_COMPOSE_FILE:-"$project_root/infra/compose/docker-compose.production.yml"}

[ -r "$audit_file" ] || {
  printf '%s\n' 'No durable deployment audit record is available for rollback.' >&2
  exit 1
}

current_container=$(docker compose -f "$compose_file" ps -q app)
[ -n "$current_container" ] || {
  printf '%s\n' 'No currently serving app container was found; rollback aborted.' >&2
  exit 1
}
current_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")

previous_image=$(sed -n \
  's/.*"image":"\([a-z0-9./:@_-]*\)".*"outcome":"succeeded".*/\1/p' \
  "$audit_file" \
  | awk -v current="$current_image" '$0 != current { previous = $0 } END { print previous }')

[ -n "$previous_image" ] || {
  printf '%s\n' 'No previous successful release is available for rollback.' >&2
  exit 1
}

DEPLOY_AUDIT_SUCCESS_OUTCOME=rollback_succeeded \
  exec "$project_root/infra/deploy/deploy.sh" "$previous_image"
