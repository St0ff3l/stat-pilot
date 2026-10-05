import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { existsSync, lstatSync, promises as fs, readdirSync } from "node:fs";
import electron from "electron";
import { fileURLToPath } from "node:url";

const app = typeof electron === "object" && electron?.app ? electron.app : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARCHIVED_CHATS_BUNDLE = "dsh-archived-chats";
const VOICE_INPUT_BUNDLE = "@deepseek-ai/dsh-experimental-voice-input-bundle";
const DEFAULT_WEB_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

function resolveAppNodeModule(packageName) {
  const bundledResources = process.env.STAT_PILOT_VERIFY_RESOURCES || (app?.isPackaged ? process.resourcesPath : "");
  const candidates = bundledResources
    ? [
      path.resolve(bundledResources, "app.asar.unpacked/node_modules", packageName),
    ]
    : [path.resolve(__dirname, "../node_modules", packageName)];

  return candidates.find((candidate) => existsSync(path.join(candidate, "package.json"))) || candidates[0];
}

async function ensureProfileBundleLink(profileDir, packageDir, expectedManifest) {
  const modulesDir = path.join(profileDir, "node_modules");
  const packageLink = path.join(modulesDir, ARCHIVED_CHATS_BUNDLE);
  await fs.mkdir(modulesDir, { recursive: true });

  try {
    const installedManifest = JSON.parse(await fs.readFile(path.join(packageLink, "package.json"), "utf8"));
    if (installedManifest.name !== ARCHIVED_CHATS_BUNDLE || installedManifest.version !== expectedManifest.version) {
      throw new Error(
        `DSH Web profile 已安装冲突的归档插件 ${installedManifest.name || "未知包"}@${installedManifest.version || "未知版本"}`
      );
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const packageRealPath = await fs.realpath(packageDir);
  try {
    await fs.symlink(packageRealPath, packageLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const installedManifest = JSON.parse(await fs.readFile(path.join(packageLink, "package.json"), "utf8"));
    if (installedManifest.name !== ARCHIVED_CHATS_BUNDLE || installedManifest.version !== expectedManifest.version) {
      throw new Error(
        `DSH Web profile 已安装冲突的归档插件 ${installedManifest.name || "未知包"}@${installedManifest.version || "未知版本"}`
      );
    }
  }
}

/** Enable app-owned bundles while preserving other DSH profile choices. */
async function ensureWebProfileBundles(dshHome) {
  const pluginDir = resolveAppNodeModule(ARCHIVED_CHATS_BUNDLE);
  const pluginManifestPath = path.join(pluginDir, "package.json");
  if (!existsSync(pluginManifestPath)) {
    throw new Error(`找不到归档管理 DSH 插件: ${pluginManifestPath}`);
  }
  const pluginManifest = JSON.parse(await fs.readFile(pluginManifestPath, "utf8"));
  const voiceBundleManifestPath = path.join(resolveAppNodeModule(VOICE_INPUT_BUNDLE), "package.json");
  if (!existsSync(voiceBundleManifestPath)) {
    throw new Error(`找不到 DSH 本地语音 Bundle: ${voiceBundleManifestPath}`);
  }

  const profileDir = path.join(dshHome, "profiles", "web");
  const profileManifestPath = path.join(profileDir, "package.json");
  await fs.mkdir(profileDir, { recursive: true });

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(profileManifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`无法读取 DSH Web profile 配置: ${profileManifestPath}`, { cause: error });
    }
    manifest = {
      name: "dsh-profile-web",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...DEFAULT_WEB_PROFILE_BUNDLES] } },
    };

    const profilePatchPath = path.join(profileDir, "cordis.patch.yml");
    if (!existsSync(profilePatchPath)) {
      await fs.writeFile(profilePatchPath, "# DSH Web profile patch layer.\n[]\n", "utf8");
    }
    const workspacePath = path.join(profileDir, "pnpm-workspace.yaml");
    if (!existsSync(workspacePath)) {
      await fs.writeFile(workspacePath, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
    }
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`DSH Web profile 配置格式无效: ${profileManifestPath}`);
  }

  if (manifest.dsh !== undefined && (!manifest.dsh || typeof manifest.dsh !== "object" || Array.isArray(manifest.dsh))) {
    throw new Error(`DSH Web profile 的 dsh 配置格式无效: ${profileManifestPath}`);
  }
  if (manifest.dependencies !== undefined
    && (!manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies))) {
    throw new Error(`DSH Web profile 的 dependencies 配置格式无效: ${profileManifestPath}`);
  }
  const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  if (dependencies[ARCHIVED_CHATS_BUNDLE] !== undefined
    && (typeof dependencies[ARCHIVED_CHATS_BUNDLE] !== "string" || dependencies[ARCHIVED_CHATS_BUNDLE] === "")) {
    throw new Error(`DSH Web profile 的 ${ARCHIVED_CHATS_BUNDLE} 依赖格式无效: ${profileManifestPath}`);
  }
  const dshConfig = manifest.dsh && typeof manifest.dsh === "object" ? manifest.dsh : {};
  if (dshConfig.profile !== undefined && (!dshConfig.profile || typeof dshConfig.profile !== "object" || Array.isArray(dshConfig.profile))) {
    throw new Error(`DSH Web profile 的 profile 配置格式无效: ${profileManifestPath}`);
  }
  const profileConfig = dshConfig.profile && typeof dshConfig.profile === "object" ? dshConfig.profile : {};
  if (profileConfig.bundles !== undefined
    && (!Array.isArray(profileConfig.bundles) || profileConfig.bundles.some((bundle) => typeof bundle !== "string" || bundle === ""))) {
    throw new Error(`DSH Web profile 的 bundles 配置格式无效: ${profileManifestPath}`);
  }
  const bundles = profileConfig.bundles === undefined
    ? [...DEFAULT_WEB_PROFILE_BUNDLES]
    : [...profileConfig.bundles];
  const missingBundles = [ARCHIVED_CHATS_BUNDLE, VOICE_INPUT_BUNDLE].filter((bundle) => !bundles.includes(bundle));
  await ensureProfileBundleLink(profileDir, pluginDir, pluginManifest);

  const hasArchiveDependency = dependencies[ARCHIVED_CHATS_BUNDLE] !== undefined;
  const nextDependencies = hasArchiveDependency
    ? dependencies
    : { ...dependencies, [ARCHIVED_CHATS_BUNDLE]: pluginManifest.version };
  if (missingBundles.length > 0 || !hasArchiveDependency || manifest.dependencies === undefined) {
    bundles.push(...missingBundles);
    const nextManifest = {
      ...manifest,
      dependencies: nextDependencies,
      dsh: {
        ...dshConfig,
        profile: { ...profileConfig, bundles },
      },
    };
    const temporaryPath = `${profileManifestPath}.tmp-${process.pid}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, profileManifestPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/**
 * Resolves a standalone Node.js binary path.
 * Note: DSH (via node-addon-require-builtin) cannot run under Electron runtime
 * because Electron modifies V8 internal isolate/context layout.
 */
export function resolveNodeBinaryPath() {
  const resPath = process.resourcesPath || "";
  if (resPath) {
    const packagedNode = path.join(resPath, "dsh-node.exe");
    if (app?.isPackaged && existsSync(packagedNode)) {
      return packagedNode;
    }
  }

  if (process.env.DSH_NODE_BIN && existsSync(process.env.DSH_NODE_BIN)) {
    return process.env.DSH_NODE_BIN;
  }

  // 1. Packaged resource candidate (also useful to inspect a package from Node).
  if (resPath) {
    const packagedNode = path.join(resPath, "dsh-node.exe");
    if (existsSync(packagedNode)) return packagedNode;
  }

  // Release CI stages a standalone Node binary here before packaging.
  const stagedNode = path.resolve(__dirname, "../.runtime/dsh-node.exe");
  if (existsSync(stagedNode)) {
    return stagedNode;
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
  const unpackedDsh = resPath
    ? path.join(resPath, "app.asar.unpacked", "node_modules/@deepseek-ai/dsh/lib/bin.js")
    : "";
  const unpackedAppDsh = appPath
    ? path.resolve(appPath, "../app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js")
    : "";
  const localDsh = path.resolve(__dirname, "../node_modules/@deepseek-ai/dsh/lib/bin.js");

  // DSH runs in a standalone Node process, which cannot read Electron's
  // virtual app.asar filesystem. Prefer the physical unpacked tree whenever
  // this is a packaged Electron app.
  const candidates = app?.isPackaged
    ? [
      unpackedDsh,
      path.resolve(resPath, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      unpackedAppDsh,
      localDsh,
    ]
    : [
      localDsh,
      unpackedDsh,
      path.resolve(resPath, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      unpackedAppDsh,
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
  // DSH_HOME may point at DSH Desktop's data. Only honor this app-specific
  // override; otherwise keep StatPilot's sessions, credentials, and profiles
  // under its own Electron userData directory.
  const override = process.env.STAT_PILOT_DSH_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (typeof app?.getPath === "function") {
    return path.join(app.getPath("userData"), "dsh-home");
  }

  return path.join(os.homedir(), ".stat-pilot", "dsh-home");
}

/** Prefer PowerShell 7 for DSH's Windows terminal, then Windows PowerShell 5.1. */
export function resolveWindowsDshTerminalShell(env = process.env) {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const systemRoot = env.SystemRoot || "C:\\Windows";
  const pathEntries = (env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const candidates = [
    path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    ...pathEntries.map((entry) => path.join(entry, "pwsh.exe")),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ...pathEntries.map((entry) => path.join(entry, "powershell.exe")),
  ];

  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return path.resolve(candidate);
    } catch {}
  }

  return null;
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
- 生成文件后，必须检查实际目标文件存在且非空，再在回复末尾写明文件名和工作区相对路径。若没有写入或检查失败，明确说明未生成，不要声称成功。不要自行构造 file://、localhost 或 127.0.0.1 形式的输出目录链接；用户可通过工作台的原生“打开输出目录”按钮打开。

## 五、公文与统计风格规范
- **文风**：克制、严谨、平实，符合政务公文规范；先事实依据，后分析建议。
- **留白待补**：未由用户提供且无法核验的正式发文字号、签发人、印章等，统一使用 \`[待补：……]\` 占位，不擅自杜撰。
`;

/**
 * Ensures Shen Xiao Tong's private persona and workspace instructions are active in DSH.
 */
export async function ensureShenXiaoTongInstructions(appRuntimeDir) {
  await fs.mkdir(appRuntimeDir, { recursive: true });

  // Keep the product prompt in app-owned storage; DSH_HOME may belong to the user.
  const patchPath = path.join(appRuntimeDir, "shenxiaotong.patch.yml");
  const appPersona = `${SHENXIAOTONG_PERSONA_PREFIX}\n\n${SHENXIAOTONG_INSTRUCTIONS}`;
  const patchContent = [
    "- id: system-prompt",
    "  config:",
    "    includeHarnessIdentity: false",
    `    personaPrefix: ${JSON.stringify(appPersona)}`,
    "    personaSuffix: Your working directory is {{cwd}}.",
    "",
  ].join("\n");
  await fs.writeFile(patchPath, patchContent, "utf8");

  console.log("[dsh-runtime] Configured app-owned 深小统 persona overlay at:", patchPath);
  return patchPath;
}

/**
 * Synchronizes built-in stat-pilot skills into $DSH_HOME/skills.
 */
async function removePlatformMetadata(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") {
      await fs.rm(entryPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removePlatformMetadata(entryPath);
    }
  }
}

