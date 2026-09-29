import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";

import { DshRuntimeManager, getDshHomeDir, resolveDshBinaryPath, scanLocalSkills } from "./dsh-runtime.mjs";
import { DshClient } from "./dsh-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const SETTINGS_FILE = "settings.json";

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

function getAppDockIconPath() {
  const dockIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-dock-icon.png")
    : path.resolve(process.cwd(), "public/sz-dock-icon.png");

  return existsSync(dockIconPath) ? dockIconPath : getAppIconPath();
}

function applyPlatformIcon() {
  const iconPath = getAppDockIconPath();

  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(iconPath);
    } catch (error) {
      console.warn("Unable to apply the macOS Dock icon:", error);
    }
  }

  return iconPath;
}

function normalizeOutputDir(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return "output";
  }

  const normalized = path.normalize(trimmed);
  return normalized === "." ? "output" : normalized;
}

function resolveOutputDir(cwd, defaultOutputDir = "output") {
  const targetDir = normalizeOutputDir(defaultOutputDir);
  return path.isAbsolute(targetDir)
    ? targetDir
    : path.resolve(cwd || process.cwd(), targetDir);
}

const defaultSettings = {
  dshBin: resolveDshBinaryPath(),
  yoloMode: true,
  model: "deepseek-flash",
  cwd: "",
  defaultOutputDir: "output",
  customModels: ["deepseek-flash", "deepseek-v4-pro"],
  apiProvider: "deepseek",
  apiKey: "",
  apiBaseUrl: "",
};

const DEEPSEEK_MODEL_ALIASES = new Map([
  ["deepseek-v4-flash", "deepseek-flash"],
  ["deepseek-v4-flash-vision-exp", "deepseek-flash"],
  ["deepseek-chat", "deepseek-flash"],
  ["deepseek-reasoner", "deepseek-flash"],
]);

function normalizeSettings(settings) {
  const input = { ...(settings ?? {}) };
  delete input.hermesBin;
  delete input.runtimeMode;
  for (const key of [
    "visionModel",
    "visionProvider",
    "visionApiKey",
    "visionBaseUrl",
    "registeredSkills",
    "firecrawlApiKey",
    "exaApiKey",
    "falApiKey",
    "voiceToolsOpenaiKey",
    "browserbaseApiKey",
    "browserbaseProjectId",
  ]) {
    delete input[key];
  }
  const defaultCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const apiProvider = input.apiProvider ?? defaultSettings.apiProvider;
  const normalizeModel = (model) => apiProvider === "deepseek" ? (DEEPSEEK_MODEL_ALIASES.get(model) || model) : model;
  const customModels = Array.isArray(input.customModels) ? input.customModels : defaultSettings.customModels;
  const normalizedCustomModels = Array.from(new Set(customModels.map(normalizeModel)));

  return {
    ...defaultSettings,
    ...input,
    // Runtime paths are owned by the current app install. Older releases saved
    // an absolute Hermes/DSH path here, which may point at a removed or stale
    // checkout after upgrade.
    dshBin: defaultSettings.dshBin,
    model: normalizeModel(input.model ?? defaultSettings.model),
    customModels: normalizedCustomModels,
    cwd: defaultCwd,
    defaultOutputDir: normalizeOutputDir(input.defaultOutputDir),
  };
}

function toSafeString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

let mainWindow = null;
const dshRuntime = new DshRuntimeManager();
let dshClient = null;

if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message?.type === "stat-pilot:quit") app.quit();
  });
}

let state = {
  status: "Starting DeepSeek Harness runtime...",
  error: null,
  currentRuntimeModel: "deepseek-flash",
  lastUsageModel: null,
  reasoningTrace: null,
  pendingApproval: null,
  pendingClarification: null,
  settings: { ...defaultSettings },
  runtime: {
    installed: false,
    uninstalling: false,
    rootDir: "",
    installDir: "",
    homeDir: "",
    bundledSourceDir: "",
    bundledWithApp: true,
  },
  account: null,
  providerCredentialStatus: {
    deepseek: { configured: false, writable: false },
    openai: { configured: false, writable: false },
    openrouter: { configured: false, writable: false },
    custom: { configured: false, writable: false },
  },
  threads: [],
  archivedThreads: [],
  activeThreadId: null,
  activeThread: null,
  messages: [],
  activeDraft: null,
  busy: false,
  skills: [],
};

// Set of threadIds completed
const completedThreads = new Set();
let archivedSessionIds = new Set();
const pendingArchiveDeletionSessionIds = new Set();
const pendingApprovals = new Map();
const pendingUserQuestions = new Map();
let archivePluginWarningLogged = false;
let accountPollTimer = null;
let accountLoginAttemptId = null;
let accountAuthUrlOpenedAttemptId = null;

function latestPendingForSession(pendingInteractions, sessionId = state.activeThreadId) {
  const pending = [...pendingInteractions.values()].reverse();
  return pending.find((interaction) => !sessionId || interaction.sessionId === sessionId) || null;
}

