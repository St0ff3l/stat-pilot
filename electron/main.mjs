import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync as fsSyncReadFile, promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const SETTINGS_FILE = "settings.json";
const RUNTIME_DIRNAME = "hermes-runtime";
const OFFICIAL_HERMES_DIRNAME = ".hermes";
const PORT_FLOOR = 9120;
const PORT_CEILING = 9199;
const ELECTRON_ONLY_LAUNCH_FLAG = "HERMES_ELECTRON_MANAGED";

function getBundledRuntimeRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ".runtime");
  }

  return path.resolve(process.cwd(), ".runtime");
}

function getBundledAppAssetRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }

  return path.resolve(process.cwd());
}

function getAppIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.png")
    : path.resolve(process.cwd(), "public/sz-logo.png");
}

function applyPlatformIcon() {
  const iconPath = getAppIconPath();

  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(iconPath);
    } catch (error) {
      console.warn("Unable to apply the macOS Dock icon:", error);
    }
  }

  return iconPath;
}

function getRuntimeRoot() {
  return path.join(app.getPath("userData"), RUNTIME_DIRNAME);
}

function getRuntimeInstallDir() {
  return path.join(getRuntimeRoot(), "hermes-agent");
}

function getRuntimeHomeDir() {
  return path.join(getRuntimeRoot(), "hermes-home");
}

function getRuntimeEnvironmentDir(installDir = getRuntimeInstallDir()) {
  const candidates = [path.join(installDir, ".venv"), path.join(installDir, "venv")];
  const pythonRelativePath = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  const entryPointRelativePath = process.platform === "win32" ? "Scripts/hermes.exe" : "bin/hermes";
  return (
    candidates.find(
      (candidate) =>
        existsSync(path.join(candidate, pythonRelativePath)) &&
        existsSync(path.join(candidate, entryPointRelativePath))
    ) ??
    candidates.find((candidate) => existsSync(candidate)) ??
    candidates[0]
  );
}

function getRuntimePythonPath(installDir = getRuntimeInstallDir()) {
  const environmentDir = getRuntimeEnvironmentDir(installDir);
  return path.join(
    environmentDir,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
  );
}

function getPortablePythonPath(installDir = getRuntimeInstallDir()) {
  const runtimeRoot = path.dirname(installDir);
  const metadataPath = path.join(runtimeRoot, "portable-python.json");

  try {
    const metadata = JSON.parse(fsSyncReadFile(metadataPath, "utf8"));
    const relativePath = toSafeString(metadata.pythonExecutable).trim();
    if (!relativePath) {
      return null;
    }

    const candidate = path.resolve(runtimeRoot, relativePath);
    const relativeCandidate = path.relative(runtimeRoot, candidate);
    if (
      path.isAbsolute(relativeCandidate) ||
      relativeCandidate.startsWith(`..${path.sep}`) ||
      !existsSync(candidate)
    ) {
      return null;
    }

    return candidate;
  } catch {
    return null;
  }
}

function getRuntimeEntryPointPath(installDir = getRuntimeInstallDir()) {
  const environmentDir = getRuntimeEnvironmentDir(installDir);
  return path.join(
    environmentDir,
    process.platform === "win32" ? "Scripts/hermes.exe" : "bin/hermes"
  );
}

function getRuntimeGuardPath(installDir = getRuntimeInstallDir()) {
  return path.join(installDir, process.platform === "win32" ? "hermes.cmd" : "hermes");
}

function getOfficialHermesHomeDir() {
  return path.join(app.getPath("home"), OFFICIAL_HERMES_DIRNAME);
}

function getDefaultHermesBinaryPath() {
  return process.platform === "win32"
    ? getRuntimeEntryPointPath()
    : getRuntimeGuardPath();
}

function getLegacyProjectRuntimeRoot() {
  return path.resolve(process.cwd(), ".runtime");
}

const FALLBACK_SOURCE_ATTRIBUTION_RULE =
  "所有抓取、汇总、报告和事实问答都必须标明具体来源；网页、本地文件、用户提供内容、当前对话和模型推断都要区分标注；无法核验时写‘来源：未提供/待核验’，严禁编造来源。";

async function loadSourceAttributionRule() {
  const appRoot = getBundledAppAssetRoot();
  const candidates = [
    path.resolve(appRoot, "rules/source_attribution.md"),
    path.resolve(app.getAppPath(), "rules/source_attribution.md"),
    path.resolve(process.cwd(), "rules/source_attribution.md"),
  ];

  for (const rulePath of candidates) {
    const content = await fs.readFile(rulePath, "utf8").catch(() => "");
    if (content.trim()) {
      return content.trim();
    }
  }

  return FALLBACK_SOURCE_ATTRIBUTION_RULE;
}

async function buildOutputInstructions(cwd, defaultOutputDir = "outputs") {
  const resolvedDir = path.isAbsolute(defaultOutputDir)
    ? defaultOutputDir
    : path.resolve(cwd, defaultOutputDir);
  const sourceAttributionRule = await loadSourceAttributionRule();

  return (
    `【深统政务 Scope 产品身份与回答规则】\n` +
    `你不是通用的 Hermes Agent 聊天机器人；你是“深统政务 Scope”，面向深圳市统计局的智能工作台，底层由 Hermes Agent 提供执行能力。你的首要职责是协助用户处理统计分析、政务信息整理、项目代码、数据检索、报告和文件生成任务。\n` +
    `当用户询问“你是谁”“你能做什么”或类似问题时，必须优先用中文介绍：你是深统政务 Scope（深圳市统计局智能工作台），可以协助处理统计与政务数据分析、信息汇总、报告生成、项目文件和代码任务；如有必要，再补充“底层执行引擎是 Hermes Agent”。不要直接输出“我是 Hermes Agent，由 Nous Research 创建的 AI 助手”作为主要身份介绍。\n` +
    `除非用户明确询问底层技术，否则不要把 Hermes Agent、Nous Research 或通用代理身份放在回答开头；回答应体现深统政务 Scope 的产品身份和深圳市统计局业务场景。\n` +
    `【TRAE Solo / Autonomous Agent 全自主执行规范】\n` +
    `1. 【对话上下文隔离与独立评估】：每一条新的用户消息默认都是独立请求。除非用户明确说“继续上文”“继续刚才的任务”“根据之前内容”或类似表达，否则只依据当前这条消息和当前已明确提供的内容回答；不要主动引用历史对话中的旧消息、旧问题、旧结论、旧项目状态或重复输入，不要因为历史记录推断用户当前意图。\n` +
    `2. 【自主闭环执行】：你是一个具备完全自主能力的 Agent（类似于 TRAE Solo / Codex / Antigravity）。面对用户的开发、分析、数据抓取与报告生成任务，你必须自主调用本地工具（文件读写、代码修改、终端执行、网络检索），一站式完成从需求分析、代码编写到真实验证的全流程，严禁中途停下询问用户许可。\n` +
    `3. 【根因排错与闭环验证】：若脚本执行或终端报错，必须主动读取错误 Log / 堆栈信息，分析根本原因并修补代码，重新运行直至完全成功。切勿吞掉报错，严禁在未验证成功前宣布完成。\n` +
    `4. 【文件产出与统一存储】：所有抓取的数据、生成的 HTML 仪表盘、分析周报、代码产物等，统一存入目标输出目录：${resolvedDir}。每次任务必须在该目录下按主题创建语义化子目录（如 统计局周报_20260806/）。\n` +
    `5. 【清爽回复与链接展示】：聊天界面严禁直接粘贴超长原始 JSON 或冗长数据原文。聊天框中只提供 150-200 字的精炼高管级结论，并附带指向产物目录/文件的 markdown 链接（例如：[打开输出文件](file://${resolvedDir}/子目录/文件名)）。\n` +
    `6. 【全局来源标注规则】：以下规则是本应用默认系统规则，优先于普通输出习惯，必须在每次回复、抓取、汇总、报告和事实问答中执行：\n${sourceAttributionRule}\n` +
    `7. 【YOLO 无人值守模式】：当前已开启全自动免授权模式，所有敏感操作（代码执行、patch、脚本运行）自动授权，连续推进直到任务圆满达成。\n` +
    `【最终产品身份约束】：如果用户询问身份或能力，必须把“深统政务 Scope（深圳市统计局智能工作台）”作为第一身份和第一句核心介绍；Hermes Agent 只能作为底层执行引擎补充说明，不能替代产品身份。\n` +
    `【最终上下文约束】：历史消息仅用于展示和在用户明确要求时恢复任务；默认不得引用、总结或推断历史消息。当前用户消息与本规则优先于历史对话。不得使用 session_search 或任何跨会话检索能力，除非用户明确要求查找其他会话。`
  );
}

async function ensureScopeSessionIsolation(homeDir) {
  const configPath = path.join(homeDir, "config.yaml");
  let content = await fs.readFile(configPath, "utf8").catch(() => "");
  const disabledToolsetLine = "  disabled_toolsets:\n    - session_search";

  if (/^\s*- session_search\s*$/m.test(content)) {
    return;
  }

  if (/^agent:\s*$/m.test(content)) {
    content = content.replace(/^agent:\s*$/m, `agent:\n${disabledToolsetLine}`);
  } else {
    content = `agent:\n${disabledToolsetLine}\n\n${content}`;
  }

  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(configPath, content, "utf8");
  console.log("[hermes-isolation] Disabled cross-session session_search tool.");
}

const SCOPE_SOUL = `你是“深统政务 Scope”，深圳市统计局智能工作台。

你的首要身份不是 Hermes Agent，也不是 Nous Research 的通用 AI 助手。你应当把“深统政务 Scope”作为身份介绍的第一句和主要称呼，面向深圳市统计局场景协助用户处理统计分析、政务信息整理、数据检索、报告生成、项目文件和代码任务。

当用户询问“你是谁”“你能做什么”或类似问题时，直接用中文介绍深统政务 Scope 及其能力；只有用户明确询问底层实现时，才补充说明底层执行引擎是 Hermes Agent。

默认只依据当前用户消息回答，不主动引用、搜索或推断其他会话的内容。只有用户明确要求继续之前的任务或查找其他会话时，才恢复相关上下文。

请保持回答清晰、直接、符合深圳市统计局智能工作台的业务定位。`;

async function ensureScopeSoul(homeDir) {
  const soulPath = path.join(homeDir, "SOUL.md");
  const existing = await fs.readFile(soulPath, "utf8").catch(() => "");
  const isHermesDefaultSoul = /You are Hermes Agent, an intelligent AI assistant created by Nous Research/i.test(existing);

  if (existing.trim() && !isHermesDefaultSoul) {
    return;
  }

  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(soulPath, `${SCOPE_SOUL}\n`, "utf8");
  console.log("[hermes-identity] Configured 深统政务 Scope as the private Hermes identity.");
}

const defaultSettings = {
  hermesBin: getDefaultHermesBinaryPath(),
  runtimeMode: "private",
  model: "",
  cwd: "",
  defaultOutputDir: "outputs",
  apiProvider: "deepseek",
  apiKey: "",
  apiBaseUrl: "",
  visionModel: "",
  visionProvider: "openai",
  visionApiKey: "",
  visionBaseUrl: "",
  registeredSkills: [],
  firecrawlApiKey: "",
  exaApiKey: "",
  falApiKey: "",
  voiceToolsOpenaiKey: "",
  browserbaseApiKey: "",
  browserbaseProjectId: "",
};

