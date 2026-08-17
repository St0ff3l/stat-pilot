#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${HERMES_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
INSTALL_DIR="${HERMES_INSTALL_DIR:-$RUNTIME_ROOT/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-$RUNTIME_ROOT/hermes-home}"
INSTALLER_URL="https://api.github.com/repos/NousResearch/hermes-agent/contents/scripts/install.sh?ref=main"
SKIP_SETUP="${HERMES_SKIP_SETUP:-0}"
NON_INTERACTIVE="${HERMES_NON_INTERACTIVE:-0}"
HERMES_COMMIT="${HERMES_COMMIT:-}"
HERMES_GITHUB_TOKEN="${HERMES_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

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

CURL_ARGS=(
  --fail
  --silent
  --show-error
  --location
  --retry 5
  --retry-delay 10
  --retry-max-time 300
  --retry-all-errors
)
CURL_ARGS+=(--header "Accept: application/vnd.github.raw")
if [[ -n "$HERMES_GITHUB_TOKEN" ]]; then
  CURL_ARGS+=(--header "Authorization: Bearer $HERMES_GITHUB_TOKEN")
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
  export GIT_CONFIG_VALUE_0="AUTHORIZATION: bearer $HERMES_GITHUB_TOKEN"
fi

curl "${CURL_ARGS[@]}" "$INSTALLER_URL" | bash -s -- "${INSTALL_ARGS[@]}"

echo "Applying local Hermes runtime patches..."
node "$PROJECT_ROOT/scripts/patch-hermes-runtime.mjs"

if [[ -n "${HERMES_BIN:-}" && ! -x "$HERMES_BIN" ]]; then
  HERMES_BIN=""
fi

if [[ -z "${HERMES_BIN:-}" ]]; then
  for candidate in \
    "$INSTALL_DIR/.venv/bin/hermes" \
    "$INSTALL_DIR/venv/bin/hermes" \
    "$INSTALL_DIR/hermes"; do
    if [[ -x "$candidate" ]]; then
      HERMES_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "${HERMES_BIN:-}" ]]; then
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