function getAccountClientMetadata() {
  return {
    version: app.getVersion(),
    locale: app.getLocale(),
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

function getSelectedModelProvider(settings = state.settings) {
  if (settings.apiProvider === "openai") return "openai";
  if (settings.apiProvider === "openrouter") return "openrouter";
  if (settings.apiProvider === "custom") return "stat-pilot-custom";

  const hasApiKey = Boolean(state.providerCredentialStatus.deepseek.configured || (process.env.DEEPSEEK_API_KEY || "").trim());
  return !hasApiKey && state.account?.status === "credential-stored"
    ? "deepseek-account"
    : "deepseek-official";
}

function getProviderCredentialRef(provider) {
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openai") return "STAT_PILOT_OPENAI_API_KEY";
  if (provider === "openrouter") return "STAT_PILOT_OPENROUTER_API_KEY";
  return "STAT_PILOT_CUSTOM_API_KEY";
}

async function configureDshProvider(settings) {
  if (!dshClient) return;

  const provider = settings.apiProvider || "deepseek";
  const credentialRef = getProviderCredentialRef(provider);
  const model = String(settings.model || "").trim();
  const apiKey = String(settings.apiKey || "").trim();

  if (provider === "deepseek") {
    await dshClient.mutateSettings({
      namespace: "llm-deepseek",
      operations: [{ op: "set", path: ["apiKeyEnv"], value: credentialRef }],
    });
  } else {
    const route = provider === "custom" ? "stat-pilot-custom" : provider;
    const operations = [
      { op: "set", path: ["providers", route, "apiKeyEnv"], value: credentialRef },
    ];
    if (provider === "custom") {
      const baseURL = String(settings.apiBaseUrl || "").trim();
      if (!baseURL) throw new Error("自定义 provider 必须填写 API Base URL");
      let parsedBaseURL;
      try {
        parsedBaseURL = new URL(baseURL);
      } catch {
        throw new Error("API Base URL 格式无效");
      }
      if (!["http:", "https:"].includes(parsedBaseURL.protocol)) {
        throw new Error("API Base URL 仅支持 HTTP 或 HTTPS");
      }
      const models = Array.from(new Set([model, ...(settings.customModels || [])].map((item) => String(item).trim()).filter(Boolean)));
      if (models.length === 0) throw new Error("自定义 provider 至少需要一个模型 ID");
      operations.push(
        { op: "set", path: ["providers", route, "displayName"], value: "自定义 OpenAI 兼容接口" },
        { op: "set", path: ["providers", route, "api"], value: "openai-completions" },
        { op: "set", path: ["providers", route, "baseURL"], value: baseURL },
        { op: "set", path: ["providers", route, "models"], value: models.map((id) => ({ id })) },
      );
    }
    await dshClient.mutateSettings({ namespace: "llm-pi-ai", operations });
  }

  if (apiKey) {
    await dshClient.setCredential(credentialRef, apiKey);
  }
}

async function configureDshPermissionDefault(settings) {
  if (!dshClient) return;

  const preset = settings.yoloMode ? "danger-full-access" : "workspace-write";
  const catalog = await dshClient.getPermissionPresetCatalog();
  if (!catalog?.defaultOptions?.some((option) => option.value === preset)) {
    throw new Error(`DSH 当前权限预设未提供 ${preset}`);
  }
  await dshClient.mutateSettings({
    namespace: "permission",
    operations: [{ op: "set", path: ["defaultPreset"], value: preset }],
  });
}

async function refreshProviderCredentialStatus() {
  if (!dshClient) return state.providerCredentialStatus;

  const refs = {
    deepseek: "DEEPSEEK_API_KEY",
    openai: "STAT_PILOT_OPENAI_API_KEY",
    openrouter: "STAT_PILOT_OPENROUTER_API_KEY",
    custom: "STAT_PILOT_CUSTOM_API_KEY",
  };
  const descriptions = await dshClient.describeCredentials(Object.values(refs));
  state.providerCredentialStatus = Object.fromEntries(
    Object.entries(refs).map(([provider, ref]) => [provider, {
      configured: Boolean(descriptions?.[ref]?.configured),
      writable: Boolean(descriptions?.[ref]?.writable),
    }])
  );
  return state.providerCredentialStatus;
}

function hasDeepSeekApiKey() {
  return Boolean(state.providerCredentialStatus.deepseek.configured || (process.env.DEEPSEEK_API_KEY || "").trim());
}

function stopAccountPolling() {
  if (accountPollTimer) {
    clearInterval(accountPollTimer);
    accountPollTimer = null;
  }
}

function startAccountPolling() {
  stopAccountPolling();
  accountPollTimer = setInterval(() => {
    void refreshDshAccountState();
  }, 1500);
}

async function openAccountAuthorization(attempt) {
  if (!attempt?.id || !attempt.authorizeUrl || accountAuthUrlOpenedAttemptId === attempt.id) return;

  const authorizeUrl = new URL(attempt.authorizeUrl);
  if (authorizeUrl.protocol !== "https:") {
    state.account = await dshClient.cancelAccountSignIn(attempt.id);
    accountLoginAttemptId = null;
    stopAccountPolling();
    throw new Error("DSH 返回了非 HTTPS 的登录地址，已取消登录");
  }

  accountAuthUrlOpenedAttemptId = attempt.id;
  await shell.openExternal(authorizeUrl.href);
}

async function refreshDshAccountState() {
  if (!dshClient) return state;

  try {
    state.account = await dshClient.getAccountState();
    const attempt = state.account?.attempt;
    if (accountLoginAttemptId && attempt?.id === accountLoginAttemptId) {
      if (["initializing", "waiting-browser", "exchanging", "committing"].includes(attempt.phase)) {
        await openAccountAuthorization(attempt);
      }
      if (attempt.phase === "succeeded") {
        accountLoginAttemptId = null;
        stopAccountPolling();
        if (!hasDeepSeekApiKey()) {
          await dshClient.initializeAccountDefaultModel();
          const catalog = await dshClient.getModelCatalog();
          const accountDefault = catalog?.default?.provider === "deepseek-account"
            ? (DEEPSEEK_MODEL_ALIASES.get(catalog.default.model) || catalog.default.model)
            : state.settings.model;
          if (accountDefault) {
            state.settings.model = accountDefault;
            await saveSettings(state.settings);
          }
          if (state.activeThreadId && accountDefault) {
            await dshClient.selectModel({
              sessionId: state.activeThreadId,
              provider: "deepseek-account",
              model: accountDefault,
            });
            state.currentRuntimeModel = accountDefault;
          }
        }
      } else if (["cancelled", "expired", "failed"].includes(attempt.phase)) {
        accountLoginAttemptId = null;
        stopAccountPolling();
      }
    } else if (!attempt || !["initializing", "waiting-browser", "exchanging", "committing"].includes(attempt.phase)) {
      stopAccountPolling();
    }
  } catch (error) {
    console.warn("[main] Failed to refresh DSH account state:", error);
  }

  broadcastState();
  return state;
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
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
  const safeSettings = { ...settings, apiKey: "" };
  await fs.writeFile(getSettingsPath(), JSON.stringify(safeSettings, null, 2), "utf8");
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (Array.isArray(state.threads)) {
      state.threads = state.threads.map((th) => {
        let taskStatus = "idle";
        if (state.busy && state.activeThreadId && th.id === state.activeThreadId) {
          if (state.pendingApproval) {
            taskStatus = "approving";
          } else if (state.pendingClarification) {
            taskStatus = "clarifying";
          } else {
            taskStatus = "running";
          }
        } else if (completedThreads.has(th.id)) {
          taskStatus = "completed";
        }
        return { ...th, taskStatus };
      });
    }

    mainWindow.webContents.send("dsh:state", state);
  }
}

function upsertActiveDraftActivity(activity, targetDraft = state.activeDraft) {
  if (!targetDraft || !activity?.id) {
    return;
  }

  const activities = Array.isArray(targetDraft.activities)
    ? targetDraft.activities
    : [];
  const index = activities.findIndex((entry) => entry.id === activity.id);
  if (index === -1) {
    targetDraft.activities = [...activities, activity];
    return;
  }

  targetDraft.activities = activities.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, ...activity } : entry
  );
}

