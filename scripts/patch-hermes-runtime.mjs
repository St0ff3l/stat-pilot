import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const APP_NAME = "sz-gov-scope";
const CHINESE_SENTINEL = "Return ONLY the title text in Chinese";
const TITLE_PROMPT_ASSIGNMENT = /_TITLE_PROMPT\s*=\s*\([\s\S]*?\n\)\n/;
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

function getUserDataPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_NAME);
  } else if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
  } else {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_NAME);
  }
}

const appSupportTitleGeneratorPath = path.join(
  getUserDataPath(),
  "hermes-runtime",
  "hermes-agent",
  "agent",
  "title_generator.py"
);

const patchTargets = [
  {
    label: "workspace runtime template",
    filePath: localTitleGeneratorPath,
    optional: false,
  },
  {
    label: "active app runtime",
    filePath: appSupportTitleGeneratorPath,
    optional: true,
  },
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

async function main() {
  console.log("Applying Hermes runtime patches...");
  for (const target of patchTargets) {
    await patchFile(target);
  }
}

await main();