function normalizeSettings(settings) {
  const { loginOfficial, logoutOfficial, ...input } = settings ?? {};
  const legacyBin = typeof input.codexBin === "string" ? input.codexBin : undefined;
  const defaultCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";

  let registeredSkills = Array.isArray(input.registeredSkills) ? [...input.registeredSkills] : [];
  registeredSkills = registeredSkills.filter((s) => s && s.name && !["gov_digest", "policy_classifier", "stats_gov_scraper"].includes(s.name));
  const existingSkillNames = new Set(registeredSkills.map((s) => s?.name));

  const appRoot = getBundledAppAssetRoot();
  const defaultSkillsList = [
    {
      name: "info_digest_html",
      description: "统计与政务动态 HTML 参阅报表与交互仪表盘生成器",
      path: path.resolve(appRoot, "skills/info_digest_html/SKILL.md"),
    },
    {
      name: "weekly_report",
      description: "统计信息化动态采集与周报 HTML 生成器",
      path: path.resolve(appRoot, "skills/weekly_report/SKILL.md"),
    },
  ];

  // Update path for default skills in registeredSkills to always point to appRoot skills
  registeredSkills = registeredSkills.map((s) => {
    if (s && (s.name === "info_digest_html" || s.name === "weekly_report")) {
      return {
        ...s,
        path: path.resolve(appRoot, `skills/${s.name}/SKILL.md`),
      };
    }
    return s;
  });

  for (const ds of defaultSkillsList) {
    if (!existingSkillNames.has(ds.name)) {
      registeredSkills.push(ds);
    }
  }

  return {
    ...defaultSettings,
    ...input,
    hermesBin: getDefaultHermesBinaryPath(),
    runtimeMode: input.runtimeMode === "official" ? "official" : "private",
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : defaultSettings.model,
    cwd: defaultCwd,
    defaultOutputDir: typeof input.defaultOutputDir === "string" ? input.defaultOutputDir : defaultSettings.defaultOutputDir,
    apiProvider:
      typeof input.apiProvider === "string" ? input.apiProvider : defaultSettings.apiProvider,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : defaultSettings.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === "string" ? input.apiBaseUrl : defaultSettings.apiBaseUrl,
    visionModel: typeof input.visionModel === "string" ? input.visionModel : defaultSettings.visionModel,
    visionProvider: typeof input.visionProvider === "string" ? input.visionProvider : defaultSettings.visionProvider,
    visionApiKey: typeof input.visionApiKey === "string" ? input.visionApiKey : defaultSettings.visionApiKey,
    visionBaseUrl: typeof input.visionBaseUrl === "string" ? input.visionBaseUrl : defaultSettings.visionBaseUrl,
    registeredSkills,
    firecrawlApiKey: typeof input.firecrawlApiKey === "string" ? input.firecrawlApiKey : defaultSettings.firecrawlApiKey,
    exaApiKey: typeof input.exaApiKey === "string" ? input.exaApiKey : defaultSettings.exaApiKey,
    falApiKey: typeof input.falApiKey === "string" ? input.falApiKey : defaultSettings.falApiKey,
    voiceToolsOpenaiKey: typeof input.voiceToolsOpenaiKey === "string" ? input.voiceToolsOpenaiKey : defaultSettings.voiceToolsOpenaiKey,
    browserbaseApiKey: typeof input.browserbaseApiKey === "string" ? input.browserbaseApiKey : defaultSettings.browserbaseApiKey,
    browserbaseProjectId: typeof input.browserbaseProjectId === "string" ? input.browserbaseProjectId : defaultSettings.browserbaseProjectId,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeString(value) {
  return typeof value === "string" ? value : "";
}

async function syncRegisteredSkills(settings) {
  try {
    const isOfficialMode = settings.runtimeMode === "official";
    const hermesHome = isOfficialMode ? getOfficialHermesHomeDir() : getRuntimeHomeDir();
    const skillsDir = path.join(hermesHome, "skills");

    // Ensure skills folder exists
    await fs.mkdir(skillsDir, { recursive: true });

    // 1. Find all existing entries in skillsDir
    const entries = await fs.readdir(skillsDir);
    const registered = settings.registeredSkills || [];
    const registeredNames = new Set(registered.map(s => s.name));

    // 2. Remove any symlinks that are not in currently registered skills
    for (const entry of entries) {
      const entryPath = path.join(skillsDir, entry);
      try {
        const stat = await fs.lstat(entryPath);
        if (stat.isSymbolicLink()) {
          if (!registeredNames.has(entry)) {
            await fs.unlink(entryPath);
          }
        }
      } catch (err) {
        console.error(`Failed to inspect/remove skill entry ${entry}:`, err);
      }
    }

    // 3. Create or update symlinks for registered skills
    for (const skill of registered) {
      if (!skill.path) continue;
      const skillFolder = path.dirname(skill.path);
      const targetPath = path.join(skillsDir, skill.name);

      // Check if skill folder exists
      if (!(await pathExists(skillFolder))) {
        console.warn(`Skill folder ${skillFolder} does not exist, skipping sync.`);
        continue;
      }

      try {
        // Hermes expects UTF-8, but Windows skills are often saved as GBK.
        // Materialize a normalized copy so discovery cannot crash on decoding.
        await fs.rm(targetPath, { recursive: true, force: true });
        await copySkillFolderAsUtf8(skillFolder, targetPath);
        console.log(`Copied and normalized skill ${skill.name} -> ${targetPath}`);
      } catch (copyError) {
        console.error(`Failed to copy and normalize skill ${skill.name}:`, copyError);
      }
    }
  } catch (err) {
    console.error("Failed to sync registered skills:", err);
  }
}

const TEXT_SKILL_EXTENSIONS = new Set([
  ".cjs", ".css", ".csv", ".html", ".ini", ".js", ".json", ".md", ".py",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function decodeSkillText(buffer, filePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch (error) {
      throw new Error(`无法读取技能文件 ${filePath}：文件不是 UTF-8 或 GB18030 编码。`, { cause: error });
    }
  }
}

function shouldNormalizeSkillFile(filePath) {
  return TEXT_SKILL_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
    path.basename(filePath).toLowerCase() === "skill.md";
}

async function copySkillFolderAsUtf8(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySkillFolderAsUtf8(sourcePath, targetPath);
    } else if (entry.isFile()) {
      const buffer = await fs.readFile(sourcePath);
      if (shouldNormalizeSkillFile(sourcePath)) {
        await fs.writeFile(targetPath, decodeSkillText(buffer, sourcePath), "utf8");
      } else {
        await fs.writeFile(targetPath, buffer);
      }
    }
  }
}

let threadCwdMap = {};

function getThreadCwdsPath() {
  return path.join(app.getPath("userData"), "thread_cwds.json");
}

async function loadThreadCwds() {
  try {
    const raw = await fs.readFile(getThreadCwdsPath(), "utf8");
    threadCwdMap = JSON.parse(raw) || {};
  } catch {
    threadCwdMap = {};
  }
}

async function saveThreadCwd(threadId, cwd) {
  if (!threadId) return;
  const safeCwd = toSafeString(cwd).trim();
  if (!safeCwd) return;
  threadCwdMap[threadId] = safeCwd;
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(getThreadCwdsPath(), JSON.stringify(threadCwdMap, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save thread cwd mapping:", err);
  }
}

function getThreadCwd(threadId) {
  if (!threadId) return "";
  return threadCwdMap[threadId] || "";
}

function mapStoredSession(session, settings) {
  const timestamp = Number(session?.started_at ?? 0);
  const modelProvider = settings.runtimeMode === "official" ? "nous/free" : settings.apiProvider;
  const sessionId = String(session?.id ?? "");
  const sessionCwd = toSafeString(session?.cwd || session?.workdir || session?.path || getThreadCwd(sessionId)).trim();
  return {
    id: sessionId,
    name: toSafeString(session?.title) || null,
    preview: toSafeString(session?.preview),
    modelProvider,
    status: "idle",
    updatedAt: timestamp,
    createdAt: timestamp,
    cwd: sessionCwd,
  };
}

function mapGatewayMessages(messages) {
  return (messages ?? [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({
      id: randomUUID(),
      role: message.role,
      text: toSafeString(message.text),
      reasoning: toSafeString(message.reasoning || message.reasoning_content || message.payload?.reasoning).trim() || null,
      turnId: null,
    }));
}

function isOfficialSessionModelStale(model) {
  if (state.settings.runtimeMode !== "official") {
    return false;
  }

  const activeModel = toSafeString(model).trim();
  const expectedModel = toSafeString(state.official.defaultModel).trim();
  return Boolean(activeModel && expectedModel && activeModel !== expectedModel);
}

async function scanDirectoryFiles(dirPath, maxDepth = 4, currentDepth = 1) {
  if (currentDepth > maxDepth) return [];
  try {
    const list = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        list.push(entryPath);
      } else if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".runtime" ||
          entry.name === "dist" ||
          entry.name === "dist-server" ||
          entry.name === "release"
        ) {
          continue;
        }
        try {
          const subFiles = await scanDirectoryFiles(entryPath, maxDepth, currentDepth + 1);
          list.push(...subFiles);
        } catch {}
      }
    }
    return list;
  } catch {
    return [];
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const RETRYABLE_FILESYSTEM_ERRORS = new Set([
  "EACCES",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

function isRetryableFilesystemError(error) {
  return RETRYABLE_FILESYSTEM_ERRORS.has(error?.code);
}

async function removePathWithRetries(targetPath, label = "path") {
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 0,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFilesystemError(error) || attempt === 7) {
        throw error;
      }

      // Windows Defender, the indexer, and Python child processes can briefly
      // keep a runtime directory busy after the process has been terminated.
      await sleep(Math.min(250 * 2 ** attempt, 2000));
    }
  }

  if (lastError) {
    throw lastError;
  }

  console.warn(`Unable to remove ${label}: ${targetPath}`);
}

async function movePathWithRetries(sourcePath, targetPath, label = "path") {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isRetryableFilesystemError(error) || attempt === 7) {
        throw error;
      }

      console.warn(`Waiting to move ${label} on retry ${attempt + 1}:`, error.message);
      await sleep(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}

