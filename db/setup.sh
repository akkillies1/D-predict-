#!/usr/bin/env bash
# One-time setup: creates a self-contained Postgres cluster whose data files
# live entirely inside this repo (db/data/), not in a system-wide location.
# No system Postgres service is used or required — this is your own private
# database, fully contained in this folder.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
PORT="${NIFTY_DB_PORT:-5433}"   # non-default port so it won't collide with a system Postgres on 5432

if [ -d "$DATA_DIR" ]; then
  echo "Data directory already exists at $DATA_DIR — setup already done."
  echo "To start it: ./start.sh   To wipe and start over: rm -rf data/ then re-run this script."
  exit 0
fi

if ! command -v initdb >/dev/null 2>&1; then
  echo "initdb not found. Install Postgres first:"
  echo "  Mac:    brew install postgresql@16"
  echo "  Ubuntu: sudo apt install postgresql"
  echo "You only need the Postgres binaries on your PATH — no system service needs to be running."
  exit 1
fi

echo "Creating local Postgres cluster in $DATA_DIR ..."
initdb -D "$DATA_DIR" -U postgres --no-locale --encoding=UTF8

echo "Starting it temporarily to create the database and load the schema ..."
pg_ctl -D "$DATA_DIR" -l "$SCRIPT_DIR/postgres.log" -o "-p $PORT -h localhost" start

# pg_ctl start returns before Postgres is fully ready to accept connections
for i in $(seq 1 20); do
  if pg_isready -h localhost -p "$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

createdb -h localhost -p "$PORT" -U postgres nifty
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/schema.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -c "insert into instruments (symbol, lot_size) values ('NIFTY', 75);"

pg_ctl -D "$DATA_DIR" stop

echo ""
echo "Done. Database is set up at $DATA_DIR (fully self-contained, not a system service)."
echo "Start it with:  ./db/start.sh"
echo "Connection string once running:  postgresql://postgres@localhost:$PORT/nifty"
