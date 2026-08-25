#!/bin/sh
set -eu

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=valstara_app_db_password="$VALSTARA_APP_DB_PASSWORD" <<'SQL'
CREATE ROLE valstara_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD :'valstara_app_db_password';
SQL
