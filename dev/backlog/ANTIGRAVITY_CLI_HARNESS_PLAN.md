# Adding Antigravity CLI (`agy`) Harness to FlightPath

**Harness ID**: `antigravity-cli`
**Binary**: `agy`
**Vendor**: Google DeepMind
**Last Updated**: May 2026
**Reference implementation**: Claude CLI harness (`src/flightpath/harness/claude/`) — most structurally similar

---

## Background

Google is deprecating the Gemini CLI and replacing it with Antigravity (`agy`) as their primary AI coding CLI harness. FlightPath already has a `gemini-cli` harness; this plan adds `antigravity-cli` as a **new, separate harness** (Gemini CLI support is kept for existing users, just like Claude CLI and Codex CLI coexist).

### `agy --help` Output Summary

```
--print / -p              Non-interactive, single prompt, print response
--prompt                  Alias for --print
--continue / -c           Continue the most recent conversation
--conversation            Resume a previous conversation by ID
--prompt-interactive / -i Run an initial prompt interactively, then continue
--dangerously-skip-permissions  Auto-approve all tool permission requests
--sandbox                 Run in a sandbox with terminal restrictions
--log-file                Override CLI log file path
--add-dir                 Add a directory to the workspace (repeatable)

Subcommands: changelog, help, install, plugin/plugins, update
```

This is structurally near-identical to Claude CLI:

- `--print` ≈ Claude's `--print`
- `--continue` / `--conversation <id>` ≈ Claude's `-c` / `-r <thread-id>`
- `--dangerously-skip-permissions` ≈ Claude's same flag
- `--add-dir` ≈ Claude's `--add-dir`
- No `--stream-json` flag observed — output format needs investigation (see Open Questions)
- No explicit MCP flag observed — needs investigation

---

## Open Questions

> **IMPORTANT**: These must be answered by running `agy` manually before implementation. They determine which shared infrastructure to use.

