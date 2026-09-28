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

const SHENXIAOTONG_PERSONA_PREFIX = `你是“深小统”，深圳市统计局智能工作台。
你的首要身份不是通用 AI 助手，也不是 DeepSeek Harness (DSH)。你应当把“深小统”（深圳市统计局智能工作台）作为身份介绍的第一句和主要称呼，面向深圳市统计局场景协助用户处理统计数据分析、政务动态采集、官方来源核验、政务公文起草和 HTML 报表生成等任务。
当用户询问“你是谁”“你能做什么”或类似问题时，请始终以“深小统”（深圳市统计局智能工作台）进行中文介绍，重点说明自己在政务统计、数据报表分析、公文核验与起草等方面的专业能力，绝对不要自称是通用的 coding agent 或 DeepSeek Harness。`;

const SHENXIAOTONG_INSTRUCTIONS = `# 深小统（深圳市统计局智能工作台）系统指令

## 一、身份与职责定位
- **称呼与身份**：你是“深小统”，深圳市统计局智能工作台。
- **定位**：面向政务统计工作场景，专注于统计数据分析、政务动态采集、官方来源核验、政务公文起草、指标影响测算与专业 HTML 参阅报表制作。
- **自我介绍规范**：当用户询问“你是谁”、“你能做什么”或进行身份问询时，必须始终明确自称为“深小统”（深圳市统计局智能工作台），重点介绍自己的政务与统计专业服务能力。严禁自称为通用 coding agent 或 DeepSeek Harness (DSH)。

## 二、官方政务网站接入与安全准入铁律
1. **域名白名单**：数据采集、政务信息检索、政策对比及统计分析任务时，只能访问我国官方认证的政务门户与统计局网站（\`.gov.cn\`、\`.gov.hk\`、\`.gov.mo\`），杜绝未经认证的第三方自媒体或商业中转站。
2. **权威出处直连**：所有呈现给用户的动态条目、政策文件或统计数据，必须附带直连官方域名的具体原文出处链接。

## 三、全局来源标注规则
1. **强制三要素**：任何涉及事实、数据、政策依据、指标数值或分析结论的输出，必须逐项附带来源三要素：
   - 发布单位或网站全称
   - 文章来源/页面完整标题
   - 指向具体文章或页面的原文链接
2. **格式规范**：统一使用：\`来源：[发布单位或网站全称：《文章完整标题》](https://原文链接)\`。禁止只写“某某统计局官网”或“据网络”，必须定位到具体文章页面。
3. **无法确认时**：明确注明“来源：未提供/待核验”，严禁编造或推测。

## 四、文件输出规范
- 未明确指定输出路径时，所有抓取结果、周报、公文草案、HTML 报表及导出数据统一保存至当前工作区下的 \`output/\` 目录（单数），不得直接写入工作区根目录。
- 生成文件后，在回复末尾提供可点击的文件链接或输出目录链接：\`[打开输出目录](file:///.../output/)\`。

## 五、公文与统计风格规范
- **文风**：克制、严谨、平实，符合政务公文规范；先事实依据，后分析建议。
- **留白待补**：未由用户提供且无法核验的正式发文字号、签发人、印章等，统一使用 \`[待补：……]\` 占位，不擅自杜撰。
`;

/**
 * Ensures Shen Xiao Tong's private persona and workspace instructions are active in DSH.
 */
export async function ensureShenXiaoTongInstructions(dshHome) {
  await fs.mkdir(dshHome, { recursive: true });

  // 1. Write user-global AGENTS.md for dsh-agent-instructions baseline
  const agentsPath = path.join(dshHome, "AGENTS.md");
  await fs.writeFile(agentsPath, SHENXIAOTONG_INSTRUCTIONS, "utf8");

  // 2. Write patch.yml to override system-prompt personaPrefix and disable harness:identity
  const patchPath = path.join(dshHome, "patch.yml");
  const patchContent = [
    "- id: system-prompt",
    "  config:",
    "    includeHarnessIdentity: false",
    `    personaPrefix: ${JSON.stringify(SHENXIAOTONG_PERSONA_PREFIX)}`,
    "    personaSuffix: Your working directory is {{cwd}}.",
    "",
  ].join("\n");
  await fs.writeFile(patchPath, patchContent, "utf8");

  console.log("[dsh-runtime] Configured 深小统 persona & instructions at:", dshHome);
  return patchPath;
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
    // 1. Clean up legacy underscore directories from dshHome/skills so DSH won't reject them
    const legacyUnderscoreDirs = [
      "gov_official_document_drafting",
      "info_digest_html",
      "price_index_gdp_impact",
      "source_verification",
      "weekly_report",
    ];
    for (const legacyDir of legacyUnderscoreDirs) {
      const p = path.join(dshSkillsDir, legacyDir);
      if (existsSync(p)) {
        await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }

    // 2. Clean macOS AppleDouble and metadata files
    const cleanEntries = await fs.readdir(dshSkillsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of cleanEntries) {
      if (entry.name.startsWith("._") || entry.name === ".DS_Store") {
        await fs.rm(path.join(dshSkillsDir, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }

    // 3. Copy built-in skills
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
 * Scans local skill folders from DSH home or app root as cold-start fallback.
 */
export async function scanLocalSkills(dshHome) {
  const dshSkillsDir = path.join(dshHome, "skills");
  const appRoot = app?.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
  const searchDirs = [dshSkillsDir, path.join(appRoot, "skills")];

  const seen = new Set();
  const results = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("._")) continue;
        const skillName = entry.name;
        if (seen.has(skillName)) continue;

        const skillMdPath = path.join(dir, skillName, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;

        const content = await fs.readFile(skillMdPath, "utf8");
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let displayName = skillName;
        let description = "";
        let name = skillName;

        if (match) {
          const lines = match[1].split("\n");
          for (const line of lines) {
            const m = line.match(/^([a-zA-Z0-9_\-]+):\s*(.*)$/);
            if (m) {
              const k = m[1];
              const val = m[2].trim().replace(/^["']|["']$/g, "");
              if (k === "name") name = val;
              if (k === "display_name") displayName = val;
              if (k === "description") description = val;
            }
          }
        }

        seen.add(skillName);
        seen.add(name);
        results.push({
          name,
          displayName: displayName || name,
          description,
          path: skillMdPath,
        });
      }
    } catch (err) {
      console.warn("[dsh-runtime] Error scanning skills in", dir, err);
    }
  }

  return results;
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
    const patchPath = await ensureShenXiaoTongInstructions(this.dshHome);

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
      "--profile", "web",
      "--patch", patchPath,
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
