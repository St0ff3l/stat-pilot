# sz-gov-scope

A desktop Hermes client for Shenzhen government intelligence work, built with Electron and a Hermes runtime bridge.

## What it does

- Connects to a local Hermes runtime from the Electron main process
- Shows conversation history in a left sidebar
- Shows a chat-style conversation pane on the right
- Hides model and workspace settings behind a settings dialog
- Persists settings locally in Electron user data

## Run locally

```bash
npm install
npm run hermes:bootstrap
npm run dev
```

That installs Hermes into `.runtime/` inside this repo, runs the Hermes setup wizard, and then starts Vite and Electron together.

The `.runtime/` directory itself stays gitignored. Any project-specific Hermes customizations should be captured in tracked patch scripts under `scripts/` so they can be re-applied deterministically after bootstrap and before packaging.

When you package the app, include `.runtime/` alongside the Electron resources so the bundled Hermes binary can be found automatically. This project now does that through `electron-builder` `extraResources`.

The installers produced by the release workflow contain a platform-specific Hermes runtime. On first launch, the app copies that bundled runtime into its private application-data directory; it does not depend on a separately installed `hermes` command. The build excludes the local `.runtime/hermes-home` so personal sessions, login state, and API keys are never bundled. A GitHub **Source code** ZIP does not contain `.runtime`, because that directory is generated and gitignored, so it cannot be used as a ready-to-run installer without running the platform bootstrap first.

On macOS, dragging the `.app` from the `.dmg` into `Applications` does not run installer hooks by itself. Instead, on the first app launch, the Electron main process copies the bundled `.runtime/` from the app's `Resources` directory into the user's private app-data directory and starts Hermes from there automatically.

Release installers are built only by GitHub Actions on the matching target runner. Push a version tag such as `v0.1.0`, or start the `Build and release installers` workflow manually; do not build a Release installer locally. The workflow runs the platform bootstrap, verifies the bundled Hermes runtime, packages the installer, and uploads the artifacts.

For local development only:

```bash
npm install
npm run hermes:bootstrap
npm run dev
```

## Desktop settings

Open the settings dialog from the top-right button in the app and set:

- `Hermes Binary`
- `Model`
- `Workspace CWD`

The model selector is intentionally hidden from the main screen so the app stays focused on the agent workflow.

If `Hermes Binary` is not available, the app will try `HERMES_BIN`, then `hermes`, then `CODEX_BIN`, then `codex`.

If you want a non-interactive bootstrap, use `npm run hermes:bootstrap:quick`.

## Project structure

```text
electron/            Electron main and preload entrypoints
src/                 React renderer UI
server/              Legacy backend helpers and protocol types
skills/              Local project skills
data/                Local JSON article store
docs/                Project context and handoff notes
```
