#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/d-predict"
BIN_ROOT="${HOME}/.local/bin"
DESKTOP_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

printf '\033[36m[D-Predict]\033[0m Installing from %s\n' "$ROOT"

command -v docker >/dev/null 2>&1 || { echo 'Docker is required. Install Docker Engine and run this installer again.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js 20+ is required.' >&2; exit 1; }
command -v corepack >/dev/null 2>&1 || { echo 'Corepack is required. Run: corepack enable' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }

docker info >/dev/null 2>&1 || { echo 'Docker daemon is not running. Start Docker and run this installer again.' >&2; exit 1; }

mkdir -p "$INSTALL_ROOT" "$BIN_ROOT" "$DESKTOP_ROOT"
rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='dashboard/node_modules' --exclude='collector/.venv' "$ROOT/" "$INSTALL_ROOT/"
chmod +x "$INSTALL_ROOT/d-predict.sh"

ln -sfn "$INSTALL_ROOT/d-predict.sh" "$BIN_ROOT/d-predict"

cat > "$DESKTOP_ROOT/d-predict.desktop" <<EOF
[Desktop Entry]
Name=D-Predict
Comment=Local D-Predict market research and paper trading
Exec=$INSTALL_ROOT/d-predict.sh
Terminal=true
Type=Application
Categories=Finance;
EOF
chmod 644 "$DESKTOP_ROOT/d-predict.desktop"

printf '\033[32m[D-Predict]\033[0m Installed to %s\n' "$INSTALL_ROOT"
printf '\033[32m[D-Predict]\033[0m Command: %s/d-predict\n' "$BIN_ROOT"
printf '\033[32m[D-Predict]\033[0m Starting D-Predict...\n'

exec "$INSTALL_ROOT/d-predict.sh"