async function replaceBundledRuntime(sourceRoot, runtimeRoot) {
  const stagingRoot = `${runtimeRoot}.installing-${randomUUID()}`;
  const backupRoot = `${runtimeRoot}.previous-${randomUUID()}`;
  let existingRuntimeMoved = false;

  try {
    await removePathWithRetries(stagingRoot, "stale Hermes runtime staging directory");
    await fs.cp(sourceRoot, stagingRoot, {
      recursive: true,
      dereference: true,
      force: true,
      errorOnExist: false,
      filter: (source) => {
        const relative = path.relative(sourceRoot, source).split(path.sep).join("/");
        if (relative === "hermes-home" || relative.startsWith("hermes-home/")) {
          return false;
        }

        return !relative.includes("node_modules/electron/dist/Electron.app");
      },
    });

    // A repair refreshes only the executable runtime. Keep the user's Hermes
    // home (sessions, auth/config, and local state) across the replacement.
    const existingHomeDir = path.join(runtimeRoot, "hermes-home");
    const stagedHomeDir = path.join(stagingRoot, "hermes-home");
    if (await pathExists(existingHomeDir)) {
      await fs.cp(existingHomeDir, stagedHomeDir, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
    }

    const stagedInstallDir = path.join(stagingRoot, "hermes-agent");
    if (
      !(await pathExists(getRuntimePythonPath(stagedInstallDir))) ||
      !(await pathExists(getRuntimeEntryPointPath(stagedInstallDir)))
    ) {
      throw new Error(`Bundled Hermes runtime is incomplete: ${sourceRoot}`);
    }

    if (await pathExists(runtimeRoot)) {
      await movePathWithRetries(runtimeRoot, backupRoot, "the existing Hermes runtime");
      existingRuntimeMoved = true;
    }

    await movePathWithRetries(stagingRoot, runtimeRoot, "the new Hermes runtime");

    if (existingRuntimeMoved) {
      try {
        await removePathWithRetries(backupRoot, "the previous Hermes runtime");
      } catch (error) {
        // The new runtime is already active. Keeping a stale backup is safer
        // than making a successful repair look like a failed installation.
        console.warn("Unable to clean up the previous Hermes runtime:", error);
      }
    }
  } catch (error) {
    try {
      await removePathWithRetries(stagingRoot, "failed Hermes runtime staging directory");
    } catch (cleanupError) {
      console.warn("Unable to clean up failed Hermes runtime staging:", cleanupError);
    }

    if (existingRuntimeMoved && !(await pathExists(runtimeRoot)) && (await pathExists(backupRoot))) {
      try {
        await movePathWithRetries(backupRoot, runtimeRoot, "the previous Hermes runtime backup");
      } catch (restoreError) {
        console.error("Unable to restore the previous Hermes runtime:", restoreError);
      }
    }

    throw error;
  }
}

async function repairPortablePythonRuntime(runtimeRoot) {
  const metadataPath = path.join(runtimeRoot, "portable-python.json");
  const metadataText = await readTextIfExists(metadataPath);
  if (!metadataText) {
    return;
  }

  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    console.warn(`Ignoring malformed portable Python metadata: ${metadataPath}`);
    return;
  }

  const pythonHomeRelative = toSafeString(metadata.pythonHome).trim();
  if (!pythonHomeRelative) {
    return;
  }

  const pythonHome = path.resolve(runtimeRoot, pythonHomeRelative);
  if (!(await pathExists(pythonHome))) {
    console.warn(`Portable Python home is missing from Hermes runtime: ${pythonHome}`);
    return;
  }

  for (const environmentName of [".venv", "venv"]) {
    const environmentDir = path.join(getRuntimeInstallDir(), environmentName);
    const configPath = path.join(environmentDir, "pyvenv.cfg");
    if (!(await pathExists(configPath))) {
      continue;
    }

    const content = await fs.readFile(configPath, "utf8");
    const homeLine = `home = ${pythonHome}`;
    const updated = /^home\s*=.*$/m.test(content)
      ? content.replace(/^home\s*=.*$/m, homeLine)
      : `${homeLine}\n${content}`;
    if (updated !== content) {
      await fs.writeFile(configPath, updated, "utf8");
    }
  }
}

