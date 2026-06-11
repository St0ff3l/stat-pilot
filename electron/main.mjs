import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const SETTINGS_FILE = "settings.json";

function getDefaultHermesBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ".runtime", "hermes-agent", "hermes");
  }

  return path.resolve(process.cwd(), ".runtime/hermes-agent/hermes");
}

const defaultSettings = {
  hermesBin: getDefaultHermesBinaryPath(),
  model: "deepseek-chat",
  cwd: process.cwd(),
  apiProvider: "deepseek",
  apiKey: "",
  apiBaseUrl: "",
  registeredSkills: [],
};

function normalizeSettings(settings) {
  const input = settings ?? {};
  const legacyBin = typeof input.codexBin === "string" ? input.codexBin : undefined;

  let registeredSkills = input.registeredSkills;
  if (!Array.isArray(registeredSkills)) {
    registeredSkills = [
      {
        name: "gov_digest",
        description: "政府公文摘要与情报提取",
        path: path.resolve(input.cwd || process.cwd(), "skills/gov_digest/SKILL.md"),
      },
      {
        name: "policy_classifier",
        description: "政策分类与政策匹配",
        path: path.resolve(input.cwd || process.cwd(), "skills/policy_classifier/SKILL.md"),
      }
    ];
  }

  return {
    ...defaultSettings,
    ...input,
    hermesBin: typeof input.hermesBin === "string" ? input.hermesBin : legacyBin ?? defaultSettings.hermesBin,
    apiProvider: typeof input.apiProvider === "string" ? input.apiProvider : defaultSettings.apiProvider,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : defaultSettings.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === "string" ? input.apiBaseUrl : defaultSettings.apiBaseUrl,
    registeredSkills,
  };
}

