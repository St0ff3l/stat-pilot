import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.resolve(
  process.env.HERMES_RUNTIME_ROOT || path.join(projectRoot, ".runtime")
);
const APP_NAME = "stat-pilot";
const LEGACY_APP_NAMES = ["sz-gov-scope", "深小统"];
const CHINESE_SENTINEL = "Return ONLY the title text in Chinese";
const TITLE_PROMPT_ASSIGNMENT = /_TITLE_PROMPT\s*=\s*\([\s\S]*?\n\)\n/;
const MODERN_LANGUAGE_RULE_ASSIGNMENT = /_LANGUAGE_RULE_MATCH_USER\s*=\s*["'][^"'\r\n]*["']/;
const ORIGINAL_TITLE_PROMPT = `_TITLE_PROMPT = (
    "Generate a short, descriptive title (3-7 words) for a conversation that starts with the "
    "following exchange. The title should capture the main topic or intent. "
    "Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes."
)`;
const CHINESE_TITLE_PROMPT = `_TITLE_PROMPT = (
    "Generate a short, descriptive title in Chinese (typically 4-10 characters) for a conversation that starts with the "
    "following exchange. The title should capture the main topic or intent. "
    "Return ONLY the title text in Chinese, nothing else. No quotes, no punctuation at the end, no prefixes. "
    "请为以下对话生成一个简短、具描述性的中文标题（一般4到10个字），能概括主要话题或意图。只需返回中文标题文本，不要包含任何其他内容，也不要有引号、结尾标点或“标题：”等前缀。"
)`;

const localTitleGeneratorPath = path.join(
  runtimeRoot,
  "hermes-agent",
  "agent",
  "title_generator.py"
);

function getAppDataRoot() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  } else if (process.platform === "win32") {
    return process.env.APPDATA || path.join(home, "AppData", "Roaming");
  } else {
    return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
}

function getUserDataPaths() {
  return [...new Set([APP_NAME, ...LEGACY_APP_NAMES])].map((name) =>
    path.join(getAppDataRoot(), name)
  );
}

const activeAppUserDataPaths = getUserDataPaths();

const localShellTargets = [
  {
    label: "workspace local terminal runtime",
    filePath: path.join(runtimeRoot, "hermes-agent", "tools", "environments", "local.py"),
    optional: false,
  },
  ...activeAppUserDataPaths.map((userDataPath, index) => ({
    label: index === 0
      ? "active app local terminal runtime"
      : `legacy app local terminal runtime (${path.basename(userDataPath)})`,
    filePath: path.join(userDataPath, "hermes-runtime", "hermes-agent", "tools", "environments", "local.py"),
    optional: true,
  })),
];

const patchTargets = [
  {
    label: "workspace runtime template",
    filePath: localTitleGeneratorPath,
    optional: false,
  },
  ...activeAppUserDataPaths.map((userDataPath, index) => ({
    label: index === 0
      ? "active app runtime"
      : `legacy app runtime (${path.basename(userDataPath)})`,
    filePath: path.join(userDataPath, "hermes-runtime", "hermes-agent", "agent", "title_generator.py"),
    optional: true,
  })),
];

const tuiGatewayTargets = [
  {
    label: "workspace TUI gateway runtime",
    filePath: path.join(runtimeRoot, "hermes-agent", "tui_gateway", "server.py"),
    optional: false,
  },
  ...activeAppUserDataPaths.map((userDataPath, index) => ({
    label: index === 0
      ? "active app TUI gateway runtime"
      : `legacy app TUI gateway runtime (${path.basename(userDataPath)})`,
    filePath: path.join(userDataPath, "hermes-runtime", "hermes-agent", "tui_gateway", "server.py"),
    optional: true,
  })),
];

const utf8DecodeTargets = [
  "hermes_cli/models.py",
  "hermes_cli/model_catalog.py",
  "hermes_cli/webhook.py",
  "hermes_cli/dashboard_register.py",
  "hermes_cli/copilot_auth.py",
  "hermes_cli/tools_config.py",
  "hermes_cli/nous_account.py",
];

