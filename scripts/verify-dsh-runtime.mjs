import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copySkillDirectoryWithoutPlatformMetadata,
  DshRuntimeManager,
  resolveDshBinaryPath,
  resolveNodeBinaryPath,
  resolveWindowsDshTerminalShell,
} from "../electron/dsh-runtime.mjs";
import { DshClient } from "../electron/dsh-client.mjs";

const dshBinPath = process.env.STAT_PILOT_VERIFY_DSH_BIN || resolveDshBinaryPath();

if (!existsSync(dshBinPath)) {
  console.error(`[verify-dsh] 找不到 DSH 运行时入口: ${dshBinPath}`);
  process.exit(1);
}

async function verifyRemoteInteractionAdapter(client) {
  const originalRequest = client.request;
  const originalClientId = client.clientId;
  const replies = [];
  const cancelled = new Set();
  let approvalRequest;
  let userQuestionRequest;
  const onCancelled = ({ eventId }) => cancelled.add(eventId);
  client.request = async (endpoint, args) => {
    replies.push({ endpoint, args });
    return { ok: true };
  };
  client.clientId = "stat-pilot-verification-client";
  client.once("approvalRequested", (request) => {
    approvalRequest = request;
  });
  client.once("userQuestionRequested", (request) => {
    userQuestionRequest = request;
  });
  client.on("remoteEventCancelled", onCancelled);

  try {
    client.handleWsMessage({
      type: "item",
      streamId: "stream-events",
      value: {
        type: "waterfall",
        event: "approval/request",
        eventId: "approval-verification-event",
        agentId: "approval-verification-agent",
        request: { toolName: "shell", reason: "Verification approval" },
      },
    });
    client.handleWsMessage({
      type: "item",
      streamId: "stream-events",
      value: {
        type: "waterfall",
        event: "user-questions/request",
        eventId: "question-verification-event",
        agentId: "question-verification-agent",
        request: { questions: [{ id: "choice", question: "Choose", options: [{ label: "A" }] }] },
      },
    });

    if (approvalRequest?.eventId !== "approval-verification-event") {
      throw new Error("DSH approval Remote Event was not routed to the desktop approval UI");
    }
    if (userQuestionRequest?.request?.questions?.[0]?.id !== "choice") {
      throw new Error("DSH user-question Remote Event was not routed to the desktop question UI");
    }

    await client.respondEventResult({
      clientId: client.clientId,
      eventId: approvalRequest.eventId,
      outcome: { kind: "result", value: "allowed-once" },
    });
    await client.respondEventResult({
      clientId: client.clientId,
      eventId: userQuestionRequest.eventId,
      outcome: { kind: "result", value: { answers: [{ id: "choice", selected: ["A"] }] } },
    });

    if (replies.length !== 2 || replies.some((reply) => reply.endpoint !== "$events/result")) {
      throw new Error("DSH interaction answers did not use the Remote Event result endpoint");
    }
    if (replies[0].args.eventId !== approvalRequest.eventId || replies[0].args.outcome.value !== "allowed-once") {
      throw new Error("DSH approval response did not preserve its Remote Event ID and decision");
    }
    if (replies[1].args.eventId !== userQuestionRequest.eventId
      || replies[1].args.outcome.value?.answers?.[0]?.id !== "choice") {
      throw new Error("DSH user-question response did not preserve its Remote Event ID and structured answer");
    }

    for (const eventId of [approvalRequest.eventId, userQuestionRequest.eventId]) {
      client.handleWsMessage({
        type: "item",
        streamId: "stream-events",
        value: { type: "cancel", eventId },
      });
    }
    if (cancelled.size !== 2) {
      throw new Error("DSH Remote Event cancellation frames were not routed to the desktop UI");
    }
  } finally {
    client.off("remoteEventCancelled", onCancelled);
    client.request = originalRequest;
    client.clientId = originalClientId;
  }

  console.log("[verify-dsh] DSH 权限审批与用户提问 Remote Event 往返验证通过");
}