function closeRunningThinkingActivities(targetDraft = state.activeDraft) {
  if (!targetDraft || !Array.isArray(targetDraft.activities)) {
    return;
  }

  targetDraft.activities = targetDraft.activities.map((activity) =>
    activity.kind === "thinking" && activity.status === "running"
      ? { ...activity, status: "complete" }
      : activity
  );
}

function finishActiveDraftActivities(targetDraft = state.activeDraft) {
  if (!targetDraft || !Array.isArray(targetDraft.activities)) {
    return;
  }

  targetDraft.activities = targetDraft.activities.map((activity) =>
    activity.status === "running"
      ? { ...activity, status: "complete" }
      : activity
  );
}

function preserveInterruptedDraft() {
  if (!state.activeDraft) {
    return;
  }

  finishActiveDraftActivities();
  const interruptedMessage = {
    id: randomUUID(),
    role: "assistant",
    text: state.activeDraft.text || "",
    reasoning: toSafeString(state.activeDraft.reasoning).trim() || null,
    turnId: null,
    meta: "interrupted",
    activities: [...(state.activeDraft.activities ?? [])],
  };

  state.messages = [...state.messages, interruptedMessage];
  state.activeDraft = null;
}

/**
 * Maps DSH session items into DshThreadSummary array expected by App.tsx.
 */
function mapDshSessionsToThreads(items = []) {
  return items
    .filter((item) => {
      // Hide sessions that have never received a user message and have no title
      // (blank sessions created eagerly but abandoned). This cleans up the
      // "未命名对话" clutter from the old eager-creation pattern.
      const hasTitle = item.projections?.values?.title || item.title;
      return !item.blank || hasTitle;
    })
    .map((item) => {
      const title = item.projections?.values?.title || item.title || "未命名对话";
      return {
        id: item.sessionId,
        name: title,
        preview: title,
        modelProvider: "deepseek",
        status: item.running ? "running" : "idle",
        updatedAt: item.updatedAt || Date.now(),
        createdAt: item.updatedAt || Date.now(),
        cwd: item.cwd || "",
        taskStatus: item.running ? "running" : "idle",
      };
    });
}

/**
 * Maps DSH session/page records into DshChatMessage array.
 */
function mapDshRecordsToMessages(records = []) {
  const messages = [];
  let currentActivities = [];

  for (const record of records) {
    const event = record.event;
    if (!event) continue;

    if (event.type === "user/message") {
      // Only keep messages initiated by human user
      if (event.data?.source?.kind === "user") {
        const textParts = (event.data.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text);
        messages.push({
          id: event.data.id || `user-${event.seq}`,
          role: "user",
          text: textParts.join(""),
          turnId: null,
        });
        currentActivities = [];
      }
    } else if (event.type === "tool/call") {
      const call = event.data;
      currentActivities.push({
        id: call.callId || `tool-${event.seq}`,
        kind: "tool",
        label: call.name || "Tool",
        toolName: call.name,
        detail: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
        status: "complete",
      });
    } else if (event.type === "assistant/message") {
      const msg = event.data.message;
      let text = "";
      let reasoning = "";
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            text += block.text || "";
          } else if (block.type === "reasoning") {
            reasoning += block.text || "";
          }
        }
      }

      messages.push({
        id: msg?.id || `assistant-${event.seq}`,
        role: "assistant",
        text,
        reasoning: reasoning.trim() || null,
        turnId: null,
        activities: [...currentActivities],
      });
      currentActivities = [];
    }
  }

  return messages;
}

