#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${DP_RELEASE_REPO:-akkillies1/D-predict-}"
VERSION="${DP_VERSION:-latest}"
INSTALL_DIR="${DP_INSTALL_DIR:-$HOME/.d-predict}"
BIN_DIR="${DP_BIN_DIR:-$HOME/.local/bin}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }

if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p' | head -1)"
  [[ -n "$VERSION" ]] || { echo "No release found for $REPO. Use DP_VERSION=v0.1.0 or download a ZIP." >&2; exit 1; }
fi

ARCHIVE="d-predict-${VERSION#v}-linux-x64.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
(cd "$TMP" && grep "  $ARCHIVE$" SHA256SUMS | sha256sum -c -)

mkdir -p "$INSTALL_DIR/releases/${VERSION}" "$BIN_DIR"
tar -xzf "$TMP/$ARCHIVE" -C "$INSTALL_DIR/releases/${VERSION}" --strip-components=1
if [[ -e "$INSTALL_DIR/current" && ! -L "$INSTALL_DIR/current" ]]; then mv "$INSTALL_DIR/current" "$INSTALL_DIR/current.backup.$(date +%s)"; fi
ln -sfn "$INSTALL_DIR/releases/${VERSION}" "$INSTALL_DIR/current"
ln -sfn "$INSTALL_DIR/current/dp" "$BIN_DIR/dp"

echo "Installed d-predict ${VERSION} in $INSTALL_DIR"
echo "Run: $BIN_DIR/dp init"
[[ ":$PATH:" == *":$BIN_DIR:"* ]] || echo "Add $BIN_DIR to PATH if needed: export PATH=\"$BIN_DIR:\$PATH\""
