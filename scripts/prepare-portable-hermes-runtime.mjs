import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.resolve(
  process.env.HERMES_RUNTIME_ROOT || path.join(projectRoot, ".runtime")
);
const installDir = path.resolve(
  process.env.HERMES_INSTALL_DIR || path.join(runtimeRoot, "hermes-agent")
);
const portablePythonRoot = path.join(runtimeRoot, "python");
const isWindows = process.platform === "win32";
const pythonVersion = process.env.HERMES_PYTHON_VERSION || "3.11";

function isWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findPortablePython() {
  if (!(await pathExists(portablePythonRoot))) {
    throw new Error(`Portable Python directory is missing: ${portablePythonRoot}`);
  }

  const wantedNames = isWindows
    ? new Set(["python.exe"])
    : new Set([`python${pythonVersion}`, "python3.11", "python3", "python"]);
  const queue = [{ directory: portablePythonRoot, depth: 0 }];
  const candidates = [];

  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".lock" || entry.name === ".git") {
        continue;
      }

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) {
        queue.push({ directory: entryPath, depth: depth + 1 });
        continue;
      }

      if (!wantedNames.has(entry.name)) {
        continue;
      }

      const stats = await fs.lstat(entryPath);
      if (stats.isFile() || stats.isSymbolicLink()) {
        candidates.push({ path: entryPath, isLink: stats.isSymbolicLink() });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Portable Python ${pythonVersion} was not found under ${portablePythonRoot}`);
  }

  candidates.sort((left, right) => {
    const leftLinkScore = left.isLink ? 1 : 0;
    const rightLinkScore = right.isLink ? 1 : 0;
    const leftVersionScore = left.path.endsWith(`python${pythonVersion}`) ? 0 : 1;
    const rightVersionScore = right.path.endsWith(`python${pythonVersion}`) ? 0 : 1;
    const leftCpythonScore = left.path.includes(`cpython-${pythonVersion}`) ? 0 : 1;
    const rightCpythonScore = right.path.includes(`cpython-${pythonVersion}`) ? 0 : 1;
    return (
      leftLinkScore - rightLinkScore ||
      leftVersionScore - rightVersionScore ||
      leftCpythonScore - rightCpythonScore ||
      left.path.localeCompare(right.path)
    );
  });

  const executable = candidates[0].path;
  const pythonHome = isWindows ? path.dirname(executable) : path.dirname(executable);
  return { executable, pythonHome };
}

async function replaceWithRelativeLink(linkPath, targetPath) {
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath) || ".";
  await fs.rm(linkPath, { force: true });
  await fs.symlink(relativeTarget, linkPath);
}

async function normalizeUnixVenv(venvDir, portablePythonExecutable) {
  const binDir = path.join(venvDir, "bin");
  if (!(await pathExists(binDir))) {
    return;
  }

  const pythonLinks = ["python", "python3", "python3.11"];
  for (const name of pythonLinks) {
    const linkPath = path.join(binDir, name);
    if (await pathExists(linkPath)) {
      const target = name === "python" ? portablePythonExecutable : path.join(binDir, "python");
      await replaceWithRelativeLink(linkPath, target);
    }
  }
}

async function rewriteVenvConfig(venvDir, pythonHome) {
  const configPath = path.join(venvDir, "pyvenv.cfg");
  if (!(await pathExists(configPath))) {
    return;
  }

  const content = await fs.readFile(configPath, "utf8");
  const homeLine = `home = ${pythonHome}`;
  const updated = /^home\s*=.*$/m.test(content)
    ? content.replace(/^home\s*=.*$/m, homeLine)
    : `${homeLine}\n${content}`;
  await fs.writeFile(configPath, updated, "utf8");
}

async function walkSymlinks(directory, results = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      results.push(entryPath);
    } else if (entry.isDirectory()) {
      await walkSymlinks(entryPath, results);
    }
  }
  return results;
}

async function verifyNoExternalSymlinks() {
  const runtimeRealPath = await fs.realpath(runtimeRoot);
  const external = [];
  for (const linkPath of await walkSymlinks(runtimeRoot)) {
    try {
      const targetRealPath = await fs.realpath(linkPath);
      if (!isWithin(runtimeRealPath, targetRealPath)) {
        external.push(`${linkPath} -> ${targetRealPath}`);
      } else if (!isWindows) {
        const linkTarget = await fs.readlink(linkPath);
        if (path.isAbsolute(linkTarget)) {
          await replaceWithRelativeLink(linkPath, targetRealPath);
          console.log(`Rebased internal symlink: ${linkPath}`);
        }
      }
    } catch (error) {
      external.push(`${linkPath} -> unreadable target (${error.message})`);
    }
  }

  if (external.length > 0) {
    throw new Error(
      [
        "Hermes runtime contains symbolic links that point outside the packaged runtime:",
        ...external.slice(0, 20).map((entry) => `  ${entry}`),
        external.length > 20 ? `  ... and ${external.length - 20} more` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

function verifyPython(pythonPath, venvDir) {
  const result = spawnSync(
    pythonPath,
    ["-c", "import sys; print(sys.executable); print(sys.version)"],
    {
      cwd: installDir,
      encoding: "utf8",
      env: { ...process.env, PYTHONHOME: "", PYTHONPATH: "" },
    }
  );

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(`Bundled Python verification failed for ${venvDir}: ${detail}`);
  }

  console.log(`Verified ${venvDir}: ${result.stdout.trim().replace(/\n/g, " | ")}`);
}

async function main() {
  const { executable: portablePythonExecutable, pythonHome } = await findPortablePython();
  const venvNames = ["venv", ".venv"];
  const venvDirs = [];

  for (const name of venvNames) {
    const venvDir = path.join(installDir, name);
    if (await pathExists(venvDir)) {
      venvDirs.push(venvDir);
      if (!isWindows) {
        await normalizeUnixVenv(venvDir, portablePythonExecutable);
      }
      await rewriteVenvConfig(venvDir, pythonHome);
    }
  }

  if (venvDirs.length === 0) {
    throw new Error(`No Hermes virtual environment found under ${installDir}`);
  }

  const metadata = {
    version: 1,
    pythonVersion,
    pythonHome: path.relative(runtimeRoot, pythonHome).split(path.sep).join("/"),
    pythonExecutable: path.relative(runtimeRoot, portablePythonExecutable).split(path.sep).join("/"),
  };
  await fs.writeFile(
    path.join(runtimeRoot, "portable-python.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );

  for (const venvDir of venvDirs) {
    const pythonPath = isWindows
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");
    if (await pathExists(pythonPath)) {
      verifyPython(pythonPath, venvDir);
    }
  }

  await verifyNoExternalSymlinks();
  console.log(`Portable Hermes runtime prepared with Python at ${portablePythonExecutable}`);
}

await main();