export async function copySkillDirectoryWithoutPlatformMetadata(sourcePath, destinationPath) {
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    filter: (entryPath) => {
      const name = path.basename(entryPath);
      return !name.startsWith("._") && name !== ".DS_Store";
    },
  });
}

export async function syncBuiltinSkills(dshHome) {
  const dshSkillsDir = path.join(dshHome, "skills");
  await fs.mkdir(dshSkillsDir, { recursive: true });
  await removePlatformMetadata(dshSkillsDir);

  const appRoot = process.env.STAT_PILOT_VERIFY_RESOURCES
    || (app?.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."));
  const srcSkillsDir = path.join(appRoot, "skills");

  if (!existsSync(srcSkillsDir)) {
    return;
  }

  try {
    // Copy app skills only when the DSH home does not already own that name.
    // Filter recursively so DSH never indexes AppleDouble or Finder metadata.
    const entries = await fs.readdir(srcSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("._")) {
        continue;
      }

      const srcDir = path.join(srcSkillsDir, entry.name);
      const destDir = path.join(dshSkillsDir, entry.name);

      if (existsSync(destDir)) continue;
      await copySkillDirectoryWithoutPlatformMetadata(srcDir, destDir);
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
  const appRoot = process.env.STAT_PILOT_VERIFY_RESOURCES
    || (app?.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."));
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
  constructor({ appRuntimeDir = null } = {}) {
    this.process = null;
    this.port = null;
    this.host = null;
    this.baseUrl = null;
    this.cookie = null;
    this.tokenUrl = null;
    this.isRunning = false;
    this.dshHome = null;
    this.appRuntimeDir = appRuntimeDir;
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

    const resolvedDshBin = resolveDshBinaryPath(settings.dshBin);
    if (!existsSync(resolvedDshBin)) {
      throw new Error(`找不到 DSH 运行时入口: ${resolvedDshBin}`);
    }
    // Windows TEMP can use an 8.3 alias (RUNNER~1). DSH's profile loader uses
    // real paths; starting via the alias loads app-boot twice with separate
    // module state, breaking profile reloads when settings are changed.
    const dshBin = await fs.realpath(resolvedDshBin);

    const nodeBin = resolveNodeBinaryPath();
    console.log("[dsh-runtime] Using Node binary:", nodeBin);

    const windowsTerminalShell = process.platform === "win32"
      ? resolveWindowsDshTerminalShell()
      : null;
    if (process.platform === "win32" && !windowsTerminalShell) {
      throw new Error("Windows DSH 终端需要 pwsh.exe 或 powershell.exe，但两者都未找到");
    }
    if (windowsTerminalShell) {
      console.log("[dsh-runtime] Using PowerShell as the Windows DSH terminal default:", windowsTerminalShell);
    }

    this.dshHome = getDshHomeDir();
    await fs.mkdir(this.dshHome, { recursive: true });
    await ensureWebProfileBundles(this.dshHome);
    await syncBuiltinSkills(this.dshHome);
    const appRuntimeDir = this.appRuntimeDir || (app
      ? path.join(app.getPath("userData"), "dsh-runtime")
      : path.join(os.homedir(), ".stat-pilot", "dsh-runtime"));
    const patchPath = await ensureShenXiaoTongInstructions(appRuntimeDir);

    const nodeDir = path.dirname(nodeBin);
    const extraPaths = process.platform === "win32"
      ? [nodeDir]
      : [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    const currentPath = process.env.PATH || "";
    const mergedPath = Array.from(new Set([...extraPaths, ...currentPath.split(path.delimiter)])).filter(Boolean).join(path.delimiter);

    const env = { ...process.env };
    if (process.platform === "win32") {
      const setWindowsEnvironmentVariable = (name, value) => {
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === name.toLowerCase()) delete env[key];
        }
        env[name] = value;
      };
      setWindowsEnvironmentVariable("PATH", mergedPath);
      setWindowsEnvironmentVariable("DSH_HOME", this.dshHome);
      setWindowsEnvironmentVariable("ComSpec", windowsTerminalShell);
    } else {
      env.PATH = mergedPath;
      env.DSH_HOME = this.dshHome;
    }
    delete env.ELECTRON_RUN_AS_NODE;

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
        const safeLine = line.replace(/([?&]token=)[^&#\s]+/gi, "$1[redacted]");
        console.log("[dsh stdout]", safeLine);

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
            const controller = new AbortController();
            const authTimeout = setTimeout(() => controller.abort(), 5000);
            try {
              const res = await fetch(fullUrl, {
                method: "GET",
                redirect: "manual",
                headers: { Host: this.host },
                signal: controller.signal,
              });
              const rawCookie = res.headers.get("set-cookie");
              if (rawCookie) {
                this.cookie = rawCookie.split(";")[0].trim();
                console.log("[dsh-runtime] Authenticated with session cookie");
              }
            } catch (err) {
              console.warn("[dsh-runtime] Failed to exchange token for cookie:", err);
            } finally {
              clearTimeout(authTimeout);
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