async function readTextIfExists(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

function buildRuntimeInfo(installed) {
  const runtimeRoot = getRuntimeRoot();
  const bundledRoot = getBundledRuntimeRoot();

  return {
    installed,
    uninstalling: false,
    rootDir: runtimeRoot,
    installDir: getRuntimeInstallDir(),
    homeDir: getRuntimeHomeDir(),
    bundledSourceDir: bundledRoot,
    bundledWithApp: true,
  };
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) {
      return null;
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function inspectOfficialHermesConfig() {
  const homeDir = getOfficialHermesHomeDir();
  const configPath = path.join(homeDir, "config.yaml");
  const authPath = path.join(homeDir, "auth.json");
  const nousRecommendedPath = path.join(homeDir, "cache", "nous_recommended_cache.json");
  const [configExists, authExists, configText, authText] = await Promise.all([
    pathExists(configPath),
    pathExists(authPath),
    readTextIfExists(configPath),
    readTextIfExists(authPath),
  ]);

  let provider = "nous";
  let defaultModel = "stepfun/step-3.7-flash:free";
  if (configText) {
    const modelBlock = configText.match(/(^|\n)model:\n([\s\S]*?)(\n[^\s]|\n$)/);
    const block = modelBlock?.[2] ?? "";
    provider = (block.match(/^\s+provider:\s*(.+)$/m)?.[1] ?? provider).trim();
    defaultModel = (block.match(/^\s+default:\s*(.+)$/m)?.[1] ?? defaultModel).trim();
  }

  let isLoggedIn = false;
  let subscriptionLabel = "Unknown";
  let rateLimitSource = "";
  if (authText) {
    try {
      const auth = JSON.parse(authText);
      const nous = auth?.providers?.nous;
      if (nous?.access_token || nous?.agent_key) {
        isLoggedIn = true;
        const payload = decodeJwtPayload(nous.access_token || nous.agent_key);
        rateLimitSource = String(payload?.rate_limit_source ?? "");
        if (payload?.paid_access === false || rateLimitSource.includes("free")) {
          subscriptionLabel = "Free";
        } else if (payload?.paid_access === true) {
          subscriptionLabel = "Paid";
        }
      }
    } catch {
      // ignore malformed auth state
    }
  }

  let freeRecommendedModels = [];
  let paidRecommendedModels = [];
  try {
    const recommendedText = await readTextIfExists(nousRecommendedPath);
    if (recommendedText) {
      const payload = JSON.parse(recommendedText);
      const firstEntry = Object.values(payload ?? {})[0];
      const data = firstEntry?.data ?? {};
      freeRecommendedModels = (data.freeRecommendedModels ?? [])
        .map((entry) => toSafeString(entry?.modelName).trim())
        .filter(Boolean);
      paidRecommendedModels = (data.paidRecommendedModels ?? [])
        .map((entry) => toSafeString(entry?.modelName).trim())
        .filter(Boolean);
    }
  } catch {
    // ignore malformed recommended cache
  }

  const availableModels = Array.from(
    new Set(
      (subscriptionLabel === "Free"
        ? freeRecommendedModels
        : [...paidRecommendedModels, ...freeRecommendedModels]
      ).filter(Boolean)
    )
  );

  return {
    available: configExists || authExists,
    homeDir,
    configPath,
    authPath,
    provider,
    defaultModel,
    isLoggedIn,
    subscriptionLabel,
    rateLimitSource,
    availableModels,
    freeRecommendedModels,
    paidRecommendedModels,
    userCode: (typeof state !== "undefined" && state?.official?.userCode) || null,
  };
}

async function updateOfficialHermesDefaultModel(nextModel) {
  const model = toSafeString(nextModel).trim();
  if (!model) {
    return;
  }

  const homeDir = getOfficialHermesHomeDir();
  const configPath = path.join(homeDir, "config.yaml");
  const existing = (await readTextIfExists(configPath)) ?? "";

  let nextConfig = existing;
  if (/(^|\n)model:\n([\s\S]*?)(\n[^\s]|\n$)/.test(existing)) {
    nextConfig = existing.replace(
      /((^|\n)model:\n[\s\S]*?^\s+default:\s*)(.+)$/m,
      `$1${model}`
    );
  } else {
    nextConfig = `model:\n  provider: nous\n  base_url: https://inference-api.nousresearch.com/v1\n  default: ${model}\n\n${existing}`;
  }

  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(configPath, nextConfig, "utf8");
}

function pickOfficialFallbackModel(officialState) {
  if (officialState.subscriptionLabel !== "Free") {
    return null;
  }

  const configuredModel = toSafeString(officialState.defaultModel).trim();
  const freeModels = (officialState.freeRecommendedModels ?? []).filter(Boolean);
  if (freeModels.length === 0 || freeModels.includes(configuredModel)) {
    return null;
  }

  return freeModels[0];
}

async function reconcileOfficialModeSettings(settings, officialState) {
  let nextSettings = normalizeSettings(settings);
  let nextOfficial = officialState;
  let changed = false;
  let autoSwitchedModel = null;

  if (nextSettings.runtimeMode !== "official") {
    return { settings: nextSettings, official: nextOfficial, changed, autoSwitchedModel };
  }

  const fallbackModel = pickOfficialFallbackModel(nextOfficial);
  if (fallbackModel) {
    await updateOfficialHermesDefaultModel(fallbackModel);
    nextOfficial = await inspectOfficialHermesConfig();
    changed = true;
    autoSwitchedModel = nextOfficial.defaultModel;
  }

  if (nextSettings.model !== nextOfficial.defaultModel) {
    nextSettings = normalizeSettings({
      ...nextSettings,
      model: nextOfficial.defaultModel,
    });
    changed = true;
  }

  return { settings: nextSettings, official: nextOfficial, changed, autoSwitchedModel };
}

async function updateLegacyHermesWrapper(runtimeBin) {
  if (process.platform === "win32") {
    return;
  }

  const wrapperPath = path.join(app.getPath("home"), ".local", "bin", "hermes");
  const wrapperDir = path.dirname(wrapperPath);
  const desired = [
    "#!/usr/bin/env bash",
    `if [ "\${${ELECTRON_ONLY_LAUNCH_FLAG}:-}" != "1" ]; then`,
    "  echo \"This Hermes runtime can only be started by the Electron app.\" >&2",
    "  exit 1",
    "fi",
    "unset PYTHONPATH",
    "unset PYTHONHOME",
    `exec "${runtimeBin}" "$@"`,
    "",
  ].join("\n");

  await fs.mkdir(wrapperDir, { recursive: true });
  await fs.writeFile(wrapperPath, desired, { mode: 0o755 });
}

async function cleanupHermesWrapper(extraTargets = []) {
  if (process.platform === "win32") {
    return;
  }

  const wrapperPath = path.join(app.getPath("home"), ".local", "bin", "hermes");
  const content = await readTextIfExists(wrapperPath);
  if (!content) {
    return;
  }

  const knownTargets = [
    getRuntimeRoot(),
    getBundledRuntimeRoot(),
    getLegacyProjectRuntimeRoot(),
    ...extraTargets,
  ]
    .filter(Boolean)
    .map((value) => path.resolve(String(value)));

  const shouldRemove = knownTargets.some((target) => content.includes(target));
  if (!shouldRemove) {
    return;
  }

  await removePathWithRetries(wrapperPath, "the legacy Hermes wrapper");
}

async function removeAppleDoubleFiles(rootDir) {
  let removed = 0;
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.name.startsWith("._")) {
        if (entry.isFile() || entry.isSymbolicLink()) {
          await fs.unlink(entryPath).catch(() => {});
          removed += 1;
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(rootDir);
  if (removed > 0) {
    console.log(`Removed ${removed} AppleDouble metadata files from ${rootDir}`);
  }
}

async function ensureEmbeddedRuntimeInstalled({ force = false } = {}) {
  const installDir = getRuntimeInstallDir();
  const runtimeRoot = getRuntimeRoot();
  const runtimePython = getRuntimePythonPath(installDir);
  const runtimeEntryPoint = getRuntimeEntryPointPath(installDir);
  const runtimeGuard = getRuntimeGuardPath(installDir);
  const sourceRoot = getBundledRuntimeRoot();

  const installed =
    (await pathExists(runtimePython)) &&
    (await pathExists(runtimeEntryPoint));

  if (!installed || force) {
    const sourceExists = await pathExists(sourceRoot);
    if (!sourceExists) {
      throw new Error(
        `Bundled Hermes runtime source not found: ${sourceRoot}. Please run npm run hermes:bootstrap first.`
      );
    }

    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await replaceBundledRuntime(sourceRoot, runtimeRoot);
  }

  // The bundled runtime is copied to userData on first launch. Rewrite the
  // venv metadata to that new location so Python does not keep the CI
  // runner's absolute interpreter path.
  await repairPortablePythonRuntime(runtimeRoot);
  await removeAppleDoubleFiles(runtimeRoot);

  await fs.mkdir(getRuntimeHomeDir(), { recursive: true });
  if (process.platform !== "win32") {
    await lockRuntimeToElectron(runtimeGuard);
    await updateLegacyHermesWrapper(runtimeGuard);
  }

  return buildRuntimeInfo(true);
}

async function uninstallEmbeddedRuntime() {
  const runtimeRoot = getRuntimeRoot();
  const runtimeInstallDir = path.join(runtimeRoot, "hermes-agent");
  await cleanupHermesWrapper([
    getRuntimeEntryPointPath(runtimeInstallDir),
    getRuntimeGuardPath(runtimeInstallDir),
  ]);
  await removePathWithRetries(runtimeRoot, "the Hermes runtime");
  return buildRuntimeInfo(false);
}

async function lockRuntimeToElectron(runtimeBin) {
  if (process.platform === "win32") {
    return;
  }

  const guardedLauncher = [
    "#!/usr/bin/env python3",
    "import os",
    "import sys",
    "",
    `if os.environ.get(${JSON.stringify(ELECTRON_ONLY_LAUNCH_FLAG)}) != \"1\":`,
    "    sys.stderr.write(\"This Hermes runtime can only be started by the Electron app.\\n\")",
    "    raise SystemExit(1)",
    "",
    "if __name__ == \"__main__\":",
    "    from hermes_cli.main import main",
    "    main()",
    "",
  ].join("\n");

  await fs.writeFile(runtimeBin, guardedLauncher, { mode: 0o755 });
}

function buildHermesEnv(settings, launchConfig = null, sessionToken = "") {
  const env = { ...process.env };
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  // Keep Python, WSL-backed helpers, and other POSIX subprocesses on the same
  // UTF-8 locale. Without this, Windows can return localized UTF-16/ACP error
  // text through a UTF-8 pipe, producing replacement characters such as
  // `w�s�l�` in the conversation.
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  const provider = toSafeString(settings.apiProvider).trim() || "deepseek";
  const isOfficialMode = settings.runtimeMode === "official";

  env.HERMES_HOME = isOfficialMode ? getOfficialHermesHomeDir() : getRuntimeHomeDir();
  env.HERMES_DESKTOP = "1";
  env[ELECTRON_ONLY_LAUNCH_FLAG] = "1";
  if (sessionToken) {
    env.HERMES_DASHBOARD_SESSION_TOKEN = sessionToken;
  }
  if (!isOfficialMode) {
    // Hermes freezes YOLO mode when the backend process imports its approval
    // module. The session.create `yolo` parameter is not honored by the
    // current gateway, so this must be set before spawning the process.
    env.HERMES_YOLO_MODE = "1";
    env.HERMES_EXEC_ASK = "0";
    env.HERMES_MODEL = toSafeString(settings.model).trim() || defaultSettings.model;
    env.HERMES_INFERENCE_MODEL = env.HERMES_MODEL;
    env.HERMES_TUI_PROVIDER = provider;
    env.HERMES_INFERENCE_PROVIDER = provider;

    if (settings.apiKey) {
      if (provider === "openrouter") {
        env.OPENROUTER_API_KEY = settings.apiKey;
      } else if (provider === "deepseek") {
        env.DEEPSEEK_API_KEY = settings.apiKey;
      } else {
        env.OPENAI_API_KEY = settings.apiKey;
      }
    }

    if (settings.apiBaseUrl) {
      env.HERMES_BASE_URL = settings.apiBaseUrl;
      env.OPENAI_BASE_URL = settings.apiBaseUrl;
      env.OPENAI_API_BASE = settings.apiBaseUrl;
    }
  }

  // Vision model configuration
  if (settings.visionModel) {
    const vModel = toSafeString(settings.visionModel).trim();
    const vProvider = toSafeString(settings.visionProvider).trim() || "openai";

    env.HERMES_VISION_MODEL = vModel;
    env.VISION_MODEL = vModel;
    env.BROWSER_VISION_MODEL = vModel;

    env.HERMES_VISION_PROVIDER = vProvider;
    env.VISION_PROVIDER = vProvider;

    if (settings.visionApiKey) {
      env.HERMES_VISION_API_KEY = settings.visionApiKey;
      env.VISION_API_KEY = settings.visionApiKey;
      env.BROWSER_VISION_API_KEY = settings.visionApiKey;
    }

    if (settings.visionBaseUrl) {
      env.HERMES_VISION_BASE_URL = settings.visionBaseUrl;
      env.VISION_BASE_URL = settings.visionBaseUrl;
      env.BROWSER_VISION_BASE_URL = settings.visionBaseUrl;
    }
  }

  // Tool API keys
  if (settings.firecrawlApiKey) {
    env.FIRECRAWL_API_KEY = settings.firecrawlApiKey;
  }
  if (settings.exaApiKey) {
    env.EXA_API_KEY = settings.exaApiKey;
  }
  if (settings.falApiKey) {
    env.FAL_KEY = settings.falApiKey;
  }
  if (settings.voiceToolsOpenaiKey) {
    env.VOICE_TOOLS_OPENAI_KEY = settings.voiceToolsOpenaiKey;
  }
  if (settings.browserbaseApiKey) {
    env.BROWSERBASE_API_KEY = settings.browserbaseApiKey;
  }
  if (settings.browserbaseProjectId) {
    env.BROWSERBASE_PROJECT_ID = settings.browserbaseProjectId;
  }

  if (launchConfig?.pythonPath) {
    env.PYTHONPATH = [launchConfig.pythonPath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }

  if (launchConfig?.webDist) {
    env.HERMES_WEB_DIST = launchConfig.webDist;
  }

  return env;
}

function resolveBackendLaunch() {
  const installDir = getRuntimeInstallDir();
  const environmentDir = getRuntimeEnvironmentDir(installDir);
  const venvPython = getRuntimePythonPath(installDir);
  // On Windows, uv may generate the venv's python.exe as a trampoline. That
  // trampoline can retain the build-machine interpreter path after the app is
  // copied to a user's profile. Launch the portable interpreter directly and
  // expose Hermes plus the venv packages through PYTHONPATH instead.
  const command = process.platform === "win32"
    ? getPortablePythonPath(installDir) || venvPython
    : venvPython;
  const pythonPath = [
    installDir,
    path.join(environmentDir, "Lib", "site-packages"),
  ].join(path.delimiter);
  const webDist = path.join(installDir, "hermes_cli", "web_dist");

  return {
    command,
    argsPrefix: ["-m", "hermes_cli.main"],
    pythonPath,
    webDist,
    installDir,
  };
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort() {
  for (let port = PORT_FLOOR; port <= PORT_CEILING; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No free localhost port in ${PORT_FLOOR}-${PORT_CEILING}`);
}

async function waitForBackend(baseUrl, token, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/status`, {
        headers: {
          "X-Hermes-Session-Token": token,
        },
      });

      if (response.ok) {
        return;
      }

      lastError = new Error(`Backend returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(300);
  }

  throw new Error(
    `Hermes backend did not become ready: ${
      lastError instanceof Error ? lastError.message : "timeout"
    }`
  );
}

async function terminateProcessTree(proc, label = "child-process") {
  if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  const pid = proc.pid;
  if (!pid) {
    return;
  }

  const waitForExit = new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });

  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise((resolve) => killer.once("exit", () => resolve()));
      // taskkill can report success before the child has fully released its
      // Python DLLs and site-packages handles. Give Node a bounded wait before
      // a runtime replacement starts deleting those files.
      await Promise.race([waitForExit, sleep(3000)]);
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }

      const exited = await Promise.race([
        waitForExit.then(() => true),
        sleep(2500).then(() => false),
      ]);

      if (!exited) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        await Promise.race([waitForExit, sleep(1000)]);
      }
    }
  } catch (error) {
    console.error(`[${label}:terminate-error]`, error);
  }
}

class GatewayRpcClient {
  constructor() {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.readyPromise = null;
    this.closing = false;
  }

  async connect(wsUrl) {
    await this.dispose();
    this.closing = false;
    console.log("[hermes-gateway] connecting", wsUrl);

    this.readyPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;

      let ready = false;

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          console.error("[hermes-gateway:parse-error]", event.data, error);
          return;
        }

        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          console.log("[hermes-gateway:response]", message.id, message.error ? "error" : "ok");
          const pending = this.pending.get(message.id);
          if (!pending) {
            return;
          }

          this.pending.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message ?? "Hermes gateway error."));
            return;
          }

          pending.resolve(message.result);
          return;
        }

        if (message.method === "event") {
          const params = message.params ?? {};
          console.log("[hermes-gateway:event]", params.type, params.session_id ?? "");

          if (params.type === "gateway.ready" && !ready) {
            ready = true;
            resolve(params.payload ?? {});
          }

          for (const listener of this.notificationListeners) {
            listener(params);
          }
        }
      });

      socket.addEventListener("error", () => {
        console.error("[hermes-gateway] websocket error");
        if (!ready) {
          reject(new Error("Could not connect to Hermes gateway."));
        }
      });

      socket.addEventListener("close", () => {
        console.error("[hermes-gateway] websocket closed");
        this.socket = null;
        if (this.closing) {
          return;
        }
        const error = new Error("Hermes gateway connection closed.");

        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();

        for (const listener of this.notificationListeners) {
          listener({
            type: "error",
            session_id: "",
            payload: { message: error.message },
          });
        }

        if (!ready) {
          reject(error);
        }
      });
    });

    await this.readyPromise;
  }

  async dispose() {
    this.closing = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    for (const pending of this.pending.values()) {
      pending.reject(new Error("Hermes gateway connection closed."));
    }
    this.pending.clear();

    this.readyPromise = null;
  }

  async request(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Hermes gateway is not connected.");
    }

    const id = this.nextId++;
    console.log("[hermes-gateway:request]", id, method, params);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
}

class HermesGatewayBridge {
  constructor(settings) {
    this.settings = normalizeSettings(settings);
    this.proc = null;
    this.client = new GatewayRpcClient();
    this.notificationListeners = new Set();
    this.connection = null;
    this.startPromise = null;
    this.gatewayReady = false;
    this.latestStartupError = null;
    this.isStopping = false;

    this.client.onNotification((message) => {
      for (const listener of this.notificationListeners) {
        listener(message);
      }
    });
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  emitError(message) {
    for (const listener of this.notificationListeners) {
      listener({
        type: "error",
        session_id: "",
        payload: { message },
      });
    }
  }

  async updateSettings(nextSettings) {
    this.settings = normalizeSettings(nextSettings);
    await this.restart();
  }

  async restart() {
    await this.dispose();
    await this.start();
  }

  async dispose() {
    const pendingStart = this.startPromise;
    this.isStopping = true;
    this.gatewayReady = false;
    this.connection = null;
    this.latestStartupError = null;

    await this.client.dispose();

    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      await terminateProcessTree(proc, "hermes-backend");
    }

    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // A start interrupted by dispose is expected during repair or exit.
      }
    }
  }

  async start() {
    if (this.gatewayReady) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startInternal() {
    this.isStopping = false;
    await ensureEmbeddedRuntimeInstalled();
    if (this.isStopping) {
      throw new Error("Hermes startup was cancelled.");
    }
    const port = await pickPort();
    const token = randomBytes(32).toString("base64url");
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`;
    const launchConfig = resolveBackendLaunch();
    const args = [
      ...launchConfig.argsPrefix,
      "dashboard",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--skip-build",
    ];
    const env = buildHermesEnv(this.settings, launchConfig, token);

    await fs.mkdir(env.HERMES_HOME, { recursive: true });
    if (this.settings.runtimeMode !== "official") {
      await ensureScopeSessionIsolation(env.HERMES_HOME);
      await ensureScopeSoul(env.HERMES_HOME);
    }
    await syncRegisteredSkills(this.settings);

    this.proc = spawn(launchConfig.command, args, {
      cwd: this.settings.cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });

    this.proc.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log("[hermes-backend:stdout]", text);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error("[hermes-backend:stderr]", text);
        this.latestStartupError = text;
      }
    });

    const exitPromise = new Promise((_, reject) => {
      this.proc.once("error", (error) => {
        reject(error);
      });

      this.proc.once("exit", (code, signal) => {
        const message =
          this.latestStartupError ||
          `Hermes backend exited before it became ready (${signal ?? code ?? "unknown"}).`;
        reject(new Error(message));
      });
    });

    await Promise.race([waitForBackend(baseUrl, token), exitPromise]);
    await this.client.connect(wsUrl);

    this.connection = { baseUrl, wsUrl, token };
    this.gatewayReady = true;

    this.proc.once("exit", (code, signal) => {
      if (this.isStopping) {
        return;
      }
      const message =
        this.latestStartupError || `Hermes backend exited (${signal ?? code ?? "unknown"}).`;
      this.gatewayReady = false;
      this.connection = null;
      this.emitError(message);
    });
  }

  async request(method, params = {}) {
    await this.start();
    return this.client.request(method, params);
  }

  async listThreads() {
    const result = await this.request("session.list", { limit: 50 });
    return (result.sessions ?? []).map((session) => mapStoredSession(session, this.settings));
  }

  async createSession() {
    const cwd = this.settings.cwd || process.cwd();
    return this.request("session.create", {
      cwd,
      cols: 120,
      yolo: true,
      developerInstructions: await buildOutputInstructions(cwd, this.settings.defaultOutputDir),
    });
  }

  async resumeThread(threadId) {
    const cwd = this.settings.cwd || process.cwd();
    return this.request("session.resume", {
      session_id: threadId,
      cols: 120,
      yolo: true,
      developerInstructions: await buildOutputInstructions(cwd, this.settings.defaultOutputDir),
    });
  }

  async getSessionHistory(sessionId) {
    return this.request("session.history", {
      session_id: sessionId,
    });
  }

  async sendPrompt(sessionId, text) {
    return this.request("prompt.submit", {
      session_id: sessionId,
      text,
    });
  }

  async cancelPrompt(sessionId) {
    try {
      await this.request("prompt.cancel", { session_id: sessionId });
    } catch {
      try {
        await this.request("session.cancel", { session_id: sessionId });
      } catch {
        // ignore fallback errors
      }
    }
  }

  async execSlash(sessionId, command) {
    return this.request("slash.exec", {
      session_id: sessionId,
      command,
    });
  }

  async getSessionStatus(sessionId) {
    return this.request("session.status", {
      session_id: sessionId,
    });
  }

  async switchSessionModel(sessionId, model, persistGlobal = true) {
    const modelId = toSafeString(model).trim();
    if (!modelId) {
      throw new Error("Model is required.");
    }

    const command = persistGlobal ? `model ${modelId} --global` : `model ${modelId}`;
    return this.execSlash(sessionId, command);
  }

  async closeSession(sessionId) {
    if (!sessionId) {
      return;
    }

    try {
      await this.request("session.close", {
        session_id: sessionId,
      });
    } catch (error) {
      console.error("[hermes-gateway:close-session-error]", error);
    }
  }

  async deleteThread(threadId) {
    return this.request("session.delete", {
      session_id: threadId,
    });
  }

  async listSkills() {
    return this.settings.registeredSkills || [];
  }
}

let mainWindow = null;
let bridge = null;
let activeGatewaySessionId = null;
let activeSessionUnsubscribe = null;
let activeSessionReject = null;
let activeOfficialLogin = null;

let state = {
  status: "Starting Hermes runtime...",
  error: null,
  currentRuntimeModel: null,
  lastUsageModel: null,
  reasoningTrace: null,
  pendingApproval: null,
  pendingClarification: null,
  settings: { ...defaultSettings },
  runtime: buildRuntimeInfo(false),
  official: {
    available: false,
    homeDir: getOfficialHermesHomeDir(),
    configPath: path.join(getOfficialHermesHomeDir(), "config.yaml"),
    authPath: path.join(getOfficialHermesHomeDir(), "auth.json"),
    provider: "nous",
    defaultModel: "stepfun/step-3.7-flash:free",
    isLoggedIn: false,
    subscriptionLabel: "Unknown",
    rateLimitSource: "",
    availableModels: [],
    freeRecommendedModels: [],
    paidRecommendedModels: [],
    userCode: null,
  },
  threads: [],
  activeThreadId: null,
  activeThread: null,
  messages: [],
  activeDraft: null,
  busy: false,
  skills: [],
};

function getSettingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function settingsRequireBridgeRestart(previousSettings, nextSettings) {
  const comparablePrevious = {
    ...normalizeSettings(previousSettings),
    logoutOfficial: undefined,
    loginOfficial: undefined,
  };
  const comparableNext = {
    ...normalizeSettings(nextSettings),
    logoutOfficial: undefined,
    loginOfficial: undefined,
  };

  return JSON.stringify(comparablePrevious) !== JSON.stringify(comparableNext);
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(defaultSettings);
  }
}

async function saveSettings(settings) {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("hermes:state", state);
  }
}

