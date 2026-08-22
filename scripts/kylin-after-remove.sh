#!/usr/bin/env bash

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' >/dev/null 2>&1 || true
else
    rm -f '/usr/bin/${executable}'
fi

# 新版麒麟包不会安装 AppArmor profile。升级旧包时，如系统仍有旧 profile，
# 最多等待 10 秒尝试卸载，避免卸载流程被 apparmor_parser 无限阻塞。
APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ] && command -v apparmor_parser >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    timeout 10s apparmor_parser --remove "$APPARMOR_PROFILE_DEST" >/dev/null 2>&1 || true
fi
rm -f "$APPARMOR_PROFILE_DEST"
