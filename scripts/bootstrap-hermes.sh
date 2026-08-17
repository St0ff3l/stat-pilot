#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${HERMES_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
INSTALL_DIR="${HERMES_INSTALL_DIR:-$RUNTIME_ROOT/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-$RUNTIME_ROOT/hermes-home}"
INSTALLER_URL="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"
SKIP_SETUP="${HERMES_SKIP_SETUP:-0}"
NON_INTERACTIVE="${HERMES_NON_INTERACTIVE:-0}"
HERMES_COMMIT="${HERMES_COMMIT:-}"

mkdir -p "$RUNTIME_ROOT"

echo "Installing Hermes Agent into:"
echo "  install dir: $INSTALL_DIR"
echo "  hermes home: $HERMES_HOME"

INSTALL_ARGS=(
  --dir "$INSTALL_DIR"
  --hermes-home "$HERMES_HOME"
)
if [[ -n "$HERMES_COMMIT" ]]; then
  INSTALL_ARGS+=(--commit "$HERMES_COMMIT")
fi
if [[ "$SKIP_SETUP" == "1" ]]; then
  INSTALL_ARGS+=(--skip-setup)
fi
if [[ "$NON_INTERACTIVE" == "1" ]]; then
  INSTALL_ARGS+=(--non-interactive)
fi

curl -fsSL "$INSTALLER_URL" | bash -s -- "${INSTALL_ARGS[@]}"

echo "Applying local Hermes runtime patches..."
node "$PROJECT_ROOT/scripts/patch-hermes-runtime.mjs"

HERMES_BIN="${HERMES_BIN:-$INSTALL_DIR/hermes}"
if [[ ! -x "$HERMES_BIN" ]]; then
  if command -v hermes >/dev/null 2>&1; then
    HERMES_BIN="$(command -v hermes)"
  else
    echo "Hermes binary not found after installation."
    exit 1
  fi
fi

if [[ "$SKIP_SETUP" == "1" ]]; then
  echo "Skipping Hermes setup wizard."
  exit 0
fi

if [[ "$NON_INTERACTIVE" == "1" ]]; then
  "$HERMES_BIN" setup --quick --non-interactive
else
  "$HERMES_BIN" setup
fi