function resolveHermesBinary(settings) {
  const candidates = [
    settings?.hermesBin,
    process.env.HERMES_BIN,
    "hermes",
    process.env.CODEX_BIN,
    "codex",
  ].filter((value) => typeof value === "string" && value.trim().length > 0);

  return candidates[0] ?? defaultSettings.hermesBin;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeString(value) {
  return typeof value === "string" ? value : "";
}

function flattenUserInput(content) {
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return `[image: ${item.url}]`;
      }
      if (item.type === "localImage") {
        return `[local image: ${item.path}]`;
      }
      if (item.type === "skill") {
        return `[skill: ${item.name}]`;
      }
      if (item.type === "mention") {
        return `@${item.name}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function threadToMessages(thread) {
  const messages = [];

  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = flattenUserInput(item.content);
        if (text) {
          messages.push({
            id: item.id,
            role: "user",
            text,
            turnId: turn.id,
          });
        }
        continue;
      }

      if (item.type === "agentMessage") {
        if (item.text) {
          messages.push({
            id: item.id,
            role: "assistant",
            text: item.text,
            turnId: turn.id,
            phase: item.phase,
          });
        }
        continue;
      }

      if (item.type === "plan" && item.text) {
        messages.push({
          id: item.id,
          role: "assistant",
          text: item.text,
          turnId: turn.id,
          meta: "plan",
        });
      }
    }
  }

  return messages;
}

function mapThreadSummary(thread) {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    modelProvider: thread.modelProvider,
    status: thread.status,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
    cwd: thread.cwd,
  };
}

class HermesAppServerBridge {
  constructor(settings) {
    this.settings = { ...defaultSettings, ...settings };
    this.runtimeBin = resolveHermesBinary(this.settings);
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.initialized = false;
  }

  async updateSettings(nextSettings) {
    const prevBin = this.settings.hermesBin;
    this.settings = normalizeSettings(nextSettings);
    this.runtimeBin = resolveHermesBinary(this.settings);

    if (prevBin !== this.settings.hermesBin) {
      await this.restart();
    }
  }

  async restart() {
    await this.dispose();
    await this.start();
  }

  async dispose() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    for (const entry of this.pending.values()) {
      entry.reject(new Error("Hermes runtime connection closed."));
    }
    this.pending.clear();
  }

  async start() {
    if (this.proc) {
      return;
    }

    const childEnv = { ...process.env };
    if (this.settings.apiKey) {
      const provider = this.settings.apiProvider;
      if (provider === "openrouter") {
        childEnv.OPENROUTER_API_KEY = this.settings.apiKey;
      } else if (provider === "deepseek") {
        childEnv.DEEPSEEK_API_KEY = this.settings.apiKey;
      } else if (provider === "openai") {
        childEnv.OPENAI_API_KEY = this.settings.apiKey;
      } else if (provider === "custom") {
        childEnv.OPENAI_API_KEY = this.settings.apiKey;
      }
    }
    if (this.settings.apiBaseUrl) {
      childEnv.OPENAI_API_BASE = this.settings.apiBaseUrl;
      childEnv.OPENAI_BASE_URL = this.settings.apiBaseUrl;
    }

    this.proc = spawn(this.runtimeBin, ["app-server", "--stdio"], {
      cwd: this.settings.cwd || process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lineReader = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });

    lineReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        console.error("[hermes-runtime:parse-error]", line, error);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Hermes runtime error."));
          return;
        }

        pending.resolve(message.result);
        return;
      }

      for (const listener of this.notificationListeners) {
        listener(message);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error("[hermes-runtime:stderr]", text);
      }
    });

    this.proc.on("error", (error) => {
      const missingBinaryMessage =
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? `找不到 Hermes 可执行文件。请先运行 npm run hermes:bootstrap，或把 Hermes/Codex 可执行文件放到 HERMES_BIN / settings.hermesBin 指向的位置。`
          : null;

      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();

      for (const listener of this.notificationListeners) {
        listener({
          method: "error",
          params: {
            code: -1,
            message:
              missingBinaryMessage ??
              (error instanceof Error ? error.message : "Failed to start Hermes runtime."),
          },
        });
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      this.initialized = false;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("Hermes runtime exited unexpectedly."));
      }
      this.pending.clear();

      for (const listener of this.notificationListeners) {
        listener({
          method: "error",
          params: {
            code: code ?? -1,
            message: `Hermes runtime exited (${signal ?? "no signal"}).`,
          },
        });
      }
    });

    await this.initialize();
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await this.request({
      method: "initialize",
      params: {
        clientInfo: {
          name: "sz_gov_scope_hermes",
          title: "SZ Gov Scope",
          version: "0.2.0",
        },
      },
    });

    const extraRootsSet = new Set();
    for (const skill of this.settings.registeredSkills || []) {
      if (skill.path) {
        extraRootsSet.add(path.dirname(path.dirname(skill.path)));
      }
    }
    const extraRoots = Array.from(extraRootsSet);

    await this.request({
      method: "skills/extraRoots/set",
      params: {
        extraRoots: extraRoots.length > 0 ? extraRoots : [path.resolve(this.settings.cwd || process.cwd(), "skills")],
      },
    }).catch((error) => {
      console.error("[hermes-runtime:skills-roots-error]", error);
    });

    this.sendNotification({ method: "initialized" });
    this.initialized = true;
  }

  sendNotification(message) {
    if (!this.proc) {
      throw new Error("Hermes runtime is not running.");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(message) {
    await this.start();

    if (!this.proc) {
      throw new Error("Hermes runtime failed to start.");
    }

    const id = this.nextId++;
    const payload = { ...message, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async listThreads() {
    const result = await this.request({
      method: "thread/list",
      params: {
        limit: 50,
        useStateDbOnly: false,
      },
    });

    return (result.data ?? []).map(mapThreadSummary);
  }

  async readThread(threadId) {
    const result = await this.request({
      method: "thread/read",
      params: {
        threadId,
        includeTurns: true,
      },
    });

    return result.thread;
  }

  async resumeThread(threadId) {
    await this.request({
      method: "thread/resume",
      params: {
        threadId,
        model: this.settings.model || null,
        cwd: this.settings.cwd || process.cwd(),
      },
    });
  }

  async startThread() {
    const result = await this.request({
      method: "thread/start",
      params: {
        model: this.settings.model || null,
        cwd: this.settings.cwd || process.cwd(),
      },
    });

    return result.thread;
  }

  async sendTurn(threadId, text, onDelta) {
    const result = await this.request({
      method: "turn/start",
      params: {
        threadId,
        model: this.settings.model || null,
        input: [
          {
            type: "text",
            text,
            text_elements: [],
          },
        ],
      },
    });

    const turnId = result.turn.id;
    let finalText = "";

    const unsubscribe = this.onNotification((message) => {
      if (
        message.method === "item/agentMessage/delta" &&
        message.params.threadId === threadId &&
        message.params.turnId === turnId
      ) {
        finalText += message.params.delta;
        onDelta(finalText);
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const stop = this.onNotification((message) => {
          if (message.method === "turn/completed" && message.params.threadId === threadId) {
            stop();
            resolve();
          }

          if (message.method === "error") {
            stop();
            reject(new Error("Hermes runtime reported an error notification."));
          }
        });
      });
    } finally {
      unsubscribe();
    }

    return finalText.trim();
  }

  async archiveThread(threadId) {
    await this.request({
      method: "thread/archive",
      params: {
        threadId,
      },
    });
  }

  async listSkills() {
    return this.settings.registeredSkills || [];
  }
}

let mainWindow = null;
let state = {
  status: "Starting Hermes runtime...",
  error: null,
  settings: { ...defaultSettings },
  threads: [],
  activeThreadId: null,
  activeThread: null,
  messages: [],
  activeDraft: null,
  busy: false,
  skills: [],
};

let bridge = null;

function getSettingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...defaultSettings };
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
  broadcastState();
}

async function loadActiveThread(threadId) {
  if (!bridge) {
    return;
  }

  state.busy = true;
  state.error = null;
  broadcastState();

  try {
    await bridge.resumeThread(threadId);
    const thread = await bridge.readThread(threadId);
    state.activeThreadId = thread.id;
    state.activeThread = mapThreadSummary(thread);
    state.messages = threadToMessages(thread);
    state.activeDraft = null;
  } finally {
    state.busy = false;
    broadcastState();
  }
}

async function startNewConversation() {
  if (!bridge) {
    return;
  }

  state.activeThreadId = null;
  state.activeThread = null;
  state.messages = [];
  state.activeDraft = null;
  broadcastState();
}

async function initializeBridge() {
  const settings = await loadSettings();
  state.settings = settings;
  bridge = new HermesAppServerBridge(settings);

  bridge.onNotification((message) => {
    if (message.method === "error") {
      state.error = message.params?.message ?? "Hermes runtime error.";
      state.status = state.error;
      broadcastState();
    }

    if (message.method === "thread/started") {
      refreshThreads().catch((error) => {
        console.error(error);
      });
    }

    if (
      message.method === "item/agentMessage/delta" &&
      state.activeDraft &&
      message.params.threadId === state.activeThreadId &&
      message.params.turnId === state.activeDraft.turnId
    ) {
      state.activeDraft.text += message.params.delta;
      broadcastState();
    }

    if (
      message.method === "turn/completed" &&
      state.activeDraft &&
      message.params.threadId === state.activeThreadId &&
      message.params.turn.id === state.activeDraft.turnId
    ) {
      state.activeDraft = null;
      refreshThreads().catch((error) => {
        console.error(error);
      });
      if (state.activeThreadId) {
        loadActiveThread(state.activeThreadId).catch((error) => {
          console.error(error);
        });
      }
    }
  });

  try {
    await bridge.start();
    state.status = "Ready.";
    state.skills = await bridge.listSkills().catch((err) => {
      console.error(err);
      return [];
    });
    await refreshThreads();
    if (state.threads.length > 0) {
      await loadActiveThread(state.threads[0].id);
    } else {
      await startNewConversation();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to start Hermes runtime.";
    state.status = state.error;
  }

  broadcastState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "SZ Gov Scope",
    backgroundColor: "#f4f1e7",
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createWindow();
  await initializeBridge();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  if (bridge) {
    await bridge.dispose();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("hermes:getState", () => state);

ipcMain.handle("hermes:newThread", async () => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  await startNewConversation();
  return state;
});

ipcMain.handle("hermes:selectThread", async (_event, threadId) => {
  if (!bridge) {
    throw new Error("Hermes bridge is not ready.");
  }

  await loadActiveThread(String(threadId));
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

  state.busy = true;
  state.error = null;
  broadcastState();

  try {
    let threadId = state.activeThreadId;
    if (!threadId) {
      const thread = await bridge.startThread();
      threadId = thread.id;
      state.activeThreadId = threadId;
      state.activeThread = mapThreadSummary(thread);
    }

    state.activeDraft = {
      id: randomUUID(),
      threadId,
      text: "",
    };

    state.messages = [
      ...state.messages,
      {
        id: state.activeDraft.id,
        role: "user",
        text,
        turnId: null,
      },
    ];
    broadcastState();

    const assistantText = await bridge.sendTurn(threadId, text, (currentText) => {
      state.activeDraft.text = currentText;
      broadcastState();
    });

    if (assistantText) {
      state.messages = [
        ...state.messages,
        {
          id: randomUUID(),
          role: "assistant",
          text: assistantText,
          turnId: null,
        },
      ];
    }

    state.activeDraft = null;
    await refreshThreads();
    if (threadId) {
      await loadActiveThread(threadId);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to send message.";
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

  await bridge.archiveThread(String(threadId));
  if (state.activeThreadId === threadId) {
    await startNewConversation();
  }
  await refreshThreads();
  return state;
});

ipcMain.handle("hermes:updateSettings", async (_event, nextSettings) => {
  const merged = { ...defaultSettings, ...nextSettings };
  state.settings = merged;
  await saveSettings(merged);

  if (bridge) {
    await bridge.updateSettings(merged);
    state.skills = await bridge.listSkills().catch((err) => {
      console.error(err);
      return [];
    });
    await refreshThreads();
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
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    console.error("Failed to read selected skill file:", error);
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

  const exists = (state.settings.registeredSkills || []).some((s) => s.path === filePath);
  if (!exists) {
    const updatedSkills = [...(state.settings.registeredSkills || []), newSkill];
    const merged = {
      ...state.settings,
      registeredSkills: updatedSkills,
    };
    state.settings = merged;
    await saveSettings(merged);

    if (bridge) {
      await bridge.updateSettings(merged);
    }
    state.skills = updatedSkills;
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:unregisterSkill", async (_event, filePath) => {
  const updatedSkills = (state.settings.registeredSkills || []).filter(
    (s) => s.path !== filePath
  );
  const merged = {
    ...state.settings,
    registeredSkills: updatedSkills,
  };
  state.settings = merged;
  await saveSettings(merged);

  if (bridge) {
    await bridge.updateSettings(merged);
  }
  state.skills = updatedSkills;

  broadcastState();
  return state;
});

ipcMain.handle("hermes:openExternal", (_event, url) => shell.openExternal(String(url)));
