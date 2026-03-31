# Adding a New CLI Harness to FlightPath

**Last Updated**: March 2026
**Reference Implementation**: `src/flightpath/harness/gemini/` (Gemini CLI)

## Overview

Adding a new CLI harness requires changes across multiple layers of the codebase. This guide documents every required touchpoint based on the actual work done to add the Gemini and Qwen harnesses.

**There is no shortcut.** Each layer below has a real reason to exist:

- The **harness directory** holds all CLI-specific logic (parsers, monitor, permissions)
- The **type layer** must be updated because `Harness` is a TypeScript enum and string IDs are centralized constants
- The **wiring layer** must be updated because `IntegrationFactory` and `WorkflowOrchestrator` explicitly manage each integration's lifecycle
- The **settings layer** must be updated because VS Code requires all settings to be declared in `package.json`
- The **UI layer** must be updated because the webview state is explicit — model lists, availability status, and harness dropdowns are all keyed by harness ID

**Estimated time**: 4–8 hours for a complete, tested integration.

---

## Table of Contents

1. [Harness Directory — 6 Implementation Files](#1-harness-directory--6-implementation-files)
2. [Hook Script](#2-hook-script)
3. [Type Layer](#3-type-layer)
4. [Wiring Layer](#4-wiring-layer)
5. [Settings Layer](#5-settings-layer)
6. [UI Layer](#6-ui-layer)
7. [Optional: Shared Infrastructure Changes](#7-optional-shared-infrastructure-changes)
8. [Complete Checklist](#8-complete-checklist)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Harness Directory — 6 Implementation Files

Create `src/flightpath/harness/<name>/` with these 6 files:

```
src/flightpath/harness/gemini/
├── GeminiCliProvider.ts          # ICliProvider — aggregates all components, defines config
├── GeminiResponseParser.ts       # IResponseParser — parses stdout/stderr into CopilotCliResult
├── GeminiNotificationMonitor.ts  # INotificationMonitor — detects completion via hooks or polling
├── GeminiToolPermissionMapper.ts # IToolPermissionMapper — converts permissions to CLI flags
├── GeminiLogParser.ts            # extends BaseLogParser — parses log files for session/completion
└── GeminiToolBuilder.ts          # (optional) — helper for constructing tool-use events
```

`GeminiToolBuilder` is only needed when your `LogParser` or `ResponseParser` constructs tool event objects — it is an internal helper, not an interface requirement. Qwen, for example, does not have one.

### ICliProvider (`GeminiCliProvider.ts`)

Key responsibilities:

- `config: ProviderConfig` — name, displayName, installHint, `useLogFileMonitoring`, `shouldStreamHeadlessOutput`
- `buildHeadlessArgs(baseArgs, prompt)` — construct the full args array for headless execution
- `buildInteractiveTuiCommand(baseArgs)` — construct the TUI command string
- `formatFileReference(relativeFilePath)` — format file paths for this CLI (e.g. `@path`, no prefix)
- `getMcpConfigArgs(mcpServerPath, workspaceRoot)` — return MCP config args or `null`
- `checkAvailability()` — return true if the CLI executable is found

**If your harness modifies workspace config files for hook registration** (like Gemini writes `.gemini/settings.json`), implement the optional `cleanupWorkspaceArtifacts(workspaceRoot)` method. See [Section 7](#7-optional-shared-infrastructure-changes).

### INotificationMonitor (`GeminiNotificationMonitor.ts`)

Completion detection approaches (pick one):

1. **Hook-based** (recommended when CLI supports hooks): CLI invokes your hook script on completion, which writes a notification file to a temp directory. Your monitor polls for that file.
2. **Log-based**: Poll the CLI's own log file for a completion event.
3. **Exit-based**: Return immediately — `CliIntegration` detects process exit.

`buildHookConfig()` returns one of these formats depending on your CLI's hook mechanism:

- `{ type: "none" }` — no hook support
- `{ type: "json", config: {...} }` — JSON hook config (Copilot style)
- `{ type: "json-string", config: "..." }` — JSON string hook arg (Claude style)
- `{ type: "toml-inline", config: "..." }` — TOML inline (Codex style)
- `{ type: "workspace-json", configPath: "...", content: {...} }` — writes a config file into the workspace (Gemini/Qwen style — requires `cleanupWorkspaceArtifacts`)

### ILogParser (`GeminiLogParser.ts`)

Extend `BaseLogParser` from `src/flightpath/harness/shared/BaseLogParser.ts`:

```typescript
import path from "path";
import os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";

export class GeminiLogParser extends BaseLogParser {
  getLogDirectory(): string {
    return path.join(os.homedir(), ".gemini", "tmp");
  }

  getLogFilePattern(): RegExp {
    return /^[a-f0-9-]+\.json$/;
  }

  parseLogLine(line: string): any | null {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  isCompletionEvent(event: any): boolean {
    return event?.type === "turn.completed" || event?.type === "session.ended";
  }

  extractSessionId(event: any): string | undefined {
    return event?.session_id || event?.sessionId;
  }
}
```

### IResponseParser (`GeminiResponseParser.ts`)

Parses raw stdout/stderr into `CopilotCliResult & { sessionId?: string }`. Implement:

- `parse(stdout, stderr, exitCode)` — main entry point
- `parseTokenCounts(output)` — extract `{ prompt, completion }` or `undefined`
- `extractSessionId(output)` — extract session ID if the CLI prints one
- `processStreamingChunk(chunk, streamState)` — for real-time streaming (return `chunk` for plain text)

### IToolPermissionMapper (`GeminiToolPermissionMapper.ts`)

Converts `ToolPermissionConfig` to CLI args for three modes:

- `dangerouslyAllowAll` — bypass all restrictions (e.g. `--all-tools`)
- `allowAll` — auto-grant with deny list
- `custom` — explicit allow/deny patterns

---

## 2. Hook Script

If your harness uses hook-based completion detection, create `src/scripts/flightpath-<name>-hook.js`.

This is a plain CJS Node.js script (not bundled). Use the shared utilities from `./flightpath-hook-utils`:

```javascript
const { initializeLogger, readStdinJson } = require("./flightpath-hook-utils");

const SCRIPT_NAME = "flightpath-gemini-hook";
const SCRIPT_PREFIX = "FlightPath Gemini Hook";

function main() {
  const notifyDir = process.argv[2];
  const debugLog = initializeLogger(SCRIPT_NAME, notifyDir);

  if (process.argv.length < 3) {
    console.error(`${SCRIPT_PREFIX}: No notification directory provided`);
    process.exit(1);
  }

  readStdinJson(SCRIPT_PREFIX, debugLog, (hookInput) => {
    // Write notification file based on hook event
    // See src/scripts/flightpath-gemini-hook.js for a complete example
  });
}

main();
```

The hook script receives hook data via stdin as JSON. It writes a notification file to the directory passed as `argv[2]`, which `NotificationMonitorBase` polls for completion.

---

## 3. Type Layer

### `src/types/FlightPathTypes.ts`

Add to the `Harness` enum:

```typescript
export enum Harness {
  CopilotCli = "copilot-cli",
  ClaudeCli = "claude-cli",
  CodexCli = "codex-cli",
  QwenCli = "qwen-cli",
  GeminiCli = "gemini-cli", // ADD THIS
  CopilotChat = "copilot-chat",
}
```

### `src/types/DashboardConstants.ts`

Four additions:

```typescript
// 1. Add to HARNESS_IDS
export const HARNESS_IDS = {
  // ...existing...
  GEMINI_CLI: "gemini-cli",
} as const;

// 2. Add to HARNESS_DISPLAY_NAMES
export const HARNESS_DISPLAY_NAMES = {
  // ...existing...
  [HARNESS_IDS.GEMINI_CLI]: { name: "Gemini CLI", shortName: "Gemini" },
} as const;

// 3. Add to HARNESS_DEFAULT_MODELS
export const HARNESS_DEFAULT_MODELS = {
  // ...existing...
  [HARNESS_IDS.GEMINI_CLI]: "auto-gemini-3",
} as const;

// 4. Add a model list constant (used by the webview store)
export const GEMINI_CLI_MODELS = [
  { value: "none", label: "None (skip --model flag)" },
  { value: "auto-gemini-3", label: "Auto Gemini 3" },
  { value: "gemini-3-pro", label: "Gemini 3 Pro" },
  { value: "gemini-3-flash", label: "Gemini 3 Flash" },
] as const;
```

---

## 4. Wiring Layer

### `src/flightpath/IntegrationFactory.ts`

```typescript
import { GeminiCliProvider } from "./harness/gemini/GeminiCliProvider";

// Add factory method:
createGeminiCli(registerWithContext: boolean = true): CliIntegration {
  const provider = new GeminiCliProvider();
  return new CliIntegration(provider, this.platform, registerWithContext);
}

// Add case in createForHarness() switch:
case Harness.GeminiCli:
  return this.createGeminiCli(registerWithContext);
```

### `src/flightpath/WorkflowOrchestrator.ts`

Six additions — follow the exact pattern of any existing harness (e.g. search for `qwenCli` to see all six):

```typescript
// 1. Field declaration
private readonly geminiCliIntegration: CliIntegration;

// 2. Construction (in constructor)
this.geminiCliIntegration = this.integrationFactory.createGeminiCli();

// 3. Registration with VS Code subscriptions (in the allIntegrations array)
[HARNESS_IDS.GEMINI_CLI, this.geminiCliIntegration],

// 4. Initialization (in the Promise.all initialization block)
this.geminiCliIntegration.initialize(),

// 5. Harness resolution (in getIntegrationForHarness() switch)
case Harness.GeminiCli:
  return this.geminiCliIntegration;

// 6. Workflow name propagation (in setWorkflowName())
this.geminiCliIntegration.setWorkflowName(name);
```

Also add a display label in the logging block (search for the `[Harness.QwenCli]: "Qwen CLI"` pattern to find the right place):

```typescript
[Harness.GeminiCli]: "Gemini CLI",
```

---

## 5. Settings Layer

### `src/utils/ConfigurationUtils.ts`

Three switch cases and one getter function:

```typescript
// 1. In getCliModelSettingKey(harness):
case Harness.GeminiCli:
  return "geminiCliModel";

// 2. In getAdditionalArgsSettingKey(harness):
case Harness.GeminiCli:
  return "geminiCliAdditionalArgs";

// 3. In normalizeHarness(value):
case HARNESS_IDS.GEMINI_CLI:
case Harness.GeminiCli:
  return Harness.GeminiCli;

// 4. New getter (follow the pattern of getQwenCliModel):
getGeminiCliModel(): string {
  return getConfig().get<string>("geminiCliModel", "auto-gemini-3");
},
```

Also add a case in `getModelForHarness()` to route to your getter:

```typescript
case Harness.GeminiCli:
  return ConfigurationUtils.getGeminiCliModel();
```

### `src/utils/ModelConstants.ts`

Add model arrays and label map (used by the settings sync and webview):

```typescript
export const GEMINI_CLI_MODELS = [
  "gemini-3-pro",
  "gemini-3-flash",
  "auto-gemini-3",
] as const;

export const GEMINI_CLI_MODEL_LABELS: Record<string, string> = {
  "gemini-3-pro": "Gemini 3 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "auto-gemini-3": "Auto Gemini 3",
};

export type GeminiCliModel = (typeof GEMINI_CLI_MODELS)[number];

export function isGeminiCliModel(model: string): model is GeminiCliModel {
  return GEMINI_CLI_MODELS.includes(model as GeminiCliModel);
}
```

### `package.json`

Two additions under `contributes.configuration.properties`:

```json
// 1. Add harness enum value (in flightpath.harness):
"enum": ["copilot-cli", "claude-cli", "codex-cli", "qwen-cli", "gemini-cli", "copilot-chat"],
"enumDescriptions": [
  "...",
  "Use Gemini CLI (Google's Gemini models via command line)"
],
"markdownDescription": "... \n- **Gemini CLI**: Uses Google's Gemini CLI"

// 2. Add model setting:
"flightpath.geminiCliModel": {
  "order": 440,
  "type": "string",
  "default": "auto-gemini-3",
  "description": "[Gemini CLI] Model for Gemini CLI execution.",
  "enum": ["gemini-3-pro", "gemini-3-flash", "auto-gemini-3"],
  "enumDescriptions": ["Gemini 3 Pro", "Gemini 3 Flash", "Auto Gemini 3"]
},
"flightpath.geminiCliAdditionalArgs": {
  "order": 441,
  "type": "string",
  "default": "",
  "description": "[Gemini CLI] Additional arguments to pass to the Gemini CLI."
}
```

---

## 6. UI Layer

### `src/ui/WebviewSettingsSync.ts`

Four additions (follow the Qwen pattern throughout):

```typescript
// 1. Import model labels
import { GEMINI_CLI_MODEL_LABELS } from "../utils/ModelConstants";

// 2. Initial harness availability state
[HARNESS_IDS.GEMINI_CLI]: { available: false, status: HARNESS_STATUS_STRINGS.CHECKING },

// 3. Add to VALID_CLI_HARNESSES array
HARNESS_IDS.GEMINI_CLI,

// 4. In buildCurrentSettings() — add to harnessDefaultModels and harnessDefaultAdditionalArgs:
[HARNESS_IDS.GEMINI_CLI]: this.getModelForHarness(Harness.GeminiCli),
[HARNESS_IDS.GEMINI_CLI]: ConfigurationUtils.getAdditionalArgsForHarness(Harness.GeminiCli),

// 5. In buildModelOptions() — add model list:
const geminiCliOptions = [
  noneOption,
  ...Object.entries(GEMINI_CLI_MODEL_LABELS).map(([value, label]) => ({ value, label })),
];
// ...and add to the returned map:
[HARNESS_IDS.GEMINI_CLI]: geminiCliOptions,
```

### `src/ui/webview-react/components/shared/HarnessDropdown.tsx`

```typescript
// 1. Add display name
const HARNESS_DISPLAY_NAME: Record<HarnessId, string> = {
  // ...existing...
  [HARNESS_IDS.GEMINI_CLI]: "Gemini",
};

// 2. Add to CLI_HARNESSES group (controls grouping in the dropdown)
export const CLI_HARNESSES: HarnessId[] = [
  HARNESS_IDS.COPILOT_CLI,
  HARNESS_IDS.CLAUDE_CLI,
  HARNESS_IDS.CODEX_CLI,
  HARNESS_IDS.QWEN_CLI,
  HARNESS_IDS.GEMINI_CLI, // ADD
];
```

### `src/ui/webview-react/store/settingsStore.ts`

```typescript
// 1. Import model list from DashboardConstants
import { GEMINI_CLI_MODELS as GEMINI_CLI_MODEL_LIST } from "@root/types/DashboardConstants";

// 2. Build ModelOption array
const GEMINI_CLI_MODELS: ModelOption[] = [...GEMINI_CLI_MODEL_LIST];

// 3. Add to initialHarnessAvailability
[HARNESS_IDS.GEMINI_CLI]: { available: false, status: HARNESS_STATUS_STRINGS.CHECKING },

// 4. Add to initialState.modelsByHarness
[HARNESS_IDS.GEMINI_CLI]: GEMINI_CLI_MODELS,
```

---

## 7. Optional: Shared Infrastructure Changes

These only apply in specific situations — check whether your harness needs them.

### `cleanupWorkspaceArtifacts` — hook config files written into the workspace

Some CLIs (Gemini, Qwen) require a settings file to be written into the workspace during hook setup (e.g. `.gemini/settings.json`). After the workflow completes, `CliIntegration` calls `provider.cleanupWorkspaceArtifacts?.(workspaceRoot)` to restore or remove it.

If your harness writes to the workspace for hook registration, implement this method in your `CliProvider`:

```typescript
async cleanupWorkspaceArtifacts(workspaceRoot: string): Promise<void> {
  // Restore pre-existing config file from backup, or remove if we created it
  const configPath = path.join(workspaceRoot, ".gemini", "settings.json");
  const backupPath = configPath + ".flightpath-backup";
  if (await fileExists(backupPath)) {
    await fs.rename(backupPath, configPath);
  } else {
    await fs.unlink(configPath).catch(() => {});
  }
}
```

This method is declared as optional (`cleanupWorkspaceArtifacts?(workspaceRoot: string): Promise<void>`) in `ICliProvider.ts` — you only implement it when needed.

### `CliEventMapper.ts` — tool name mappings

`src/flightpath/harness/shared/CliEventMapper.ts` maps CLI-specific tool names to FlightPath's generic action categories (`SHELL_EXEC`, `FILE_READ`, `FILE_WRITE`, etc.). If your CLI uses tool names not already in the map (e.g. `google_web_search`, `grep_search`), add them to the relevant Set.

Check first — many common tool names are already mapped. Only add entries for tool names your harness actually emits.

---

## 8. Complete Checklist

### Harness directory

- [ ] `<Name>CliProvider.ts` implementing `ICliProvider`
- [ ] `<Name>ResponseParser.ts` implementing `IResponseParser`
- [ ] `<Name>NotificationMonitor.ts` implementing `INotificationMonitor`
- [ ] `<Name>ToolPermissionMapper.ts` implementing `IToolPermissionMapper`
- [ ] `<Name>LogParser.ts` extending `BaseLogParser`
- [ ] `<Name>ToolBuilder.ts` (only if your parser constructs tool-use events)

### Hook script (if hook-based)

- [ ] `src/scripts/flightpath-<name>-hook.js` using `initializeLogger` + `readStdinJson` from `flightpath-hook-utils`

### Type layer

- [ ] `src/types/FlightPathTypes.ts` — add `Harness` enum value
- [ ] `src/types/DashboardConstants.ts` — add to `HARNESS_IDS`, `HARNESS_DISPLAY_NAMES`, `HARNESS_DEFAULT_MODELS`, and add model list constant

### Wiring layer

- [ ] `src/flightpath/IntegrationFactory.ts` — import, factory method, switch case
- [ ] `src/flightpath/WorkflowOrchestrator.ts` — field, construction, registration, initialization, harness resolution, workflow name propagation, display label

### Settings layer

- [ ] `src/utils/ConfigurationUtils.ts` — model key, additional args key, harness normalizer, model getter, `getModelForHarness` case
- [ ] `src/utils/ModelConstants.ts` — model array, label map, type, guard function
- [ ] `package.json` — harness enum value + description, model setting, additional args setting

### UI layer

- [ ] `src/ui/WebviewSettingsSync.ts` — import, initial status, valid harnesses, model/args mappings, model options
- [ ] `src/ui/webview-react/components/shared/HarnessDropdown.tsx` — display name, CLI_HARNESSES group
- [ ] `src/ui/webview-react/store/settingsStore.ts` — import, model array, initial availability, `modelsByHarness`

### Optional (if applicable)

- [ ] `cleanupWorkspaceArtifacts` in your `CliProvider` (if you write workspace config files for hooks)
- [ ] New tool name entries in `src/flightpath/harness/shared/CliEventMapper.ts` (if your CLI uses unmapped tool names)

---

## 9. Troubleshooting

### "Setup Required" / harness not detected

- Verify CLI executable is on PATH: `gemini --version`
- Check `checkAvailability()` in your `CliProvider` returns `true`
- Restart VS Code after PATH changes

### Completion never detected (timeout)

- Confirm hook script is being invoked: check `.flightpath/logs/flightpath-<name>-hook-debug.log`
- Verify notification directory exists and notification file is written
- Verify `getNotificationDirectory()` in your monitor returns the same path as the hook script receives
- If using log-based monitoring: verify `getLogDirectory()` and `getLogFilePattern()` match actual log file locations

### Response text includes CLI chrome / UI decorations

- Capture raw TUI output and identify repeating UI patterns
- Add patterns to `config.chromePatterns` in your `CliProvider`
- Temporarily set `chromePatterns: []` to see the raw output during debugging

### Token counts not showing

- Enable `flightpath.showCliOutput` to see raw stdout/stderr
- Identify the exact token count format your CLI uses
- Update `parseTokenCounts()` regex to match it

### Workspace config file not restored after workflow

- Implement `cleanupWorkspaceArtifacts()` in your `CliProvider`
- Verify backup file is written before modifying the config
- Check the backup path matches what cleanup expects

### Session not continuing between prompts

- Verify `extractSessionId()` captures the session ID from CLI output or log events
- Check that the resume flag (`--resume`, `--continue-session`, etc.) is included in `buildHeadlessArgs()` when a session ID is present
- Enable output logging and trace the session ID through both prompts

---

## Reference Implementation

The Gemini harness is the most complete and recent implementation. Use it as a reference for all patterns described here:

```
src/flightpath/harness/gemini/    — all 6 harness files
src/scripts/flightpath-gemini-hook.js  — hook script
```

For hook-config-via-workspace-file patterns (backup/restore), also see:

```
src/flightpath/harness/qwen/QwenNotificationMonitor.ts
src/flightpath/harness/qwen/QwenCliProvider.ts
```
