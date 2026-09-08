#!/usr/bin/env bash
# Starts the local, self-contained Postgres cluster created by setup.sh.
# Data lives in db/data/ — nothing outside this repo folder is touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
PORT="${NIFTY_DB_PORT:-5433}"

if [ ! -d "$DATA_DIR" ]; then
  echo "No local database found. Run ./db/setup.sh first."
  exit 1
fi

pg_ctl -D "$DATA_DIR" -l "$SCRIPT_DIR/postgres.log" -o "-p $PORT -h localhost" start
echo "Postgres running locally on port $PORT, data in $DATA_DIR"
echo "Connection string:  postgresql://postgres@localhost:$PORT/nifty"
echo "Stop it with:       ./db/stop.sh"