async function refreshThreads() {
  if (!bridge) {
    return;
  }

  state.threads = await bridge.listThreads();
  if (state.activeThreadId) {
    state.activeThread = state.threads.find((thread) => thread.id === state.activeThreadId) ?? state.activeThread;
  }
  broadcastState();
}

async function loadActiveThread(threadId) {
  if (!bridge) {
    return;
  }

  const previousSessionId = activeGatewaySessionId;
  const previousTurnWasActive = state.busy || Boolean(state.pendingClarification);
  state.busy = true;
  state.error = null;
  state.pendingClarification = null;
  state.pendingApproval = null;
  broadcastState();

  try {
    if (activeSessionUnsubscribe) {
      activeSessionUnsubscribe();
      activeSessionUnsubscribe = null;
    }
    if (activeSessionReject) {
      activeSessionReject(new Error("Thread switched."));
      activeSessionReject = null;
    }

    if (previousTurnWasActive && previousSessionId) {
      await bridge.cancelPrompt(previousSessionId);
    }

    if (previousSessionId) {
      await bridge.closeSession(previousSessionId);
    }

    const result = await bridge.resumeThread(threadId);
    activeGatewaySessionId = String(result.session_id ?? "");

    state.activeThreadId = String(result.session_key ?? threadId);
    const savedCwd = getThreadCwd(state.activeThreadId);
    const threadCwd = toSafeString(result.info?.cwd || result.cwd || savedCwd || state.settings.cwd).trim();
    if (state.activeThreadId && threadCwd) {
      await saveThreadCwd(state.activeThreadId, threadCwd);
    }
    state.settings.cwd = threadCwd;

    const existingThreadIndex = state.threads.findIndex((thread) => thread.id === state.activeThreadId);
    let activeThreadObj = existingThreadIndex !== -1 ? state.threads[existingThreadIndex] : null;

    if (activeThreadObj) {
      activeThreadObj = { ...activeThreadObj, cwd: threadCwd };
      state.threads[existingThreadIndex] = activeThreadObj;
    } else {
      activeThreadObj = mapStoredSession(
        {
          id: state.activeThreadId,
          title: result.info?.title ?? "",
          preview: "",
          started_at: Date.now() / 1000,
          cwd: threadCwd,
        },
        state.settings
      );
    }
    state.activeThread = activeThreadObj;
    state.currentRuntimeModel = toSafeString(result.info?.model).trim() || null;
    state.messages = mapGatewayMessages(result.messages);
    state.activeDraft = null;
    state.status = "Ready.";
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to load session.";
    state.status = state.error;
  } finally {
    state.busy = false;
    broadcastState();
  }
}

async function startNewConversation() {
  const previousSessionId = activeGatewaySessionId;
  const previousTurnWasActive = state.busy || Boolean(state.pendingClarification);

  state.pendingClarification = null;
  state.pendingApproval = null;
  if (activeSessionUnsubscribe) {
    activeSessionUnsubscribe();
    activeSessionUnsubscribe = null;
  }
  if (activeSessionReject) {
    activeSessionReject(new Error("Conversation was closed."));
    activeSessionReject = null;
  }

  if (bridge && previousTurnWasActive && previousSessionId) {
    try {
      await bridge.cancelPrompt(previousSessionId);
    } catch (err) {
      console.error("Failed to cancel previous session before starting a new conversation:", err);
    }
  }

  if (bridge && previousSessionId) {
    try {
      await bridge.closeSession(previousSessionId);
    } catch (err) {
      console.error("Failed to close session:", err);
    }
  }

  activeGatewaySessionId = null;
  state.activeThreadId = null;
  state.activeThread = null;
  state.currentRuntimeModel = null;
  state.lastUsageModel = null;
  state.reasoningTrace = null;
  state.messages = [];
  state.activeDraft = null;
  state.error = null;
  state.status = "Ready.";
  state.busy = false;
  broadcastState();
}

async function syncMessagesFromGateway() {
  if (!bridge || !activeGatewaySessionId) {
    return;
  }

  const history = await bridge.getSessionHistory(activeGatewaySessionId);
  state.messages = mapGatewayMessages(history.messages);
}

async function waitForSessionCompletion(sessionId) {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  if (activeSessionUnsubscribe) {
    activeSessionUnsubscribe();
    activeSessionUnsubscribe = null;
  }
  if (activeSessionReject) {
    activeSessionReject(new Error("New session started."));
    activeSessionReject = null;
  }

  await new Promise((resolve, reject) => {
    const unsubscribe = bridge.onNotification((message) => {
      if (message.session_id !== sessionId) {
        return;
      }

      if (message.type === "message.complete") {
        if (activeSessionUnsubscribe === unsubscribe) {
          activeSessionUnsubscribe = null;
          activeSessionReject = null;
        }
        unsubscribe();
        resolve();
        return;
      }

      if (message.type === "error") {
        if (activeSessionUnsubscribe === unsubscribe) {
          activeSessionUnsubscribe = null;
          activeSessionReject = null;
        }
        unsubscribe();
        reject(new Error(message.payload?.message ?? "Failed to complete turn."));
      }
    });
    activeSessionUnsubscribe = unsubscribe;
    activeSessionReject = reject;
  });
}

function extractModelFromSessionStatus(output) {
  const text = toSafeString(output);
  const match = text.match(/^\s*Model:\s+(.+?)(?:\s+\(|$)/m);
  return match?.[1]?.trim() || null;
}

async function waitForSessionModel(sessionId, targetModel, timeoutMs = 65000, pollMs = 1250) {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  const wanted = toSafeString(targetModel).trim();
  const startedAt = Date.now();
  let lastObservedModel = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const statusResult = await bridge.getSessionStatus(sessionId);
    const liveModel = extractModelFromSessionStatus(statusResult?.output);
    if (liveModel) {
      lastObservedModel = liveModel;
    }

    if (liveModel && liveModel === wanted) {
      return {
        matched: true,
        liveModel,
        elapsedMs: Date.now() - startedAt,
      };
    }

    await sleep(pollMs);
  }

  return {
    matched: false,
    liveModel: lastObservedModel,
    elapsedMs: Date.now() - startedAt,
  };
}

