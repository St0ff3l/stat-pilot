# 发布 深小统

深小统将 Hermes Runtime 和项目 Skill 一起打进安装包。由于 Hermes 的 Python 虚拟环境包含平台相关文件，必须在对应的 GitHub Actions Runner 上分别构建五个目标：

- macOS：`macos-14`，生成 Apple Silicon `.dmg`；
- macOS Intel：`macos-15-intel`，生成 Intel `.dmg`；
- Windows：`windows-2022`，生成 NSIS `.exe`；
- Linux x64：`ubuntu-22.04`，生成 `amd64` `.deb`；
- 银河麒麟 ARM64：`ubuntu-24.04-arm`，生成 `arm64` `.deb`。

## GitHub Actions 发布

推送版本标签即可触发五个目标并行构建：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流位于 `.github/workflows/release.yml`，会：

1. 在目标平台安装对应的 Hermes Runtime；
2. 构建前端与 Electron 主进程；
3. 验证目标平台的 `.runtime` 同时包含 Python、Hermes 入口和 `portable-python.json`；
4. 把 `.runtime`、`skills/` 和 `rules/` 一起打包；
5. 按架构校验 DEB 的 `Package`、`Version`、`Architecture`、`Maintainer`、`Description` 字段；
6. 上传 macOS、Windows、Linux 安装包；
7. 创建或更新 GitHub Release，并附带 `SHA256SUMS.txt`。

## 银河麒麟 V10(SP1) ARM64 打包约束

麒麟 ARM64 包使用 `build/electron-builder.kylin.yml`。它仍然按照官方指南输出
`deb`，但使用 `scripts/kylin-after-install.sh` 安装钩子：

- 对 `unshare` 检测设置超时，避免旧内核在安装阶段阻塞；
- MIME 和桌面数据库刷新设置超时，失败不会阻断安装；
- 不执行 Electron Builder 默认的 Ubuntu AppArmor 安装钩子，避免在麒麟 V10(SP1)
  上调用 `apparmor_parser` 导致软件中心长时间停留在“安装中”。

官方参考文档：

- [银河麒麟桌面操作系统 V10 Electron 应用开发者打包指南](https://www.kylinos.cn/upload/1/editor/20251223/1766460381009.pdf)
- [银河麒麟桌面操作系统 V10-DEB 包开发者指南](https://www.kylinos.cn/upload/1/editor/20251223/1766460292334.pdf)
- [银河麒麟桌面操作系统 V10 常见问题](https://www.kylinos.cn/upload/1/kycms/20250617/1934877956515139584.pdf)

Hermes 引导会下载源码归档并在临时目录建立本地镜像，再执行归档内的官方安装脚本；构建过程不依赖对上游仓库执行 Git clone，也不会把临时镜像放进最终安装包。

`package.json` 的版本号必须与标签一致，例如 `package.json` 为 `0.1.0` 时使用 `v0.1.0`。

## CI 构建（唯一发布路径）

不要在本机运行 `npm run dist:*` 或 `electron-builder`。发布统一由 `.github/workflows/release.yml` 在目标平台 Runner 上完成：

1. 推送与 `package.json` 版本一致的 `v*` 标签；或手动启动 `Build and release installers` workflow。
2. CI 在 macOS、Windows、Linux 三个平台分别安装 Hermes、验证运行时并打包。
3. CI 上传安装包和 `SHA256SUMS.txt` 到 GitHub Release。

只有 GitHub Release 中的 `.exe`、`.dmg`、`.deb` 安装包包含对应平台的 Hermes；GitHub 的 Source code ZIP 不包含生成的 `.runtime`。打包时会排除 `.runtime/hermes-home`，因此构建机上的会话、登录态和 API key 不会进入安装包。本地打包脚本和 CI 都会在打包前运行 `npm run verify:runtime`，发现运行时缺失或不完整会直接失败。

CI 构建产物位于 GitHub Actions artifacts 或 GitHub Release，不在本地生成 `release/`。

## Runtime 版本固定

为了让发布可复现，可以在 GitHub Repository Variables 中设置 `HERMES_COMMIT`。工作流会下载该 ref 对应的 Hermes 源码归档；不设置时使用 Hermes `main` 分支的最新版本。

## 签名

macOS 构建使用 ad-hoc 签名（`identity: "-"`），用于保证 App 包完整性，不需要 Apple Developer 证书。它不是 Developer ID 签名，也不能替代 notarization；从互联网下载时，macOS 仍可能显示“无法验证开发者”。

正式对外发布时，需在 GitHub Secrets 中配置 Developer ID 证书、公证信息和 Windows 代码签名证书，才能减少系统安全提示。
