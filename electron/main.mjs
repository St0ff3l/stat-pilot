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
      {
        name: "stats_gov_scraper",
        description: "国家统计局数据发布详情深度分析与本地入库器",
        path: path.resolve(defaultCwd, "skills/stats_gov_scraper/SKILL.md"),
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

      // Check if target already exists (could be a symlink, directory, or file)
      let exists = false;
      let isSymlink = false;
      try {
        const stat = await fs.lstat(targetPath);
        exists = true;
        isSymlink = stat.isSymbolicLink();
      } catch {
        // targetPath does not exist
      }

      if (exists) {
        if (isSymlink) {
          // Check if symlink target is correct
          try {
            const currentTarget = await fs.readlink(targetPath);
            if (path.resolve(currentTarget) === path.resolve(skillFolder)) {
              // Target is already correct, no need to recreate
              continue;
            }
          } catch {
            // failed to read symlink target, recreate it
          }
          await fs.unlink(targetPath);
        } else {
          // It exists but is a real file or directory (e.g. a built-in skill has the same name).
          // We shouldn't overwrite a built-in directory! Let's log a warning.
          console.warn(`Cannot symlink skill ${skill.name} to ${targetPath} because a real file/folder already exists there.`);
          continue;
        }
      }

      // Create symlink
      try {
        await fs.symlink(skillFolder, targetPath, "dir");
        console.log(`Created symlink for skill ${skill.name} -> ${skillFolder}`);
      } catch (err) {
        console.error(`Failed to create symlink for skill ${skill.name}:`, err);
      }
    }
  } catch (err) {
    console.error("Failed to sync registered skills:", err);
  }
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

async function scanDirectoryFiles(dirPath) {
  try {
    const list = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        list.push(path.join(dirPath, entry.name));
      } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== ".runtime" && entry.name !== "dist") {
        try {
          const subDirPath = path.join(dirPath, entry.name);
          const subEntries = await fs.readdir(subDirPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile()) {
              list.push(path.join(subDirPath, subEntry.name));
            }
          }
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
  env.PYTHONUNBUFFERED = "1";
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
      developerInstructions: 
        `【文件存储与对话规范】\n` +
        `1. 如果用户要求你进行数据抓取、文件爬取、导出报告或生成本地文档等涉及“输出文件/抓取数据”的任务，你必须调用本地文件写入工具，将生成的内容保存到当前工作区目录（CWD: ${cwd}）下。你可以存放在 CWD 根目录，或者 CWD 下的 outputs/ 或 scraped_data/ 目录中。\n` +
        `2. 在对话回复中，严禁直接展示庞大的原始数据（如大段的原始 JSON、长篇原始文本、超长的完整表格）。你只能在对话回复中说明文件保存的具体相对路径和文件名，并给出一个简明扼要的 150 字内核心摘要/结论，保持聊天界面整洁。\n` +
        `3. 请在回复中输出指向生成文件或文件夹的本地 file:// 协议链接（格式为 markdown 链接，例如：[打开输出目录](file://${cwd}/scraped_data/) ），以便用户点击。`,
    });
  }

  async resumeThread(threadId) {
    const cwd = this.settings.cwd || process.cwd();
    return this.request("session.resume", {
      session_id: threadId,
      cols: 120,
      developerInstructions: 
        `【文件存储与对话规范】\n` +
        `1. 如果用户要求你进行数据抓取、文件爬取、导出报告或生成本地文档等涉及“输出文件/抓取数据”的任务，你必须调用本地文件写入工具，将生成的内容保存到当前工作区目录（CWD: ${cwd}）下。你可以存放在 CWD 根目录，或者 CWD 下的 outputs/ 或 scraped_data/ 目录中。\n` +
        `2. 在对话回复中，严禁直接展示庞大的原始数据（如大段的原始 JSON、长篇原始文本、超长的完整表格）。你只能在对话回复中说明文件保存的具体相对路径和文件名，并给出一个简明扼要的 150 字内核心摘要/结论，保持聊天界面整洁。\n` +
        `3. 请在回复中输出指向生成文件或文件夹的本地 file:// 协议链接（格式为 markdown 链接，例如：[打开输出目录](file://${cwd}/scraped_data/) ），以便用户点击。`,
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

let state = {
  status: "Starting Hermes runtime...",
  error: null,
  currentRuntimeModel: null,
  lastUsageModel: null,
  reasoningTrace: null,
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
    if (activeSessionUnsubscribe) {
      activeSessionUnsubscribe();
      activeSessionUnsubscribe = null;
    }
    if (activeSessionReject) {
      activeSessionReject(new Error("Thread switched."));
      activeSessionReject = null;
    }

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
  if (activeSessionUnsubscribe) {
    activeSessionUnsubscribe();
    activeSessionUnsubscribe = null;
  }
  if (activeSessionReject) {
    activeSessionReject(new Error("Conversation was closed."));
    activeSessionReject = null;
  }

  if (bridge && activeGatewaySessionId) {
    try {
      await bridge.closeSession(activeGatewaySessionId);
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

    if (message.type === "reasoning.delta" && state.activeDraft) {
      const delta = toSafeString(message.payload?.text);
      state.reasoningTrace = `${state.reasoningTrace ?? ""}${delta}`;
      state.activeDraft = {
        ...state.activeDraft,
        reasoning: `${state.activeDraft.reasoning ?? ""}${delta}`,
      };
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
        state.activeDraft = {
          ...state.activeDraft,
          reasoning,
        };
      }
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
    };
    broadcastState();

    const targetCwd = state.settings.cwd || process.cwd();
    const beforeFiles = await scanDirectoryFiles(targetCwd);

    console.log("[hermes-send] submitting prompt", activeGatewaySessionId, text);
    await bridge.sendPrompt(activeGatewaySessionId, text);

    await waitForSessionCompletion(activeGatewaySessionId);
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
    state.error = error instanceof Error ? error.message : "Failed to send message.";
    state.status = state.error;
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
  });

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
    loginProc.on("close", (code) => {
      console.log("[hermes-login] exited with code:", code);
      state.official.userCode = null;
      broadcastState();
      if (!resolved) {
        resolved = true;
        resolve(code === 0);
      }
    });

    loginProc.on("error", (err) => {
      console.error("[hermes-login] error:", err);
      state.official.userCode = null;
      broadcastState();
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        state.official.userCode = null;
        broadcastState();
        try {
          loginProc.kill();
        } catch {}
        resolve(false);
      }
    }, 180000);
  });
}

ipcMain.handle("hermes:updateSettings", async (_event, nextSettings) => {
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

  if (loginOfficial) {
    await runOfficialHermesLogin(state.settings);
  }

  let merged = normalizeSettings({ ...state.settings, ...cleanSettings });

  if (merged.runtimeMode === "official") {
    await updateOfficialHermesDefaultModel(merged.model);
  }

  state.official = await inspectOfficialHermesConfig();
  const reconciled = await reconcileOfficialModeSettings(merged, state.official);
  merged = reconciled.settings;
  state.settings = merged;
  state.skills = merged.registeredSkills || [];
  state.official = reconciled.official;
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

ipcMain.handle("hermes:openExternal", (_event, url) => shell.openExternal(String(url)));
