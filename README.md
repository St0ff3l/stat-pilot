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

When you package the app, include `.runtime/` alongside the Electron resources so the bundled Hermes binary can be found automatically.

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
