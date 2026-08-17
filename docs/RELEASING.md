# 发布 SZ Gov Scope

SZ Gov Scope 将 Hermes Runtime 和项目 Skill 一起打进安装包。由于 Hermes 的 Python 虚拟环境包含平台相关文件，必须在对应的 GitHub Actions Runner 上分别构建四个目标：

- macOS：`macos-14`，生成 Apple Silicon `.dmg`；
- macOS Intel：`macos-15-intel`，生成 Intel `.dmg`；
- Windows：`windows-2022`，生成 NSIS `.exe`；
- Linux：`ubuntu-22.04`，生成 x64 `.deb`。

## GitHub Actions 发布

推送版本标签即可触发四个目标并行构建：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流位于 `.github/workflows/release.yml`，会：

1. 在目标平台安装对应的 Hermes Runtime；
2. 构建前端与 Electron 主进程；
3. 把 `.runtime`、`skills/` 和 `rules/` 一起打包；
4. 上传 macOS、Windows、Linux 安装包；
5. 创建或更新 GitHub Release，并附带 `SHA256SUMS.txt`。

`package.json` 的版本号必须与标签一致，例如 `package.json` 为 `0.1.0` 时使用 `v0.1.0`。

## 手动构建

需要在目标平台本机执行 Runtime 准备和打包：

```bash
# macOS / Linux
npm ci
npm run hermes:bootstrap:quick
npm run dist:mac       # macOS
npm run dist:linux     # Linux .deb
```

Windows 使用 PowerShell：

```powershell
npm ci
npm run hermes:bootstrap:windows
npm run dist:win
```

默认构建产物位于 `release/`。

## Runtime 版本固定

为了让发布可复现，可以在 GitHub Repository Variables 中设置 `HERMES_COMMIT`。工作流会把它传给 Hermes 安装脚本；不设置时使用 Hermes `main` 分支的最新版本。

## 签名

当前工作流先生成未签名安装包。正式对外发布时，再在 GitHub Secrets 中配置 macOS 证书/公证信息和 Windows 代码签名证书，避免系统安全提示影响安装体验。
