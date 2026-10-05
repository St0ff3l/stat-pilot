import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const releaseRoot = path.join(projectRoot, "release");
const dshRelativePath = path.join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

async function findPackagedDshResources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
    if (!entry.isDirectory()) continue;

    const childPath = path.join(directory, entry.name);
    if (entry.name === "app.asar.unpacked") {
      const candidate = path.join(childPath, dshRelativePath);
      if (existsSync(candidate)) return { resourcesPath: path.dirname(childPath), dshBinPath: candidate };
      continue;
    }

    if (entry.name === "node_modules" || entry.name === "resources") {
      if (entry.name === "resources") {
        const unpackedPath = path.join(childPath, "app.asar.unpacked");
        const candidate = path.join(unpackedPath, dshRelativePath);
        if (existsSync(candidate)) return { resourcesPath: childPath, dshBinPath: candidate };
      }
      continue;
    }

    const found = await findPackagedDshResources(childPath);
    if (found) return found;
  }

  return null;
}

const packaged = await findPackagedDshResources(releaseRoot);
if (!packaged) {
  throw new Error(`在 ${releaseRoot} 中找不到解包后的 DSH 运行时`);
}

const nodeBinPath = path.join(packaged.resourcesPath, "dsh-node.exe");
if (!existsSync(nodeBinPath)) {
  throw new Error(`安装包缺少独立 Node.js 运行时: ${nodeBinPath}`);
}

// A package under release/ can resolve missing dependencies from the checkout's
// node_modules. Move its physical resources outside the checkout before booting.
const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "stat-pilot-packaged-verify-"));
try {
  const resourcesPath = path.join(isolatedRoot, "resources");
  await cp(packaged.resourcesPath, resourcesPath, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !path.basename(source).startsWith("._") && path.basename(source) !== ".DS_Store",
  });
  const isolatedNode = path.join(resourcesPath, "dsh-node.exe");
  const isolatedDsh = path.join(resourcesPath, "app.asar.unpacked", dshRelativePath);
  console.log(`[verify-packaged-dsh] Isolated DSH: ${isolatedDsh}`);
  console.log(`[verify-packaged-dsh] Isolated Node: ${isolatedNode}`);

  const smoke = spawnSync(isolatedNode, [isolatedDsh, "--version"], {
    cwd: isolatedRoot,
    env: { ...process.env, NODE_PATH: "" },
    encoding: "utf8",
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) {
    throw new Error(`安装包中的 DSH 无法独立加载依赖:\n${smoke.stderr || smoke.stdout}`);
  }
  console.log(`[verify-packaged-dsh] Standalone dependency smoke test passed: ${smoke.stdout.trim()}`);

  const result = spawnSync(process.execPath, [path.join(scriptDir, "verify-dsh-runtime.mjs")], {
    cwd: isolatedRoot,
    env: {
      ...process.env,
      NODE_PATH: "",
      DSH_NODE_BIN: isolatedNode,
      STAT_PILOT_VERIFY_RESOURCES: resourcesPath,
      STAT_PILOT_VERIFY_DSH_BIN: isolatedDsh,
    },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}