async function refreshThreads() {
  if (!dshClient) return;

  let rawSessions;
  let archivedRows = null;
  try {
    [rawSessions, archivedRows] = await Promise.all([
      dshClient.listSessions(),
      dshClient.listArchivedSessions().catch((error) => {
        if (!archivePluginWarningLogged) {
          console.warn("[main] DSH archive manager is unavailable; using the workspace archive projection:", error);
          archivePluginWarningLogged = true;
        }
        return null;
      }),
    ]);
  } catch (error) {
    console.warn("[main] Failed to refresh sessions:", error);
    broadcastState();
    return;
  }

  const mappedThreads = mapDshSessionsToThreads(rawSessions);
  const visibleArchivedIds = Array.isArray(archivedRows)
    ? new Set(archivedRows.map((thread) => String(thread.id)))
    : null;
  if (visibleArchivedIds) archivePluginWarningLogged = false;
  state.threads = mappedThreads.filter((thread) => !archivedSessionIds.has(thread.id));
  state.archivedThreads = mappedThreads.filter((thread) =>
    archivedSessionIds.has(thread.id)
    && !pendingArchiveDeletionSessionIds.has(thread.id)
    && (visibleArchivedIds === null || visibleArchivedIds.has(thread.id))
  );

  if (state.activeThreadId && archivedSessionIds.has(state.activeThreadId)) {
    enterBlankNewThread();
  }

  if (state.activeThreadId) {
    state.activeThread = state.threads.find((t) => t.id === state.activeThreadId) || state.activeThread;
  }

  broadcastState();
}

const BUILTIN_DISPLAY_NAMES = {
  "info-digest-html": "动态信息汇总 HTML 报表",
  "weekly-report": "统计信息化动态采集与周报",
  "price-index-gdp-impact": "价格指数对 GDP 各项影响分析",
  "source-verification": "官方来源与转载核验",
  "gov-official-document-drafting": "政务公文起草",
  info_digest_html: "动态信息汇总 HTML 报表",
  weekly_report: "统计信息化动态采集与周报",
  price_index_gdp_impact: "价格指数对 GDP 各项影响分析",
  source_verification: "官方来源与转载核验",
  gov_official_document_drafting: "政务公文起草",
};

async function refreshSkills() {
  const dshHome = dshRuntime.dshHome || getDshHomeDir();

  let skills = [];
  if (dshClient && state.activeThreadId) {
    try {
      const dshSkills = await dshClient.listSkills(state.activeThreadId);
      if (dshSkills && dshSkills.length > 0) {
        skills = dshSkills.map((s) => ({
          name: s.name,
          displayName: BUILTIN_DISPLAY_NAMES[s.name] || s.displayName || s.metadata?.displayName || s.name,
          description: s.description || "",
          path: s.path || "",
        }));
      }
    } catch (error) {
      console.warn("[main] Failed to list skills from client:", error);
    }
  }

  if (skills.length === 0) {
    try {
      const localSkills = await scanLocalSkills(dshHome);
      skills = localSkills.map((s) => ({
        name: s.name,
        displayName: BUILTIN_DISPLAY_NAMES[s.name] || s.displayName || s.name,
        description: s.description || "",
        path: s.path || "",
      }));
    } catch (error) {
      console.warn("[main] Failed to scan local skills:", error);
    }
  }

  state.skills = skills;
  broadcastState();
}

/**
 * Wires DSH Client streaming and life-cycle events to Electron state.
 */
function setupDshEvents(client) {
  const installArchivedSessionIds = async (ids) => {
    archivedSessionIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
    if (state.activeThreadId && archivedSessionIds.has(state.activeThreadId)) {
      completedThreads.delete(state.activeThreadId);
      enterBlankNewThread();
    }
    await refreshThreads();
  };

  client.on("workspaceBaseline", (baseline) => {
    void installArchivedSessionIds(baseline?.archivedSessionIds);
  });

  client.on("workspaceArchivedSessions", (ids) => {
    void installArchivedSessionIds(ids);
  });

  client.on("approvalRequested", ({ eventId, agentId, request }) => {
    const interaction = {
      sessionId: state.activeThreadId || "",
      requestId: eventId,
      agentId,
      command: toSafeString(request?.toolName),
      description: toSafeString(request?.displayReason || request?.reason) || "DSH 工具请求权限审批",
      patternKey: toSafeString(request?.toolName) || "dsh-tool",
      allowPermanent: false,
    };
    pendingApprovals.set(eventId, interaction);
    state.pendingApproval = interaction;
    broadcastState();
  });

  client.on("userQuestionRequested", ({ eventId, agentId, request }) => {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) {
      void client.respondEventResult({
        clientId: client.clientId,
        eventId,
        outcome: {
          kind: "rejected",
          error: {
            name: "UserQuestionError",
            code: "BAD_REQUEST",
            message: "ask_user_question did not include any questions",
          },
        },
      }).catch((error) => console.warn("[main] Failed to reject an empty DSH question request:", error));
      return;
    }

    const interaction = {
      sessionId: state.activeThreadId,
      requestId: eventId,
      agentId,
      questions,
    };
    pendingUserQuestions.set(eventId, interaction);
    state.pendingClarification = interaction;
    broadcastState();
  });

  client.on("remoteEventCancelled", ({ eventId }) => {
    pendingApprovals.delete(eventId);
    pendingUserQuestions.delete(eventId);
    if (state.pendingApproval?.requestId === eventId) {
      state.pendingApproval = latestPendingForSession(pendingApprovals);
    }
    if (state.pendingClarification?.requestId === eventId) {
      state.pendingClarification = latestPendingForSession(pendingUserQuestions);
    }
    broadcastState();
  });

  client.on("textDelta", ({ text }) => {
    if (!state.activeDraft) {
      state.activeDraft = {
        id: randomUUID(),
        threadId: state.activeThreadId,
        text: "",
        pendingText: "",
        reasoning: "",
        activities: [],
      };
      state.busy = true;
    }

    closeRunningThinkingActivities();
    state.activeDraft.text = (state.activeDraft.text || "") + text;
    state.activeDraft.pendingText = state.activeDraft.text;
    broadcastState();
  });

  client.on("reasoningDelta", ({ text }) => {
    if (!state.activeDraft) {
      state.activeDraft = {
        id: randomUUID(),
        threadId: state.activeThreadId,
        text: "",
        pendingText: "",
        reasoning: "",
        activities: [],
      };
      state.busy = true;
    }

    state.activeDraft.reasoning = (state.activeDraft.reasoning || "") + text;
    upsertActiveDraftActivity({
      id: `thinking:${state.activeDraft.id}`,
      kind: "thinking",
      label: "思考中...",
      detail: state.activeDraft.reasoning,
      status: "running",
    });
    broadcastState();
  });

  client.on("toolCall", (call) => {
    closeRunningThinkingActivities();
    upsertActiveDraftActivity({
      id: call.callId || randomUUID(),
      kind: "tool",
      label: call.name || "Tool",
      toolName: call.name,
      detail: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      status: "running",
    });
    broadcastState();
  });

  client.on("toolResult", (result) => {
    if (state.activeDraft?.activities) {
      const target = state.activeDraft.activities.find(
        (a) => a.id === result.callId || (a.status === "running" && a.kind === "tool")
      );
      if (target) {
        target.status = "complete";
      }
    }
    broadcastState();
  });

  client.on("turnEnd", async () => {
    finishActiveDraftActivities();
    if (state.activeDraft) {
      state.messages = [
        ...state.messages,
        {
          id: state.activeDraft.id || randomUUID(),
          role: "assistant",
          text: state.activeDraft.text || "",
          reasoning: toSafeString(state.activeDraft.reasoning).trim() || null,
          turnId: null,
          activities: [...(state.activeDraft.activities || [])],
        },
      ];
      state.activeDraft = null;
    }

    state.busy = false;
    state.pendingApproval = latestPendingForSession(pendingApprovals);
    state.pendingClarification = latestPendingForSession(pendingUserQuestions);

    if (state.activeThreadId) {
      completedThreads.add(state.activeThreadId);
    }

    await refreshThreads();
    broadcastState();
  });

  client.on("sessionTitle", async ({ title }) => {
    if (title && state.activeThread) {
      state.activeThread.name = title;
      state.activeThread.preview = title;
      const th = state.threads.find((t) => t.id === state.activeThreadId);
      if (th) {
        th.name = title;
        th.preview = title;
      }
      broadcastState();
    }
  });

  client.on("globalEvent", async ({ event }) => {
    if (event === "api-session/added" || event === "api-session/removed") {
      await refreshThreads();
    }
  });
}

