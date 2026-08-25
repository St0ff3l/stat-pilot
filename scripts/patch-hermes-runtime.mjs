import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const APP_NAME = "stat-pilot";
const LEGACY_APP_NAMES = ["sz-gov-scope", "深小统"];
const CHINESE_SENTINEL = "Return ONLY the title text in Chinese";
const TITLE_PROMPT_ASSIGNMENT = /_TITLE_PROMPT\s*=\s*\([\s\S]*?\n\)\n/;
const MODERN_LANGUAGE_RULE_ASSIGNMENT = /_LANGUAGE_RULE_MATCH_USER\s*=\s*["'][^"'\r\n]*["']/;
const ORIGINAL_TITLE_PROMPT = `_TITLE_PROMPT = (
    "Generate a short, descriptive title (3-7 words) for a conversation that starts with the "
    "following exchange. The title should capture the main topic or intent. "
    "Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes."
)`;
const CHINESE_TITLE_PROMPT = `_TITLE_PROMPT = (
    "Generate a short, descriptive title in Chinese (typically 4-10 characters) for a conversation that starts with the "
    "following exchange. The title should capture the main topic or intent. "
    "Return ONLY the title text in Chinese, nothing else. No quotes, no punctuation at the end, no prefixes. "
    "请为以下对话生成一个简短、具描述性的中文标题（一般4到10个字），能概括主要话题或意图。只需返回中文标题文本，不要包含任何其他内容，也不要有引号、结尾标点或“标题：”等前缀。"
)`;

const localTitleGeneratorPath = path.join(
  projectRoot,
  ".runtime",
  "hermes-agent",
  "agent",
  "title_generator.py"
);

function getAppDataRoot() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  } else if (process.platform === "win32") {
    return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  } else {
    return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
}

function getUserDataPaths() {
  return [...new Set([APP_NAME, ...LEGACY_APP_NAMES])].map((name) =>
    path.join(getAppDataRoot(), name)
  );
}

const activeAppUserDataPaths = getUserDataPaths();

const localShellTargets = [
  {
    label: "workspace local terminal runtime",
    filePath: path.join(projectRoot, ".runtime", "hermes-agent", "tools", "environments", "local.py"),
    optional: false,
  },
  ...activeAppUserDataPaths.map((userDataPath, index) => ({
    label: index === 0
      ? "active app local terminal runtime"
      : `legacy app local terminal runtime (${path.basename(userDataPath)})`,
    filePath: path.join(userDataPath, "hermes-runtime", "hermes-agent", "tools", "environments", "local.py"),
    optional: true,
  })),
];

const patchTargets = [
  {
    label: "workspace runtime template",
    filePath: localTitleGeneratorPath,
    optional: false,
  },
  ...activeAppUserDataPaths.map((userDataPath, index) => ({
    label: index === 0
      ? "active app runtime"
      : `legacy app runtime (${path.basename(userDataPath)})`,
    filePath: path.join(userDataPath, "hermes-runtime", "hermes-agent", "agent", "title_generator.py"),
    optional: true,
  })),
];

const utf8DecodeTargets = [
  "hermes_cli/models.py",
  "hermes_cli/model_catalog.py",
  "hermes_cli/webhook.py",
  "hermes_cli/dashboard_register.py",
  "hermes_cli/copilot_auth.py",
  "hermes_cli/tools_config.py",
  "hermes_cli/nous_account.py",
];

