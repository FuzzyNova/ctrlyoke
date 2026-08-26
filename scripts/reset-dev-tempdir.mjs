#!/usr/bin/env node

// Wipes .vscode-dev-tempdir/ (the "Run Extension (Debug, Isolated)" launch
// config's workspace folder + --user-data-dir + CTRLYOKE_HOME) and recreates
// an empty workspace/ subfolder, so that launch always starts from an
// unconfigured folder with unseen walkthrough globalState. See
// .vscode/tasks.json's "reset-onboarding-tempdir" task.

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const tempDir = path.join(process.cwd(), ".vscode-dev-tempdir");

await rm(tempDir, { recursive: true, force: true });
await mkdir(path.join(tempDir, "workspace"), { recursive: true });
