# 发布 深小统

安装包在干净的目标平台 Runner 上构建，随包提供 Electron、独立 Node.js、DSH 依赖、技能和规则。不要把开发机的 DSH_HOME、会话、登录态、`.env` 或 API Key 放入构建产物。

## GitHub Actions 目标

- macOS Apple Silicon：`macos-14`，`.dmg`
- macOS Intel：`macos-15-intel`，`.dmg`
- Windows x64：`windows-2022`，NSIS `.exe`
- Linux x64：`ubuntu-22.04`，`amd64` `.deb`
- 麒麟 Linux ARM64：`ubuntu-24.04-arm`，`arm64` `.deb`

Linux ARM64 必须在原生 ARM64 Runner 上构建，确保 Electron、Node.js 和 DSH 原生依赖均为 ARM64。

## GitHub Actions 发布

推送与 `package.json` 版本一致的 `v*` 标签，或手动启动 `Build and release installers` workflow 并填写 `release_tag`。也可以填写已成功构建的 workflow run ID 复用现有安装包；复用时必须同时填写目标 `release_tag`。工作流位于 `.github/workflows/release.yml`，会：

1. 在目标平台安装 Node.js 22 并执行 `npm ci`，依赖版本由 lockfile 固定；
2. 构建前端与 Electron 主进程；
3. 将目标平台的 Node.js 可执行文件暂存到 `.runtime/`；
4. 使用暂存的 Node.js 启动 DSH，验证服务、会话流、技能、身份配置、归档/恢复/彻底删除；Windows 还验证默认终端优先使用 `pwsh.exe` 并回退到 `powershell.exe`；
5. 通过 Electron Builder 打包，并从 `.runtime/` 只复制 `dsh-node.exe`；
6. 使用最终安装包内的 Node.js 和解包后的 DSH 依赖再次启动 DSH，验证打包产物可运行；
7. 按架构校验 DEB 的 `Package`、`Version`、`Architecture`、`Maintainer`、`Description` 字段；
8. 上传 macOS、Windows 和 Linux 安装包，成功后创建或更新 GitHub Release。

`.runtime/` 是构建暂存目录，不会整体打进安装包。GitHub Source code ZIP 不包含生成的安装包运行时，也不能直接替代安装程序。

## 麒麟 V10(SP1) ARM64 打包约束

麒麟 ARM64 包使用 Electron Builder 输出 `deb`，并由 `package.json` 配置安装与卸载钩子：

- 对 `unshare` 检测设置超时，避免旧内核在安装阶段阻塞；
- MIME 和桌面数据库刷新设置超时，失败不会阻断安装；
- 不执行 Electron Builder 默认的 Ubuntu AppArmor 安装钩子，避免麒麟 V10(SP1) 调用 `apparmor_parser` 后卡住软件中心。

官方参考文档：

- [银河麒麟桌面操作系统 V10 Electron 应用开发者打包指南](https://www.kylinos.cn/upload/1/editor/20251223/1766460381009.pdf)
- [银河麒麟桌面操作系统 V10-DEB 包开发者指南](https://www.kylinos.cn/upload/1/editor/20251223/1766460292334.pdf)
- [银河麒麟桌面操作系统 V10 常见问题](https://www.kylinos.cn/upload/1/kycms/20250617/1934877956515139584.pdf)

## CI 构建（唯一发布路径）

不要在本机运行 `npm run dist:*` 或 `electron-builder`。发布统一由 `.github/workflows/release.yml` 在目标平台 Runner 上完成。`.github/workflows/ci.yml` 会在 Windows、macOS 和 Linux 启动 DSH，检查 V4.1 模型、权限设置、凭据接口、自定义 Provider、语音 Provider、内置技能及会话归档、恢复、彻底删除；验证使用临时 DSH_HOME 并在退出后清理。安装包构建与 Debian 架构校验也都在对应 Runner 上完成。产物位于 GitHub Actions artifacts 或 GitHub Release，不在本地生成 `release/`。

## 签名

macOS 构建使用 ad-hoc 签名（`identity: "-"`），用于保证 App 包完整性，不需要 Apple Developer 证书。它不是 Developer ID 签名，也不能替代 notarization；从互联网下载时，macOS 仍可能显示“无法验证开发者”。正式对外发布时，需在 GitHub Secrets 中配置 Developer ID 证书、公证信息和 Windows 代码签名证书。