async function patchFile({ label, filePath, optional }) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (optional) {
      console.log(`Skipped ${label}: file not found at ${filePath}`);
      return;
    }
    console.error(`Missing ${label}: ${filePath}`);
    console.error("Run `npm run hermes:bootstrap` first so the runtime is installed locally.");
    process.exitCode = 1;
    return;
  }

  if (content.includes("_TITLE_PROMPT_TEMPLATE")) {
    if (content.includes("title in Chinese")) {
      console.log(`OK ${label}: already uses a Chinese title language rule`);
      return;
    }

    if (!MODERN_LANGUAGE_RULE_ASSIGNMENT.test(content)) {
      console.error(`Unexpected modern title_generator.py format in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }

    const updated = content.replace(
      MODERN_LANGUAGE_RULE_ASSIGNMENT,
      '_LANGUAGE_RULE_MATCH_USER = "- Write the title in Chinese."'
    );
    await fs.writeFile(filePath, updated, "utf8");
    console.log(`Patched ${label}: pinned modern title language to Chinese`);
    return;
  }

  if (content.includes(CHINESE_SENTINEL) || (content.includes("_TITLE_PROMPT") && content.includes("中文"))) {
    console.log(`OK ${label}: already uses a Chinese title prompt`);
    return;
  }

  if (!content.includes(ORIGINAL_TITLE_PROMPT) && !TITLE_PROMPT_ASSIGNMENT.test(content)) {
    console.error(`Unexpected title_generator.py format in ${label}: ${filePath}`);
    console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
    process.exitCode = 1;
    return;
  }

  const updated = content.includes(ORIGINAL_TITLE_PROMPT)
    ? content.replace(ORIGINAL_TITLE_PROMPT, CHINESE_TITLE_PROMPT)
    : content.replace(TITLE_PROMPT_ASSIGNMENT, `${CHINESE_TITLE_PROMPT}\n`);
  await fs.writeFile(filePath, updated, "utf8");
  console.log(`Patched ${label}: ${filePath}`);
}

async function patchUtf8Decoders() {
  for (const relativePath of utf8DecodeTargets) {
    const filePath = path.join(projectRoot, ".runtime", "hermes-agent", relativePath);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      console.log(`Skipped UTF-8 decoder patch: ${filePath}`);
      continue;
    }

    const updated = content.replace(
      /\.read\(\)\.decode\(\)/g,
      '.read().decode("utf-8", errors="replace")'
    );
    if (updated === content) {
      continue;
    }

    await fs.writeFile(filePath, updated, "utf8");
    console.log(`Patched UTF-8 decoder tolerance: ${relativePath}`);
  }
}

async function patchWindowsLocalShell() {
  const powershellFinder = `
def _find_powershell() -> str:
    """Find PowerShell for native Windows command execution."""
    custom = os.environ.get("HERMES_POWERSHELL_PATH")
    if custom and os.path.isfile(custom):
        return custom

    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found

    raise RuntimeError(
        "PowerShell not found. Install PowerShell 7 or set HERMES_POWERSHELL_PATH."
    )

`;

  for (const target of localShellTargets) {
    let content;
    try {
      content = await fs.readFile(target.filePath, "utf8");
    } catch {
      if (!target.optional) {
        console.error(`Missing ${target.label}: ${target.filePath}`);
        process.exitCode = 1;
      } else {
        console.log(`Skipped ${target.label}: file not found at ${target.filePath}`);
      }
      continue;
    }

    const alreadyPatched =
      content.includes("def _find_powershell() -> str:") &&
      content.includes("_find_shell = _find_powershell if _IS_WINDOWS else _find_bash") &&
      content.includes("bash = _find_shell()") &&
      content.includes("        if _IS_WINDOWS:\n            powershell_cmd =") &&
      content.includes("        else:\n            args = [bash, \"-l\", \"-c\", cmd_string]") &&
      !content.includes("        else:\n            if _IS_WINDOWS:");
    if (alreadyPatched) {
      console.log(`OK ${target.label}: Windows local terminal uses PowerShell`);
      continue;
    }

    let updated = content;
    if (!updated.includes("def _find_powershell() -> str:")) {
      const insertionPoint = updated.indexOf("def _run_bash");
      if (insertionPoint < 0) {
        console.error(`Unexpected local terminal runtime format: ${target.filePath}`);
        console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
        process.exitCode = 1;
        continue;
      }
      updated = updated.slice(0, insertionPoint) + powershellFinder + updated.slice(insertionPoint);
    }
    updated = updated.replace("bash = _find_bash()", "bash = _find_powershell() if _IS_WINDOWS else _find_bash()");
    const runBashStart = updated.indexOf("def _run_bash");
    const argsStart = updated.indexOf("        args = ", runBashStart);
    const runEnvMarker = "        run_env = _make_run_env(self.env)";
    const argsEnd = updated.indexOf("\n", argsStart);
    if (runBashStart < 0 || argsStart < 0 || argsEnd < 0 || !updated.includes(runEnvMarker, argsEnd)) {
      console.error(`Unexpected local shell invocation format: ${target.filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      continue;
    }
    const newArgs = `        if _IS_WINDOWS:
            powershell_cmd = "$OutputEncoding = [System.Text.UTF8Encoding]::new(\$false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(\$false); [Console]::ErrorEncoding = [System.Text.UTF8Encoding]::new(\$false); " + cmd_string
            args = [bash, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell_cmd]
        else:
            args = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]`;
    updated = updated.slice(0, argsStart) + newArgs + updated.slice(argsEnd);
    await fs.writeFile(target.filePath, updated, "utf8");
    console.log(`Patched ${target.label}: Windows local terminal now prefers pwsh`);
  }
}

async function main() {
  console.log("Applying Hermes runtime patches...");
  for (const target of patchTargets) {
    await patchFile(target);
  }
  await patchWindowsLocalShell();
  await patchUtf8Decoders();
}

await main();
