#!/usr/bin/env bash
# Create the Nereus tables.
# Usage: schema/apply.sh [-h host] [-P port] [-u user] [-p password] [-d db] [-r retention_days] [-n replication_num] [-a agent_retention_days]
set -euo pipefail

HOST=127.0.0.1 PORT=9030 USER_NAME=root PASSWORD="" DB=otel RETENTION_DAYS=30 REPLICATION_NUM=1 AGENT_RETENTION_DAYS=365
while getopts "h:P:u:p:d:r:n:a:" opt; do
  case $opt in
    h) HOST=$OPTARG ;; P) PORT=$OPTARG ;; u) USER_NAME=$OPTARG ;; p) PASSWORD=$OPTARG ;;
    d) DB=$OPTARG ;; r) RETENTION_DAYS=$OPTARG ;; n) REPLICATION_NUM=$OPTARG ;; a) AGENT_RETENTION_DAYS=$OPTARG ;;
    *) echo "bad option" >&2; exit 2 ;;
  esac
done

DIR=$(cd "$(dirname "$0")" && pwd)

# A database from before the rum rename keeps browser sessions in otel_sessions; an empty
# rum_sessions created next to it would hide them, so stop and point at the upgrade.
TABLES=$(MYSQL_PWD="$PASSWORD" mysql -h"$HOST" -P"$PORT" -u"$USER_NAME" -N -e "SHOW TABLES FROM \`${DB}\`" 2>/dev/null || true)
if grep -qx otel_sessions <<<"$TABLES" && ! grep -qx rum_sessions <<<"$TABLES"; then
  echo "${DB}.otel_sessions exists: rename it first with schema/upgrades/003_rum_sessions.sql (see schema/upgrades/README.md)" >&2
  exit 1
fi
for f in "$DIR"/[0-9][0-9][0-9]_*.sql; do
  echo "applying $(basename "$f") to ${HOST}:${PORT}/${DB}"
  sed -e "s/\${DB}/${DB}/g" -e "s/\${RETENTION_DAYS}/${RETENTION_DAYS}/g" \
      -e "s/\${AGENT_RETENTION_DAYS}/${AGENT_RETENTION_DAYS}/g" \
      -e "s/\${REPLICATION_NUM}/${REPLICATION_NUM}/g" "$f" |
    MYSQL_PWD="$PASSWORD" mysql -h"$HOST" -P"$PORT" -u"$USER_NAME"
done
