import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.resolve(
  process.env.HERMES_RUNTIME_ROOT || path.join(projectRoot, ".runtime")
);
const isWindows = process.platform === "win32";
const pythonRelativePath = isWindows ? "Scripts/python.exe" : "bin/python";
const entryPointRelativePath = isWindows ? "Scripts/hermes.exe" : "bin/hermes";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findVenv() {
  for (const name of [".venv", "venv"]) {
    const candidate = path.join(runtimeRoot, "hermes-agent", name);
    if (
      (await exists(path.join(candidate, pythonRelativePath))) &&
      (await exists(path.join(candidate, entryPointRelativePath)))
    ) {
      return candidate;
    }
  }

  return null;
}

if (!(await exists(runtimeRoot))) {
  throw new Error(
    `Bundled Hermes runtime is missing: ${runtimeRoot}. Run the platform bootstrap command before packaging.`
  );
}

const venvDir = await findVenv();
if (!venvDir) {
  throw new Error(
    `Bundled Hermes runtime is incomplete for ${process.platform}: expected ${pythonRelativePath} and ${entryPointRelativePath} under ${path.join(runtimeRoot, "hermes-agent")}.`
  );
}

if (!(await exists(path.join(runtimeRoot, "portable-python.json")))) {
  throw new Error(
    `Bundled Hermes runtime is missing portable-python.json: ${runtimeRoot}`
  );
}

console.log(`Bundled Hermes runtime verified for ${process.platform}: ${venvDir}`);
