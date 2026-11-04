#!/usr/bin/env bash
# Create the DorisStack tables.
# Usage: schema/apply.sh [-h host] [-P port] [-u user] [-p password] [-d db] [-r retention_days] [-n replication_num]
set -euo pipefail

HOST=127.0.0.1 PORT=9030 USER_NAME=root PASSWORD="" DB=otel RETENTION_DAYS=30 REPLICATION_NUM=1
while getopts "h:P:u:p:d:r:n:" opt; do
  case $opt in
    h) HOST=$OPTARG ;; P) PORT=$OPTARG ;; u) USER_NAME=$OPTARG ;; p) PASSWORD=$OPTARG ;;
    d) DB=$OPTARG ;; r) RETENTION_DAYS=$OPTARG ;; n) REPLICATION_NUM=$OPTARG ;;
    *) echo "bad option" >&2; exit 2 ;;
  esac
done

DIR=$(cd "$(dirname "$0")" && pwd)
for f in "$DIR"/[0-9][0-9][0-9]_*.sql; do
  echo "applying $(basename "$f") to ${HOST}:${PORT}/${DB}"
  sed -e "s/\${DB}/${DB}/g" -e "s/\${RETENTION_DAYS}/${RETENTION_DAYS}/g" \
      -e "s/\${REPLICATION_NUM}/${REPLICATION_NUM}/g" "$f" |
    MYSQL_PWD="$PASSWORD" mysql -h"$HOST" -P"$PORT" -u"$USER_NAME"
done