async function initializeBridge() {
  state.status = "正在准备 DSH 工作台...";
  state.error = null;
  state.runtime.installed = false;
  broadcastState();

  try {
    const settings = await loadSettings();
    // Older releases stored the provider key in this settings file. Keep it
    // only long enough to migrate it into DSH Credentials after startup.
    state.settings = { ...settings, apiKey: "" };

    state.status = "正在启动 DSH 运行时...";
    broadcastState();
    const runtimeInfo = await dshRuntime.start({ ...settings, apiKey: "" });
    dshClient = new DshClient(runtimeInfo);

    dshClient.connectWebSocket();
    setupDshEvents(dshClient);

    state.status = "正在同步模型和权限设置...";
    broadcastState();
    await Promise.all([
      configureDshProvider(settings),
      configureDshPermissionDefault(settings),
    ]);
    await refreshProviderCredentialStatus();
    await saveSettings(state.settings);
    // Account metadata is useful but should not hold the workspace behind a
    // slow RPC. The status update will arrive over the normal state broadcast.
    void refreshDshAccountState();

    const dshHome = dshRuntime.dshHome || getDshHomeDir();
    state.runtime = {
      installed: true,
      uninstalling: false,
      rootDir: dshHome,
      installDir: dshHome,
      homeDir: dshHome,
      bundledSourceDir: "",
      bundledWithApp: true,
    };

    state.status = "正在恢复最近的对话和技能...";
    broadcastState();
    // Wait for DSH's archive projection before choosing the startup session.
    // If the stream is unavailable, the later baseline event refreshes both lists.
    await dshClient.waitForWorkspaceBaseline();
    await refreshThreads();

    // If there is an existing session, select the most recent one; otherwise create a fresh session
    if (state.threads.length > 0) {
      const first = state.threads[0];
      await selectThread(first.id, { loadSkills: false });
    } else {
      // No sessions yet — show blank new-conversation state; a real session
      // will be created lazily when the user sends their first message.
      enterBlankNewThread();
    }

    state.status = "Ready.";
    state.error = null;
    broadcastState();
    // Skill discovery is non-critical for opening the workspace. Load it after
    // the chat surface is usable so a slow skills RPC cannot look like a hang.
    void refreshSkills();
  } catch (error) {
    console.error("[main] Failed to initialize DSH runtime:", error);
    state.status = "Runtime Error";
    state.error = error.message;
    state.runtime.installed = false;
    state.busy = false;
    broadcastState();
  }
}

async function selectThread(threadId, { loadSkills = true } = {}) {
  if (!dshClient || !threadId) return;

  state.activeThreadId = threadId;
  state.pendingApproval = latestPendingForSession(pendingApprovals, threadId);
  state.pendingClarification = latestPendingForSession(pendingUserQuestions, threadId);
  completedThreads.delete(threadId);
  state.activeThread = state.threads.find((t) => t.id === threadId) || null;

  dshClient.followSession(threadId);

  try {
    const proj = await dshClient.getProjections(threadId);
    const asOfSeq = proj?.asOfSeq ?? 0;
    const page = await dshClient.getPage({ sessionId: threadId, throughSeq: asOfSeq });
    if (state.activeThreadId !== threadId) return;
    state.messages = mapDshRecordsToMessages(page?.records || []);
  } catch (err) {
    console.warn(`[main] Failed to fetch session history for ${threadId}:`, err);
    if (state.activeThreadId === threadId) {
      state.messages = [];
    }
  }

  if (state.activeThreadId !== threadId) return;

  state.activeDraft = null;
  state.busy = false;
  state.pendingApproval = null;
  state.pendingClarification = null;
  if (loadSkills) await refreshSkills();
  broadcastState();
}

