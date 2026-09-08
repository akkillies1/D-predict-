#!/usr/bin/env bash
# Stops the local Postgres cluster started by start.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"

if [ ! -d "$DATA_DIR" ]; then
  echo "No local database found — nothing to stop."
  exit 0
fi

pg_ctl -D "$DATA_DIR" stop