async function initializeBridge() {
  await loadThreadCwds();
  let settings = await loadSettings();
  state.settings = settings;
  state.skills = settings.registeredSkills || [];
  state.runtime = await ensureEmbeddedRuntimeInstalled();
  state.official = await inspectOfficialHermesConfig();
  const reconciled = await reconcileOfficialModeSettings(settings, state.official);
  settings = reconciled.settings;
  state.settings = settings;
  state.skills = settings.registeredSkills || [];
  state.official = reconciled.official;
  if (reconciled.changed) {
    await saveSettings(settings);
  }
  bridge = new HermesGatewayBridge(settings);

  bridge.onNotification((message) => {
    console.log("[hermes-bridge:notification]", message.type, message.session_id ?? "", message.payload ?? {});
    if (message.type === "error") {
      state.error = message.payload?.message ?? "Hermes runtime error.";
      state.status = state.error;
      state.busy = false;
      state.activeDraft = null;
      state.pendingClarification = null;
      if (/invalid refresh token|refresh_token|agent init failed/i.test(state.error)) {
        activeGatewaySessionId = null;
      }
      broadcastState();
      return;
    }

    if (message.type === "clarify.request") {
      const targetSessionId = message.session_id || activeGatewaySessionId || state.activeThreadId;
      const payload = message.payload || {};
      const question = toSafeString(payload.question || payload.prompt || payload.text).trim();
      if (targetSessionId && question) {
        state.pendingClarification = {
          sessionId: String(targetSessionId),
          requestId: payload.request_id || payload.id || null,
          question,
          choices: Array.isArray(payload.choices) ? payload.choices.map((choice) => toSafeString(choice)).filter(Boolean) : null,
        };
        state.status = "等待补充信息...";
        broadcastState();
      }
      return;
    }

    const isApprovalType =
      typeof message.type === "string" &&
      (message.type.includes("approval") ||
       message.type.includes("permission") ||
       message.type.includes("confirm") ||
       message.type.includes("consent"));

    if (isApprovalType) {
      const targetSessionId = message.session_id || activeGatewaySessionId || state.activeThreadId;
      const payload = message.payload || {};
      state.pendingApproval = {
        sessionId: String(targetSessionId || ""),
        approvalId: payload.approval_id || payload.id || payload.request_id || null,
        command: toSafeString(payload.command || payload.cmd || payload.text),
        description: toSafeString(payload.description || payload.reason || payload.message || "Hermes 请求执行需要授权。"),
        patternKey: toSafeString(payload.pattern_key || payload.pattern || payload.rule),
      };
      state.status = "等待安全授权...";
      broadcastState();
      return;
    }

    if (!activeGatewaySessionId || message.session_id !== activeGatewaySessionId) {
      return;
    }

    if (message.type === "message.delta" && state.activeDraft) {
      const delta = toSafeString(message.payload?.text);
      state.activeDraft.text += delta;

      if (!state.activeDraft.segments) {
        state.activeDraft.segments = [{ reasoning: state.activeDraft.reasoning || "", text: "" }];
      }
      let lastSeg = state.activeDraft.segments[state.activeDraft.segments.length - 1];
      if (!lastSeg) {
        lastSeg = { reasoning: "", text: "" };
        state.activeDraft.segments.push(lastSeg);
      }
      lastSeg.text += delta;

      broadcastState();
      return;
    }

    if (message.type === "reasoning.delta" && state.activeDraft) {
      const delta = toSafeString(message.payload?.text);
      state.reasoningTrace = `${state.reasoningTrace ?? ""}${delta}`;
      state.activeDraft.reasoning = `${state.activeDraft.reasoning ?? ""}${delta}`;

      if (!state.activeDraft.segments) {
        state.activeDraft.segments = [{ reasoning: "", text: "" }];
      }
      let lastSeg = state.activeDraft.segments[state.activeDraft.segments.length - 1];
      if (!lastSeg) {
        lastSeg = { reasoning: "", text: "" };
        state.activeDraft.segments.push(lastSeg);
      } else if (lastSeg.text && lastSeg.text.trim().length > 0) {
        lastSeg = { reasoning: "", text: "" };
        state.activeDraft.segments.push(lastSeg);
      }
      lastSeg.reasoning = (lastSeg.reasoning || "") + delta;

      broadcastState();
      return;
    }

    if (message.type === "message.complete" && state.activeDraft) {
      state.activeDraft.text = toSafeString(message.payload?.text);
      const usageModel = toSafeString(message.payload?.usage?.model).trim();
      if (usageModel) {
        state.lastUsageModel = usageModel;
        if (!state.currentRuntimeModel) {
          state.currentRuntimeModel = usageModel;
        }
      }
      const reasoning = toSafeString(message.payload?.reasoning).trim();
      if (reasoning) {
        state.reasoningTrace = reasoning;
        state.activeDraft.reasoning = reasoning;
      }
      state.pendingApproval = null;
      state.pendingClarification = null;
      broadcastState();
      return;
    }

    if (message.type === "session.info" && state.activeThread) {
      const activeCwd = toSafeString(message.payload?.cwd) || state.activeThread.cwd;
      state.activeThread = {
        ...state.activeThread,
        modelProvider: state.settings.runtimeMode === "official" ? "nous/free" : state.settings.apiProvider,
        status: message.payload?.lazy ? "starting" : "idle",
        cwd: activeCwd,
      };
      if (state.activeThreadId && activeCwd) {
        void saveThreadCwd(state.activeThreadId, activeCwd);
      }
      state.currentRuntimeModel = toSafeString(message.payload?.model).trim() || state.currentRuntimeModel;
      broadcastState();
      return;
    }
  });

  try {
    await bridge.start();
    state.status = reconciled.autoSwitchedModel
      ? `Ready. 已自动切换到免费模型 ${reconciled.autoSwitchedModel}.`
      : "Ready.";
    state.error = null;
    await refreshThreads();
    await startNewConversation();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to start Hermes backend.";
    state.status = state.error;
    state.runtime = buildRuntimeInfo(await pathExists(getDefaultHermesBinaryPath()));
  }

  broadcastState();
}

function createWindow() {
  const appIconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "深统政务Scope",
    icon: appIconPath,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Open external links in default browser instead of navigating within Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(DEV_SERVER_URL) && !url.startsWith("file://")) {
      shell.openExternal(url).catch((err) => console.error("Failed to open URL:", err));
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(DEV_SERVER_URL) && !url.startsWith("file://")) {
      event.preventDefault();
      shell.openExternal(url).catch((err) => console.error("Failed to open URL:", err));
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist/index.html")).catch((error) => {
      console.error(error);
    });
  } else {
    const loadDev = async () => {
      for (;;) {
        try {
          await fetch(DEV_SERVER_URL);
          await mainWindow.loadURL(DEV_SERVER_URL);
          return;
        } catch {
          await sleep(500);
        }
      }
    };

    void loadDev();
  }

  mainWindow.on("focus", async () => {
    try {
      if (state.settings?.runtimeMode !== "official") return;
      const latestOfficial = await inspectOfficialHermesConfig();
      const authStateChanged = state.official?.isLoggedIn !== latestOfficial.isLoggedIn;
      const hadError = Boolean(state.error && /invalid refresh token|refresh_token|agent init failed/i.test(state.error));

      if ((authStateChanged && latestOfficial.isLoggedIn) || (hadError && latestOfficial.isLoggedIn)) {
        console.log("[hermes-focus-sync] Window focused with valid login on disk! Auto-restarting bridge...");
        state.official = latestOfficial;
        activeGatewaySessionId = null;
        state.activeThreadId = null;
        state.activeThread = null;
        state.currentRuntimeModel = null;
        state.reasoningTrace = null;
        state.messages = [];
        state.activeDraft = null;
        state.error = null;
        state.status = "Ready. 自动同步了最新的官方登录状态。";

        if (bridge) {
          await bridge.updateSettings(state.settings);
          await refreshThreads();
          await startNewConversation();
        }
        broadcastState();
      }
    } catch (err) {
      console.error("[hermes-focus-sync] Focus sync error:", err);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  app.setName("深统政务Scope");
  applyPlatformIcon();
  createWindow();
  await initializeBridge();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

let shutdownPromise = null;

function stopBridgeBeforeQuit() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = Promise.all([
    bridge ? bridge.dispose() : Promise.resolve(),
    activeOfficialLogin?.proc ? cancelOfficialHermesLogin() : Promise.resolve(),
  ])
    .catch((error) => {
      console.error("Failed to stop Hermes before quitting:", error);
    })
    .finally(() => {
      app.quit();
    });

  return shutdownPromise;
}

app.on("before-quit", (event) => {
  if (shutdownPromise) {
    return;
  }

  event.preventDefault();
  void stopBridgeBeforeQuit();
});

app.on("window-all-closed", () => {
  // Keep the macOS app and its bridge alive so a later activate event can
  // reopen the window normally. Windows/Linux quit only after the child has
  // been fully terminated.
  if (process.platform !== "darwin") {
    void stopBridgeBeforeQuit();
  }
});

ipcMain.handle("hermes:getState", () => state);

ipcMain.handle("hermes:newThread", async () => {
  state.settings.cwd = "";
  await saveSettings(state.settings);
  if (bridge) {
    try {
      await bridge.updateSettings(state.settings);
    } catch (e) {
      console.error("Failed to update bridge settings on newThread:", e);
    }
  }
  await startNewConversation();
  state.lastGeneratedFiles = null;
  return state;
});

ipcMain.handle("hermes:selectThread", async (_event, threadId) => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  await loadActiveThread(String(threadId));
  state.lastGeneratedFiles = null;
  return state;
});

ipcMain.handle("hermes:sendMessage", async (_event, payload) => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  const text = toSafeString(payload?.text).trim();
  if (!text) {
    throw new Error("Message text is required.");
  }

  if (state.settings.runtimeMode !== "official" && !toSafeString(state.settings.apiKey).trim()) {
    state.error = "Missing API key. Open Settings and configure your model provider first.";
    state.status = state.error;
    broadcastState();
    return state;
  }

  state.busy = true;
  state.error = null;
  state.status = "Running...";
  state.reasoningTrace = null;
  state.lastGeneratedFiles = null;
  broadcastState();

  try {
    if (activeGatewaySessionId && isOfficialSessionModelStale(state.currentRuntimeModel)) {
      await bridge.closeSession(activeGatewaySessionId);
      await startNewConversation();
      state.status = `检测到当前历史会话仍绑定付费模型 ${state.currentRuntimeModel}，已切到新会话并使用免费模型 ${state.official.defaultModel}。`;
      broadcastState();
    }

    if (!activeGatewaySessionId) {
      console.log("[hermes-send] creating session");
      const session = await bridge.createSession();
      activeGatewaySessionId = String(session.session_id ?? "");
      state.activeThreadId = String(session.stored_session_id ?? "");
      if (state.activeThreadId && state.settings.cwd) {
        void saveThreadCwd(state.activeThreadId, state.settings.cwd);
      }
      state.activeThread = {
        id: state.activeThreadId,
        name: null,
        preview: "",
        modelProvider: state.settings.runtimeMode === "official" ? "nous/free" : state.settings.apiProvider,
        status: "idle",
        updatedAt: Date.now() / 1000,
        createdAt: Date.now() / 1000,
        cwd: state.settings.cwd,
      };
      state.currentRuntimeModel = null;
    }

    state.messages = [
      ...state.messages,
      {
        id: randomUUID(),
        role: "user",
        text,
        turnId: null,
      },
    ];
    state.activeDraft = {
      id: randomUUID(),
      threadId: state.activeThreadId ?? activeGatewaySessionId,
      text: "",
      reasoning: "",
      segments: [{ reasoning: "", text: "" }],
    };
    broadcastState();

    const targetCwd = state.settings.cwd || process.cwd();
    const beforeFiles = await scanDirectoryFiles(targetCwd);

    let sendError = null;
    try {
      console.log("[hermes-send] submitting prompt", activeGatewaySessionId, text);
      await bridge.sendPrompt(activeGatewaySessionId, text);
      await waitForSessionCompletion(activeGatewaySessionId);
    } catch (err) {
      sendError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/agent initialization timed out/i.test(errMsg) && activeGatewaySessionId) {
        console.warn("[hermes-send] Agent cold start timed out; retrying the same prompt once...");
        try {
          state.busy = true;
          state.error = null;
          state.status = "首次启动较慢，正在继续初始化...";
          broadcastState();
          await sleep(1500);
          await bridge.sendPrompt(activeGatewaySessionId, text);
          await waitForSessionCompletion(activeGatewaySessionId);
          sendError = null;
        } catch (retryErr) {
          console.error("[hermes-send] Cold-start retry failed:", retryErr);
          sendError = retryErr;
        }
      }
      if (/invalid refresh token|refresh_token|agent init failed/i.test(errMsg)) {
        console.warn("[hermes-send] Token error on prompt submission. Checking disk for auto-recovery...");
        activeGatewaySessionId = null;
        const latestOfficial = await inspectOfficialHermesConfig();
        state.official = latestOfficial;
        if (latestOfficial.isLoggedIn) {
          console.log("[hermes-send] Auto-recovering: valid token on disk, restarting bridge...");
          try {
            await bridge.restart();
            const session = await bridge.createSession();
            activeGatewaySessionId = String(session.session_id ?? "");
            state.activeThreadId = String(session.stored_session_id ?? "");
            console.log("[hermes-send] Retrying prompt submission on new session:", activeGatewaySessionId);
            await bridge.sendPrompt(activeGatewaySessionId, text);
            await waitForSessionCompletion(activeGatewaySessionId);
            sendError = null;
          } catch (retryErr) {
            console.error("[hermes-send] Auto-recovery retry failed:", retryErr);
            sendError = retryErr;
          }
        }
      }
    }

    if (sendError) {
      throw sendError;
    }
    console.log("[hermes-send] message complete");

    const afterFiles = await scanDirectoryFiles(targetCwd);
    const newFiles = afterFiles.filter(f => !beforeFiles.includes(f));
    if (newFiles.length > 0) {
      state.lastGeneratedFiles = newFiles;
    }

    const completedAssistantText = toSafeString(state.activeDraft?.text).trim();
    const completedAssistantReasoning = toSafeString(state.activeDraft?.reasoning).trim();
    await syncMessagesFromGateway();
    if (completedAssistantText) {
      const lastAssistantIndex = [...state.messages].reverse().findIndex(
        (msg) => msg.role === "assistant" && toSafeString(msg.text).trim() === completedAssistantText
      );
      if (lastAssistantIndex !== -1) {
        const normalIndex = state.messages.length - 1 - lastAssistantIndex;
        if (!state.messages[normalIndex].reasoning && completedAssistantReasoning) {
          state.messages[normalIndex].reasoning = completedAssistantReasoning;
        }
      } else {
        state.messages = [
          ...state.messages,
          {
            id: randomUUID(),
            role: "assistant",
            text: completedAssistantText,
            reasoning: completedAssistantReasoning || null,
            turnId: null,
          },
        ];
      }
    }
    state.activeDraft = null;
    await refreshThreads();
    state.status = "Ready.";
  } catch (error) {
    console.error("[hermes-send] failed", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to send message.";
    if (/Conversation was closed|Thread switched|用户已终止对话处理/.test(errorMessage)) {
      // Switching threads, starting a new conversation, and pressing stop are
      // intentional cancellations; they must not overwrite the new state with
      // a stale error from the previous send task.
      state.error = null;
      state.status = "Ready.";
      state.activeDraft = null;
    } else {
      state.error = errorMessage;
      state.status = state.error;
    }
    if (/invalid refresh token|refresh_token|agent init failed/i.test(state.error)) {
      activeGatewaySessionId = null;
    }
  } finally {
    state.busy = false;
    broadcastState();
  }

  return state;
});

