---
name: loadout-opencode-cli
description: Run non-interactive OpenCode CLI prompts and follow-up conversations. Use when asked to delegate a task to OpenCode CLI or continue an OpenCode CLI session.
---

Start with `opencode run --format json "PROMPT"` using the configured default model, and capture `sessionID` from the output.
For follow-ups, run `opencode run --session SESSION_ID --format json "FOLLOW-UP"` in the same working directory.
