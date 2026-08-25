#!/bin/sh
set -eu

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=umami_db_user="$UMAMI_DB_USER" \
  --set=umami_db_password="$UMAMI_DB_PASSWORD" <<'SQL'
CREATE ROLE :"umami_db_user" WITH LOGIN PASSWORD :'umami_db_password';
SQL

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=umami_db_name="$UMAMI_DB_NAME" \
  --set=umami_db_user="$UMAMI_DB_USER" <<'SQL'
CREATE DATABASE :"umami_db_name" OWNER :"umami_db_user";
SQL
