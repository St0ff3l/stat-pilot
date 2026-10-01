# 深小统（StatPilot）

面向深圳市统计政务工作的 Electron 桌面工作台。主进程启动本地 DeepSeek Harness（DSH），通过 DSH RPC 和事件流管理对话、模型、技能与授权。

## 功能

- 对话历史、归档列表、恢复与彻底删除
- DSH 原生图片和文件附件
- DSH 本地 SenseVoice 语音转写，结果进入草稿后由用户确认发送
- DSH 会话消息流、工具活动、任务授权和澄清
- 工作区、技能和模型设置
- 本地保存应用设置与 DSH 会话数据

归档页固定在侧边栏中，可搜索、恢复或彻底删除对话。归档和恢复使用 DSH 原生接口；永久删除使用 MIT 插件 [`dsh-archived-chats` 1.4.5](https://github.com/Ultronen/dsh-archived-chats)，需要二次确认，并由插件清理 DSH 会话记录。

聊天输入框的语音按钮使用 DSH 本地 SenseVoice。首次使用需确认下载并准备模型；录音经本地 DSH 转写为草稿，不会自动发送。麦克风权限仅授予应用主窗口的纯音频请求。

## 本地开发

```bash
npm install
npm run dev
```

`npm run dev` 同时启动 Vite 和 Electron。应用从 `@deepseek-ai/dsh` 启动 DSH CLI。可以通过 `DSH_HOME` 指定 DSH 数据目录；否则会复用已有的 `~/.dsh`，没有该目录时使用 Electron 私有数据目录中的 `dsh-home`。

## 运行配置

在应用设置中配置 provider、API Key、模型和工作区。DeepSeek 默认模型为 `deepseek-flash`（DeepSeek V4.1 Flash）；官方 API 当前也会将 `deepseek-v4-pro` 路由到 V4.1 Flash，因此该 ID 仅作为兼容选项保留。旧 ID `deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 也按 DeepSeek 兼容规则归一到 V4.1 Flash。OpenRouter 和自定义 Provider 的模型 ID 仍按各自服务处理。账号授权、provider 配置和 API 凭据通过 DSH 的 Account、Settings 与 Credentials 接口管理。

## 发布

安装包只通过 GitHub Actions 在目标平台构建，不要在本机运行 `npm run dist:*` 或直接运行 `electron-builder`。工作流会在目标平台准备并验证 DSH，再打包该平台的 Electron、Node.js、DSH 依赖、技能和规则。Linux ARM64 `.deb` 在原生 ARM64 Runner 构建。

发布细节见 [docs/RELEASING.md](docs/RELEASING.md)。

## 目录

```text
electron/            Electron 主进程、preload 和 DSH 客户端
src/                 React 渲染界面
scripts/             DSH 运行时准备与 Debian 校验脚本
skills/              内置技能
rules/               工作台规则
docs/                项目上下文和发布说明
```
