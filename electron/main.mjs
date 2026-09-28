import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";

import { DshRuntimeManager, getDshHomeDir, resolveDshBinaryPath } from "./dsh-runtime.mjs";
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
  hermesBin: "",
  dshBin: resolveDshBinaryPath(),
  runtimeMode: "private",
  yoloMode: true,
  model: "deepseek-flash",
  cwd: "",
  defaultOutputDir: "output",
  customModels: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
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
  const input = settings ?? {};
  const defaultCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";

  let registeredSkills = Array.isArray(input.registeredSkills) ? [...input.registeredSkills] : [];
  registeredSkills = registeredSkills.filter((s) => s && s.name);

  return {
    ...defaultSettings,
    ...input,
    cwd: defaultCwd,
    defaultOutputDir: normalizeOutputDir(input.defaultOutputDir),
    registeredSkills,
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
    installed: true,
    uninstalling: false,
    rootDir: "",
    installDir: "",
    homeDir: "",
    bundledSourceDir: "",
    bundledWithApp: true,
  },
  official: {
    available: false,
    homeDir: "",
    configPath: "",
    authPath: "",
    provider: "deepseek",
    defaultModel: "deepseek-flash",
    isLoggedIn: true,
    subscriptionLabel: "DeepSeek",
    rateLimitSource: "",
    availableModels: ["deepseek-flash", "deepseek-v4-pro"],
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

// Set of threadIds completed
const completedThreads = new Set();

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
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
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

    mainWindow.webContents.send("hermes:state", state);
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
 * Maps DSH session items into HermesThreadSummary array expected by App.tsx.
 */
function mapDshSessionsToThreads(items = []) {
  return items.map((item) => {
    const title = item.projections?.title || item.title || (item.blank ? "新对话" : "未命名对话");
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
 * Maps DSH session/page records into HermesChatMessage array.
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

  try {
    const rawSessions = await dshClient.listSessions();
    state.threads = mapDshSessionsToThreads(rawSessions);

    if (state.activeThreadId) {
      state.activeThread = state.threads.find((t) => t.id === state.activeThreadId) || state.activeThread;
    }
  } catch (error) {
    console.warn("[main] Failed to refresh sessions:", error);
  }

  broadcastState();
}

async function refreshSkills() {
  if (!dshClient) return;

  try {
    const dshSkills = await dshClient.listSkills(state.activeThreadId);
    state.skills = (dshSkills || []).map((s) => ({
      name: s.name,
      displayName: s.displayName || s.name,
      description: s.description || "",
      path: s.path || "",
    }));
  } catch (error) {
    console.warn("[main] Failed to list skills:", error);
  }

  broadcastState();
}

/**
 * Wires DSH Client streaming and life-cycle events to Electron state.
 */
function setupDshEvents(client) {
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

  client.on("approvalAsked", (data) => {
    state.pendingApproval = {
      sessionId: state.activeThreadId,
      approvalId: data.id,
      command: data.toolName,
      description: data.reason || `工具 ${data.toolName} 需要权限审批`,
      patternKey: data.toolName,
      allowPermanent: true,
    };
    broadcastState();
  });

  client.on("approvalDecided", () => {
    state.pendingApproval = null;
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
    state.pendingApproval = null;
    state.pendingClarification = null;

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
  state.status = "Starting DeepSeek Harness runtime...";
  broadcastState();

  try {
    const settings = await loadSettings();
    state.settings = settings;

    const runtimeInfo = await dshRuntime.start(settings);
    dshClient = new DshClient(runtimeInfo);

    dshClient.connectWebSocket();
    setupDshEvents(dshClient);

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

    // Load initial sessions
    const rawSessions = await dshClient.listSessions();
    state.threads = mapDshSessionsToThreads(rawSessions);

    // If there is an existing session, select the most recent one; otherwise create a fresh session
    if (state.threads.length > 0) {
      const first = state.threads[0];
      await selectThread(first.id);
    } else {
      await createNewThread();
    }

    await refreshSkills();

    state.status = "Ready.";
    state.error = null;
    broadcastState();
  } catch (error) {
    console.error("[main] Failed to initialize DSH runtime:", error);
    state.status = "Runtime Error";
    state.error = error.message;
    state.busy = false;
    broadcastState();
  }
}

async function selectThread(threadId) {
  if (!dshClient || !threadId) return;

  state.activeThreadId = threadId;
  completedThreads.delete(threadId);
  state.activeThread = state.threads.find((t) => t.id === threadId) || null;

  dshClient.followSession(threadId);

  try {
    const proj = await dshClient.getProjections(threadId);
    const asOfSeq = proj?.asOfSeq ?? 0;
    const page = await dshClient.getPage({ sessionId: threadId, throughSeq: asOfSeq });
    state.messages = mapDshRecordsToMessages(page?.records || []);
  } catch (err) {
    console.warn(`[main] Failed to fetch session history for ${threadId}:`, err);
    state.messages = [];
  }

  state.activeDraft = null;
  state.busy = false;
  state.pendingApproval = null;
  state.pendingClarification = null;
  broadcastState();
}

async function createNewThread() {
  if (!dshClient) return;

  try {
    const cwd = state.settings.cwd || process.cwd();
    const result = await dshClient.createSession({ cwd });
    const sessionId = result.sessionId;

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

ipcMain.handle("hermes:getState", () => state);

ipcMain.handle("hermes:newThread", async () => {
  await createNewThread();
  return state;
});

ipcMain.handle("hermes:selectThread", async (_event, threadId) => {
  await selectThread(threadId);
  return state;
});

ipcMain.handle("hermes:ackThreadCompleted", async (_event, threadId) => {
  if (threadId) {
    completedThreads.delete(threadId);
    broadcastState();
  }
  return state;
});

ipcMain.handle("hermes:sendMessage", async (_event, payload) => {
  if (!dshClient) {
    throw new Error("DSH 后端尚未就绪");
  }

  const text = (payload?.text || "").trim();
  if (!text) {
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

ipcMain.handle("hermes:stopMessage", async () => {
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

ipcMain.handle("hermes:switchSessionModel", async (_event, model) => {
  state.settings.model = model;
  state.currentRuntimeModel = model;

  if (dshClient && state.activeThreadId) {
    try {
      await dshClient.selectModel({
        sessionId: state.activeThreadId,
        provider: "deepseek-official",
        model,
      });
    } catch (err) {
      console.warn("[main] Failed to switch session model:", err);
    }
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:archiveThread", async (_event, threadId) => {
  if (dshClient && threadId) {
    try {
      await dshClient.archiveSession(threadId);
    } catch (err) {
      console.warn("[main] Failed to archive session:", err);
    }
  }

  if (state.activeThreadId === threadId) {
    const remaining = state.threads.filter((t) => t.id !== threadId);
    if (remaining.length > 0) {
      await selectThread(remaining[0].id);
    } else {
      await createNewThread();
    }
  } else {
    await refreshThreads();
  }

  return state;
});

ipcMain.handle("hermes:updateSettings", async (_event, nextSettings) => {
  const previousSettings = { ...state.settings };
  state.settings = normalizeSettings({ ...state.settings, ...nextSettings });
  await saveSettings(state.settings);

  // If apiKey changed or backend needs restart
  if (previousSettings.apiKey !== state.settings.apiKey) {
    if (dshClient) {
      dshClient.dispose();
      dshClient = null;
    }
    await dshRuntime.stop();
    await initializeBridge();
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:selectWorkspaceFolder", async () => {
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

ipcMain.handle("hermes:selectFiles", async () => {
  if (!mainWindow) return [];

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择附加文件",
    properties: ["openFile", "multiSelections"],
  });

  if (result.canceled) return [];

  return result.filePaths.map((fp) => ({
    path: fp,
    name: path.basename(fp),
  }));
});

ipcMain.handle("hermes:respondApproval", async (_event, choice) => {
  const approval = state.pendingApproval;
  state.pendingApproval = null;
  broadcastState();

  if (dshClient && approval && dshClient.clientId) {
    try {
      const outcome = choice === "deny" ? { kind: "rejected" } : { kind: "result", value: "allowed-once" };
      await dshClient.respondEventResult({
        clientId: dshClient.clientId,
        eventId: approval.approvalId,
        outcome,
      });
    } catch (err) {
      console.warn("[main] Failed to respond to approval:", err);
    }
  }

  return state;
});

ipcMain.handle("hermes:respondClarification", async (_event, answer) => {
  state.pendingClarification = null;
  broadcastState();

  if (dshClient && answer && state.activeThreadId) {
    await dshClient.sendPrompt({
      sessionId: state.activeThreadId,
      text: answer,
    });
  }

  return state;
});

ipcMain.handle("hermes:openExternal", async (_event, targetUrl) => {
  if (targetUrl) {
    await shell.openExternal(targetUrl);
  }
});

ipcMain.handle("hermes:registerSkillFile", async () => {
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

ipcMain.handle("hermes:unregisterSkill", async (_event, skillNameOrPath) => {
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

ipcMain.handle("hermes:cancelOfficialLogin", async () => state);
ipcMain.handle("hermes:repairRuntime", async () => {
  if (dshClient) {
    dshClient.dispose();
    dshClient = null;
  }
  await dshRuntime.stop();
  await initializeBridge();
  return state;
});
ipcMain.handle("hermes:uninstallRuntime", async () => state);

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

app.on("before-quit", async () => {
  if (dshClient) {
    dshClient.dispose();
    dshClient = null;
  }
  await dshRuntime.stop();
});
