# Project Context

Last updated: 2026-09-29

## Project

- Name: `StatPilot（深小统）`
- Repository: `stat-pilot`
- Goal: Electron desktop workspace for Shenzhen government intelligence and statistics work.
- Runtime: local DeepSeek Harness (DSH), launched by `electron/dsh-runtime.mjs` and controlled by `electron/dsh-client.mjs`.

## Current DSH integration

- Electron main process starts the DSH Web profile and connects through its HTTP RPC and WebSocket streams.
- Conversation list/history, live messages, tool activity, approvals, clarifications, model selection, and skill discovery use DSH APIs.
- Image prompts use DSH's native image content blocks; other files use its streamed upload route and per-session upload receipts.
- Voice dictation uses DSH's experimental local SenseVoice bundle and authenticated speech RPC. The renderer converts recordings to bounded 16 kHz mono PCM WAV; transcripts are inserted into the draft and are never auto-submitted.
- Sessions removed from the sidebar are archived through `workspace/archiveSession`; a persistent sidebar view lists archived sessions and restores them through `workspace/unarchiveSession`.
- The app enables the pinned `dsh-archived-chats` 1.4.5 DSH bundle in the Web profile. Its host routes power the archive view and permanent deletion; deletion requires a renderer confirmation and uses the plugin's DSH lifecycle/persistence cleanup, including deferred cleanup when the host cannot safely remove a live session immediately.
- DeepSeek browser sign-in uses DSH's `account/startSignIn`, `account/getState`, `account/cancelSignIn`, and `account/signOut` operations. Account credentials remain inside DSH.
- Provider API keys use DSH's credential reference store and are not retained in the app settings file. OpenAI and OpenRouter map to DSH `llm-pi-ai` catalog routes, while custom OpenAI-compatible endpoints are written to a dedicated DSH provider profile.
- The app's permission toggle maps to DSH's `permission.defaultPreset` for new sessions: `danger-full-access` when enabled and `workspace-write` when disabled. Existing sessions keep their recorded permission preset.
- On Windows, DSH's interactive terminal defaults to `pwsh.exe`, falling back to the system `powershell.exe`; the preference is scoped to the DSH child process.
- The product persona is supplied by an app-owned DSH patch under Electron user data; startup does not overwrite the user's DSH `AGENTS.md`, home patch, or existing same-name skills.
- Release CI stages the target runner's Node.js binary, packages only that executable alongside the DSH dependencies, then starts DSH from the packaged app's unpacked dependency tree. The DSH home, conversations, credentials, and other local runtime data are not release assets.
- The default DeepSeek model is `deepseek-flash` (DeepSeek V4.1 Flash). Retired V4 Flash/Vision Exp IDs and legacy chat/reasoner IDs normalize to it. The official API currently routes `deepseek-v4-pro` to V4.1 Flash, so the app retains it only as a compatibility option; OpenRouter and custom Provider model IDs remain provider-specific.
- The old Express article-crawler/analyzer had no renderer or Electron caller and was not launched by the desktop app. Its sidecar and unreferenced Hermes App Server generated bindings have been removed; desktop collection and analysis use DSH skills. Any future API endpoint must use the DSH runtime rather than call a model provider directly.

## DSH adaptation notes

- Image attachments and DeepSeek's native `web_search` use DSH capabilities and the DSH-managed DeepSeek credential. DeepSeek V4.1 Flash handles images directly; the old independent vision-provider inputs had no backend calls and are removed.
- Local voice dictation now uses DSH's experimental SenseVoice bundle; its model is downloaded only after the user confirms first-time preparation. Firecrawl/Exa search, FAL image generation, Browserbase automation, OpenAI Voice, and independent vision keys had settings fields but no backend calls. Their UI, types, defaults, and persisted values are removed during settings normalization.
- Renderer types and IPC channels now use DSH names. Legacy `hermes_*` local-storage values migrate once to `statpilot_*` keys so existing workspace preferences and file indexes survive without retaining Hermes names.
- The former Hermes executable and `runtimeMode` settings are discarded during settings normalization. Account UI and handlers use DSH's account operations.

## Release constraints

- Installers and build verification run only in GitHub Actions on the matching target runner.
- Linux ARM64 packages are built on native ARM64 runners.
- Do not include `.runtime` as a whole; release packaging copies only `.runtime/dsh-node.exe`.
- Ignore `._*` and `.DS_Store` during skill discovery and packaging.
