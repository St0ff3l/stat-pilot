import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import electron from "electron";
import { fileURLToPath } from "node:url";

const app = typeof electron === "object" && electron?.app ? electron.app : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves a standalone Node.js binary path.
 * Note: DSH (via node-addon-require-builtin) cannot run under Electron runtime
 * because Electron modifies V8 internal isolate/context layout.
 */
export function resolveNodeBinaryPath() {
  if (process.env.DSH_NODE_BIN && existsSync(process.env.DSH_NODE_BIN)) {
    return process.env.DSH_NODE_BIN;
  }

  // 1. Packaged resource candidate
  const resPath = process.resourcesPath || "";
  if (resPath) {
    const packagedNode = process.platform === "win32"
      ? path.join(resPath, "node.exe")
      : path.join(resPath, "node");
    if (existsSync(packagedNode)) {
      return packagedNode;
    }
  }

  // 2. Try which/where
  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const out = execSync(cmd, { encoding: "utf8", timeout: 2000 }).trim().split(/\r?\n/)[0].trim();
    if (out && existsSync(out)) {
      return out;
    }
  } catch {}

  // 3. Common system paths
  const commonPaths = process.platform === "win32" ? [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/node/node.exe"),
  ] : [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/bin/node",
  ];

  for (const candidate of commonPaths) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  // 4. Version managers (nvm, volta, fnm, asdf)
  const home = os.homedir();
  if (home) {
    const nvmDir = path.join(home, ".nvm/versions/node");
    if (existsSync(nvmDir)) {
      try {
        const versions = readdirSync(nvmDir);
        if (versions.length > 0) {
          const sorted = versions.sort();
          const candidate = path.join(nvmDir, sorted[sorted.length - 1], "bin/node");
          if (existsSync(candidate)) return candidate;
        }
      } catch {}
    }

    const voltaNode = process.platform === "win32"
      ? path.join(home, ".volta/bin/node.exe")
      : path.join(home, ".volta/bin/node");
    if (existsSync(voltaNode)) return voltaNode;

    const fnmNode = process.platform === "win32"
      ? path.join(home, ".fnm/current/node.exe")
      : path.join(home, ".fnm/current/bin/node");
    if (existsSync(fnmNode)) return fnmNode;

    const asdfNode = path.join(home, ".asdf/shims/node");
    if (existsSync(asdfNode)) return asdfNode;
  }

  // 5. If current process is not Electron, use process.execPath
  if (!process.versions.electron && process.execPath && existsSync(process.execPath)) {
    return process.execPath;
  }

  return "node";
}

/**
 * Resolves the path to the DSH CLI entry point.
 */
