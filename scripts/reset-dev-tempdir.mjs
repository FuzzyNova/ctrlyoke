#!/usr/bin/env node

// Wipes .vscode-dev-tempdir/ (the "Run Extension (Debug, Isolated)" launch
// config's workspace folder + --user-data-dir + CTRLYOKE_HOME) and recreates
// an empty workspace/ subfolder, so that launch always starts from an
// unconfigured folder with unseen walkthrough globalState. The workspace
// settings also disable VS Code's built-in AI sign-in prompt, which can block
// the extension host before a hosted dashboard is usable. See
// .vscode/tasks.json's "reset-onboarding-tempdir" task.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const tempDir = path.join(process.cwd(), ".vscode-dev-tempdir");
const workspaceDir = path.join(tempDir, "workspace");
const workspaceSettingsDir = path.join(workspaceDir, ".vscode");
const workspaceSettings = `${JSON.stringify(
  { "chat.disableAIFeatures": true },
  null,
  2
)}\n`;

await rm(tempDir, { recursive: true, force: true });
await mkdir(workspaceSettingsDir, { recursive: true });
await writeFile(
  path.join(workspaceSettingsDir, "settings.json"),
  workspaceSettings,
  "utf8"
);