async function patchFile({ label, filePath, optional }) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (optional) {
      console.log(`Skipped ${label}: file not found at ${filePath}`);
      return;
    }
    console.error(`Missing ${label}: ${filePath}`);
    console.error("Run `npm run hermes:bootstrap` first so the runtime is installed locally.");
    process.exitCode = 1;
    return;
  }

  if (content.includes("_TITLE_PROMPT_TEMPLATE")) {
    if (content.includes("title in Chinese")) {
      console.log(`OK ${label}: already uses a Chinese title language rule`);
      return;
    }

    if (!MODERN_LANGUAGE_RULE_ASSIGNMENT.test(content)) {
      console.error(`Unexpected modern title_generator.py format in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }

    const updated = content.replace(
      MODERN_LANGUAGE_RULE_ASSIGNMENT,
      '_LANGUAGE_RULE_MATCH_USER = "- Write the title in Chinese."'
    );
    await fs.writeFile(filePath, updated, "utf8");
    console.log(`Patched ${label}: pinned modern title language to Chinese`);
    return;
  }

  if (content.includes(CHINESE_SENTINEL) || (content.includes("_TITLE_PROMPT") && content.includes("中文"))) {
    console.log(`OK ${label}: already uses a Chinese title prompt`);
    return;
  }

  if (!content.includes(ORIGINAL_TITLE_PROMPT) && !TITLE_PROMPT_ASSIGNMENT.test(content)) {
    console.error(`Unexpected title_generator.py format in ${label}: ${filePath}`);
    console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
    process.exitCode = 1;
    return;
  }

  const updated = content.includes(ORIGINAL_TITLE_PROMPT)
    ? content.replace(ORIGINAL_TITLE_PROMPT, CHINESE_TITLE_PROMPT)
    : content.replace(TITLE_PROMPT_ASSIGNMENT, `${CHINESE_TITLE_PROMPT}\n`);
  await fs.writeFile(filePath, updated, "utf8");
  console.log(`Patched ${label}: ${filePath}`);
}

async function patchTuiGatewayAutoTitle({ label, filePath, optional }) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    if (optional) {
      console.log(`Skipped ${label}: file not found at ${filePath}`);
      return;
    }
    console.error(`Missing ${label}: ${filePath}`);
    console.error("Run `npm run hermes:bootstrap` first so the runtime is installed locally.");
    process.exitCode = 1;
    return;
  }

  const originalCall = [
    "                    maybe_auto_title(",
    "                        _get_db(),",
    '                        session.get("session_key") or sid,',
    "                        text,",
    "                        raw,",
    '                        session.get("history", []),',
    "                    )",
  ].join("\n");
  const activeRuntimeCall = [
    "                    maybe_auto_title(",
    "                        _get_db(),",
    '                        session.get("session_key") or sid,',
    "                        text,",
    "                        raw,",
    '                        session.get("history", []),',
    "                        main_runtime={",
    '                            "model": getattr(agent, "model", None),',
    '                            "provider": getattr(agent, "provider", None),',
    '                            "base_url": getattr(agent, "base_url", None),',
    '                            "api_key": getattr(agent, "api_key", None),',
    '                            "api_mode": getattr(agent, "api_mode", None),',
    "                        } if agent else None,",
    "                    )",
  ].join("\n");
  const interruptedRuntimeCall = activeRuntimeCall.replace(
    "                        raw,",
    '                        raw if raw.strip() else "任务已被用户终止。",',
  );
  const originalGate = [
    "            if (",
    '                status == "complete"',
    "                and isinstance(raw, str)",
    "                and raw.strip()",
    "                and isinstance(text, str)",
    "                and text.strip()",
    "            ):",
  ].join("\n");
  const interruptedGate = [
    "            if (",
    '                status in {"complete", "interrupted"}',
    "                and isinstance(raw, str)",
    '                and (raw.strip() or status == "interrupted")',
    "                and isinstance(text, str)",
    "                and text.strip()",
    "            ):",
  ].join("\n");
  const autoTitleLongHandlerMarker = '        "session.branch",';
  const autoTitleLongHandlerEntry = '        "session.auto_title",';
  const autoTitleMethodMarker = '@method("session.auto_title")';
  const autoTitleMethod = [
    '@method("session.auto_title")',
    "def _(rid, params: dict) -> dict:",
    '    target = str(params.get("session_id") or "").strip()',
    "    if not target:",
    '        return _err(rid, 4006, "session_id required")',
    "    db = _get_db()",
    "    if db is None:",
    "        return _db_unavailable_error(rid, code=5036)",
    "    try:",
    '        existing = (db.get_session_title(target) or "").strip()',
    "    except Exception:",
    '        existing = ""',
    "    if existing:",
    '        return _ok(rid, {"scheduled": False, "title": existing, "session_id": target})',
    "",
    '    user_message = str(params.get("user_message") or "").strip()',
    '    assistant_response = str(params.get("assistant_response") or "").strip() or "任务已被用户终止。"',
    "    history = []",
    "    try:",
    '        history = db.get_messages_as_conversation(target, include_ancestors=True) or []',
    "    except Exception:",
    "        history = []",
    "    if not user_message:",
    "        for message in history:",
    '            if isinstance(message, dict) and message.get("role") == "user":',
    '                user_message = str(message.get("content") or message.get("text") or "").strip()',
    "                if user_message:",
    "                    break",
    "    if not user_message:",
    '        return _err(rid, 4008, "user_message required")',
    "",
    "    live = _find_live_session_by_key(target)",
    '    session = live[1] if live else None',
    '    agent = session.get("agent") if session else None',
    "    if agent is not None:",
    "        main_runtime = {",
    '            "model": getattr(agent, "model", None),',
    '            "provider": getattr(agent, "provider", None),',
    '            "base_url": getattr(agent, "base_url", None),',
    '            "api_key": getattr(agent, "api_key", None),',
    '            "api_mode": getattr(agent, "api_mode", None),',
    "        }",
    "    else:",
    '        cfg = _load_cfg()',
    '        cfg_model = cfg.get("model") if isinstance(cfg, dict) else {}',
    '        cfg_provider = cfg_model.get("provider") if isinstance(cfg_model, dict) else ""',
    "        main_runtime = {",
    '            "model": _resolve_model(),',
    '            "provider": (os.environ.get("HERMES_TUI_PROVIDER") or os.environ.get("HERMES_INFERENCE_PROVIDER") or cfg_provider or "").strip(),',
    '            "base_url": (os.environ.get("HERMES_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or "").strip(),',
    '            "api_key": (os.environ.get("HERMES_API_KEY") or os.environ.get("HERMES_INFERENCE_API_KEY") or os.environ.get("OPENAI_API_KEY") or "").strip(),',
    '            "api_mode": (os.environ.get("HERMES_API_MODE") or "").strip(),',
    "        }",
    "",
    "    try:",
    "        from agent.title_generator import auto_title_session",
    "        auto_title_session(",
    "            db,",
    "            target,",
    "            user_message,",
    "            assistant_response,",
    "            main_runtime=main_runtime,",
    "        )",
    '        title = (db.get_session_title(target) or "").strip()',
    "    except Exception as exc:",
    '        logger.warning("Failed to retry auto-title for %s: %s", target, exc)',
    '        return _err(rid, 5008, f"auto-title failed: {exc}")',
    "    if not title:",
    '        return _err(rid, 5008, "auto-title did not produce a title")',
    '    return _ok(rid, {"scheduled": False, "title": title, "session_id": target})',
  ].join("\n");

  let updated = content;
  const hasActiveRuntime =
    updated.includes("main_runtime={") &&
    updated.includes('"api_key": getattr(agent, "api_key", None)');
  if (!hasActiveRuntime) {
    if (!updated.includes(originalCall)) {
      console.error(`Unexpected TUI gateway auto-title format in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }
    updated = updated.replace(originalCall, activeRuntimeCall);
  }

  if (!updated.includes(interruptedGate)) {
    if (!updated.includes(originalGate)) {
      console.error(`Unexpected TUI gateway auto-title condition in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }
    updated = updated.replace(originalGate, interruptedGate);
  }

  if (!updated.includes('raw if raw.strip() else "任务已被用户终止。"')) {
    if (!updated.includes(activeRuntimeCall)) {
      console.error(`Unexpected TUI gateway auto-title call in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }
    updated = updated.replace(activeRuntimeCall, interruptedRuntimeCall);
  }

  if (!updated.includes(autoTitleLongHandlerEntry)) {
    if (!updated.includes(autoTitleLongHandlerMarker)) {
      console.error(`Unexpected TUI gateway long-handler list in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }
    updated = updated.replace(
      autoTitleLongHandlerMarker,
      `${autoTitleLongHandlerMarker}\n${autoTitleLongHandlerEntry}`
    );
  }

  if (!updated.includes(autoTitleMethodMarker)) {
    if (!updated.includes('@method("session.undo")')) {
      console.error(`Unexpected TUI gateway session method layout in ${label}: ${filePath}`);
      console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
      process.exitCode = 1;
      return;
    }
    updated = updated.replace(
      '@method("session.undo")',
      `${autoTitleMethod}\n\n@method("session.undo")`
    );
  }

  if (updated === content) {
    console.log(`OK ${label}: auto-title supports completed, interrupted, and restart-retry tasks`);
    return;
  }

  await fs.writeFile(filePath, updated, "utf8");
  console.log(`Patched ${label}: auto-title now covers completed, interrupted, and restart-retry tasks`);
}

async function patchUtf8Decoders() {
  for (const relativePath of utf8DecodeTargets) {
    const filePath = path.join(runtimeRoot, "hermes-agent", relativePath);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      console.log(`Skipped UTF-8 decoder patch: ${filePath}`);
      continue;
    }

    const updated = content.replace(
      /\.read\(\)\.decode\(\)/g,
      '.read().decode("utf-8", errors="replace")'
    );
    if (updated === content) {
      continue;
    }

    await fs.writeFile(filePath, updated, "utf8");
    console.log(`Patched UTF-8 decoder tolerance: ${relativePath}`);
  }
}

async function patchWindowsLocalShell() {
  const powershellFinder = `
def _find_powershell() -> str:
    """Find PowerShell for native Windows command execution."""
    custom = os.environ.get("HERMES_POWERSHELL_PATH")
    if custom and os.path.isfile(custom):
        return custom

    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found

    raise RuntimeError(
        "PowerShell not found. Install PowerShell 7 or set HERMES_POWERSHELL_PATH."
    )

`;

  for (const target of localShellTargets) {
    let content;
    try {
      content = await fs.readFile(target.filePath, "utf8");
    } catch {
      if (!target.optional) {
        console.error(`Missing ${target.label}: ${target.filePath}`);
        process.exitCode = 1;
      } else {
        console.log(`Skipped ${target.label}: file not found at ${target.filePath}`);
      }
      continue;
    }

    // Older versions inserted the module-level helper at the character
    // offset of the indented class method. That left the method definition at
    // column zero and produced an IndentationError in packaged runtimes.
    // Remove that exact helper block first so the patch can repair a runtime
    // generated by the older script as well as patch a clean upstream file.
    let updated = content.replace(powershellFinder, "");
    updated = updated.replace(/^[ \t]*def _run_bash\(/m, "    def _run_bash(");

    if (!updated.includes("def _find_powershell() -> str:")) {
      const insertionPoint = updated.indexOf("class LocalEnvironment");
      if (insertionPoint < 0) {
        console.error(`Unexpected local terminal runtime format: ${target.filePath}`);
        console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
        process.exitCode = 1;
        continue;
      }
      updated = updated.slice(0, insertionPoint) + powershellFinder + updated.slice(insertionPoint);
    }
    updated = updated.replace(
      /^[ \t]*bash = _find_bash\(\)$/m,
      "        bash = _find_powershell() if _IS_WINDOWS else _find_bash()"
    );
    const runBashStart = updated.indexOf("def _run_bash");
    const hasWindowsArgs = updated.includes("            powershell_cmd = \"$OutputEncoding =");
    if (!hasWindowsArgs) {
      const argsStart = updated.indexOf("        args = ", runBashStart);
      const runEnvMarker = "        run_env = _make_run_env(self.env)";
      const argsEnd = updated.indexOf("\n", argsStart);
      if (runBashStart < 0 || argsStart < 0 || argsEnd < 0 || !updated.includes(runEnvMarker, argsEnd)) {
        console.error(`Unexpected local shell invocation format: ${target.filePath}`);
        console.error("Hermes upstream may have changed. Please review and update scripts/patch-hermes-runtime.mjs.");
        process.exitCode = 1;
        continue;
      }
      const newArgs = `        if _IS_WINDOWS:
            powershell_cmd = "$OutputEncoding = [System.Text.UTF8Encoding]::new(\$false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(\$false); [Console]::ErrorEncoding = [System.Text.UTF8Encoding]::new(\$false); " + cmd_string
            args = [bash, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell_cmd]
        else:
            args = [bash, "-l", "-c", cmd_string] if login else [bash, "-c", cmd_string]`;
      updated = updated.slice(0, argsStart) + newArgs + updated.slice(argsEnd);
    }

    if (updated === content) {
      console.log(`OK ${target.label}: Windows local terminal uses PowerShell`);
      continue;
    }

    await fs.writeFile(target.filePath, updated, "utf8");
    console.log(`Patched ${target.label}: Windows local terminal now prefers pwsh`);
  }
}

async function main() {
  console.log("Applying Hermes runtime patches...");
  for (const target of patchTargets) {
    await patchFile(target);
  }
  for (const target of tuiGatewayTargets) {
    await patchTuiGatewayAutoTitle(target);
  }
  await patchWindowsLocalShell();
  await patchUtf8Decoders();
}

await main();
