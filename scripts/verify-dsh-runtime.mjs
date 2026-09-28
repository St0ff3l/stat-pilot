import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dshBinPath = path.resolve(__dirname, "../node_modules/@deepseek-ai/dsh/lib/bin.js");

if (!existsSync(dshBinPath)) {
  console.error(`[verify-dsh] 找不到 DSH 运行时入口: ${dshBinPath}`);
  process.exit(1);
}

console.log(`[verify-dsh] DSH 运行时验证通过: ${dshBinPath}`);
process.exit(0);
