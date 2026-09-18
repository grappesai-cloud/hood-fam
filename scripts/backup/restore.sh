#!/bin/sh
# Restores one dump into the running database. Stop the api and keeper first so the indexer is not
# writing while tables are replaced; start them after and the indexer resumes from the restored
# cursor, re-reading only the blocks between the dump and now.
#
#   docker compose stop api keeper
#   docker compose run --rm backup sh /scripts/restore.sh /backups/hood-20260917-230000.dump
#   docker compose start api keeper
set -eu
FILE="${1:?usage: restore.sh <dump file>}"
[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }
if [ -n "${DATABASE_URL:-}" ]; then
  pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$FILE"
else
  pg_restore --clean --if-exists --no-owner --dbname="${PGDATABASE:-hood}" "$FILE"
fi
echo "restored $FILE"
