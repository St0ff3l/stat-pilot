import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DshRuntimeManager, resolveDshBinaryPath, resolveNodeBinaryPath } from "../electron/dsh-runtime.mjs";
import { DshClient } from "../electron/dsh-client.mjs";

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

// Verify persona and AGENTS.md
const agentsPath = path.join(manager.dshHome, "AGENTS.md");
const patchPath = path.join(manager.dshHome, "patch.yml");
if (!existsSync(agentsPath) || !existsSync(patchPath)) {
  throw new Error("DSH 身份提示词文件未生成");
}
const patchContent = readFileSync(patchPath, "utf8");
if (!patchContent.includes("深小统") || !patchContent.includes("includeHarnessIdentity: false")) {
  throw new Error("DSH patch.yml 缺少深小统身份提示词或 includeHarnessIdentity: false");
}
console.log("[verify-dsh] 深小统提示词与 patch 验证通过");

// Verify skills via DshClient
const client = new DshClient(info);
const session = await client.createSession({ cwd: process.cwd() });
if (!session?.sessionId) {
  throw new Error("DSH 创建会话失败");
}
console.log(`[verify-dsh] 会话创建成功: ${session.sessionId}`);

const skills = await client.listSkills(session.sessionId);
console.log(`[verify-dsh] 发现技能总数: ${skills.length}`);
const expectedSkills = [
  "gov-official-document-drafting",
  "info-digest-html",
  "price-index-gdp-impact",
  "source-verification",
  "weekly-report",
];
for (const exp of expectedSkills) {
  const found = skills.some((s) => s.name === exp);
  if (!found) {
    throw new Error(`未能在 DSH 中发现内置技能: ${exp}`);
  }
}
console.log("[verify-dsh] 全部 5 个内置技能发现验证通过:", expectedSkills.join(", "));

await client.archiveSession(session.sessionId).catch(() => {});
client.dispose();
await manager.stop();
console.log("[verify-dsh] DSH 优雅停止验证通过");
process.exit(0);
