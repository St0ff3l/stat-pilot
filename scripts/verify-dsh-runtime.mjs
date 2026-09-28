import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DshRuntimeManager, resolveDshBinaryPath, resolveNodeBinaryPath } from "../electron/dsh-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dshBinPath = resolveDshBinaryPath();

if (!existsSync(dshBinPath)) {
  console.error(`[verify-dsh] 找不到 DSH 运行时入口: ${dshBinPath}`);
  process.exit(1);
}

const nodeBin = resolveNodeBinaryPath();
console.log(`[verify-dsh] 使用 Node: ${nodeBin}`);
console.log(`[verify-dsh] DSH 入口验证通过: ${dshBinPath}`);

const manager = new DshRuntimeManager();
const info = await manager.start({ apiKey: "test" });
if (!info.baseUrl) {
  throw new Error("DSH 未返回服务地址");
}
console.log(`[verify-dsh] DSH 启动服务验证通过: ${info.baseUrl}`);
await manager.stop();
console.log("[verify-dsh] DSH 优雅停止验证通过");
process.exit(0);
