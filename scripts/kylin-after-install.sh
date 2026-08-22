#!/usr/bin/env bash

# 这是银河麒麟 V10(SP1) ARM64 包专用的 DEB 安装钩子。
# 不使用 set -e：可选的桌面数据库刷新失败时，不应阻断应用安装。

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' ] && [ -e '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# 麒麟 V10 的内核可能禁用 user namespace。检测设置 5 秒上限，避免
# unshare 在安装器中长时间阻塞；失败时使用 Electron 的 SUID sandbox。
USER_NS_OK=0
if command -v unshare >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
        timeout 5s unshare --user true >/dev/null 2>&1 && USER_NS_OK=1
    else
        unshare --user true >/dev/null 2>&1 && USER_NS_OK=1
    fi
fi

if [ "$USER_NS_OK" -eq 1 ]; then
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

# 麒麟软件桌面环境需要桌面入口，但数据库刷新属于可选操作，增加超时。
if command -v update-mime-database >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
        timeout 30s update-mime-database /usr/share/mime >/dev/null 2>&1 || true
    else
        update-mime-database /usr/share/mime >/dev/null 2>&1 || true
    fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
        timeout 30s update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    else
        update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    fi
fi

# 不在麒麟 V10 安装阶段执行 apparmor_parser。该系统不是 Ubuntu 24，
# 而 Electron Builder 26 的默认钩子会在启用 AppArmor 的机器上加载其
# Ubuntu profile，可能导致麒麟软件安装器长时间停留在“安装中”。
