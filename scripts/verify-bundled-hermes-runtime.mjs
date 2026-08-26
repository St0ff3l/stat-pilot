import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

const metadataPath = path.join(runtimeRoot, "portable-python.json");
if (!(await exists(metadataPath))) {
  throw new Error(
    `Bundled Hermes runtime is missing portable-python.json: ${runtimeRoot}`
  );
}

let metadata;
try {
  metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
} catch (error) {
  throw new Error(`Bundled Hermes runtime has invalid portable-python.json: ${error.message}`);
}

const portablePythonRelativePath = String(metadata.pythonExecutable || "").trim();
if (!portablePythonRelativePath) {
  throw new Error(`Bundled Hermes runtime has no portable Python executable: ${metadataPath}`);
}

const portablePythonPath = path.resolve(runtimeRoot, portablePythonRelativePath);
const portableRelativePath = path.relative(runtimeRoot, portablePythonPath);
if (
  path.isAbsolute(portableRelativePath) ||
  portableRelativePath.startsWith(`..${path.sep}`) ||
  !(await exists(portablePythonPath))
) {
  throw new Error(
    `Bundled Hermes runtime portable Python is missing or outside the runtime: ${portablePythonRelativePath}`
  );
}

const pythonCheck = spawnSync(
  portablePythonPath,
  ["-c", "import sys; print(sys.executable); print(sys.version)"],
  { cwd: path.join(runtimeRoot, "hermes-agent"), encoding: "utf8" }
);
if (pythonCheck.error || pythonCheck.status !== 0) {
  throw new Error(
    `Bundled portable Python verification failed: ${pythonCheck.error?.message || pythonCheck.stderr?.trim() || `exit code ${pythonCheck.status}`}`
  );
}

console.log(
  `Bundled Hermes runtime verified for ${process.platform}: ${venvDir}; portable Python ${portablePythonPath}`
);

const localEnvironmentPath = path.join(
  runtimeRoot,
  "hermes-agent",
  "tools",
  "environments",
  "local.py"
);
if (!(await exists(localEnvironmentPath))) {
  throw new Error(`Bundled Hermes runtime is missing local.py: ${localEnvironmentPath}`);
}

const syntaxCheck = spawnSync(
  portablePythonPath,
  [
    "-c",
    "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), filename=sys.argv[1])",
    localEnvironmentPath,
  ],
  { cwd: path.join(runtimeRoot, "hermes-agent"), encoding: "utf8" }
);
if (syntaxCheck.error || syntaxCheck.status !== 0) {
  throw new Error(
    `Bundled Hermes local.py syntax verification failed: ${syntaxCheck.error?.message || syntaxCheck.stderr?.trim() || `exit code ${syntaxCheck.status}`}`
  );
}

console.log(`Bundled Hermes local.py syntax verified: ${localEnvironmentPath}`);

const tuiGatewayPath = path.join(
  runtimeRoot,
  "hermes-agent",
  "tui_gateway",
  "server.py"
);
if (!(await exists(tuiGatewayPath))) {
  throw new Error(`Bundled Hermes runtime is missing tui_gateway/server.py: ${tuiGatewayPath}`);
}

const tuiGatewaySource = await fs.readFile(tuiGatewayPath, "utf8");
if (
  !tuiGatewaySource.includes("main_runtime={") ||
  !tuiGatewaySource.includes('"api_key": getattr(agent, "api_key", None)') ||
  !tuiGatewaySource.includes('status in {"complete", "interrupted"}') ||
  !tuiGatewaySource.includes('raw if raw.strip() else "任务已被用户终止。"') ||
  !tuiGatewaySource.includes('@method("session.auto_title")') ||
  !tuiGatewaySource.includes("auto_title_session(")
) {
  throw new Error(
    `Bundled Hermes TUI gateway is missing the active-runtime interrupted/restart-retry auto-title patch: ${tuiGatewayPath}. Run npm run hermes:patch.`
  );
}

console.log(`Bundled Hermes TUI gateway auto-title patch verified for completed, interrupted, and restart-retry tasks: ${tuiGatewayPath}`);
