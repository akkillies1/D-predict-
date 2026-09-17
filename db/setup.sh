#!/usr/bin/env bash
# One-time setup: creates a self-contained Postgres cluster whose data files
# live entirely inside this repo (db/data/), not in a system-wide location.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
PORT="${NIFTY_DB_PORT:-5433}"

if [ -d "$DATA_DIR" ]; then
  echo "Data directory already exists at $DATA_DIR — setup already done."
  echo "To start it: ./start.sh   To wipe and start over: rm -rf data/ then re-run this script."
  exit 0
fi

if ! command -v initdb >/dev/null 2>&1; then
  echo "initdb not found. Install Postgres first."
  echo "  Mac:    brew install postgresql@16"
  echo "  Ubuntu: sudo apt install postgresql"
  exit 1
fi

echo "Creating local Postgres cluster in $DATA_DIR ..."
initdb -D "$DATA_DIR" -U postgres --no-locale --encoding=UTF8

echo "Starting it temporarily to create the database and load the schema ..."
pg_ctl -D "$DATA_DIR" -l "$SCRIPT_DIR/postgres.log" -o "-p $PORT -h localhost" start
for i in $(seq 1 20); do
  if pg_isready -h localhost -p "$PORT" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

createdb -h localhost -p "$PORT" -U postgres nifty
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/schema.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/002_prediction_ml.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/003_instrument_metadata.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/004_canonical_instrument_metadata.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/005_ipo_analysis.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/006_research_data.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/006_seed_instruments.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/007_live_ml_ledger.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/008_shadow_trading.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/009_option_paper_trading.sql"
psql -h localhost -p "$PORT" -U postgres -d nifty -f "$SCRIPT_DIR/migrations/010_dpredict_20.sql"

pg_ctl -D "$DATA_DIR" stop

echo ""
echo "Done. Database is set up at $DATA_DIR."
echo "Start it with:  ./db/start.sh"
echo "Connection string once running:  postgresql://postgres@localhost:$PORT/nifty"
