#!/bin/sh
# Dumps the database on a schedule and prunes old dumps. Runs in a plain postgres image next to the
# database, so the only dependency is pg_dump itself. Offloading to object storage is a separate,
# optional container (see docker-compose.yml, profile "offload"), so a broken upload never stops
# the local dumps.
#
#   env: PGHOST PGUSER PGPASSWORD PGDATABASE (or DATABASE_URL), BACKUP_DIR (default /backups),
#        BACKUP_EVERY_SECONDS (default 21600, six hours), BACKUP_KEEP_DAYS (default 14)
#   arg: "once" dumps a single time and exits, for a manual backup or a test
set -eu

DIR="${BACKUP_DIR:-/backups}"
EVERY="${BACKUP_EVERY_SECONDS:-21600}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"

dump() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  tmp="$DIR/.hood-$stamp.dump.part"
  out="$DIR/hood-$stamp.dump"
  # custom format: compressed, restorable table by table with pg_restore
  if [ -n "${DATABASE_URL:-}" ]; then
    pg_dump --format=custom --no-owner --file="$tmp" "$DATABASE_URL"
  else
    pg_dump --format=custom --no-owner --file="$tmp"
  fi
  mv "$tmp" "$out"
  echo "$(date -u +%FT%TZ) wrote $out ($(du -h "$out" | cut -f1))"
  # prune, oldest first, by age
  find "$DIR" -name 'hood-*.dump' -type f -mtime "+$KEEP" -print -delete | sed 's/^/pruned /'
}

if [ "${1:-}" = "once" ]; then
  dump
  exit 0
fi

echo "backup loop: every ${EVERY}s, keeping ${KEEP} days, into $DIR"
while true; do
  dump || echo "$(date -u +%FT%TZ) backup failed, retrying next round"
  sleep "$EVERY"
done
