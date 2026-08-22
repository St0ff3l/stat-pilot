#!/usr/bin/env bash

set -euo pipefail

PACKAGE_PATH=${1:?用法: validate-deb-package.sh package.deb amd64\|arm64}
EXPECTED_ARCH=${2:?用法: validate-deb-package.sh package.deb amd64\|arm64}

if [ ! -f "$PACKAGE_PATH" ]; then
    echo "找不到 DEB 文件: $PACKAGE_PATH" >&2
    exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "当前环境没有 dpkg-deb，无法验证 DEB 包" >&2
    exit 1
fi

read_field() {
    dpkg-deb -f "$PACKAGE_PATH" "$1"
}

PACKAGE_NAME=$(read_field Package)
PACKAGE_VERSION=$(read_field Version)
PACKAGE_ARCH=$(read_field Architecture)
PACKAGE_MAINTAINER=$(read_field Maintainer)
PACKAGE_DESCRIPTION=$(read_field Description)

for required_value in PACKAGE_NAME PACKAGE_VERSION PACKAGE_ARCH PACKAGE_MAINTAINER PACKAGE_DESCRIPTION; do
    if [ -z "${!required_value}" ]; then
        echo "DEB 必填字段为空: $required_value" >&2
        exit 1
    fi
done

if [ "$PACKAGE_NAME" != "sz-gov-scope" ]; then
    echo "DEB 包名错误: $PACKAGE_NAME" >&2
    exit 1
fi

if [ "$PACKAGE_ARCH" != "$EXPECTED_ARCH" ]; then
    echo "DEB 架构错误: 期望 $EXPECTED_ARCH，实际 $PACKAGE_ARCH" >&2
    exit 1
fi

if dpkg-deb --contents "$PACKAGE_PATH" | grep -E '(^|/)(\._[^/]*|\.DS_Store)(/|$)' >/dev/null; then
    echo "DEB 包包含 macOS 平台元数据文件（._* 或 .DS_Store）" >&2
    exit 1
fi

CONTROL_DIR=$(mktemp -d)
trap 'rm -rf "$CONTROL_DIR"' EXIT
dpkg-deb --control "$PACKAGE_PATH" "$CONTROL_DIR"

# 麒麟 ARM64 包不应包含 Electron Builder 26 的 AppArmor 安装钩子。
if [ "$EXPECTED_ARCH" = "arm64" ] && sed '/^[[:space:]]*#/d' "$CONTROL_DIR/postinst" 2>/dev/null | grep -q "apparmor_parser"; then
    echo "ARM64 麒麟 DEB 仍包含 apparmor_parser 安装钩子" >&2
    exit 1
fi

printf '%s\n' \
    "DEB 校验通过" \
    "Package: $PACKAGE_NAME" \
    "Version: $PACKAGE_VERSION" \
    "Architecture: $PACKAGE_ARCH" \
    "Maintainer: $PACKAGE_MAINTAINER"