async function verifyLiveEventStreams(client, timeoutMs = 10000) {
  client.connectWebSocket();
  const deadline = Date.now() + timeoutMs;
  while (!client.wsConnected || !client.clientId || !client.workspaceBaseline) {
    if (Date.now() >= deadline) {
      throw new Error("DSH WebSocket 事件流未能连接并接收认证或工作区基线");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log("[verify-dsh] DSH 认证 WebSocket 与工作区事件流验证通过");
}

function waitForClientEvent(client, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(eventName, onEvent);
      reject(new Error(`等待 DSH ${eventName} 事件超过 ${Math.round(timeoutMs / 1000)} 秒`));
    }, timeoutMs);
    const onEvent = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    client.once(eventName, onEvent);
  });
}

async function startOpenAiSmokeServer(expectedApiKey) {
  let requestCount = 0;
  let requestError = null;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      requestError = `DSH 请求到了意外的本机兼容服务路由: ${request.method} ${request.url}`;
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        requestError = "DSH 向兼容服务发送了无效 JSON";
        response.writeHead(400).end();
        return;
      }

      if (request.headers.authorization !== `Bearer ${expectedApiKey}`) {
        requestError = "DSH 没有使用凭据库提供的 API Key 调用兼容服务";
        response.writeHead(401).end();
        return;
      }
      if (payload.model !== "smoke-model" || payload.stream !== true) {
        requestError = "DSH 兼容服务请求中的模型 ID 或流式标记不正确";
        response.writeHead(400).end();
        return;
      }

      requestCount += 1;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const metadata = {
        id: "chatcmpl-stat-pilot-smoke",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "smoke-model",
      };
      response.write(`data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: { role: "assistant", content: "DSH end-to-end streaming verified." }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("无法读取本机兼容模型 smoke 服务端口");
  }
  return {
    server,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() { return requestCount; },
    get requestError() { return requestError; },
  };
}

const nodeBin = resolveNodeBinaryPath();
console.log(`[verify-dsh] 使用 Node: ${nodeBin}`);
console.log(`[verify-dsh] DSH 入口验证通过: ${dshBinPath}`);

const verifyRoot = await mkdtemp(path.join(os.tmpdir(), "stat-pilot-dsh-verify-"));
const dshHome = path.join(verifyRoot, "dsh-home");
await mkdir(dshHome, { recursive: true });
const userInstructionsPath = path.join(dshHome, "AGENTS.md");
const userInstructions = "User-owned DSH instructions must survive app startup.\n";
await writeFile(userInstructionsPath, userInstructions, "utf8");
const userSkillPath = path.join(dshHome, "skills", "weekly-report", "SKILL.md");
const userSkill = "---\nname: weekly-report\ndescription: User-owned override.\n---\n# User-owned skill\n";
await mkdir(path.dirname(userSkillPath), { recursive: true });
await writeFile(userSkillPath, userSkill, "utf8");
const userSkillMetadataDir = path.join(path.dirname(userSkillPath), "references");
await mkdir(userSkillMetadataDir, { recursive: true });
const nestedAppleDoublePath = path.join(userSkillMetadataDir, "._reference.md");
const nestedFinderMetadataPath = path.join(userSkillMetadataDir, ".DS_Store");
await writeFile(nestedAppleDoublePath, Buffer.from([0x00, 0x81, 0xff]));
await writeFile(nestedFinderMetadataPath, Buffer.from([0x00, 0x81, 0xff]));
const appleDoubleSkillDir = path.join(dshHome, "skills", "._invalid-skill");
await mkdir(appleDoubleSkillDir, { recursive: true });
await writeFile(path.join(appleDoubleSkillDir, "SKILL.md"), Buffer.from([0x00, 0x81, 0xff]));
await writeFile(path.join(dshHome, "skills", ".DS_Store"), Buffer.from([0x00, 0x81, 0xff]));
const previousStatPilotDshHome = process.env.STAT_PILOT_DSH_HOME;
process.env.STAT_PILOT_DSH_HOME = dshHome;

const appRuntimeDir = path.join(verifyRoot, "runtime");
const manager = new DshRuntimeManager({ appRuntimeDir });
let client;
let mockProviderServer;
try {
  const shellResolutionRoot = path.join(verifyRoot, "powershell-resolution");
  const programFiles = path.join(shellResolutionRoot, "program-files");
  const systemRoot = path.join(shellResolutionRoot, "windows");
  const pathPwshDir = path.join(shellResolutionRoot, "path-pwsh");
  const pathPowerShellDir = path.join(shellResolutionRoot, "path-powershell");
  const programFilesPwsh = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  const pathPwsh = path.join(pathPwshDir, "pwsh.exe");
  const systemPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await Promise.all([
    mkdir(path.dirname(programFilesPwsh), { recursive: true }),
    mkdir(pathPwshDir, { recursive: true }),
    mkdir(path.dirname(systemPowerShell), { recursive: true }),
    mkdir(pathPowerShellDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(programFilesPwsh, "mock PowerShell 7 executable"),
    writeFile(pathPwsh, "mock PATH PowerShell 7 executable"),
    writeFile(systemPowerShell, "mock Windows PowerShell executable"),
    writeFile(path.join(pathPowerShellDir, "powershell.exe"), "mock PATH Windows PowerShell executable"),
  ]);
  const shellResolutionEnv = {
    ProgramFiles: programFiles,
    SystemRoot: systemRoot,
    PATH: [pathPowerShellDir, pathPwshDir].join(path.delimiter),
  };
  if (resolveWindowsDshTerminalShell(shellResolutionEnv) !== path.resolve(programFilesPwsh)) {
    throw new Error("Windows DSH 终端未优先选择 PowerShell 7 的标准安装位置");
  }
  await rm(programFilesPwsh);
  if (resolveWindowsDshTerminalShell(shellResolutionEnv) !== path.resolve(pathPwsh)) {
    throw new Error("Windows DSH 终端未从 PATH 解析 PowerShell 7");
  }
  await rm(pathPwsh);
  if (resolveWindowsDshTerminalShell(shellResolutionEnv) !== path.resolve(systemPowerShell)) {
    throw new Error("Windows DSH 终端未回退到系统 powershell.exe");
  }
  console.log("[verify-dsh] Windows DSH 终端 pwsh 优先与 powershell.exe 回退验证通过");

  const metadataSource = path.join(verifyRoot, "metadata-skill-source");
  const metadataDestination = path.join(verifyRoot, "metadata-skill-copy");
  const nestedMetadataDir = path.join(metadataSource, "references");
  await mkdir(nestedMetadataDir, { recursive: true });
  await writeFile(path.join(metadataSource, "SKILL.md"), "---\nname: metadata-copy-check\n---\n", "utf8");
  await writeFile(path.join(nestedMetadataDir, "._reference.md"), Buffer.from([0x00, 0x81, 0xff]));
  await writeFile(path.join(nestedMetadataDir, ".DS_Store"), Buffer.from([0x00, 0x81, 0xff]));
  await copySkillDirectoryWithoutPlatformMetadata(metadataSource, metadataDestination);
  if (!existsSync(path.join(metadataDestination, "SKILL.md"))
    || existsSync(path.join(metadataDestination, "references", "._reference.md"))
    || existsSync(path.join(metadataDestination, "references", ".DS_Store"))) {
    throw new Error("技能目录复制没有递归过滤 AppleDouble 或 .DS_Store 元数据");
  }
  console.log("[verify-dsh] 内嵌技能资源复制过滤平台元数据验证通过");

  const info = await manager.start({ dshBin: dshBinPath });
  if (!info.baseUrl) {
    throw new Error("DSH 未返回服务地址");
  }
  console.log(`[verify-dsh] DSH 启动服务验证通过: ${info.baseUrl}`);

  if (readFileSync(userInstructionsPath, "utf8") !== userInstructions) {
    throw new Error("应用启动覆盖了用户自己的 DSH AGENTS.md");
  }
  if (readFileSync(userSkillPath, "utf8") !== userSkill) {
    throw new Error("应用启动覆盖了同名的用户 DSH 技能");
  }
  if (existsSync(appleDoubleSkillDir)
    || existsSync(path.join(dshHome, "skills", ".DS_Store"))
    || existsSync(nestedAppleDoublePath)
    || existsSync(nestedFinderMetadataPath)) {
    throw new Error("DSH 技能同步没有清理 AppleDouble 或 .DS_Store 元数据");
  }
  console.log("[verify-dsh] 用户指令/同名技能保留与 AppleDouble 清理验证通过");

  const patchPath = path.join(appRuntimeDir, "shenxiaotong.patch.yml");
  if (!existsSync(patchPath)) {
    throw new Error("应用私有的 DSH 身份提示词未生成");
  }
  const patchContent = readFileSync(patchPath, "utf8");
  if (!patchContent.includes("深小统") || !patchContent.includes("includeHarnessIdentity: false")) {
    throw new Error("DSH patch.yml 缺少深小统身份提示词或 includeHarnessIdentity: false");
  }
  console.log("[verify-dsh] 深小统提示词与 patch 验证通过");

  client = new DshClient(info);
  await verifyLiveEventStreams(client);
  await verifyRemoteInteractionAdapter(client);

  const speechCatalog = await client.getSpeechCatalog();
  if (!speechCatalog?.providers?.some((provider) => provider.id === "sensevoice-local")) {
    throw new Error("DSH 未注册应用启用的本地 SenseVoice Provider");
  }
  console.log("[verify-dsh] DSH 本地语音 Provider 注册验证通过");

  const permissionCatalog = await client.getPermissionPresetCatalog();
  const permissionPresets = new Set((permissionCatalog?.defaultOptions || []).map((option) => option.value));
  for (const preset of ["danger-full-access", "workspace-write"]) {
    if (!permissionPresets.has(preset)) {
      throw new Error(`DSH 未提供应用使用的权限预设: ${preset}`);
    }
  }
  await client.mutateSettings({
    namespace: "permission",
    operations: [{ op: "set", path: ["defaultPreset"], value: "danger-full-access" }],
  });
  await client.mutateSettings({
    namespace: "permission",
    operations: [{ op: "set", path: ["defaultPreset"], value: "workspace-write" }],
  });
  console.log("[verify-dsh] DSH 权限预设验证通过");

  const credentials = await client.describeCredentials(["DEEPSEEK_API_KEY"]);
  if (!credentials || typeof credentials !== "object") {
    throw new Error("DSH Credentials 接口没有返回凭据状态");
  }
  const smokeCredentialRef = "STAT_PILOT_VERIFY_API_KEY";
  await client.setCredential(smokeCredentialRef, "stat-pilot-verification-not-a-real-api-key");
  const storedCredential = await client.describeCredentials([smokeCredentialRef]);
  if (!storedCredential?.[smokeCredentialRef]?.configured || !storedCredential[smokeCredentialRef]?.writable) {
    throw new Error("DSH 未能安全保存并识别应用迁移的 provider 凭据");
  }
  await client.unsetCredential(smokeCredentialRef);
  const clearedCredential = await client.describeCredentials([smokeCredentialRef]);
  if (clearedCredential?.[smokeCredentialRef]?.configured) {
    throw new Error("DSH 未能清除应用 provider 凭据");
  }
  console.log("[verify-dsh] DSH 凭据读取、保存与清除验证通过");

  const session = await client.createSession({ cwd: process.cwd() });
  if (!session?.sessionId) {
    throw new Error("DSH 创建会话失败");
  }
  console.log(`[verify-dsh] 会话创建成功: ${session.sessionId}`);

  const terminalShells = await client.request("terminal/shells", { agentId: session.sessionId });
  const defaultShellPath = terminalShells?.[0]?.path || "";
  if (!Array.isArray(terminalShells) || terminalShells.length === 0 || !defaultShellPath) {
    throw new Error("DSH 交互终端没有返回可用的默认 shell");
  }
  if (process.platform === "win32") {
    if (!/^(pwsh|powershell)(\.exe)?$/i.test(path.basename(defaultShellPath))) {
      throw new Error(`Windows DSH 交互终端默认 shell 不是 PowerShell: ${defaultShellPath || "未返回 shell"}`);
    }
  }
  console.log(`[verify-dsh] DSH 交互终端默认 shell 验证通过: ${path.basename(defaultShellPath)}`);

  const followSnapshotPromise = waitForClientEvent(client, "snapshot");
  client.followSession(session.sessionId);
  const followSnapshot = await followSnapshotPromise;
  if (String(followSnapshot?.header?.id) !== session.sessionId) {
    throw new Error("DSH 会话 WebSocket 没有返回目标会话快照");
  }
  const projections = await client.getProjections(session.sessionId);
  const page = await client.getPage({ sessionId: session.sessionId, throughSeq: projections?.asOfSeq ?? 0 });
  if (!Array.isArray(page?.records)) {
    throw new Error("DSH 会话投影或历史分页接口没有返回记录列表");
  }
  console.log("[verify-dsh] DSH 会话跟随流、投影与历史分页验证通过");

  await client.selectModel({
    sessionId: session.sessionId,
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
  });
  await client.selectModel({
    sessionId: session.sessionId,
    provider: "deepseek-official",
    model: "deepseek-flash",
  });
  console.log("[verify-dsh] DeepSeek V4.1 Flash 默认模型与 V4 Pro 兼容 ID 选择验证通过");

  const smokeProviderId = "stat-pilot-smoke";
  await client.mutateSettings({
    namespace: "llm-pi-ai",
    operations: [
      { op: "set", path: ["providers", smokeProviderId, "displayName"], value: "StatPilot CI provider" },
      { op: "set", path: ["providers", smokeProviderId, "api"], value: "openai-completions" },
      { op: "set", path: ["providers", smokeProviderId, "baseURL"], value: "https://example.invalid/v1" },
      { op: "set", path: ["providers", smokeProviderId, "models"], value: [{ id: "smoke-model" }] },
      { op: "set", path: ["providers", smokeProviderId, "apiKeyEnv"], value: "STAT_PILOT_SMOKE_API_KEY" },
    ],
  });
  await client.selectModel({
    sessionId: session.sessionId,
    provider: smokeProviderId,
    model: "smoke-model",
  });
  console.log("[verify-dsh] DSH 自定义 OpenAI 兼容 Provider 验证通过");

  const smokeApiKey = "stat-pilot-verification-api-key";
  const smokeApiKeyRef = "STAT_PILOT_SMOKE_API_KEY";
  await client.setCredential(smokeApiKeyRef, smokeApiKey);
  mockProviderServer = await startOpenAiSmokeServer(smokeApiKey);
  await client.mutateSettings({
    namespace: "llm-pi-ai",
    operations: [
      { op: "set", path: ["providers", smokeProviderId, "apiKeyEnv"], value: smokeApiKeyRef },
      { op: "set", path: ["providers", smokeProviderId, "baseURL"], value: mockProviderServer.baseURL },
    ],
  });
  await client.selectModel({ sessionId: session.sessionId, provider: smokeProviderId, model: "smoke-model" });
  let streamedText = "";
  const onTextDelta = ({ text }) => { streamedText += text; };
  client.on("textDelta", onTextDelta);
  const turnEndPromise = waitForClientEvent(client, "turnEnd", 20000);
  let promptResult;
  let turnEnd;
  try {
    [promptResult, turnEnd] = await Promise.all([
      client.sendPrompt({ sessionId: session.sessionId, text: "Return the local DSH smoke response." }),
      turnEndPromise,
    ]);
  } finally {
    client.off("textDelta", onTextDelta);
  }
  if (mockProviderServer.requestError) throw new Error(mockProviderServer.requestError);
  if (mockProviderServer.requestCount < 1 || !streamedText.includes("DSH end-to-end streaming verified.")) {
    throw new Error(`DSH 本机模型端到端回复缺失 (requests=${mockProviderServer.requestCount}, streamedText=${JSON.stringify(streamedText)}, prompt=${JSON.stringify(promptResult)}, turn=${JSON.stringify(turnEnd)})`);
  }
  const finalProjections = await client.getProjections(session.sessionId);
  const finalPage = await client.getPage({ sessionId: session.sessionId, throughSeq: finalProjections?.asOfSeq ?? 0 });
  const hasDurableUserMessage = finalPage?.records?.some((record) =>
    record.event?.type === "user/message"
    && record.event.data?.source?.kind === "user"
    && record.event.data?.content?.some((block) => block.type === "text" && block.text.includes("local DSH smoke response"))
  );
  const durableAssistantText = (finalPage?.records || [])
    .filter((record) => record.event?.type === "assistant/message")
    .flatMap((record) => record.event.data?.message?.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!hasDurableUserMessage || !durableAssistantText.includes("DSH end-to-end streaming verified.")) {
    throw new Error("DSH 会话历史没有持久化用户消息和助手回复");
  }
  console.log("[verify-dsh] DSH 用户消息、凭据路由与模型流式回复端到端验证通过");
  console.log("[verify-dsh] DSH 持久化会话历史用户/助手记录验证通过");

  const skills = await client.listSkills(session.sessionId);
  console.log(`[verify-dsh] 发现技能总数: ${skills.length}`);
  const expectedSkills = [
    "gov-official-document-drafting",
    "info-digest-html",
    "price-index-gdp-impact",
    "source-verification",
    "weekly-report",
  ];
  for (const expected of expectedSkills) {
    if (!skills.some((skill) => skill.name === expected)) {
      throw new Error(`未能在 DSH 中发现内置技能: ${expected}`);
    }
  }
  console.log("[verify-dsh] 全部 5 个内置技能发现验证通过:", expectedSkills.join(", "));

  const archiveResult = await client.archiveSession(session.sessionId);
  if (!archiveResult?.archivedSessionIds?.map(String).includes(session.sessionId)) {
    throw new Error("DSH 未确认测试会话已归档");
  }
  let archived = await client.listArchivedSessions();
  if (!archived.some((item) => String(item.id) === session.sessionId)) {
    throw new Error("DSH 归档 Bundle 未返回刚归档的测试会话");
  }

  const restoreResult = await client.unarchiveSession(session.sessionId);
  if (restoreResult?.archivedSessionIds?.map(String).includes(session.sessionId)) {
    throw new Error("DSH 未从归档列表移除已恢复的测试会话");
  }
  const sessions = await client.listSessions();
  if (!sessions.some((item) => String(item.sessionId) === session.sessionId)) {
    throw new Error("DSH 恢复后未在会话列表中找到测试会话");
  }

  const rearchiveResult = await client.archiveSession(session.sessionId);
  if (!rearchiveResult?.archivedSessionIds?.map(String).includes(session.sessionId)) {
    throw new Error("DSH 未确认测试会话再次归档");
  }
  const deletion = await client.permanentlyDeleteArchivedSession(session.sessionId);
  archived = await client.listArchivedSessions();
  if (archived.some((item) => String(item.id) === session.sessionId)) {
    throw new Error("彻底删除后测试会话仍出现在 DSH 归档列表中");
  }
  const deletionPending = deletion.pending?.map(String).includes(session.sessionId) || false;
  const deletionCompleted = deletion.deleted?.map(String).includes(session.sessionId) || false;
  if (deletionPending) {
    const pendingPath = path.join(dshHome, "plugin-data", "archived-chats", "pending-deletions.json");
    const pendingStore = JSON.parse(readFileSync(pendingPath, "utf8"));
    if (!pendingStore.ids?.map(String).includes(session.sessionId)) {
      throw new Error("延后删除没有把会话 ID 持久化到 DSH pending-deletions 存储");
    }
  } else {
    if (!deletionCompleted) {
      throw new Error("DSH 没有确认测试会话已完成彻底删除");
    }
    const remainingSessions = await client.listSessions();
    if (remainingSessions.some((item) => String(item.sessionId) === session.sessionId)) {
      throw new Error("DSH 确认删除后，会话仍存在于持久化 session/list 中");
    }
  }
  console.log(`[verify-dsh] 归档、恢复和彻底删除验证通过${deletionPending ? "（DSH 已持久化延后清理）" : "（session/list 已确认会话移除）"}`);
} finally {
  client?.dispose();
  if (mockProviderServer) {
    const server = mockProviderServer.server;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
  await manager.stop().catch((error) => {
    console.warn("[verify-dsh] DSH 停止时报告错误:", error);
  });
  if (previousStatPilotDshHome === undefined) delete process.env.STAT_PILOT_DSH_HOME;
  else process.env.STAT_PILOT_DSH_HOME = previousStatPilotDshHome;
  await rm(verifyRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

console.log("[verify-dsh] DSH 运行时验证与临时数据清理完成");
