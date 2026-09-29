import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(scriptDir, "../.runtime");
const filename = "dsh-node.exe";
const targetPath = path.join(runtimeDir, filename);

await mkdir(runtimeDir, { recursive: true });
if (path.resolve(process.execPath) !== targetPath) {
  await copyFile(process.execPath, targetPath);
}
if (process.platform !== "win32") {
  await chmod(targetPath, 0o755);
}

console.log(`[stage-dsh-node] Staged Node ${process.version} (${process.platform}/${process.arch}) at ${targetPath}`);
