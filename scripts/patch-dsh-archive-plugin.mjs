import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(projectRoot, "node_modules", "dsh-archived-chats");
const manifestPath = path.join(packageRoot, "package.json");
const safetyPath = path.join(packageRoot, "lib", "deletion-safety.js");

// DSH locate() points to the current write generation, while archived-chats
// 1.4.5 treated that path as the only existing log. Validate the actual
// generation files in the same session directory instead.
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== "1.4.5") {
  throw new Error(`Expected dsh-archived-chats@1.4.5, received ${manifest.version || "unknown version"}`);
}

let source = await readFile(safetyPath, "utf8");
if (source.includes("const SESSION_LOG_FILENAME =")) {
  console.log("[postinstall] dsh-archived-chats deletion path compatibility is already applied");
  process.exit(0);
}

function replaceExactlyOnce(before, after, description) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Could not safely patch dsh-archived-chats: expected one ${description} block`);
  }
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceExactlyOnce(
  "import { lstat, realpath } from 'node:fs/promises';",
  "import { lstat, readdir, realpath } from 'node:fs/promises';",
  "filesystem import",
);

replaceExactlyOnce(
  "import { basename, dirname, isAbsolute, normalize, parse, relative, sep } from 'node:path';",
  "import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path';",
  "path import",
);

replaceExactlyOnce(
  "function inside(parent, candidate) {\n  const offset = relative(parent, candidate);\n  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));\n}\n",
  "function inside(parent, candidate) {\n  const offset = relative(parent, candidate);\n  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));\n}\n\nconst SESSION_LOG_FILENAME = /^session(?:\\.v[1-9]\\d*)?\\.jsonl(?:\\.zstd)?$/u;\n",
  "path containment helper",
);

replaceExactlyOnce(
  "    if (directory === parse(path).root || basename(directory) !== id) {\n      throw unsafe('session location is not session-scoped');\n    }\n    entries.push({ id, path, directory });",
  "    if (directory === parse(path).root || basename(directory) !== id) {\n      throw unsafe('session location is not session-scoped');\n    }\n    if (!SESSION_LOG_FILENAME.test(basename(path))) {\n      throw unsafe('session location is not a canonical Session log path');\n    }\n    entries.push({ id, path, directory });",
  "session path validation",
);

replaceExactlyOnce(
  "    const fileStat = await checkedStat(entry.path, 'session location');\n    if (!fileStat.isFile()) throw unsafe('session location is not a regular file');\n    try {\n      entry.realDirectory = await realpath(entry.directory);\n      entry.realPath = await realpath(entry.path);\n    } catch { throw unavailable('session location cannot be canonicalized'); }\n    await checkCanonicalDirectoryAncestry(entry.realDirectory, checkedCanonicalDirectories);\n    if (!inside(entry.realDirectory, entry.realPath)) throw unsafe('session location escapes its directory');",
  "    let filenames;\n    try { filenames = await readdir(entry.directory); }\n    catch { throw unavailable('session directory cannot be inspected'); }\n    const logPaths = filenames\n      .filter((filename) => SESSION_LOG_FILENAME.test(filename))\n      .map((filename) => join(entry.directory, filename));\n    if (logPaths.length === 0) throw unavailable('session directory has no stored Session log');\n    try {\n      entry.realDirectory = await realpath(entry.directory);\n    } catch { throw unavailable('session directory cannot be canonicalized'); }\n    await checkCanonicalDirectoryAncestry(entry.realDirectory, checkedCanonicalDirectories);\n    for (const logPath of logPaths) {\n      const fileStat = await checkedStat(logPath, 'session log');\n      if (!fileStat.isFile()) throw unsafe('session log is not a regular file');\n      let realLogPath;\n      try { realLogPath = await realpath(logPath); }\n      catch { throw unavailable('session log cannot be canonicalized'); }\n      if (!inside(entry.realDirectory, realLogPath)) throw unsafe('session log escapes its directory');\n    }",
  "session file and canonical path checks",
);

replaceExactlyOnce(
  "    if (inside(target.realDirectory, entry.realPath)\n      || inside(entry.realDirectory, target.realPath)\n      || inside(target.realDirectory, entry.realDirectory)\n      || inside(entry.realDirectory, target.realDirectory)) {",
  "    if (inside(target.realDirectory, entry.realDirectory)\n      || inside(entry.realDirectory, target.realDirectory)) {",
  "session directory overlap check",
);

await writeFile(safetyPath, source, "utf8");
console.log("[postinstall] patched dsh-archived-chats to validate the stored Session log generation");
