#!/bin/sh
set -eu

lock_checksum=$(sha256sum package-lock.json | cut -d ' ' -f 1)
installed_checksum=''

if [ -r node_modules/.valstara-lock-checksum ]; then
  installed_checksum=$(cat node_modules/.valstara-lock-checksum)
fi

if [ "$lock_checksum" != "$installed_checksum" ]; then
  npm ci
  printf '%s\n' "$lock_checksum" >node_modules/.valstara-lock-checksum
fi

node src/server/config.ts
exec npm run dev -- --host 0.0.0.0