/**
 * Reset the app to a blank "new conversation" UI state without creating a
 * real DSH session. The session will be created lazily on the first sent
 * message by the sendMessage handler.
 */
function enterBlankNewThread() {
  dshClient?.unfollowSession();
  state.activeThreadId = null;
  state.activeThread = null;
  state.messages = [];
  state.activeDraft = null;
  state.busy = false;
  state.pendingApproval = null;
  state.pendingClarification = null;
}

async function createNewThread() {
  if (!dshClient) return;

  try {
    const cwd = state.settings.cwd || process.cwd();
    const result = await dshClient.createSession({ cwd });
    const sessionId = result.sessionId;

    if (state.settings.model) {
      await dshClient.selectModel({
        sessionId,
        provider: getSelectedModelProvider(),
        model: state.settings.model,
      });
      state.currentRuntimeModel = state.settings.model;
    }

    await refreshThreads();
    await selectThread(sessionId);
  } catch (err) {
    console.error("[main] Failed to create new session:", err);
    state.error = err.message;
    broadcastState();
  }
}


function createWindow() {
  const appIconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 925,
    minHeight: 625,
    title: "深小统",
    icon: appIconPath,
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const windowSession = mainWindow.webContents.session;
  const isMainAppAudioRequest = (webContents, requestingUrl, isMainFrame, mediaType) => {
    if (webContents !== mainWindow?.webContents || !isMainFrame || mediaType !== "audio") return false;
    const appUrl = webContents.getURL();
    if (!appUrl || !requestingUrl) return false;
    try {
      const requested = new URL(requestingUrl);
      const current = new URL(appUrl);
      return requested.protocol === "file:" && current.protocol === "file:"
        ? requested.pathname === current.pathname
        : requested.origin === current.origin;
    } catch {
      return false;
    }
  };
  windowSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => (
    permission === "media"
      && isMainAppAudioRequest(webContents, details.requestingUrl, details.isMainFrame, details.mediaType)
  ));
  windowSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = details.mediaTypes || [];
    const allow = permission === "media"
      && mediaTypes.includes("audio")
      && !mediaTypes.includes("video")
      && isMainAppAudioRequest(webContents, details.requestingUrl, details.isMainFrame, "audio");
    callback(allow);
  });

  mainWindow.setMenuBarVisibility(false);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.resolve(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle("dsh:getState", () => state);

ipcMain.handle("dsh:getSpeechCatalog", async () => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法读取语音识别状态");
  return dshClient.getSpeechCatalog();
});

ipcMain.handle("dsh:prepareSpeechProvider", async (_event, providerId) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法准备语音识别模型");
  return dshClient.prepareSpeechProvider(String(providerId));
});

ipcMain.handle("dsh:cancelSpeechPreparation", async (_event, providerId) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法取消语音模型准备");
  return dshClient.cancelSpeechPreparation(String(providerId));
});

ipcMain.handle("dsh:transcribeSpeech", async (_event, request) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法转写语音");
  return dshClient.transcribeSpeech(request);
});

ipcMain.handle("dsh:newThread", async () => {
  // Use lazy creation — just reset to blank state.
  // The actual DSH session is created on the first sendMessage call.
  enterBlankNewThread();
  broadcastState();
  return state;
});

ipcMain.handle("dsh:selectThread", async (_event, threadId) => {
  await selectThread(threadId);
  return state;
});

ipcMain.handle("dsh:ackThreadCompleted", async (_event, threadId) => {
  if (threadId) {
    completedThreads.delete(threadId);
    broadcastState();
  }
  return state;
});

ipcMain.handle("dsh:sendMessage", async (_event, payload) => {
  if (!dshClient) {
    throw new Error("DSH 后端尚未就绪");
  }

  const text = (payload?.text || "").trim();
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (!text && attachments.length === 0) {
    return state;
  }

  if (!state.activeThreadId) {
    await createNewThread();
  }

  const sid = state.activeThreadId;

  // Add user message
  state.messages.push({
    id: randomUUID(),
    role: "user",
    text,
    turnId: null,
  });

  // Prepare draft
  state.activeDraft = {
    id: randomUUID(),
    threadId: sid,
    text: "",
    pendingText: "",
    reasoning: "",
    activities: [],
  };
  state.busy = true;
  broadcastState();

  try {
    await dshClient.sendPrompt({
      sessionId: sid,
      text,
      attachments,
      mode: "queue",
    });
  } catch (error) {
    console.error("[main] Failed to send prompt:", error);
    state.error = error.message;
    state.busy = false;
    state.activeDraft = null;
    broadcastState();
  }

  return state;
});

ipcMain.handle("dsh:stopMessage", async () => {
  if (dshClient && state.activeThreadId) {
    try {
      await dshClient.cancelSession(state.activeThreadId);
    } catch (err) {
      console.warn("[main] Failed to cancel session:", err);
    }
  }

  preserveInterruptedDraft();
  state.busy = false;
  broadcastState();
  return state;
});

ipcMain.handle("dsh:switchSessionModel", async (_event, model) => {
  state.settings.model = model;
  state.currentRuntimeModel = model;

  if (dshClient && state.activeThreadId) {
    try {
      await dshClient.selectModel({
        sessionId: state.activeThreadId,
        provider: getSelectedModelProvider(),
        model,
      });
    } catch (err) {
      console.warn("[main] Failed to switch session model:", err);
    }
  }

  broadcastState();
  return state;
});