export function resolveDshBinaryPath(customPath) {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }

  const appPath = typeof app?.getAppPath === "function" ? app.getAppPath() : "";
  const resPath = process.resourcesPath || "";

  const candidates = [
    // Development or local node_modules
    path.resolve(__dirname, "../node_modules/@deepseek-ai/dsh/lib/bin.js"),
    // Electron packaged extraResources / unpacked
    path.resolve(resPath, "app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    path.resolve(resPath, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    ...(appPath ? [
      path.resolve(appPath, "../app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      path.resolve(appPath, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    ] : []),
    // macOS DSH Desktop fallback if available
    "/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js",
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

/**
 * Resolves the DSH Home directory.
 */
export function getDshHomeDir() {
  if (process.env.DSH_HOME && existsSync(process.env.DSH_HOME)) {
    return process.env.DSH_HOME;
  }

  const home = typeof app?.getPath === "function" ? app.getPath("home") : os.homedir();
  const userHomeDsh = path.join(home, ".dsh");
  if (existsSync(userHomeDsh)) {
    return userHomeDsh;
  }

  if (typeof app?.getPath === "function") {
    return path.join(app.getPath("userData"), "dsh-home");
  }

  return path.join(home, ".stat-pilot", "dsh-home");
}

/**
 * Synchronizes built-in stat-pilot skills into $DSH_HOME/skills.
 */
export async function syncBuiltinSkills(dshHome) {
  const dshSkillsDir = path.join(dshHome, "skills");
  await fs.mkdir(dshSkillsDir, { recursive: true });

  const appRoot = app?.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..");
  const srcSkillsDir = path.join(appRoot, "skills");

  if (!existsSync(srcSkillsDir)) {
    return;
  }

  try {
    const entries = await fs.readdir(srcSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("._")) {
        continue;
      }

      const srcDir = path.join(srcSkillsDir, entry.name);
      const destDir = path.join(dshSkillsDir, entry.name);

      await fs.cp(srcDir, destDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn("[dsh-runtime] Failed to sync skills:", error);
  }
}

/**
 * Manages the DSH subprocess lifecycle.
 */
export class DshRuntimeManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.host = null;
    this.baseUrl = null;
    this.cookie = null;
    this.tokenUrl = null;
    this.isRunning = false;
    this.dshHome = null;
  }

  async start(settings = {}) {
    if (this.isRunning && this.baseUrl) {
      return {
        baseUrl: this.baseUrl,
        host: this.host,
        cookie: this.cookie,
        tokenUrl: this.tokenUrl,
      };
    }

    const dshBin = resolveDshBinaryPath(settings.dshBin || settings.hermesBin);
    if (!existsSync(dshBin)) {
      throw new Error(`找不到 DSH 运行时入口: ${dshBin}`);
    }

    const nodeBin = resolveNodeBinaryPath();
    console.log("[dsh-runtime] Using Node binary:", nodeBin);

    this.dshHome = getDshHomeDir();
    await fs.mkdir(this.dshHome, { recursive: true });
    await syncBuiltinSkills(this.dshHome);

    const nodeDir = path.dirname(nodeBin);
    const extraPaths = process.platform === "win32"
      ? [nodeDir]
      : [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    const currentPath = process.env.PATH || "";
    const mergedPath = Array.from(new Set([...extraPaths, ...currentPath.split(path.delimiter)])).filter(Boolean).join(path.delimiter);

    const env = {
      ...process.env,
      PATH: mergedPath,
      DSH_HOME: this.dshHome,
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const apiKey = (settings.apiKey || process.env.DEEPSEEK_API_KEY || "").trim();
    if (apiKey) {
      env.DEEPSEEK_API_KEY = apiKey;
    }

    const spawnArgs = [
      dshBin,
      "web",
      "--port", "0",
      "--no-open",
      "--host", "127.0.0.1",
    ];

    console.log("[dsh-runtime] Spawning DSH with:", nodeBin, spawnArgs.join(" "));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.stop();
          reject(new Error("DSH 启动超时 (20秒内未输出 Web 服务地址)"));
        }
      }, 20000);

      try {
        this.process = spawn(nodeBin, spawnArgs, {
          env,
          cwd: settings.cwd || process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        clearTimeout(timeout);
        return reject(err);
      }

      this.process.on("error", (err) => {
        console.error("[dsh-runtime] Process error:", err);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.process.on("exit", (code, signal) => {
        console.log(`[dsh-runtime] Process exited with code ${code}, signal ${signal}`);
        this.isRunning = false;
        this.baseUrl = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`DSH 异常退出 (code: ${code}, signal: ${signal})`));
        }
      });

      this.process.stderr.on("data", (data) => {
        const text = data.toString();
        // Ignore noise, log warnings/errors
        if (!text.includes("ExperimentalWarning")) {
          console.warn("[dsh stderr]", text.trim());
        }
      });

      const rl = readline.createInterface({ input: this.process.stdout });
      rl.on("line", async (line) => {
        console.log("[dsh stdout]", line);

        const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[^\s]+)?)/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timeout);

          const fullUrl = match[1];
          this.tokenUrl = fullUrl;
          const parsed = new URL(fullUrl);
          this.host = parsed.host;
          this.port = parsed.port;
          this.baseUrl = `http://${this.host}`;

          // If there is an auth token in the URL, exchange it for a session cookie
          if (parsed.searchParams.has("token")) {
            try {
              const res = await fetch(fullUrl, {
                method: "GET",
                redirect: "manual",
                headers: { Host: this.host },
              });
              const rawCookie = res.headers.get("set-cookie");
              if (rawCookie) {
                this.cookie = rawCookie.split(";")[0].trim();
                console.log("[dsh-runtime] Authenticated with session cookie");
              }
            } catch (err) {
              console.warn("[dsh-runtime] Failed to exchange token for cookie:", err);
            }
          }

          this.isRunning = true;
          resolve({
            baseUrl: this.baseUrl,
            host: this.host,
            cookie: this.cookie,
            tokenUrl: this.tokenUrl,
          });
        }
      });
    });
  }

  async stop() {
    this.isRunning = false;
    this.baseUrl = null;
    this.cookie = null;

    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = null;

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve();
        }
      }, 2000);

      proc.once("exit", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      }
    });
  }
}
