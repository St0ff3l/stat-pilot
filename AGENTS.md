# AGENTS.md

## Git 分支命名

创建新分支时不要默认使用 `codex/`，请根据任务类型选择前缀：

- 新功能：`feat/<description>`
- 修复问题：`fix/<description>`
- 工程维护：`chore/<description>`
- 文档变更：`docs/<description>`
- 发布分支：`release/<version>`

分支名使用小写 kebab-case。任务类型明确时直接选择对应前缀；无法判断时再询问用户。

## 跨平台本地开发

- 开发启动统一使用 `npm run dev`，不要在 `package.json` 中直接写 `VITE_DEV_SERVER_URL=... electron .` 这类仅适用于 Unix shell 的环境变量语法；使用 `cross-env` 保证 Windows、macOS、Linux 一致。
- Hermes Runtime 源码归档可能携带 macOS AppleDouble 元数据（文件名以 `._` 开头或为 `.DS_Store`）。这些文件不是文本，不能让 Hermes 扫描；引导脚本和应用启动流程都必须清理它们。
- 新增文件扫描或技能加载逻辑时，必须忽略 `._*`、`.DS_Store` 等平台元数据，并在 Windows、macOS、Linux 至少各做一次启动/技能发现验证。
- Windows 下 Hermes 终端默认使用 `pwsh`，找不到时回退 `powershell.exe`；不要主动使用 WSL、`wsl.exe`、bash 或 Git Bash，命令使用 PowerShell 语法。

## 文件输出目录

- 未指定工作区文件夹时，所有抓取结果、报告、HTML 和其他生成文件统一写入工作区下的 `output/`，不得直接写入工作区根目录或应用安装目录。
- 默认目录名称统一使用 `output`（单数）；不要再新增或使用 `outputs` 作为默认目录。用户明确指定输出目录时，才使用用户指定的位置。

## Hermes 身份提示

- Hermes Gateway 的 `session.create` / `session.resume` 当前不会使用客户端传入的 `developerInstructions` 作为模型身份提示。
- 产品身份必须通过应用私有 `HERMES_HOME/SOUL.md` 注入；应用启动时由 `electron/main.mjs` 创建或更新默认 Hermes 身份模板，不要在前端写死“你是谁”的回复。
- 仅替换 Hermes 默认的 `You are Hermes Agent...` 模板，不能覆盖用户自行修改过的 `SOUL.md`。
- 私有运行时的 YOLO 必须通过启动 Hermes 进程前设置 `HERMES_YOLO_MODE=1`（可同时设置 `HERMES_EXEC_ASK=0`）；`session.create` 的 `yolo: true` 不能替代环境变量。
- 审批事件不得在主进程静默自动批准；如果 YOLO 或硬性规则仍触发审批，必须保留 `pendingApproval` 并由前端展示授权操作。

## Git 合并策略

除非用户明确要求其他方式，创建 Pull Request 后默认使用 GitHub 普通 Merge（Create a merge commit），不要使用 Squash and merge 或 Rebase and merge。

## GitHub Issue 生命周期

- 修复 Issue 后，创建或合并 Pull Request 不得自动关闭、归档或标记该 Issue 为已解决。
- PR 合并仅表示代码已合入，不代表已发布、部署、验证或确认问题已解决；必须等用户明确确认发布并验证通过后，才允许关闭 Issue。
- 关联 Issue 时不要使用 `Fixes #123`、`Closes #123`、`Resolves #123` 等 GitHub 自动关闭关键词，改用 `Refs #123` 或 `Related to #123`。
- 除非用户明确要求，否则不要执行关闭 Issue 的操作。

## 发布与本地构建

- 安装包和 Release 一律通过 GitHub Actions CI 在目标平台构建并上传；不要在本机运行 `npm run dist:mac`、`npm run dist:win`、`npm run dist:linux` 或直接调用 `electron-builder` 生成 Release。
- 不要在本机执行编译/构建验证（包括 `npm run build`）；发布验证放在 GitHub Actions 的目标平台 Runner 上完成。
- 本地 `release/`、`dist/`、`dist-server/` 和其他打包产物不作为交付物；任务结束时清理它们。保留 `.runtime/`，因为它是本地 Hermes 开发/CI 准备环境，不是 Release 产物。
- CI 构建必须使用干净的目标平台环境，并在打包前验证平台对应的 Hermes Runtime；不要把本机的 `.runtime/hermes-home`、会话、登录态、`.env`、API Key 或其他运行数据上传到 GitHub。