ipcMain.handle("dsh:archiveThread", async (_event, threadId) => {
  if (!dshClient || !threadId) {
    throw new Error("DSH 后端尚未就绪，无法移除对话");
  }

  const result = await dshClient.archiveSession(threadId);
  archivedSessionIds = new Set(Array.isArray(result?.archivedSessionIds) ? result.archivedSessionIds.map(String) : []);

  if (!archivedSessionIds.has(threadId)) {
    throw new Error("DSH 未确认对话已归档，侧边栏内容未更改");
  }

  if (state.activeThreadId === threadId) {
    completedThreads.delete(threadId);
    enterBlankNewThread();
  }

  await refreshThreads();
  return state;
});

ipcMain.handle("dsh:unarchiveThread", async (_event, threadId) => {
  if (!dshClient || !threadId) {
    throw new Error("DSH 后端尚未就绪，无法恢复对话");
  }

  const result = await dshClient.unarchiveSession(threadId);
  archivedSessionIds = new Set(Array.isArray(result?.archivedSessionIds) ? result.archivedSessionIds.map(String) : []);
  await refreshThreads();
  return state;
});

ipcMain.handle("dsh:deleteArchivedThread", async (_event, threadId) => {
  if (!dshClient || !threadId) {
    throw new Error("DSH 后端尚未就绪，无法删除对话");
  }
  if (!archivedSessionIds.has(String(threadId))) {
    throw new Error("只能从已归档列表彻底删除对话");
  }

  const result = await dshClient.permanentlyDeleteArchivedSession(String(threadId));
  const isPending = Array.isArray(result?.pending) && result.pending.map(String).includes(String(threadId));
  if (isPending) pendingArchiveDeletionSessionIds.add(String(threadId));
  else pendingArchiveDeletionSessionIds.delete(String(threadId));

  if (state.activeThreadId === threadId) {
    completedThreads.delete(threadId);
    enterBlankNewThread();
  }

  await refreshThreads();
  return { state, pendingDeletion: isPending };
});

ipcMain.handle("dsh:startAccountSignIn", async () => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法登录 DeepSeek 账号");

  const account = await dshClient.startAccountSignIn({
    client: getAccountClientMetadata(),
    callbackOrigin: dshClient.baseUrl,
  });
  state.account = account;
  accountAuthUrlOpenedAttemptId = null;

  if (account.attempt?.id && ["initializing", "waiting-browser", "exchanging", "committing"].includes(account.attempt.phase)) {
    accountLoginAttemptId = account.attempt.id;
    startAccountPolling();
    await openAccountAuthorization(account.attempt);
  }

  broadcastState();
  return state;
});

ipcMain.handle("dsh:cancelAccountSignIn", async () => {
  if (!dshClient) return state;
  const attemptId = state.account?.attempt?.id;
  if (attemptId) {
    state.account = await dshClient.cancelAccountSignIn(attemptId);
  }
  accountLoginAttemptId = null;
  stopAccountPolling();
  broadcastState();
  return state;
});

ipcMain.handle("dsh:signOutAccount", async () => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法退出 DeepSeek 账号");
  state.account = await dshClient.signOutAccount(getAccountClientMetadata());
  accountLoginAttemptId = null;
  stopAccountPolling();
  if (state.activeThreadId) {
    await dshClient.selectModel({
      sessionId: state.activeThreadId,
      provider: getSelectedModelProvider(),
      model: state.settings.model,
    });
  }
  broadcastState();
  return state;
});

ipcMain.handle("dsh:updateSettings", async (_event, nextSettings) => {
  const previousSettings = { ...state.settings };
  const updatedSettings = normalizeSettings({ ...state.settings, ...nextSettings });
  await configureDshProvider(updatedSettings);
  await configureDshPermissionDefault(updatedSettings);
  state.settings = { ...updatedSettings, apiKey: "" };
  await saveSettings(state.settings);
  await refreshProviderCredentialStatus();

  if (dshClient && state.activeThreadId && state.settings.model && (
    previousSettings.model !== state.settings.model ||
    previousSettings.apiProvider !== state.settings.apiProvider ||
    previousSettings.apiBaseUrl !== state.settings.apiBaseUrl ||
    previousSettings.apiKey !== updatedSettings.apiKey
  )) {
    await dshClient.selectModel({
      sessionId: state.activeThreadId,
      provider: getSelectedModelProvider(),
      model: state.settings.model,
    });
    state.currentRuntimeModel = state.settings.model;
  }

  broadcastState();
  return state;
});

ipcMain.handle("dsh:clearProviderApiKey", async (_event, provider) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法清除 API Key");
  if (!["deepseek", "openai", "openrouter", "custom"].includes(provider)) {
    throw new Error("不支持的 API Provider");
  }
  if (!state.providerCredentialStatus[provider]?.writable) {
    throw new Error("此凭据由只读环境提供，请在启动环境中移除");
  }

  await dshClient.unsetCredential(getProviderCredentialRef(provider));
  await refreshProviderCredentialStatus();

  if (provider === "deepseek" && state.activeThreadId) {
    await dshClient.selectModel({
      sessionId: state.activeThreadId,
      provider: getSelectedModelProvider(),
      model: state.settings.model,
    });
  }

  broadcastState();
  return state;
});

ipcMain.handle("dsh:selectWorkspaceFolder", async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择统计工作区文件夹",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: state.settings.cwd || process.cwd(),
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  state.settings.cwd = selectedPath;
  await saveSettings(state.settings);

  broadcastState();
  return {
    cwd: selectedPath,
    folderName: path.basename(selectedPath),
    branch: null,
  };
});

