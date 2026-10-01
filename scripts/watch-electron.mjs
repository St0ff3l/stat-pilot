import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const electronExecutable = createRequire(import.meta.url)("electron");
const electronSourceDir = path.join(projectRoot, "electron");

let electronProcess = null;
let restartPending = false;
let shuttingDown = false;
let restartDebounce = null;
let forceStopTimer = null;

function requestElectronQuit(reason) {
  const child = electronProcess;
  if (!child || child.exitCode !== null) return;

  clearTimeout(forceStopTimer);
  forceStopTimer = setTimeout(() => {
    if (electronProcess === child && child.exitCode === null) child.kill();
  }, 8000);
  forceStopTimer.unref();

  if (!child.connected) {
    child.kill();
    return;
  }

  child.send({ type: "stat-pilot:quit", reason }, (error) => {
    if (error && electronProcess === child && child.exitCode === null) child.kill();
  });
}

function launchElectron() {
  const child = spawn(electronExecutable, ["."], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  electronProcess = child;

  child.once("error", (error) => {
    console.error("[dev] Failed to start Electron:", error);
    shuttingDown = true;
    watcher.close();
    process.exitCode = 1;
  });

  child.once("exit", (code) => {
    if (electronProcess !== child) return;
    electronProcess = null;
    clearTimeout(forceStopTimer);
    forceStopTimer = null;

    if (shuttingDown) {
      process.exitCode = 0;
      return;
    }

    if (restartPending) {
      restartPending = false;
      launchElectron();
      return;
    }

    watcher.close();
    process.exitCode = code ?? 1;
  });
}

const watcher = watch(electronSourceDir, { recursive: true }, (_eventType, filename) => {
  if (!filename || shuttingDown || restartPending) return;
  clearTimeout(restartDebounce);
  restartDebounce = setTimeout(() => {
    if (!electronProcess || shuttingDown || restartPending) return;
    console.log(`[dev] Electron source changed (${filename}); restarting the main process.`);
    restartPending = true;
    requestElectronQuit("restart");
  }, 250);
});

function stopElectron() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartDebounce);
  watcher.close();
  if (electronProcess) {
    requestElectronQuit("shutdown");
  } else {
    process.exitCode = 0;
  }
}

process.once("SIGINT", stopElectron);
process.once("SIGTERM", stopElectron);

launchElectron();
