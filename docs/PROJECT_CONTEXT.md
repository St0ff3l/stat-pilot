# Project Context

Last updated: 2026-06-09

This file captures migrated project context from a prior agent conversation and should be treated as the current working context unless contradicted by the codebase.

## Project

- Name: `sz-gov-scope`
- Path: `/Users/stoffel/CodeFile/sz-gov-scope`
- Goal: build a desktop Hermes client for Shenzhen government intelligence work with a chat-style UI and conversation history.

## Decisions already made

- The app uses Electron as the desktop shell.
- The main process talks to a Hermes runtime bridge over the app-server-style protocol.
- Model selection is hidden in settings rather than the main UI.
- The renderer should feel like a focused agent desktop: left history, right chat, simple composer.

## Already implemented

- Electron main process in `electron/main.mjs`
- Electron preload bridge in `electron/preload.cjs`
- React chat UI in `src/App.tsx`
- Conversation history sidebar, message stream, and settings dialog in the renderer
- Hermes runtime startup, thread listing, thread loading, and turn streaming in the Electron main process

## Verified state

- Renderer build passes
- Lint passes
- The app now targets a desktop Electron workflow

## Important implementation notes

- Generated runtime protocol TypeScript bindings are kept under `server/generated`
- For runtime, the server uses `tsx` instead of compiling the generated bindings for Node ESM
- The skill list endpoint merges project-local skills with runtime-discovered skills so the UI can reliably show project skills

## Likely next steps

1. Add thread naming and archive controls in the sidebar
2. Surface app-server approval/sandbox settings in advanced settings
3. Add a better empty state and loading/error handling for a missing Hermes runtime
4. Package the Electron app for distribution

## Migration note

- A source folder existed at `/Users/stoffel/Documents/Hermes/2026-06-09/hermes-runtime-agnet`
- At migration time, that folder did not contain an actual conversation export or project files beyond empty `work/` and `outputs/` directories
- The authoritative migrated context was therefore preserved here from the provided delegation context