ipcMain.handle("dsh:selectFiles", async () => {
  if (!mainWindow) return [];

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择附加文件",
    properties: ["openFile", "multiSelections"],
  });

  if (result.canceled) return [];

  return Promise.all(result.filePaths.map(async (fp) => {
    let size;
    try {
      size = (await fs.stat(fp)).size;
    } catch {}
    return {
      path: fp,
      name: path.basename(fp),
      size,
    };
  }));
});

ipcMain.handle("dsh:respondApproval", async (_event, payload) => {
  const requestId = String(payload?.requestId || "");
  const choice = payload?.choice;
  const approval = pendingApprovals.get(requestId);
  if (!dshClient || !approval) {
    throw new Error("当前没有等待处理的 DSH 权限请求");
  }
  if (choice !== "once" && choice !== "deny") {
    throw new Error("DSH 权限请求只支持本次允许或拒绝");
  }

  await dshClient.respondEventResult({
    clientId: dshClient.clientId,
    eventId: requestId,
    outcome: { kind: "result", value: choice === "deny" ? "rejected" : "allowed-once" },
  });
  pendingApprovals.delete(requestId);
  state.pendingApproval = latestPendingForSession(pendingApprovals, approval.sessionId);
  broadcastState();
  return state;
});

ipcMain.handle("dsh:respondClarification", async (_event, payload) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法提交回答");
  const requestId = String(payload?.requestId || "");
  const interaction = pendingUserQuestions.get(requestId);
  if (!interaction) throw new Error("这条 DSH 提问已结束或不再等待回答");
  if (!Array.isArray(payload?.answers)) throw new Error("DSH 提问回答格式无效");

  const expectedIds = new Set(interaction.questions.map((question) => question.id));
  const answers = payload.answers.map((answer) => ({
    id: String(answer?.id || ""),
    selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
    ...(typeof answer?.custom === "string" && answer.custom !== "" ? { custom: answer.custom } : {}),
  }));
  if (answers.length !== expectedIds.size || answers.some((answer) => !expectedIds.delete(answer.id)) || expectedIds.size !== 0) {
    throw new Error("回答必须与 DSH 提问逐项对应");
  }

  await dshClient.respondEventResult({
    clientId: dshClient.clientId,
    eventId: requestId,
    outcome: { kind: "result", value: { answers } },
  });
  pendingUserQuestions.delete(requestId);
  state.pendingClarification = latestPendingForSession(pendingUserQuestions);
  broadcastState();
  return state;
});

ipcMain.handle("dsh:cancelClarification", async (_event, requestId) => {
  if (!dshClient) throw new Error("DSH 后端尚未就绪，无法关闭提问");
  const id = String(requestId || "");
  const interaction = pendingUserQuestions.get(id);
  if (!interaction) throw new Error("这条 DSH 提问已结束或不再等待回答");

  await dshClient.respondEventResult({
    clientId: dshClient.clientId,
    eventId: id,
    outcome: {
      kind: "rejected",
      error: {
        name: "UserQuestionError",
        code: "ASK_CANCELLED",
        message: "The user cancelled ask_user_question",
      },
    },
  });
  pendingUserQuestions.delete(id);
  state.pendingClarification = latestPendingForSession(pendingUserQuestions);
  broadcastState();
  return state;
});

ipcMain.handle("dsh:openExternal", async (_event, targetUrl) => {
  if (targetUrl) {
    await shell.openExternal(targetUrl);
  }
});

ipcMain.handle("dsh:registerSkillFile", async () => {
  if (!mainWindow) return state;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择技能文件或目录",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "Skill Markdown", extensions: ["md"] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return state;
  }

  const selectedPath = result.filePaths[0];
  const dshHome = dshRuntime.dshHome || getDshHomeDir();
  const dshSkillsDir = path.join(dshHome, "skills");

  try {
    const baseName = path.basename(selectedPath);
    const dest = path.join(dshSkillsDir, baseName);
    await fs.cp(selectedPath, dest, { recursive: true, force: true });
    await refreshSkills();
  } catch (err) {
    console.error("[main] Failed to register skill file:", err);
  }

  return state;
});

ipcMain.handle("dsh:unregisterSkill", async (_event, skillNameOrPath) => {
  const dshHome = dshRuntime.dshHome || getDshHomeDir();
  const dshSkillsDir = path.join(dshHome, "skills");

  try {
    const target = path.join(dshSkillsDir, path.basename(skillNameOrPath));
    if (existsSync(target)) {
      await fs.rm(target, { recursive: true, force: true });
    }
    await refreshSkills();
  } catch (err) {
    console.error("[main] Failed to unregister skill:", err);
  }

  return state;
});

ipcMain.handle("dsh:repairRuntime", async () => {
  if (dshClient) {
    dshClient.dispose();
    dshClient = null;
  }
  await dshRuntime.stop();
  await initializeBridge();
  return state;
});
// --- App Lifecycle ---

app.whenReady().then(async () => {
  app.setName("深小统");
  applyPlatformIcon();
  createWindow();
  await initializeBridge();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let runtimeShutdownPromise = null;
let runtimeShutdownComplete = false;
app.on("before-quit", (event) => {
  if (runtimeShutdownComplete) return;

  event.preventDefault();
  if (runtimeShutdownPromise) return;

  stopAccountPolling();
  if (dshClient) {
    dshClient.dispose();
    dshClient = null;
  }

  runtimeShutdownPromise = dshRuntime.stop()
    .catch((error) => console.warn("[main] Failed to stop DSH cleanly:", error))
    .finally(() => {
      runtimeShutdownComplete = true;
      app.quit();
    });
});
