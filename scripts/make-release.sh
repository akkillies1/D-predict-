#!/usr/bin/env bash
set -Eeuo pipefail
VERSION="${1:-v0.1.0}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/releases"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$OUT_DIR"
NAME="d-predict-${VERSION#v}-linux-x64"
mkdir -p "$TMP_DIR/$NAME"
tar --exclude='.git' --exclude='db/data' --exclude='db/postgres.log' --exclude='node_modules' --exclude='collector/.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='*.env' -cf - -C "$ROOT_DIR" . | tar -C "$TMP_DIR/$NAME" -xf -
tar -C "$TMP_DIR" -czf "$OUT_DIR/$NAME.tar.gz" "$NAME"
(cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > SHA256SUMS)
printf 'Created %s and %s\n' "$OUT_DIR/$NAME.tar.gz" "$OUT_DIR/SHA256SUMS"
