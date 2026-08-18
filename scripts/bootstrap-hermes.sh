#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${HERMES_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
INSTALL_DIR="${HERMES_INSTALL_DIR:-$RUNTIME_ROOT/hermes-agent}"
HERMES_HOME="${HERMES_HOME:-$RUNTIME_ROOT/hermes-home}"
HERMES_BRANCH="${HERMES_BRANCH:-main}"
SKIP_SETUP="${HERMES_SKIP_SETUP:-0}"
NON_INTERACTIVE="${HERMES_NON_INTERACTIVE:-0}"
HERMES_COMMIT="${HERMES_COMMIT:-}"
HERMES_GITHUB_TOKEN="${HERMES_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
HERMES_SOURCE_URL="${HERMES_SOURCE_URL:-}"
HERMES_PYTHON_VERSION="${HERMES_PYTHON_VERSION:-3.11}"
PORTABLE_PYTHON_ROOT="${HERMES_PORTABLE_PYTHON_ROOT:-$RUNTIME_ROOT/python}"
HERMES_ARCHIVE_BOOTSTRAPPED=0
HERMES_BOOTSTRAP_TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sz-gov-hermes.XXXXXX")"
trap 'rm -rf "$HERMES_BOOTSTRAP_TEMP_ROOT"' EXIT

# Keep the interpreter and its standard library inside the runtime that will
# be copied into the Electron app. Without these settings uv may reuse a
# machine-local Python (for example /opt/anaconda3/bin/python3), leaving an
# absolute symlink and an unusable pyvenv.cfg in the packaged app.
export HERMES_PYTHON_VERSION
export UV_PYTHON_INSTALL_DIR="$PORTABLE_PYTHON_ROOT"
export UV_MANAGED_PYTHON=1
unset UV_PYTHON

mkdir -p "$RUNTIME_ROOT"

echo "Installing Hermes Agent into:"
echo "  install dir: $INSTALL_DIR"
echo "  hermes home: $HERMES_HOME"

INSTALL_ARGS=(
  --dir "$INSTALL_DIR"
  --hermes-home "$HERMES_HOME"
)
INSTALL_ARGS+=(--branch "$HERMES_BRANCH")
if [[ "$SKIP_SETUP" == "1" ]]; then
  INSTALL_ARGS+=(--skip-setup)
fi
if [[ "$NON_INTERACTIVE" == "1" ]]; then
  INSTALL_ARGS+=(--non-interactive)
fi

