#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log() { printf '\033[36m[D-Predict]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[D-Predict]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Engine/Desktop and run this script again."
docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker and run this script again."
command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required for the dashboard."
command -v corepack >/dev/null 2>&1 || fail "Corepack is required. Enable it with: corepack enable"
command -v curl >/dev/null 2>&1 || fail "curl is required."

if [[ ! -f .env ]]; then
  log "Creating local .env from .env.example"
  cp .env.example .env
fi

log "Starting local PostgreSQL..."
docker compose --profile local up -d postgres

log "Waiting for PostgreSQL..."
for i in {1..60}; do
  if docker compose exec -T postgres pg_isready -U postgres -d nifty >/dev/null 2>&1; then break; fi
  [[ "$i" == 60 ]] && fail "PostgreSQL did not become ready. Run: docker compose logs postgres --tail=100"
  sleep 1
done

log "Applying idempotent shadow trading migration..."
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/008-shadow-trading.sql >/dev/null

log "Applying idempotent option paper trading migration..."
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/009-option-paper-trading.sql >/dev/null

log "Applying idempotent D-Predict 2.0 migration..."
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/010-dpredict-20.sql >/dev/null

log "Starting API, research, ML inference, collector and engine..."
docker compose --profile local up -d api research ml collector engine

log "Waiting for API on http://127.0.0.1:4100..."
for i in {1..60}; do
  if curl -fsS --max-time 2 http://127.0.0.1:4100/health >/dev/null 2>&1; then break; fi
  [[ "$i" == 60 ]] && { docker compose logs api --tail=100; fail "Market API did not become healthy on port 4100."; }
  sleep 1
done

log "Waiting for research API on http://127.0.0.1:4200..."
for i in {1..60}; do
  if curl -fsS --max-time 2 http://127.0.0.1:4200/health >/dev/null 2>&1; then break; fi
  [[ "$i" == 60 ]] && { docker compose logs research --tail=100; fail "Research API did not become healthy on port 4200."; }
  sleep 1
done

log "Waiting for ML inference API on http://127.0.0.1:4300..."
for i in {1..60}; do
  if curl -fsS --max-time 2 http://127.0.0.1:4300/health >/dev/null 2>&1; then break; fi
  [[ "$i" == 60 ]] && { docker compose logs ml --tail=100; fail "ML inference service did not become healthy on port 4300."; }
  sleep 1
done

log "Preparing dashboard dependencies..."
(
  cd dashboard
  corepack pnpm install --frozen-lockfile
)

DASHBOARD_LOG="$PWD/dashboard-local.log"
log "Starting dashboard..."
(
  cd dashboard
  exec corepack pnpm dev --host 127.0.0.1
) >"$DASHBOARD_LOG" 2>&1 &
DASHBOARD_PID=$!
trap 'kill "$DASHBOARD_PID" 2>/dev/null || true' EXIT INT TERM

DASHBOARD_URL=""
log "Waiting for dashboard..."
for i in {1..60}; do
  for port in {3000..3019}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      DASHBOARD_URL="http://127.0.0.1:${port}/"
      break 2
    fi
  done
  if ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
    tail -n 100 "$DASHBOARD_LOG" || true
    fail "Dashboard process exited."
  fi
  sleep 1
done

[[ -n "$DASHBOARD_URL" ]] || { tail -n 100 "$DASHBOARD_LOG" || true; fail "Dashboard did not start."; }

log "D-Predict is ready."
printf '\n  Dashboard : %s\n  Market API: http://127.0.0.1:4100/health\n  Shadow API: http://127.0.0.1:4100/api/shadow/portfolio\n  Research  : http://127.0.0.1:4200/health\n  ML model  : http://127.0.0.1:4300/health\n  PostgreSQL: localhost:5433\n\n' "$DASHBOARD_URL"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$DASHBOARD_URL" >/dev/null 2>&1 || true
fi

log "Press Ctrl+C to stop the dashboard. Use 'docker compose down' to stop containers."
wait "$DASHBOARD_PID"
