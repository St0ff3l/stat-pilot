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

On macOS, dragging the `.app` from the `.dmg` into `Applications` does not run installer hooks by itself. Instead, on the first app launch, the Electron main process copies the bundled `.runtime/` from the app's `Resources` directory into the user's private app-data directory and starts Hermes from there automatically.

To build a distributable macOS `.dmg`:

```bash
npm install
npm run hermes:bootstrap
npm run dist:mac
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