1. **Output format**: Does `agy --print "..."` emit plain text, JSON streaming, or JSONL? This determines how `AntigravityResponseParser` is written (clone of Claude's stream-json parser vs plain text vs JSONL).
2. **Session ID**: How does `agy` expose the conversation/session ID? From `--conversation <id>` it is implied it uses an opaque ID — does it print it to stdout, stderr, or a log file?
3. **Hook mechanism**: Does `agy` support hooks (like `--settings` for Claude)? Check `agy help install` or `agy help plugin` for hook/notification support.
4. **MCP support**: Does `agy` support `--mcp-config` or similar? Check `agy plugin` subcommand.
5. **Log files**: Where does `agy` write log files? (e.g., `~/.antigravity/logs/` or `~/.agy/logs/`?) Needed for `AntigravityLogParser`.
6. **`--model` flag**: Does `agy` accept a `--model` flag? What model identifiers does it use?
7. **Tool permissions**: Beyond `--dangerously-skip-permissions`, are there `--allow-tools` / `--deny-tools` flags?
8. **Additional flags**: Run `agy help` and `agy changelog` to discover any undocumented flags.

> **NOTE**: Until questions 3-4 are answered, the completion detection strategy cannot be finalized. The plan below assumes hook-based detection (like Claude/Gemini) but the approach may need to be adjusted to log-based or exit-based if hooks are unavailable.

---

## Proposed Changes

### 1. Harness Directory — 5 Implementation Files

Create `src/flightpath/harness/antigravity/` with these files:

#### [NEW] `AntigravityCliProvider.ts`

Main provider. Model on `ClaudeCliProvider.ts`. Key differences:

- `config.name = "antigravity"`
- `config.harnessId = HARNESS_IDS.ANTIGRAVITY_CLI`
- `config.displayName = "Antigravity CLI"`
- `config.terminalName = "Antigravity"`
- `config.installHint = "Install via: agy install (or via the Antigravity website)"`
- `buildHeadlessArgs()` — use `--print` for non-interactive; `--add-dir` for workspace dirs
- `buildInteractiveTuiCommand()` — use `--prompt-interactive` / `-i` for interactive sessions
- Session resume: `--continue` (continue most recent) or `--conversation <id>` (resume specific)
- Permissions: `--dangerously-skip-permissions` for bypass; investigate allow/deny flags
- `formatFileReference()` — TBD based on how `agy` accepts file refs (likely no prefix, same as Claude)

#### [NEW] `AntigravityResponseParser.ts`

Implements `IResponseParser`. Strategy depends on output format (see Open Questions):

- If JSON streaming → clone `ClaudeResponseParser` and adapt field names
- If plain text → clone `GeminiResponseParser`
- If JSONL → clone `CodexResponseParser`

Must implement:

- `parse(stdout, stderr, exitCode)` → `CopilotCliResult & { sessionId? }`
- `extractSessionId(output)` → extract conversation ID
- `processStreamingChunk(chunk, streamState)` → real-time streaming (if applicable)
- `parseTokenCounts(output)` → extract token usage stats

#### [NEW] `AntigravityNotificationMonitor.ts`

Implements `INotificationMonitor`. Completion detection strategy (TBD — see Open Questions):

- **If hooks supported**: Use hook-based detection writing to `.flightpath/temp/antigravity-notifications/`; hook config passed via `--settings <path>` (like Claude) or written to `.antigravity/settings.json` (like Gemini)
- **If no hooks**: Fall back to log-based or process-exit detection

Hook event mapping (TBD):

| FlightPath logical | Antigravity native |
| ------------------ | ------------------ |
| `stop`             | TBD                |
| `sessionStart`     | TBD                |
| `preToolUse`       | TBD                |
| `postToolUse`      | TBD                |
| `userPromptSubmit` | TBD                |

#### [NEW] `AntigravityToolPermissionMapper.ts`

Implements `IToolPermissionMapper`. Maps FlightPath's three permission modes:

- `dangerouslyAllowAll` → `--dangerously-skip-permissions`
- `allowAll` → TBD (investigate `agy` flags)
- `custom` → TBD allow/deny flags

#### [NEW] `AntigravityLogParser.ts`

Extends `BaseLogParser`. Key config:

- `getLogDirectory()` → path to `agy` log files (TBD — likely `~/.agy/logs/` or `~/.antigravity/tmp/`)
- `getLogFilePattern()` → regex matching log file names
- `parseLogLine(line)` → parse JSON or text log lines
- `isCompletionEvent(event)` → detect session-ended events
- `extractSessionId(event)` → extract conversation ID

---

### 2. Hook Script (if hook-based)

#### [NEW] `src/scripts/flightpath-antigravity-hook.js`

Plain CJS Node.js script using `flightpath-hook-utils`. Receives hook data via stdin (JSON), writes notification file to `argv[2]` directory. Pattern identical to `flightpath-gemini-hook.js` or `flightpath-claude-hook.js`.

Only needed if Antigravity supports hooks. Skip if using log-based or exit-based detection.

---

### 3. Type Layer

#### [MODIFY] `src/types/DashboardConstants.ts`

Four additions following the exact pattern of `GEMINI_CLI`:

```typescript
// 1. HARNESS_IDS
ANTIGRAVITY_CLI: "antigravity-cli",

// 2. HARNESS_INFO
[HARNESS_IDS.ANTIGRAVITY_CLI]: { name: "Antigravity", shortName: "Antigravity" },

// 3. Hook event table comment — add antigravity column once native event names are known

// 4. Model list constant
export const ANTIGRAVITY_CLI_MODELS = [
  { value: "none", label: "None (skip --model flag)" },
  // populated after investigating agy model options
] as const;
```

#### [MODIFY] `src/types/FlightPathTypes.ts`

Add to the `Harness` enum (verify it exists as an enum, or follow DashboardConstants pattern):

```typescript
AntigravityCli = "antigravity-cli",
```

---

### 4. Wiring Layer

#### [MODIFY] `src/flightpath/IntegrationFactory.ts`

```typescript
import { AntigravityCliProvider } from "./harness/antigravity/AntigravityCliProvider";

createAntigravityCli(registerWithContext = true): CliIntegration {
  const provider = new AntigravityCliProvider();
  return new CliIntegration(provider, this.platform, registerWithContext);
}

// Add case in createForHarness():
case Harness.AntigravityCli:
  return this.createAntigravityCli(registerWithContext);
```

#### [MODIFY] `src/flightpath/WorkflowOrchestrator.ts`

Six additions (search for `geminiCli` pattern and mirror for `antigravityCli`):

1. `private readonly antigravityCliIntegration: CliIntegration;`
2. `this.antigravityCliIntegration = this.integrationFactory.createAntigravityCli();`
3. `[HARNESS_IDS.ANTIGRAVITY_CLI, this.antigravityCliIntegration],` in the allIntegrations array
4. `this.antigravityCliIntegration.initialize(),` in the Promise.all block
5. `case Harness.AntigravityCli: return this.antigravityCliIntegration;` in `getIntegrationForHarness()`
6. `this.antigravityCliIntegration.setWorkflowName(name);` in `setWorkflowName()`

Also add display label:

```typescript
[Harness.AntigravityCli]: "Antigravity CLI",
```

---

### 5. Settings Layer

#### [MODIFY] `src/utils/ConfigurationUtils.ts`

Four additions following the `getGeminiCliModel` pattern:

```typescript
// getCliModelSettingKey():
case Harness.AntigravityCli: return "antigravityCliModel";

// getAdditionalArgsSettingKey():
case Harness.AntigravityCli: return "antigravityCliAdditionalArgs";

// normalizeHarness():
case HARNESS_IDS.ANTIGRAVITY_CLI:
case Harness.AntigravityCli:
  return Harness.AntigravityCli;

// New getter:
getAntigravityCliModel(): string {
  return getConfig().get<string>("antigravityCliModel", "");
}

// getModelForHarness():
case Harness.AntigravityCli:
  return ConfigurationUtils.getAntigravityCliModel();
```

#### [MODIFY] `src/utils/ModelConstants.ts`

```typescript
export const ANTIGRAVITY_CLI_MODELS = [
  // TBD — populate after investigating `agy` model flags
] as const;

export const ANTIGRAVITY_CLI_MODEL_LABELS: Record<string, string> = {
  // TBD
};

export type AntigravityCliModel = (typeof ANTIGRAVITY_CLI_MODELS)[number];

export function isAntigravityCliModel(
  model: string
): model is AntigravityCliModel {
  return ANTIGRAVITY_CLI_MODELS.includes(model as AntigravityCliModel);
}
```

#### [MODIFY] `package.json`

Three additions under `contributes.configuration.properties`:

```jsonc
// 1. Add "antigravity-cli" to flightpath.harness enum + enumDescriptions
// 2. Model setting:
"flightpath.antigravityCliModel": {
  "order": 450,
  "type": "string",
  "default": "",
  "description": "[Antigravity CLI] Model for Antigravity CLI (agy) execution.",
  "enum": [ /* TBD */ ],
  "enumDescriptions": [ /* TBD */ ]
},
// 3. Additional args setting:
"flightpath.antigravityCliAdditionalArgs": {
  "order": 451,
  "type": "string",
  "default": "",
  "description": "[Antigravity CLI] Additional arguments to pass to agy."
}
```

---

### 6. UI Layer

#### [MODIFY] `src/ui/WebviewSettingsSync.ts`

Following the `GEMINI_CLI` pattern:

1. Import `ANTIGRAVITY_CLI_MODEL_LABELS` from `ModelConstants`
2. Add `[HARNESS_IDS.ANTIGRAVITY_CLI]: { available: false, status: HARNESS_STATUS_STRINGS.CHECKING }` to initial availability
3. Add `HARNESS_IDS.ANTIGRAVITY_CLI` to `VALID_CLI_HARNESSES`
4. Add to `buildCurrentSettings()` — `harnessDefaultModels` and `harnessDefaultAdditionalArgs` maps
5. Add model options in `buildModelOptions()`

#### [MODIFY] `src/ui/webview-react/components/shared/HarnessDropdown.tsx`

```typescript
// Display name:
[HARNESS_IDS.ANTIGRAVITY_CLI]: "Antigravity",

// Add to CLI_HARNESSES array:
HARNESS_IDS.ANTIGRAVITY_CLI,
```

#### [MODIFY] `src/ui/webview-react/store/settingsStore.ts`

```typescript
// Import and build model list:
const ANTIGRAVITY_CLI_MODELS: ModelOption[] = [...ANTIGRAVITY_CLI_MODEL_LIST];

// initialHarnessAvailability:
[HARNESS_IDS.ANTIGRAVITY_CLI]: { available: false, status: HARNESS_STATUS_STRINGS.CHECKING },

// initialState.modelsByHarness:
[HARNESS_IDS.ANTIGRAVITY_CLI]: ANTIGRAVITY_CLI_MODELS,
```

---

### 7. Schema Updates

#### [MODIFY] `schemas/prompt-schema.json`

Add `"antigravity-cli"` to the `harness` enum array.

#### [MODIFY] `schemas/settings-schema.json`

Four additions mirroring `gemini-cli`:

1. Add `"antigravity-cli"` to the `defaults.harness` enum
2. Add `"antigravity-cli": { "type": "string" }` to `models` object properties
3. Add `"antigravity-cli": { "type": "string" }` to `additionalArgs` object properties
4. Add `"antigravity-cli"` to any other harness enum arrays

After editing JSON schema, run:

```
npm run generate-schema
```

to regenerate `schemas/prompt-schema.yaml`.

---

### 8. Additional Settings-Layer Touchpoints

These files were confirmed via codebase grep and are NOT covered by the ADDING_NEW_CLI_HARNESS.md guide — they are extra spots that must also be updated.

#### [MODIFY] `src/types/FlightPathSettings.ts`

Add default model to `FLIGHTPATH_SETTINGS_DEFAULTS.defaults.models`:

```typescript
"antigravity-cli": "<default-model>", // TBD — set after investigating agy --model options
```

This is the fallback default used by the CLI binary and settings service when no model is explicitly configured.

#### [MODIFY] `src/utils/ModelConstants.ts`

Add a `case` in `getModelDisplayName()` (the function that maps harness + modelId → human-readable label):

```typescript
case "antigravity-cli":
  return ANTIGRAVITY_CLI_MODEL_LABELS[modelId] ?? modelId;
```

#### [MODIFY] `src/cli.ts`

Update the `--harness` option description string (line ~58) to include `antigravity-cli`:

```typescript
"-H, --harness <harness>",
"AI harness: copilot-cli, claude-cli, codex-cli, antigravity-cli",  // add antigravity-cli
```

---

### 9. Debug Log Table (docs)

#### [MODIFY] `.github/copilot-instructions.md`

Add entry to the hook/notify debug logs table:

```
| flightpath-antigravity-hook-debug.log | antigravity-cli |
```

---

### 9. Test Updates

#### [MODIFY] `src/test/harness/helpers/harnessRunner.ts`

```typescript
// Add to union type:
| "antigravity-cli"

// Add to default model map:
"antigravity-cli": "<cheapest-available-model>", // TBD
```

#### [MODIFY] `src/test/harness/hooks.harness.test.ts`

Add `"antigravity-cli"` to:

- Harness union type
- Active harnesses array
- Default model map
- Supported hook events maps (`stop`, `preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`)

#### [NEW] `src/test/unit/AntigravityResponseParser.test.ts` (recommended)

Unit tests for `AntigravityResponseParser` covering response text extraction, session ID extraction, token count parsing, and edge cases.

---

### 10. Optional: Shared Infrastructure

#### `src/flightpath/harness/shared/CliEventMapper.ts`

If `agy` uses tool names not already in the map, add them. Check after running `agy` and observing tool call output.

#### `cleanupWorkspaceArtifacts` in `AntigravityCliProvider`

Only needed if Antigravity hooks write a settings file to the workspace (like `.antigravity/settings.json`). Not needed if hook config is passed via CLI flag like Claude's `--settings`.

---

## Complete Checklist

### Pre-implementation research

- [ ] Run `agy --print "hello"` and capture full stdout/stderr — confirm output format
- [ ] Confirm session/conversation ID location in output
- [ ] Run `agy help`, `agy changelog`, `agy plugin list` for all flags and hook support
- [ ] Locate `agy` log files and confirm path/format
- [ ] Identify `--model` flag and available model names

### Harness directory (`src/flightpath/harness/antigravity/`)

- [ ] `AntigravityCliProvider.ts` implementing `ICliProvider`
- [ ] `AntigravityResponseParser.ts` implementing `IResponseParser`
- [ ] `AntigravityNotificationMonitor.ts` implementing `INotificationMonitor`
- [ ] `AntigravityToolPermissionMapper.ts` implementing `IToolPermissionMapper`
- [ ] `AntigravityLogParser.ts` extending `BaseLogParser`

### Hook script (if hook-based)

- [ ] `src/scripts/flightpath-antigravity-hook.js`

### Type layer

- [ ] `src/types/DashboardConstants.ts` — `HARNESS_IDS`, `HARNESS_INFO`, model list constant, hook event table comment
- [ ] `src/types/FlightPathTypes.ts` — `Harness` enum value (if applicable)

### Wiring layer

- [ ] `src/flightpath/IntegrationFactory.ts` — import, factory method, switch case
- [ ] `src/flightpath/WorkflowOrchestrator.ts` — field, construction, registration, initialization, harness resolution, workflow name propagation, display label

### Settings layer

- [ ] `src/utils/ConfigurationUtils.ts` — model key, additional args key, harness normalizer, model getter, `getModelForHarness` case
- [ ] `src/utils/ModelConstants.ts` — model array, label map, type, guard function, `getModelDisplayName` case
- [ ] `src/types/FlightPathSettings.ts` — add `"antigravity-cli"` to `FLIGHTPATH_SETTINGS_DEFAULTS.defaults.models`
- [ ] `src/cli.ts` — add `antigravity-cli` to `--harness` option description string
- [ ] `package.json` — harness enum value + description, model setting, additional args setting

### UI layer

- [ ] `src/ui/WebviewSettingsSync.ts` — import, initial status, valid harnesses, model/args mappings, model options
- [ ] `src/ui/webview-react/components/shared/HarnessDropdown.tsx` — display name, `CLI_HARNESSES` group
- [ ] `src/ui/webview-react/store/settingsStore.ts` — import, model array, initial availability, `modelsByHarness`

### Schemas

- [ ] `schemas/prompt-schema.json` — harness enum
- [ ] `schemas/settings-schema.json` — harness enum, models, additionalArgs
- [ ] Run `npm run generate-schema` to regenerate `schemas/prompt-schema.yaml`

### Docs / debug

- [ ] `.github/copilot-instructions.md` — add to harness table and debug log table

### Tests

- [ ] `src/test/harness/helpers/harnessRunner.ts` — union type + default model
- [ ] `src/test/harness/hooks.harness.test.ts` — union type, active harnesses, models, hook events
- [ ] `src/test/unit/AntigravityResponseParser.test.ts` — unit tests (recommended)

### Optional (if applicable)

- [ ] `cleanupWorkspaceArtifacts` in `AntigravityCliProvider` (if workspace config files are written for hooks)
- [ ] New tool name entries in `src/flightpath/harness/shared/CliEventMapper.ts`

---

## Verification Plan

### Automated

- `npm run compile` — zero TypeScript errors
- `npm test` — all existing tests pass; new parser unit tests pass
- `npm run generate-schema` — schema regeneration succeeds

### Manual (requires `agy` installed)

1. Set `flightpath.harness` to `antigravity-cli` in VS Code settings
2. Verify harness shows "Available" in the FlightPath dashboard
3. Run a single-step workflow in interactive mode — confirm terminal opens, prompt sent, completion detected
4. Run same workflow in headless mode — confirm background execution and response capture
5. Run a two-step workflow with `resumeSession: true` — confirm session continues between prompts
6. Verify token counts appear in the dashboard
7. Verify `--dangerously-skip-permissions` mode works (no tool approval prompts)
8. Verify hook debug log is written to `.flightpath/logs/flightpath-antigravity-hook-debug.log`

---

## Estimated Effort

**4–8 hours** for a complete, tested integration (per `ADDING_NEW_CLI_HARNESS.md` estimate).

Most time will be spent on:

1. Pre-implementation research (output format, session ID, hooks) — **do this first**
2. `AntigravityResponseParser.ts` — depends heavily on output format
3. `AntigravityNotificationMonitor.ts` — depends on hook availability

The wiring, type, settings, and UI layers are all mechanical and follow the established gemini-cli pattern exactly.
