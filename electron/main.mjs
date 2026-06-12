import { randomUUID, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
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

function getRuntimeRoot() {
  return path.join(app.getPath("userData"), RUNTIME_DIRNAME);
}

function getRuntimeInstallDir() {
  return path.join(getRuntimeRoot(), "hermes-agent");
}

function getRuntimeHomeDir() {
  return path.join(getRuntimeRoot(), "hermes-home");
}

function getOfficialHermesHomeDir() {
  return path.join(app.getPath("home"), OFFICIAL_HERMES_DIRNAME);
}

function getDefaultHermesBinaryPath() {
  return path.join(getRuntimeInstallDir(), "hermes");
}

function getLegacyProjectRuntimeRoot() {
  return path.resolve(process.cwd(), ".runtime");
}

const defaultSettings = {
  hermesBin: getDefaultHermesBinaryPath(),
  runtimeMode: "private",
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
  const defaultCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();

  let registeredSkills = input.registeredSkills;
  if (!Array.isArray(registeredSkills)) {
    registeredSkills = [
      {
        name: "gov_digest",
        description: "政府公文摘要与情报提取",
        path: path.resolve(defaultCwd, "skills/gov_digest/SKILL.md"),
      },
      {
        name: "policy_classifier",
        description: "政策分类与政策匹配",
        path: path.resolve(defaultCwd, "skills/policy_classifier/SKILL.md"),
      },
    ];
  }

  return {
    ...defaultSettings,
    ...input,
    hermesBin: getDefaultHermesBinaryPath(),
    runtimeMode: input.runtimeMode === "official" ? "official" : "private",
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : defaultSettings.model,
    cwd: defaultCwd,
    apiProvider:
      typeof input.apiProvider === "string" ? input.apiProvider : defaultSettings.apiProvider,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : defaultSettings.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === "string" ? input.apiBaseUrl : defaultSettings.apiBaseUrl,
    registeredSkills,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeString(value) {
  return typeof value === "string" ? value : "";
}

function mapStoredSession(session, settings) {
  const timestamp = Number(session?.started_at ?? 0);
  const modelProvider = settings.runtimeMode === "official" ? "nous/free" : settings.apiProvider;
  return {
    id: String(session?.id ?? ""),
    name: toSafeString(session?.title) || null,
    preview: toSafeString(session?.preview),
    modelProvider,
    status: "idle",
    updatedAt: timestamp,
    createdAt: timestamp,
    cwd: settings.cwd,
  };
}

function mapGatewayMessages(messages) {
  return (messages ?? [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({
      id: randomUUID(),
      role: message.role,
      text: toSafeString(message.text),
      turnId: null,
    }));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
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
  };
}

async function updateLegacyHermesWrapper(runtimeBin) {
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

  await fs.rm(wrapperPath, { force: true });
}

async function ensureEmbeddedRuntimeInstalled() {
  const installDir = getRuntimeInstallDir();
  const runtimeRoot = getRuntimeRoot();
  const runtimeBin = getDefaultHermesBinaryPath();
  const sourceRoot = getBundledRuntimeRoot();

  const installed =
    (await pathExists(runtimeBin)) &&
    (await pathExists(path.join(installDir, "venv", "bin", "python")));

  if (!installed) {
    const sourceExists = await pathExists(sourceRoot);
    if (!sourceExists) {
      throw new Error(
        `Bundled Hermes runtime source not found: ${sourceRoot}. Please run npm run hermes:bootstrap first.`
      );
    }

    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.rm(runtimeRoot, { recursive: true, force: true });
    await fs.cp(sourceRoot, runtimeRoot, {
      recursive: true,
      dereference: true,
      force: true,
      errorOnExist: false,
      filter: (source) => {
        const normalized = source.split(path.sep).join("/");
        if (normalized.includes("/node_modules/electron/dist/Electron.app")) {
          return false;
        }
        return true;
      },
    });
  }

  await fs.mkdir(getRuntimeHomeDir(), { recursive: true });
  await lockRuntimeToElectron(runtimeBin);
  await updateLegacyHermesWrapper(runtimeBin);

  return buildRuntimeInfo(true);
}

async function uninstallEmbeddedRuntime() {
  const runtimeRoot = getRuntimeRoot();
  await cleanupHermesWrapper([path.join(runtimeRoot, "hermes-agent", "venv", "bin", "hermes")]);
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  return buildRuntimeInfo(false);
}

async function lockRuntimeToElectron(runtimeBin) {
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
  const provider = toSafeString(settings.apiProvider).trim() || "deepseek";
  const isOfficialMode = settings.runtimeMode === "official";

  env.HERMES_HOME = isOfficialMode ? getOfficialHermesHomeDir() : getRuntimeHomeDir();
  env.HERMES_DESKTOP = "1";
  env[ELECTRON_ONLY_LAUNCH_FLAG] = "1";
  if (sessionToken) {
    env.HERMES_DASHBOARD_SESSION_TOKEN = sessionToken;
  }
  if (!isOfficialMode) {
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

  if (launchConfig?.pythonPath) {
    env.PYTHONPATH = [launchConfig.pythonPath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }

  if (launchConfig?.webDist) {
    env.HERMES_WEB_DIST = launchConfig.webDist;
  }

  return env;
}

function resolveBackendLaunch() {
  const hermesBin = path.resolve(getDefaultHermesBinaryPath());
  const installDir = path.dirname(hermesBin);
  const venvPython = path.join(installDir, "venv", "bin", "python");
  const webDist = path.join(installDir, "hermes_cli", "web_dist");

  return {
    command: venvPython,
    argsPrefix: ["-m", "hermes_cli.main"],
    pythonPath: installDir,
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
  if (!proc || proc.killed) {
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
    this.isStopping = true;
    this.gatewayReady = false;
    this.connection = null;
    this.startPromise = null;
    this.latestStartupError = null;

    await this.client.dispose();

    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      await terminateProcessTree(proc, "hermes-backend");
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
    return this.request("session.create", {
      cwd: this.settings.cwd || process.cwd(),
      cols: 120,
    });
  }

  async resumeThread(threadId) {
    return this.request("session.resume", {
      session_id: threadId,
      cols: 120,
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

let state = {
  status: "Starting Hermes runtime...",
  error: null,
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

  state.busy = true;
  state.error = null;
  broadcastState();

  try {
    if (activeGatewaySessionId) {
      await bridge.closeSession(activeGatewaySessionId);
    }

    const result = await bridge.resumeThread(threadId);
    activeGatewaySessionId = String(result.session_id ?? "");

    state.activeThreadId = String(result.session_key ?? threadId);
    state.activeThread =
      state.threads.find((thread) => thread.id === state.activeThreadId) ??
      mapStoredSession(
        {
          id: state.activeThreadId,
          title: result.info?.title ?? "",
          preview: "",
          started_at: Date.now() / 1000,
        },
        state.settings
      );
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
  if (bridge && activeGatewaySessionId) {
    await bridge.closeSession(activeGatewaySessionId);
  }

  activeGatewaySessionId = null;
  state.activeThreadId = null;
  state.activeThread = null;
  state.messages = [];
  state.activeDraft = null;
  state.error = null;
  state.status = "Ready.";
  broadcastState();
}

async function syncMessagesFromGateway() {
  if (!bridge || !activeGatewaySessionId) {
    return;
  }

  const history = await bridge.getSessionHistory(activeGatewaySessionId);
  state.messages = mapGatewayMessages(history.messages);
}

async function initializeBridge() {
  const settings = await loadSettings();
  state.settings = settings;
  state.skills = settings.registeredSkills || [];
  state.runtime = await ensureEmbeddedRuntimeInstalled();
  state.official = await inspectOfficialHermesConfig();
  bridge = new HermesGatewayBridge(settings);

  bridge.onNotification((message) => {
    console.log("[hermes-bridge:notification]", message.type, message.session_id ?? "", message.payload ?? {});
    if (message.type === "error") {
      state.error = message.payload?.message ?? "Hermes runtime error.";
      state.status = state.error;
      state.busy = false;
      state.activeDraft = null;
      broadcastState();
      return;
    }

    if (!activeGatewaySessionId || message.session_id !== activeGatewaySessionId) {
      return;
    }

    if (message.type === "message.delta" && state.activeDraft) {
      state.activeDraft.text += toSafeString(message.payload?.text);
      broadcastState();
      return;
    }

    if (message.type === "message.complete" && state.activeDraft) {
      state.activeDraft.text = toSafeString(message.payload?.text);
      broadcastState();
      return;
    }

    if (message.type === "session.info" && state.activeThread) {
      state.activeThread = {
        ...state.activeThread,
        modelProvider: state.settings.runtimeMode === "official" ? "nous/free" : state.settings.apiProvider,
        status: message.payload?.lazy ? "starting" : "idle",
        cwd: toSafeString(message.payload?.cwd) || state.activeThread.cwd,
      };
      broadcastState();
      return;
    }
  });

  try {
    await bridge.start();
    state.status = "Ready.";
    state.error = null;
    await refreshThreads();
    if (state.threads.length > 0) {
      await loadActiveThread(state.threads[0].id);
    } else {
      await startNewConversation();
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Failed to start Hermes backend.";
    state.status = state.error;
    state.runtime = buildRuntimeInfo(await pathExists(getDefaultHermesBinaryPath()));
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

app.on("before-quit", async () => {
  if (bridge) {
    await bridge.dispose();
  }
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

  if (state.settings.runtimeMode !== "official" && !toSafeString(state.settings.apiKey).trim()) {
    state.error = "Missing API key. Open Settings and configure your model provider first.";
    state.status = state.error;
    broadcastState();
    return state;
  }

  state.busy = true;
  state.error = null;
  state.status = "Running...";
  broadcastState();

  try {
    if (!activeGatewaySessionId) {
      console.log("[hermes-send] creating session");
      const session = await bridge.createSession();
      activeGatewaySessionId = String(session.session_id ?? "");
      state.activeThreadId = String(session.stored_session_id ?? "");
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
    };
    broadcastState();

    console.log("[hermes-send] submitting prompt", activeGatewaySessionId, text);
    await bridge.sendPrompt(activeGatewaySessionId, text);

    await new Promise((resolve, reject) => {
      const unsubscribe = bridge.onNotification((message) => {
        if (message.session_id !== activeGatewaySessionId) {
          return;
        }

        if (message.type === "message.complete") {
          console.log("[hermes-send] message complete");
          unsubscribe();
          resolve();
          return;
        }

        if (message.type === "error") {
          console.error("[hermes-send] message error", message.payload);
          unsubscribe();
          reject(new Error(message.payload?.message ?? "Failed to complete turn."));
        }
      });
    });

    await syncMessagesFromGateway();
    state.activeDraft = null;
    await refreshThreads();
    state.status = "Ready.";
  } catch (error) {
    console.error("[hermes-send] failed", error);
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

ipcMain.handle("hermes:updateSettings", async (_event, nextSettings) => {
  const merged = normalizeSettings({ ...state.settings, ...nextSettings });
  state.settings = merged;
  state.skills = merged.registeredSkills || [];
  state.official = await inspectOfficialHermesConfig();
  await saveSettings(merged);

  if (bridge) {
    activeGatewaySessionId = null;
    state.activeThreadId = null;
    state.activeThread = null;
    state.messages = [];
    state.activeDraft = null;

    try {
      await bridge.updateSettings(merged);
      state.error = null;
      state.status = "Ready.";
      await refreshThreads();
      if (state.threads.length > 0) {
        await loadActiveThread(state.threads[0].id);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Failed to restart Hermes backend.";
      state.status = state.error;
    }
  }

  broadcastState();
  return state;
});

ipcMain.handle("hermes:repairRuntime", async () => {
  state.status = "Installing embedded Hermes runtime...";
  state.error = null;
  broadcastState();

  try {
    state.runtime = await ensureEmbeddedRuntimeInstalled();
    state.official = await inspectOfficialHermesConfig();

    if (bridge) {
      activeGatewaySessionId = null;
      state.activeThreadId = null;
      state.activeThread = null;
      state.messages = [];
      state.activeDraft = null;
      await bridge.restart();
      await refreshThreads();
      state.status = "Ready.";
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
    if (bridge) {
      await bridge.dispose();
    }

    bridge = null;
    activeGatewaySessionId = null;
    state.activeThreadId = null;
    state.activeThread = null;
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

  broadcastState();
  return state;
});

ipcMain.handle("hermes:openExternal", (_event, url) => shell.openExternal(String(url)));