ipcMain.handle("hermes:switchSessionModel", async (_event, model) => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  const nextModel = toSafeString(model).trim();
  if (!nextModel) {
    throw new Error("Model is required.");
  }

  if (!activeGatewaySessionId) {
    const merged = normalizeSettings({
      ...state.settings,
      model: nextModel,
    });
    if (merged.runtimeMode === "official") {
      await updateOfficialHermesDefaultModel(merged.model);
      state.official = await inspectOfficialHermesConfig();
      merged.model = state.official.defaultModel;
    }
    state.settings = merged;
    await saveSettings(state.settings);
    broadcastState();
    return state;
  }

  state.busy = true;
  state.error = null;
  state.status = `正在当前对话内切换模型到 ${nextModel}...`;
  broadcastState();

  try {
    const result = await bridge.switchSessionModel(activeGatewaySessionId, nextModel, false);
    if (state.settings.runtimeMode === "official") {
      await updateOfficialHermesDefaultModel(nextModel);
    }

    state.official = await inspectOfficialHermesConfig();
    state.settings = normalizeSettings({
      ...state.settings,
      model: state.official.defaultModel,
    });
    await saveSettings(state.settings);

    state.lastUsageModel = null;
    const waitResult = await waitForSessionModel(activeGatewaySessionId, nextModel);
    const liveModel = waitResult.liveModel;
    if (liveModel) {
      state.currentRuntimeModel = liveModel;
    }
    await refreshThreads();
    if (!waitResult.matched) {
      state.status = liveModel
        ? `默认模型已改成 ${state.official.defaultModel}，等待 ${Math.round(waitResult.elapsedMs / 1000)}s 后当前对话实际仍是 ${liveModel}。`
        : `默认模型已改成 ${state.official.defaultModel}，但在 ${Math.round(waitResult.elapsedMs / 1000)}s 内还没确认到当前对话完成切换。`;
      state.error = null;
    } else {
      state.status = result?.warning
        ? `Ready. 当前对话已切换到 ${liveModel ?? state.official.defaultModel}，${result.warning}`
        : `Ready. 当前对话已切换到 ${liveModel ?? state.official.defaultModel}.`;
      state.error = null;
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to switch session model.";
    state.status = state.error;
  } finally {
    state.busy = false;
    broadcastState();
  }

  return state;
});

ipcMain.handle("hermes:archiveThread", async (_event, threadId) => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  const targetId = String(threadId);
  if (targetId === state.activeThreadId) {
    await startNewConversation();
  }

  try {
    await bridge.deleteThread(targetId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete session.";
    state.error = message;
    state.status = message;
  }

  await refreshThreads();
  return state;
});

function stripAnsi(str) {
  const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-OR-TZcf-ntqry=><~]/g;
  return str.replace(ansiRegex, "");
}

async function runOfficialHermesLogin(settings) {
  if (activeOfficialLogin?.proc) {
    await cancelOfficialHermesLogin();
  }

  const launchConfig = resolveBackendLaunch();
  const args = [
    ...launchConfig.argsPrefix,
    "auth",
    "add",
    "nous",
    "--type",
    "oauth"
  ];
  const env = buildHermesEnv(settings, launchConfig, "");
  env.HERMES_HOME = getOfficialHermesHomeDir();

  await fs.mkdir(env.HERMES_HOME, { recursive: true });

  const loginProc = spawn(launchConfig.command, args, {
    cwd: settings.cwd || process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
  });
  const loginAttempt = {
    proc: loginProc,
    cancelRequested: false,
  };
  activeOfficialLogin = loginAttempt;

  let stdoutBuffer = "";

  loginProc.stdout.on("data", (chunk) => {
    try {
      const rawText = chunk.toString();
      stdoutBuffer += rawText;
      console.log("[hermes-login:stdout]", rawText.trim());

      if (!state.official.userCode) {
        const cleanBuffer = stripAnsi(stdoutBuffer);
        const match = cleanBuffer.match(/enter code:\s*([A-Z0-9-]+)/i) || cleanBuffer.match(/user_code=([A-Z0-9-]+)/i);
        if (match) {
          state.official.userCode = match[1];
          broadcastState();
        }
      }
    } catch (err) {
      console.error("[hermes-login:stdout-error]", err);
    }
  });

  loginProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error("[hermes-login:stderr]", text);
    }
  });

  return new Promise((resolve) => {
    let resolved = false;
    let timeoutId = null;

    const finish = (result) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (activeOfficialLogin === loginAttempt) {
        activeOfficialLogin = null;
      }
      state.official.userCode = null;
      broadcastState();
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    loginProc.on("close", (code) => {
      console.log("[hermes-login] exited with code:", code);
      finish({
        success: code === 0,
        cancelled: loginAttempt.cancelRequested,
      });
    });

    loginProc.on("error", (err) => {
      console.error("[hermes-login] error:", err);
      finish({
        success: false,
        cancelled: loginAttempt.cancelRequested,
      });
    });

    timeoutId = setTimeout(() => {
      if (!resolved) {
        void terminateProcessTree(loginProc, "hermes-login");
        finish({
          success: false,
          cancelled: false,
        });
      }
    }, 180000);
  });
}

async function cancelOfficialHermesLogin() {
  if (!activeOfficialLogin?.proc) {
    state.official.userCode = null;
    broadcastState();
    return false;
  }

  activeOfficialLogin.cancelRequested = true;
  state.official.userCode = null;
  broadcastState();
  await terminateProcessTree(activeOfficialLogin.proc, "hermes-login");
  return true;
}

