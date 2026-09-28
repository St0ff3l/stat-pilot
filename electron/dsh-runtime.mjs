import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { app } from "electron";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const userHomeDsh = path.join(app.getPath("home"), ".dsh");
  if (existsSync(userHomeDsh)) {
    return userHomeDsh;
  }

  return path.join(app.getPath("userData"), "dsh-home");
}

/**
 * Synchronizes built-in stat-pilot skills into $DSH_HOME/skills.
 */
export async function syncBuiltinSkills(dshHome) {
  const dshSkillsDir = path.join(dshHome, "skills");
  await fs.mkdir(dshSkillsDir, { recursive: true });

  const appRoot = app.isPackaged
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

    this.dshHome = getDshHomeDir();
    await fs.mkdir(this.dshHome, { recursive: true });
    await syncBuiltinSkills(this.dshHome);

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DSH_HOME: this.dshHome,
    };

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

    console.log("[dsh-runtime] Spawning DSH with:", process.execPath, spawnArgs.join(" "));

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
        this.process = spawn(process.execPath, spawnArgs, {
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
