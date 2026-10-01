import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
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

console.log(`[verify-packaged-dsh] DSH: ${packaged.dshBinPath}`);
console.log(`[verify-packaged-dsh] Node: ${nodeBinPath}`);

const result = spawnSync(process.execPath, [path.join(scriptDir, "verify-dsh-runtime.mjs")], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DSH_NODE_BIN: nodeBinPath,
    STAT_PILOT_VERIFY_RESOURCES: packaged.resourcesPath,
    STAT_PILOT_VERIFY_DSH_BIN: packaged.dshBinPath,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