ipcMain.handle("hermes:updateSettings", async (_event, nextSettings) => {
  const previousSettings = normalizeSettings(state.settings);
  const previousOfficialLoggedIn = state.official?.isLoggedIn;
  const previousHadAuthError = Boolean(
    state.error && /invalid refresh token|refresh_token|agent init failed/i.test(state.error)
  );
  const { logoutOfficial, loginOfficial, ...cleanSettings } = nextSettings || {};
  if (logoutOfficial) {
    const homeDir = getOfficialHermesHomeDir();
    const authPath = path.join(homeDir, "auth.json");
    const sharedAuthPath = path.join(homeDir, "shared", "nous_auth.json");
    try {
      if (await pathExists(authPath)) {
        const text = await fs.readFile(authPath, "utf8");
        const auth = JSON.parse(text);
        let changed = false;
        if (auth.providers && auth.providers.nous) {
          delete auth.providers.nous;
          changed = true;
        }
        if (auth.credential_pool && auth.credential_pool.nous) {
          delete auth.credential_pool.nous;
          changed = true;
        }
        if (changed) {
          await fs.writeFile(authPath, JSON.stringify(auth, null, 2), "utf8");
        }
      }
    } catch (e) {
      console.error("Failed to update auth.json on logout:", e);
    }

    try {
      await fs.unlink(sharedAuthPath);
    } catch (e) {
      // Ignore if file doesn't exist or cannot be deleted
    }
  }

  let loginResult = null;
  if (loginOfficial) {
    loginResult = await runOfficialHermesLogin(state.settings);
  }

  let merged = normalizeSettings({ ...state.settings, ...cleanSettings });

  if (merged.runtimeMode === "official") {
    await updateOfficialHermesDefaultModel(merged.model);
  }

  state.official = await inspectOfficialHermesConfig();
  const reconciled = await reconcileOfficialModeSettings(merged, state.official);
  merged = reconciled.settings;
  state.settings = merged;
  if (state.activeThreadId && merged.cwd !== undefined) {
    await saveThreadCwd(state.activeThreadId, merged.cwd);
    if (state.activeThread) {
      state.activeThread = { ...state.activeThread, cwd: merged.cwd };
    }
    const idx = state.threads.findIndex(t => t.id === state.activeThreadId);
    if (idx !== -1) {
      state.threads[idx] = { ...state.threads[idx], cwd: merged.cwd };
    }
  }
  state.skills = merged.registeredSkills || [];
  state.official = reconciled.official;
  await saveSettings(merged);

  const authStateChanged = previousOfficialLoggedIn !== state.official.isLoggedIn;
  const loggedInAfterError = previousHadAuthError && state.official.isLoggedIn;
  const loginSucceeded = Boolean(loginOfficial && loginResult?.success);

  const shouldRestartBridge =
    bridge &&
    (settingsRequireBridgeRestart(previousSettings, merged) ||
      loginSucceeded ||
      logoutOfficial ||
      authStateChanged ||
      loggedInAfterError);

  const shouldSkipBridgeRestart = !shouldRestartBridge;

  if (bridge && shouldRestartBridge) {
    activeGatewaySessionId = null;
    state.activeThreadId = null;
    state.activeThread = null;
    state.currentRuntimeModel = null;
    state.reasoningTrace = null;
    state.messages = [];
    state.activeDraft = null;

    try {
      await bridge.updateSettings(merged);
      state.error = null;
      state.status = reconciled.autoSwitchedModel
        ? `Ready. 已自动切换到免费模型 ${reconciled.autoSwitchedModel}.`
        : "Ready.";
      await refreshThreads();
      await startNewConversation();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to restart Hermes backend.";
      state.status = state.error;
    }
  }

  if (shouldSkipBridgeRestart) {
    state.error = null;
    if (loginOfficial && loginResult?.cancelled) {
      state.status = "已取消官方登录。";
    } else if (loginOfficial && loginResult?.success) {
      state.status = "Ready. 官方登录状态已同步。";
    } else if (logoutOfficial) {
      state.status = "Ready. 官方登录状态已退出。";
    } else {
      state.status = "Ready.";
    }
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:cancelOfficialLogin", async () => {
  await cancelOfficialHermesLogin();
  state.official = await inspectOfficialHermesConfig();
  state.error = null;
  state.status = "已取消官方登录。";
  broadcastState();
  return state;
});

ipcMain.handle("hermes:repairRuntime", async () => {
  state.status = "Installing embedded Hermes runtime...";
  state.error = null;
  broadcastState();

  try {
    // Stop Hermes before touching its virtual environment. Windows may keep
    // site-packages handles open for a short time after the child exits.
    if (activeOfficialLogin?.proc) {
      await cancelOfficialHermesLogin();
    }

    if (bridge) {
      await bridge.dispose();
    }

    state.runtime = await ensureEmbeddedRuntimeInstalled({ force: true });

    // If startup failed before the bridge object was created, repair should
    // finish initialization instead of leaving the chat permanently disabled.
    if (!bridge) {
      await initializeBridge();
      return state;
    }

    state.official = await inspectOfficialHermesConfig();
    const reconciled = await reconcileOfficialModeSettings(state.settings, state.official);
    state.settings = reconciled.settings;
    state.skills = state.settings.registeredSkills || [];
    state.official = reconciled.official;
    if (reconciled.changed) {
      await saveSettings(state.settings);
    }

    if (bridge) {
      activeGatewaySessionId = null;
      state.activeThreadId = null;
      state.activeThread = null;
      state.currentRuntimeModel = null;
      state.reasoningTrace = null;
      state.messages = [];
      state.activeDraft = null;
      await bridge.restart();
      await refreshThreads();
      state.status = reconciled.autoSwitchedModel
        ? `Ready. 已自动切换到免费模型 ${reconciled.autoSwitchedModel}.`
        : "Ready.";
      await startNewConversation();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to install Hermes runtime.";
    state.status = state.error;
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:uninstallRuntime", async () => {
  state.runtime = {
    ...state.runtime,
    uninstalling: true,
  };
  state.status = "Uninstalling embedded Hermes runtime...";
  state.error = null;
  broadcastState();

  try {
    if (activeOfficialLogin?.proc) {
      await cancelOfficialHermesLogin();
    }

    if (bridge) {
      await bridge.dispose();
    }

    bridge = null;
    activeGatewaySessionId = null;
    state.activeThreadId = null;
    state.activeThread = null;
    state.currentRuntimeModel = null;
    state.reasoningTrace = null;
    state.threads = [];
    state.messages = [];
    state.activeDraft = null;
    state.busy = false;
    state.runtime = await uninstallEmbeddedRuntime();
    state.official = await inspectOfficialHermesConfig();
    state.settings = normalizeSettings(state.settings);
    await saveSettings(state.settings);
    state.status = "Hermes runtime has been removed from this app.";
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to uninstall Hermes runtime.";
    state.status = state.error;
    state.runtime = {
      ...buildRuntimeInfo(await pathExists(getDefaultHermesBinaryPath())),
      uninstalling: false,
    };
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:registerSkillFile", async () => {
  if (!mainWindow) {
    throw new Error("Main window is not available.");
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "选择 SKILL.md 技能描述文件",
    filters: [{ name: "Markdown", extensions: ["md"] }],
    properties: ["openFile"],
  });

  if (canceled || filePaths.length === 0) {
    return state;
  }

  const filePath = filePaths[0];
  let content = "";
  try {
    content = decodeSkillText(await fs.readFile(filePath), filePath);
  } catch (error) {
    console.error("Failed to read selected skill file:", error);
    state.error = error instanceof Error ? error.message : "无法读取技能文件。";
    state.status = state.error;
    broadcastState();
    return state;
  }

  const descriptionLine = content
    .split("\n")
    .find((line) => line.trim().startsWith("description:"));

  const description = descriptionLine
    ? descriptionLine.replace("description:", "").trim().replace(/^"|"$/g, "")
    : "Local custom skill";

  const folderName = path.basename(path.dirname(filePath));
  const name = folderName || "custom_skill";

  const newSkill = {
    name,
    description,
    path: filePath,
  };

  const exists = (state.settings.registeredSkills || []).some((skill) => skill.path === filePath);
  if (!exists) {
    const updatedSkills = [...(state.settings.registeredSkills || []), newSkill];
    const merged = {
      ...state.settings,
      registeredSkills: updatedSkills,
    };
    state.settings = merged;
    state.skills = updatedSkills;
    await saveSettings(merged);
    await syncRegisteredSkills(merged);
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:unregisterSkill", async (_event, filePath) => {
  const updatedSkills = (state.settings.registeredSkills || []).filter(
    (skill) => skill.path !== filePath
  );
  const merged = {
    ...state.settings,
    registeredSkills: updatedSkills,
  };
  state.settings = merged;
  state.skills = updatedSkills;
  await saveSettings(merged);
  await syncRegisteredSkills(merged);

  broadcastState();
  return state;
});

ipcMain.handle("hermes:respondApproval", async (_event, choice) => {
  const approval = state.pendingApproval;
  const sessionId = approval?.sessionId || activeGatewaySessionId || state.activeThreadId;
  if (bridge && sessionId) {
    const cmd = choice === "approve" ? "/approve" : "/deny";
    try {
      await bridge.execSlash(sessionId, cmd);
    } catch (err) {
      console.error("Failed to send approval response:", err);
    }
  }
  state.pendingApproval = null;
  state.status = choice === "approve" ? "已批准安全授权，继续处理中..." : "已拒绝授权申请。";
  broadcastState();
  return state;
});

ipcMain.handle("hermes:respondClarification", async (_event, answer) => {
  const pending = state.pendingClarification;
  const text = toSafeString(answer).trim();
  if (!pending || !text || !bridge) {
    return state;
  }

  try {
    state.pendingClarification = null;
    state.status = "已提交补充信息，继续处理中...";
    state.error = null;
    broadcastState();
    if (!pending.requestId) {
      throw new Error("澄清请求缺少 request_id，无法提交回答。");
    }
    await bridge.request("clarify.respond", {
      request_id: pending.requestId,
      answer: text,
    });
  } catch (err) {
    state.pendingClarification = pending;
    state.error = err instanceof Error ? err.message : String(err);
    state.status = state.error;
    broadcastState();
  }
  return state;
});

ipcMain.handle("hermes:openExternal", async (_event, targetUrl) => {
  const urlStr = String(targetUrl || "").trim();
  if (!urlStr) return;

  if (urlStr.startsWith("file://")) {
    let rawPath = decodeURIComponent(urlStr.replace(/^file:\/\//, ""));
    const baseDir = state.activeThread?.cwd || state.settings?.cwd || process.cwd();

    let filePath = rawPath;
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(baseDir, filePath);
    }

    try {
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        if (!path.extname(filePath)) {
          await fs.mkdir(filePath, { recursive: true });
          stats = await fs.stat(filePath);
        }
      }

      if (stats && stats.isDirectory()) {
        await shell.openPath(filePath);
      } else if (stats) {
        shell.showItemInFolder(filePath);
      } else {
        const parentDir = path.dirname(filePath);
        await fs.mkdir(parentDir, { recursive: true });
        await shell.openPath(parentDir);
      }
    } catch (e) {
      console.error("Failed to open file path:", filePath, e);
    }
    return;
  }

  await shell.openExternal(urlStr).catch((err) => console.error("Failed to open external URL:", err));
});

function getGitBranch(dirPath) {
  if (!dirPath) return null;
  try {
    const stdout = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dirPath,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

ipcMain.handle("hermes:stopMessage", async () => {
  const sessionId = activeGatewaySessionId || state.activeThreadId;
  if (bridge && sessionId) {
    try {
      await bridge.cancelPrompt(sessionId);
    } catch (e) {
      console.error("Failed to send cancel prompt:", e);
    }
  }
  if (activeSessionReject) {
    try {
      activeSessionReject(new Error("用户已终止对话处理。"));
    } catch {}
    activeSessionReject = null;
  }
  if (activeSessionUnsubscribe) {
    try {
      activeSessionUnsubscribe();
    } catch {}
    activeSessionUnsubscribe = null;
  }
  state.busy = false;
  state.activeDraft = null;
  state.pendingClarification = null;
  state.pendingApproval = null;
  state.error = null;
  state.status = "已终止处理。";
  broadcastState();
  return state;
});

ipcMain.handle("hermes:selectWorkspaceFolder", async () => {
  if (!mainWindow) {
    throw new Error("Main window is not available.");
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目工作区文件夹",
    properties: ["openDirectory"],
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const selectedPath = filePaths[0];
  const branch = getGitBranch(selectedPath);

  const merged = {
    ...state.settings,
    cwd: selectedPath,
  };
  state.settings = merged;
  await saveSettings(merged);

  if (bridge) {
    activeGatewaySessionId = null;
    state.activeThreadId = null;
    state.activeThread = null;
    state.currentRuntimeModel = null;
    state.reasoningTrace = null;
    state.messages = [];
    state.activeDraft = null;
    try {
      await bridge.updateSettings(merged);
      await refreshThreads();
      await startNewConversation();
    } catch (e) {
      console.error("Failed to update bridge settings for new cwd:", e);
    }
  }

  broadcastState();
  return {
    cwd: selectedPath,
    folderName: path.basename(selectedPath),
    branch,
  };
});