prepare_local_hermes_repository() {
  local local_source_repo="$HERMES_BOOTSTRAP_TEMP_ROOT/hermes-agent-source.git"
  local archive_path="$HERMES_BOOTSTRAP_TEMP_ROOT/hermes-agent-source.tar.gz"
  local source_ref="${HERMES_COMMIT:-$HERMES_BRANCH}"
  local archive_dir="$HERMES_BOOTSTRAP_TEMP_ROOT/extract"

  if [[ -d "$INSTALL_DIR/.git" ]] && git -C "$INSTALL_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "Using the existing Hermes source checkout and a local-only git remote."
  else
    HERMES_ARCHIVE_BOOTSTRAPPED=1
    local archive_args=(
      --fail
      --silent
      --show-error
      --location
      --retry 5
      --retry-delay 10
      --retry-max-time 300
      --retry-all-errors
      --output "$archive_path"
    )
    if [[ -n "$HERMES_GITHUB_TOKEN" ]]; then
      archive_args+=(--header "Authorization: Bearer $HERMES_GITHUB_TOKEN")
    fi

    echo "Downloading Hermes source archive (no upstream git clone)..."
    if [[ -n "$HERMES_SOURCE_URL" && -z "$HERMES_COMMIT" ]]; then
      curl "${archive_args[@]}" "$HERMES_SOURCE_URL"
    else
      local archive_url_api="https://api.github.com/repos/NousResearch/hermes-agent/tarball/${source_ref}"
      local archive_url_codeload="https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${source_ref}"
      if ! curl "${archive_args[@]}" "$archive_url_api"; then
        echo "GitHub API archive download failed; trying codeload fallback..."
        curl "${archive_args[@]}" "$archive_url_codeload"
      fi
    fi

    mkdir -p "$archive_dir"
    tar -xzf "$archive_path" -C "$archive_dir"
    local extracted_dir
    extracted_dir="$(find "$archive_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    if [[ -z "$extracted_dir" ]]; then
      echo "Hermes source archive did not contain a top-level directory."
      exit 1
    fi

    if [[ -e "$INSTALL_DIR" ]]; then
      local backup_dir="${INSTALL_DIR}.broken-$(date -u +%Y%m%d-%H%M%S)"
      mv "$INSTALL_DIR" "$backup_dir"
      echo "Moved incomplete Hermes directory to $backup_dir"
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    mv "$extracted_dir" "$INSTALL_DIR"

    git -C "$INSTALL_DIR" init -b "$HERMES_BRANCH" >/dev/null
    git -C "$INSTALL_DIR" -c user.name="SZ Gov Scope build" -c user.email="build@localhost" add -A
    git -C "$INSTALL_DIR" -c user.name="SZ Gov Scope build" -c user.email="build@localhost" commit -m "Hermes source archive" >/dev/null
    echo "Prepared Hermes source from ref: $source_ref"
  fi

  if [[ -e "$local_source_repo" ]]; then
    rm -rf "$local_source_repo"
  fi
  git init --bare "$local_source_repo" >/dev/null
  git -C "$local_source_repo" config receive.shallowUpdate true
  git -C "$INSTALL_DIR" checkout -B "$HERMES_BRANCH" >/dev/null 2>&1 || true
  git -C "$INSTALL_DIR" remote remove origin >/dev/null 2>&1 || true
  git -C "$INSTALL_DIR" remote add origin "$local_source_repo"
  git -C "$INSTALL_DIR" push --force --set-upstream origin "$HERMES_BRANCH" >/dev/null
  echo "Configured Hermes installer to update from the local source mirror."
}

prepare_local_hermes_repository

remove_macos_metadata() {
  local removed=0
  while IFS= read -r -d '' metadata_path; do
    rm -f "$metadata_path"
    removed=$((removed + 1))
  done < <(find "$RUNTIME_ROOT" -type f \( -name '._*' -o -name '.DS_Store' \) -print0)
  if [[ "$removed" -gt 0 ]]; then
    echo "Removed $removed macOS metadata files from $RUNTIME_ROOT"
  fi
}

remove_macos_metadata

if [[ -n "$HERMES_COMMIT" && "$HERMES_ARCHIVE_BOOTSTRAPPED" != "1" ]]; then
  INSTALL_ARGS+=(--commit "$HERMES_COMMIT")
fi

INSTALLER_PATH="$INSTALL_DIR/scripts/install.sh"
if [[ ! -f "$INSTALLER_PATH" ]]; then
  echo "Hermes installer script not found in the prepared source: $INSTALLER_PATH"
  exit 1
fi
bash "$INSTALLER_PATH" "${INSTALL_ARGS[@]}"

git -C "$INSTALL_DIR" remote set-url origin "https://github.com/NousResearch/hermes-agent.git" >/dev/null 2>&1 || true

UV_PATH="$HERMES_HOME/bin/uv"
if [[ ! -x "$UV_PATH" ]]; then
  UV_PATH="$(command -v uv || true)"
fi
if [[ -z "$UV_PATH" || ! -x "$UV_PATH" ]]; then
  echo "Managed uv was not found after Hermes installation; cannot prepare portable Python."
  exit 1
fi

echo "Ensuring portable Python $HERMES_PYTHON_VERSION is bundled with Hermes..."
"$UV_PATH" python install "$HERMES_PYTHON_VERSION" --install-dir "$PORTABLE_PYTHON_ROOT" --no-bin
HERMES_RUNTIME_ROOT="$RUNTIME_ROOT" \
  HERMES_INSTALL_DIR="$INSTALL_DIR" \
  HERMES_PYTHON_VERSION="$HERMES_PYTHON_VERSION" \
  node "$PROJECT_ROOT/scripts/prepare-portable-hermes-runtime.mjs"

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
