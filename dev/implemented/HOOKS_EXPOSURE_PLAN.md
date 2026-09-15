# `hooks` Property — User Hook Exposure Plan

**Date:** 2026-03-27
**Inspired by:** `MCP_SERVERS_PROPERTY_PLAN.md`
**Problem:** FlightPath silently clobbers user-defined hooks in `.qwen/settings.json` and `.gemini/settings.json` during interactive runs, and offers no way for users to add their own scripts alongside FlightPath's completion detection hooks.

> **Note on the deep-merge fix (Section 3):** This is a permanent, necessary part of the implementation — not an interim workaround. Even after the full `hooks` property ships, three independent layers of hooks must coexist: (1) FlightPath's completion-detection handlers, (2) commands declared in the workflow `hooks` YAML property, and (3) commands already present in the user's settings file before FlightPath runs. The full feature implementation handles layer 2; the deep-merge fix handles layer 3. Both are required.
>
> **Status: Section 3 is already implemented.** The deep-merge fix has been applied to both `QwenCliProvider.buildInteractiveHookSettings()` and `GeminiCliProvider` as of the current codebase. The code comments in both providers even note "future workflow hooks" as a placeholder for layer 2. The problem statement table below reflects what was true before the fix; the fix itself is complete.

---

## 1. Problem Statement

### Current Behavior by Harness

FlightPath injects its own completion-detection hooks into each CLI's hook system when running in interactive mode. The current behavior varies by harness:

| Harness          | Hook Method                                                       | Conflict Risk                 | User Hooks Preserved?                                     | Parallel Safe?                                                                       |
| ---------------- | ----------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Copilot CLI**  | Creates `.github/hooks/flightpath-<stem>-p<n>.json` per prompt    | None                          | YES — Copilot loads all JSON files in `.github/hooks/`    | **YES** — unique filename per prompt (fixed in `ce423b7`)                            |
| **Claude CLI**   | Fixed temp file `claude-hook-settings.json` via `--settings` flag | None                          | YES — `--settings` is additive in Claude's settings chain | **NO** — shared temp file clobbered by concurrent prompts (see Section 11)           |
| **Codex CLI**    | Inline `--config notify=[...]` argument                           | Partial                       | NO — only one `notify` command can be passed inline       | N/A — stateless flag, no shared file                                                 |
| **OpenCode CLI** | Plugin file deployment (not hook-based)                           | None                          | YES — plugin is separate; no hooks key used               | N/A — plugin re-deployed each run                                                    |
| **Qwen CLI**     | Reads `.qwen/settings.json`, deep-merges `hooks` key              | None (deep-merge implemented) | **YES** — deep-merge preserves pre-existing hooks (fixed) | **NO** — shared backup file and no ref-counting causes restore race (see Section 11) |
| **Gemini CLI**   | Reads `.gemini/settings.json`, deep-merges `hooks` key            | None (deep-merge implemented) | **YES** — deep-merge preserves pre-existing hooks (fixed) | **NO** — shared backup file and no ref-counting causes restore race (see Section 11) |

### The Core Bug (Qwen & Gemini)

```typescript
// Current code in QwenCliProvider and GeminiCliProvider:
const mergedSettings = {
  ...existingSettings, // Non-hooks keys preserved ✅
  hooks: hooksSection, // Entire hooks key REPLACED ❌
};
```

If a user has, for example, a custom Stop hook that runs their test suite or sends a notification, it **silently stops firing** during any FlightPath session. The backup/restore mechanism restores the file after the run completes, but the user's hook doesn't fire _during_ the run.

### Feature Gap

There is currently no way for users to:

1. Add their own hook scripts to any FlightPath-managed hook event
2. Know which hook events each CLI supports
3. Specify hooks per-workflow or per-prompt (like `mcpServers`)

---

## 2. Hook System Architecture by CLI

Understanding each CLI's hook format informs the merge strategy.

### Claude Code / Qwen Code (identical format, Claude fork)

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/script" }] }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/flightpath-hook.js /notifyDir"
          }
        ]
      },
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/user-script.js" }
        ]
      }
    ]
  }
}
```

**Key:** Each event is an **array** of hook groups. FlightPath already uses this format — multiple entries are supported at the data model level, but FlightPath only ever writes one.

**Available events (Claude Code):** `SessionStart`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`
**Available events (Qwen Code):** `SessionStart`, `UserPromptSubmit`, `Stop` (Claude fork; `PreToolUse`/`PostToolUse` may also work)

### Copilot CLI

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "node ...",
        "powershell": "node ...",
        "timeoutSec": 10
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "node ...",
        "powershell": "node ...",
        "timeoutSec": 10
      }
    ]
  }
}
```

**Key:** Each event is an array of objects. Copilot loads **all** JSON files under `.github/hooks/` — FlightPath's file (`flightpath.json`) coexists with any user-created files. User hooks should NOT go in `flightpath.json`; users can create their own `my-hooks.json` in `.github/hooks/`.

**Available events:** `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `userPromptSubmitted`, `errorOccurred`

### Gemini CLI

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/script" }] }
    ],
    "AfterAgent": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/flightpath-hook.js /notifyDir"
          }
        ]
      }
    ]
  }
}
```

**Key:** Same array-of-groups format as Claude. `AfterAgent` is the completion event (not `Stop`).

**Available events:** `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`

### Codex CLI

```
notify=['node','/path/to/hook']
```

**Key:** TOML inline format. Only one `notify` command can be set. FlightPath currently uses this as the sole completion signal. Adding user hooks here requires chaining scripts.

**Available events:** `notify` only (no named event system)

### OpenCode CLI

Uses a plugin system (not hooks). Separate plugin file deployed to `.opencode/plugin/`. No hook conflict exists — the plugin is fully controlled by FlightPath.

**Available events:** `session.created`, `session.status`, `session.deleted`, `tool.execute.before`, `tool.execute.after`, `message.updated`, `permission.asked`, and others — see https://opencode.ai/docs/plugins/#events

---

## 3. Deep-Merge Fix (Qwen & Gemini) — Already Implemented

> **This section is complete.** The fix described here has already been applied to both `QwenCliProvider.buildInteractiveHookSettings()` and `GeminiCliProvider`. Preserved for architectural context — understanding the three-layer merge is required before working on Section 5.

The merge strategy for Qwen and Gemini preserves all three layers of hooks during FlightPath runs. This was a prerequisite for the full `hooks` property: workflow user hooks (layer 2) are inserted between FlightPath's completion-detection handlers (layer 1) and the pre-existing settings file hooks (layer 3).

### Implemented Fix: Deep-merge hook event arrays instead of replacing the hooks key

```typescript
// In QwenCliProvider.buildInteractiveHookSettings() and GeminiCliProvider equivalent:

// Old (broken) approach — no longer in codebase:
const mergedSettings = { ...existingSettings, hooks: hooksSection }; // ❌ Replaced all user hooks

// Current implementation:
const existingHooks =
  (existingSettings.hooks as Record<string, unknown[]> | undefined) ?? {};
const flightpathHooks = hooksSection as Record<string, unknown[]>;
const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
for (const [event, handlers] of Object.entries(flightpathHooks)) {
  const userHandlers = (existingHooks[event] as unknown[] | undefined) ?? [];
  // FlightPath handlers first, then existing settings-file handlers
  // TODO (Section 5): workflow user handlers will be inserted between these two layers
  mergedHooks[event] = [...handlers, ...userHandlers];
}
const mergedSettings = { ...existingSettings, hooks: mergedHooks };
```

The TODO comment in the code marks where Section 5's `workflowUserHandlers` layer will be added.

---

## 4. Schema Design — `hooks` Workflow Property

Analogous to `mcpServers`, expose a `hooks` property that lets users add their own scripts to hook events in the workflow YAML.

### Use Cases

```yaml
# Run a test suite after every prompt completes (Stop event)
hooks:
  - event: stop
    command: npm test

# Notify a webhook on session start
hooks:
  - event: sessionStart
    command: node ./scripts/notify-start.js

# Run a custom linter on every tool use (Claude/Qwen only)
hooks:
  - event: preToolUse
    command: node ./scripts/lint-tool-call.js

# Multiple hooks on the same event
hooks:
  - event: stop
    command: node ./scripts/run-tests.js
  - event: stop
    command: node ./scripts/send-notification.js

# Workflow-level default, per-event override at prompt level
# The prompt's stop hook replaces the workflow's stop hook.
# Events NOT listed in the prompt's hooks array still inherit from the workflow.
hooks:
  - event: stop
    command: node ./scripts/default-check.js
  - event: sessionStart
    command: node ./scripts/notify-start.js
prompts:
  - name: risky-step
    hooks:
      - event: stop
        command: node ./scripts/extra-validation.js # Replaces workflow's stop hook
    # sessionStart not listed → still inherits notify-start.js from workflow level

  - name: silent-step
    hooks: null # No hooks at all — suppresses even the workflow's sessionStart hook
```

### TypeScript Types

**`src/types/FlightPathTypes.ts`:**

```typescript
/**
 * Logical hook event names — mapped to CLI-specific event names at inject time.
 *
 * | Logical name      | Claude/Qwen      | Copilot CLI         | Gemini CLI   | Codex            | OpenCode                |
 * |-------------------|------------------|---------------------|--------------|------------------|-------------------------|
 * | "stop"            | Stop             | agentStop           | AfterAgent   | Stop             | session.status { idle } |
 * | "sessionStart"    | SessionStart     | sessionStart        | SessionStart | SessionStart     | session.created         |
 * | "preToolUse"      | PreToolUse       | preToolUse          | BeforeTool   | PreToolUse       | tool.execute.before     |
 * | "postToolUse"     | PostToolUse      | postToolUse         | AfterTool    | PostToolUse      | tool.execute.after      |
 * | "userPromptSubmit"| UserPromptSubmit | userPromptSubmitted | BeforeAgent  | UserPromptSubmit | session.status { busy } |
 */
export type HookEvent =
  | "stop"
  | "sessionStart"
  | "preToolUse"
  | "postToolUse"
  | "userPromptSubmit";

/**
 * A user-defined hook to run alongside FlightPath's built-in hooks.
 */
export interface UserHookConfig {
  /**
   * Logical hook event name.
   * Events not supported by the active harness are silently skipped.
   */
  event: HookEvent;

  /**
   * Command to run. Resolved relative to workspace root if not absolute.
   * Passed to the CLI's hook runner as-is (platform-appropriate quoting applied by FlightPath).
   */
  command: string;

  /**
   * Optional timeout in seconds for this hook (default: CLI's default timeout).
   * Only respected by CLIs that support per-hook timeouts (Copilot CLI).
   */
  timeoutSec?: number;
}

// In ExecutionProperties, add:
/**
 * User-defined hooks to run alongside FlightPath's completion-detection hooks.
 * Supported events vary by harness; unsupported events are silently ignored.
 *
 * Precedence semantics (per event type):
 * - Omitted → inherit all events from the tier below (workflow → global setting)
 * - null or [] → explicitly no hooks for this prompt (override every event to empty)
 * - [...] → per-event override: events present in the array replace the tier below
 *            for that event only; events not mentioned inherit from the tier below
 */
hooks?: UserHookConfig[] | null;
```

### JSON Schema Addition

**`schemas/prompt-schema.json`:**

Add to `definitions` (the schema uses JSON Schema draft-07 with `"definitions"`, not `"$defs"`):

```json
"userHookConfig": {
  "type": "object",
  "required": ["event", "command"],
  "additionalProperties": false,
  "properties": {
    "event": {
      "type": "string",
      "enum": ["stop", "sessionStart", "preToolUse", "postToolUse", "userPromptSubmit"],
      "description": "Logical hook event. Unsupported events for the active harness are silently skipped. 'stop' maps to Stop (Claude/Qwen), sessionEnd (Copilot), AfterAgent (Gemini), notify (Codex)."
    },
    "command": {
      "type": "string",
      "description": "Command to execute. Resolved relative to workspace root if not absolute."
    },
    "timeoutSec": {
      "type": "number",
      "description": "Timeout in seconds. Only respected by CLIs that support per-hook timeouts."
    }
  }
}
```

Add `hooks` inside `executionProperties` (alongside `mcpServers` — both workflow-level and prompt-level share the same `executionProperties` definition):

```json
"hooks": {
  "oneOf": [
    {
      "type": "array",
      "items": { "$ref": "#/definitions/userHookConfig" },
      "description": "User-defined hooks. Per-event override: events present in this array replace the tier below for that event; events absent inherit from the tier below. An empty array explicitly disables all hooks."
    },
    {
      "type": "null",
      "description": "Explicitly disables all hooks for this prompt/workflow."
    }
  ],
  "description": "User-defined hooks run alongside FlightPath's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped. null or [] disables all hooks. Omit to inherit from the tier below (workflow → global setting)."
}
```

---

## 5. Harness-Specific Implementation

### Event Name Mapping

Each harness implements a mapping from `HookEvent` to its native event name(s):

```typescript
// In each NotificationMonitor or CliProvider:
getUserHookEventName(event: HookEvent): string | null {
  // Returns the CLI-native event name, or null if unsupported
}
```

| Logical Event      | Claude CLI         | Qwen CLI           | Copilot CLI           | Gemini CLI     | Codex CLI          | OpenCode CLI                      |
| ------------------ | ------------------ | ------------------ | --------------------- | -------------- | ------------------ | --------------------------------- |
| `stop`             | `Stop`             | `Stop`             | `agentStop`           | `AfterAgent`   | `Stop`             | `session.status { type: "idle" }` |
| `sessionStart`     | `SessionStart`     | `SessionStart`     | `sessionStart`        | `SessionStart` | `SessionStart`     | `session.created`                 |
| `preToolUse`       | `PreToolUse`       | `PreToolUse`       | `preToolUse`          | `BeforeTool`   | `PreToolUse`       | `tool.execute.before`             |
| `postToolUse`      | `PostToolUse`      | `PostToolUse`      | `postToolUse`         | `AfterTool`    | `PostToolUse`      | `tool.execute.after`              |
| `userPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `userPromptSubmitted` | `BeforeAgent`  | `UserPromptSubmit` | `session.status { type: "busy" }` |

### Claude CLI

Claude's `--settings` file is already an overlay on top of the user's global `~/.claude/settings.json`. User's global hooks fire independently — no conflict exists today.

With `hooks` property support: append user hook entries to the relevant event arrays in the temp settings file written to `.flightpath/temp/claude-hook-settings.json`. No change needed for global hook preservation (already works).

```typescript
// In ClaudeNotificationMonitor.buildHookConfig(), generalize to accept userHooks:
buildHookConfig(scriptPath, notifyDir, workspaceRoot, userHooks?: UserHookConfig[]): HookConfig {
  const flightpathEntry = { hooks: [{ type: "command", command: `node "${scriptPath}" "${notifyDir}"` }] };
  const userStopEntries = (userHooks ?? [])
    .filter(h => h.event === "stop")
    .map(h => ({ hooks: [{ type: "command", command: h.command }] }));

  return {
    type: "json-string",
    config: JSON.stringify({
      hooks: {
        SessionStart: [flightpathEntry],
        Stop: [flightpathEntry, ...userStopEntries],
        // Other events from userHooks...
      }
    })
  };
}
```

### Qwen CLI & Gemini CLI

**Injection point: `buildInteractiveHookSettings()`, not `buildHookConfig()`.**

For Claude and Copilot, `buildHookConfig()` produces the complete hook configuration that is passed as a CLI flag — so `userHooks` belongs there. For Qwen and Gemini, `buildHookConfig()` only produces FlightPath's completion-detection hooks (the `hooksSection`). The actual merge happens in `buildInteractiveHookSettings()`, which reads and writes the settings file. `userHooks` must reach `buildInteractiveHookSettings()` directly (via `workflowContext.resolvedProperties.hooks`), not through `buildHookConfig()`.

Extend the existing merge loop to insert workflow user handlers as the middle layer:

```typescript
// In QwenCliProvider.buildInteractiveHookSettings() and GeminiCliProvider equivalent:
// workflowUserHooks = resolvedProperties.hooks filtered to CLI-supported events + converted to native format

for (const [event, flightpathHandlers] of Object.entries(flightpathHooks)) {
  const workflowUserHandlers =
    (workflowUserHooks[event] as unknown[] | undefined) ?? [];
  const existingUserHandlers =
    (existingHooks[event] as unknown[] | undefined) ?? [];
  mergedHooks[event] = [
    ...flightpathHandlers, // FlightPath's completion detection (highest priority)
    ...workflowUserHandlers, // From UserHookConfig in workflow YAML
    ...existingUserHandlers, // From pre-existing settings file
  ];
}
```

**Qwen trusted hooks for user-defined commands.** `buildInteractiveHookSettings()` currently pre-trusts FlightPath's specific hook commands in `~/.qwen/trusted_hooks.json`. User-defined commands must also be written there — Qwen will show a trust dialog on the first run for any command not already trusted. For each `UserHookConfig` being injected, write `"": ["<command>"]` into `trusted_hooks.json` using the same format as the existing FlightPath trust entries. Without this, the feature appears broken: the user sees an interactive trust prompt mid-workflow.

### Copilot CLI

Copilot reads all files in `.github/hooks/`. FlightPath writes to `flightpath.json`. User hooks from the `hooks` property should be injected into `flightpath.json` alongside FlightPath's own entries:

```typescript
// Append user hook entries to the hook array in flightpath.json
const config = {
  version: 1,
  hooks: {
    sessionStart: [flightpathStartEntry, ...userStartEntries],
    sessionEnd: [flightpathEndEntry, ...userStopEntries],
  },
};
```

Users who already have their own `.github/hooks/` files are completely unaffected — their files coexist and Copilot runs all of them.

### OpenCode CLI

OpenCode's plugin system is the **most capable** approach for user hooks — and also the easiest to implement. Because FlightPath already generates and deploys `flightpath-completion-hook.js` fresh each run (copied from `src/scripts/flightpath-opencode-plugin.js`), it can instead **generate the plugin dynamically** with user hook commands embedded directly.

**Why this is simpler than all other harnesses:** There is no settings file to merge, no existing hooks to preserve, and no CLI-specific hook configuration format to serialize. The plugin is JavaScript that FlightPath fully controls. User commands are just additional `execSync` calls within the relevant event handlers.

**Approach: generate the plugin dynamically when `userHooks` is non-empty**

`OpenCodeCliProvider.deployCompletionPlugin()` currently copies the static source file. With user hooks, it instead calls a `generatePlugin(userHooks)` helper that produces a JavaScript string and writes it directly.

The generated plugin embeds user commands as a static array (no env-var roundtrip needed):

```javascript
// Generated section injected into the plugin at session.status idle handler:
const USER_STOP_HOOKS = [
  "node /path/to/user-script.js",
  "node /path/to/another-script.js",
];

// And at session.created handler:
const USER_SESSION_START_HOOKS = ["node /path/to/on-start.js"];
```

The generated plugin executes each user command via `child_process.execSync` after the FlightPath notification file is written:

```javascript
// Generated inside the session.status idle block (after writing stop file):
const { execSync } = require("child_process");
for (const cmd of USER_STOP_HOOKS) {
  try {
    execSync(cmd, { stdio: "inherit", cwd: workspaceRoot });
  } catch (e) {
    // Silently swallow — user hook failure must not break completion detection
  }
}
```

**Event coverage:** OpenCode's plugin system receives all events from the OpenCode process. The plugin handles `session.created`, `session.status` (checking `status.type` for `"idle"` and `"busy"`), `tool.execute.before`, and `tool.execute.after`. All five logical events (`stop`, `sessionStart`, `preToolUse`, `postToolUse`, `userPromptSubmit`) are fully supported. Note: `sessionStart` has a known OpenCode bug (#14808) and may not fire in all cases.

**No conflict with existing OpenCode configuration:** OpenCode's MCP config (`.opencode/opencode.json`) is unaffected — it's a separate concern from the plugin. The plugin file at `.opencode/plugin/flightpath-completion-hook.ts` is written and cleaned up entirely by FlightPath. No merge needed.

**Implementation changes:**

- `OpenCodeCliProvider.deployCompletionPlugin()` → call `OpenCodePluginGenerator.generate(scriptPath, notifyDir, userHooks)` and write the result, instead of copying the static source file
- `src/scripts/flightpath-opencode-plugin.js` remains the **template/reference** (not deleted) — the generator uses it as the basis and appends the user hook execution sections
- `OpenCodeNotificationMonitor` does not need to change (it returns `type: "none"` for `buildHookConfig`, which is still correct — the plugin approach is handled entirely in the provider)

### Codex CLI

Codex's `notify` is a single command. To support user hooks, use a **chaining script** approach:

1. FlightPath writes a `flightpath-notify-chain.js` script to `.flightpath/temp/`
2. The chain script runs the FlightPath notification hook, then executes user hook commands in sequence
3. `--config notify=['node','/path/to/flightpath-notify-chain.js',...]` passes the chain script

This is the only way to support user hooks for Codex without CLI changes.

```javascript
// flightpath-notify-chain.js (generated per run)
const { execSync } = require("child_process");
require("./flightpath-codex-hook.js"); // Original FlightPath notify hook
// User hooks from workflow:
execSync("node /path/to/user-script.js", { stdio: "inherit" });
```

---

## 6. `INotificationMonitor` Interface Changes

Add optional method to expose supported events and accept user hooks:

```typescript
/**
 * Returns the CLI-native event name for a logical hook event,
 * or null if this event is unsupported by this harness.
 */
getHookEventName?(event: HookEvent): string | null;
```

Alternatively, add `userHooks?: UserHookConfig[]` as an optional parameter to `buildHookConfig()` to keep injection centralized. The `buildHookConfig` signature already captures all the information needed to produce the hook configuration — adding user hooks here is the minimal-change approach.

**Preferred approach:** Pass `userHooks` to `buildHookConfig()`:

```typescript
buildHookConfig(
  scriptPath: string,
  notifyDir: string,
  workspaceRoot: string,
  userHooks?: UserHookConfig[]  // New optional parameter
): HookConfig;
```

Default implementation in `NotificationMonitorBase.buildHookConfig()` ignores `userHooks` (backward compatible). Each harness that supports user hooks overrides to include them.

---

## 7. `PropertyResolver` Changes

Add `resolveHooks()` with **per-event override semantics**:

```typescript
// Three-tier: prompt-level → workflow-level → VS Code setting (flightpath.defaultHooks)
resolveHooks(
  promptItem: PromptItem,
  workflowFile: PromptFile
): UserHookConfig[]
```

### Precedence Semantics — Per Event Type

This is the key behavioral difference from `mcpServers` and most other properties. Rather than one tier wholesale replacing another, resolution happens **independently per logical event name**:

| `hooks` value at a tier    | Effect on that event at that tier                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omitted (`undefined`)      | No override — events inherit from the tier below (global default is pre-seeded into workflow tier by `populateSettingsDefaults()`)                            |
| `null`                     | All events explicitly suppressed — return `[]` immediately, no inheritance                                                                                    |
| `[]`                       | Empty list — effectively no hooks, but semantically "use this empty list" rather than "suppress". Behaviorally identical to null since both produce no hooks. |
| `[{ event: "stop", ... }]` | `stop` is overridden for this tier; all other events not mentioned inherit from the tier below                                                                |

**Example — most common case:**

```yaml
# Workflow level
hooks:
  - event: stop
    command: npm test
  - event: sessionStart
    command: node ./scripts/notify-start.js

prompts:
  - name: risky-step
    hooks:
      - event: stop
        command: node ./scripts/extra-validation.js # Replaces workflow's stop hook
    # sessionStart not mentioned → still inherits from workflow level
```

Result for `risky-step`: `stop` runs `extra-validation.js` only; `sessionStart` still runs `notify-start.js`.

**Example — explicit clear:**

```yaml
- name: cleanup-step
  hooks: null # (or hooks: []) — no hooks at all for this prompt
```

Result: no user hooks fire for `cleanup-step` regardless of workflow or global defaults.

**Algorithm in `resolveHooks()`:**

> **Two-tier only, not three.** Because `populateSettingsDefaults()` bakes the global `flightpath.hooks` setting into `workflowFile.hooks` (the same pattern `mcpServers` uses), `resolveHooks()` does NOT need to call `ConfigurationUtils.getDefaultHooks()` at runtime. The global default is already embedded in the working file by the time resolution runs. `resolveMcpServers()` in `PropertyResolver.ts` follows the same pattern and never re-reads the VS Code setting. This also means `workflowFile.hooks` is **never `undefined`** at resolve time — it is always at least `[]` (the seeded global default or an explicit user value).

> **`null` is the only suppress sentinel.** `null` in the YAML (`hooks: null`) copies through `extractWorkflowProperties()` (since `null !== undefined`), causes `populateSettingsDefaults()` to skip the default, and arrives at `resolveHooks()` as `null`. An empty array `hooks: []` is ambiguous — it could be an explicit "use no hooks" or the seeded global default being empty. Since the behavioral outcome is identical in either case (no hooks), the ambiguity is harmless: both `null` and `[]` resolve to no hooks. Use `=== null` checks, not `length === 0`, to avoid confusion.

```typescript
resolveHooks(promptItem: PromptItem, workflowFile: PromptFile): UserHookConfig[] {
  // Explicit null at prompt level → no hooks for this prompt, no inheritance
  if (promptItem.hooks === null) return [];

  // Explicit null at workflow level (no prompt override) → no hooks for this prompt
  if (promptItem.hooks === undefined && workflowFile.hooks === null) return [];

  // workflowFile.hooks is never undefined here (seeded by populateSettingsDefaults)
  const workflowHooks = workflowFile.hooks ?? [];

  // No prompt-level override → return workflow hooks (which include global default)
  if (promptItem.hooks === undefined || promptItem.hooks.length === 0) {
    return workflowHooks;
  }

  // Prompt has hooks → per-event override against workflow level
  const eventMap = new Map<HookEvent, UserHookConfig[]>();

  // Base: workflow-level hooks (includes baked-in global default)
  for (const hook of workflowHooks) {
    if (!eventMap.has(hook.event)) eventMap.set(hook.event, []);
    eventMap.get(hook.event)!.push(hook);
  }

  // Override: prompt-level hooks replace workflow hooks per event
  const promptEvents = new Set(promptItem.hooks.map(h => h.event));
  for (const event of promptEvents) {
    eventMap.set(event, promptItem.hooks!.filter(h => h.event === event));
  }

  return [...eventMap.values()].flat();
}
```

**Why per-event override, not simple merge:**
A workflow-level "always run tests on stop" hook should remain the default — but a specific prompt that defines its own stop hooks likely has a reason to run _different_ validation, not additional validation on top. Simple merge would silently double-fire workflow hooks even when the prompt author intended to replace them. Per-event override is more predictable: if you define a hook for an event, you own that event at your tier.

---

## 7a. VS Code Setting — `flightpath.hooks`

Analogous to `flightpath.mcpServers` — a global default array used to pre-populate new workflow files and as the ultimate fallback in `resolveHooks()`.

> **Naming:** The VS Code setting is `flightpath.hooks` (not `flightpath.defaultHooks`). This matches the `flightpath.mcpServers` precedent, where the setting key matches the property name directly rather than using a "default" prefix.

**`package.json` setting:**

```json
"flightpath.hooks": {
  "order": 610,
  "type": "array",
  "default": [],
  "description": "[Hooks] Default user hooks to run alongside FlightPath's completion-detection hooks. Used to pre-populate new workflow files. An empty array disables default injection.",
  "items": {
    "type": "object",
    "required": ["event", "command"],
    "properties": {
      "event": { "type": "string", "enum": ["stop", "sessionStart", "preToolUse", "postToolUse", "userPromptSubmit"] },
      "command": { "type": "string" },
      "timeoutSec": { "type": "number" }
    }
  }
}
```

**`ConfigurationUtils` addition:**

```typescript
getDefaultHooks(): UserHookConfig[] {
  return getConfig().get<UserHookConfig[]>("hooks", []);
}

async setDefaultHooks(hooks: UserHookConfig[]): Promise<void> {
  await this.updateSetting("hooks", hooks);
}
```

**`PromptFileLoader.populateSettingsDefaults()` addition:**

`hooks` MUST follow the same pattern as `mcpServers` and be added to `populateSettingsDefaults()`:

```typescript
if (explicitValues.hooks === undefined) {
  defaults.hooks = ConfigurationUtils.getDefaultHooks();
}
```

Without this, the `SettingsDrawer` cannot show the "Set as Default" button (it compares `workflowProperties.hooks` against the global setting — if `workflowProperties.hooks` is always `undefined`, the comparison never triggers). This also means new workflows silently ignore the global `flightpath.hooks` default.

### "Set as Default" Button in SettingsDrawer

The "Set as Default" button appears in `SettingsDrawer.tsx` (NOT `PropertiesDrawer.tsx`). For `mcpServers`, the button is rendered as a `<SetAsDefaultButton>` adjacent to the `<McpServersEditor>` block. The full plumbing path for the `hooks` equivalent:

1. **User clicks "Set as Default"** in SettingsDrawer → calls `handleSetAsDefault("hooks", workflowProperties.hooks)`
2. **`handleSetAsDefault`** sends `{ type: MESSAGE_TYPES.SET_AS_DEFAULT, property: "hooks", value: workflowProperties.hooks }`
3. **`WebviewSettingsSync.handleSetAsDefault()`** routes `property === "hooks"` → calls `ConfigurationUtils.setDefaultHooks(value ?? [])`
4. **VS Code settings** updated globally via `updateSetting("hooks", hooks)`

**`isDifferentFromGlobal("hooks")`** in SettingsDrawer needs the same null/`[]` normalization as `mcpServers` — both null and empty array count as "no hooks" and should not show the button when the global is also empty.

**`buildGlobalSettings()` in `WebviewSettingsSync.ts`** must include:

```typescript
hooks: ConfigurationUtils.getDefaultHooks(),
```

This is needed in both `buildGlobalSettings()` (used by `GlobalSettingsUpdatedMessage`) AND in `sendInitialState()` (used by `InitMessageData.globalSettings`). Both message types must carry the global hooks default so the SettingsDrawer can compare workflow vs global.

### Single Array vs Per-Event Settings

A single `flightpath.hooks` array is the right choice — not separate settings per event. Consistent with `flightpath.mcpServers`; per-event settings would require users to know all event names upfront. The VS Code setting holds a simple list — complex per-event override logic lives in the YAML.

---

## 7b. PropertiesDrawer UX

> **Not deferred.** The `hooks` property needs a usable editor in `PropertiesDrawer` — without it, users have no way to set per-prompt hooks short of editing raw YAML. The editor does NOT need to be as complex as `McpServersEditor`. A simple inline list editor is sufficient for V1.

### New Tab Page: HOOKS

Add a new `DRAWER_PAGES.HOOKS` entry to `src/ui/webview-react/types/drawerPages.ts`. This gives hooks its own tab in PropertiesDrawer, following the same pattern as `DRAWER_PAGES.MCP` and `DRAWER_PAGES.PERMISSIONS`.

The tab label is "Hooks". A hook icon (or a simple 🪝 emoji in dev) suffices; a proper SVG icon can be added alongside the others in the icons package.

### Editor Layout

Each hook entry is rendered as a compact inline row:

```
[ Event dropdown ▼ ] [ Command text input                          ] [ ✕ ]
[ Event dropdown ▼ ] [ Command text input                          ] [ ✕ ]
                                                    [ + Add Hook ]
```

**Event dropdown** — `<select>` or `<CustomSelect>` showing the 5 logical event names with human-readable labels:

| Value              | Label              |
| ------------------ | ------------------ |
| `stop`             | Stop (session end) |
| `sessionStart`     | Session Start      |
| `preToolUse`       | Pre Tool Use       |
| `postToolUse`      | Post Tool Use      |
| `userPromptSubmit` | User Prompt Submit |

**Command input** — plain `<input type="text">` with `font-mono` styling and placeholder `node ./scripts/my-hook.js`. Commands are entered as-is (resolved relative to workspace root at inject time).

**Optional timeout** — collapsed behind a "▸ Options" disclosure toggle per row to avoid visual clutter in the common case. When expanded, shows `<input type="number" placeholder="10">` labeled "Timeout (sec)". This matches the `timeoutSec` field — Copilot-only for V1.

**Add Hook button** — plain text link `+ Add Hook` that appends `{ event: "stop", command: "" }` to the array (defaulting to the most common event).

**Remove button** — `✕` icon button per row (matching the pattern used in `McpServersEditor` row actions).

### Default / Inherited / Custom Mode

Like `mcpServers`, use the three-mode pattern:

- **Default** (shown when `hooks === undefined`): displays the resolved inherited value (from workflow level or global default) in a read-only preview, with a "Customize" link to switch to Custom mode.
- **None** (shown when `hooks === null` or `hooks === []`): shows "No hooks — inherited hooks suppressed" label.
- **Custom** (shown when `hooks` is a non-null non-undefined array): shows the add/remove list editor described above.

A `CustomSelect` or button group to switch between Default / None / Custom (same pattern as `mcpServers` in PropertiesDrawer: the `McpServersEditor` exposes `value === undefined` as Default mode, `value === null` as None mode).

### Inherited Value Preview

When in Default mode, show the resolved hooks list in a muted read-only style (opacity-60 or similar), so users can see what hooks will actually run without switching to Custom mode. This is the `inheritedValue` prop pattern from `McpServersEditor`.

### SettingsDrawer Hook Editor

In `SettingsDrawer.tsx`, the global `flightpath.hooks` setting is edited using the **same component**. The SettingsDrawer renders it without the Default/None/Custom mode (since the global setting is always a concrete value — there is no tier above it to inherit from). A "Set as Default" button appears when `workflowProperties.hooks` differs from the global setting.

---

## 8. Complete File Change List

| File | Change |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `src/types/FlightPathTypes.ts` | Add `HookEvent` type, `UserHookConfig` interface, `hooks?: UserHookConfig[] \| null` to `ExecutionProperties` |
| `schemas/prompt-schema.json` | Add `userHookConfig` entry under `definitions` (draft-07, NOT `$defs`); add `hooks` `oneOf` array/null inside `executionProperties` alongside `mcpServers` |
| `src/flightpath/PropertyResolver.ts` | Add `resolveHooks()` with per-event override semantics (Section 7) |
| `src/flightpath/PromptFileParser.ts` | Copy `hooks` array/null from source |
| `src/flightpath/WorkflowInstance.ts` | Add `hooks` to the webview property coercion block (parallel to `mcpServers` cast at lines 2259–2261): `...(props?.hooks !== undefined && { hooks: props.hooks as UserHookConfig[]                                                                                                                                                         | null })` |
| `src/flightpath/orchestration/PromptFileLoader.ts` | (1) Copy `hooks` in `extractWorkflowLevelUpdates()` like `mcpServers`. (2) Add `hooks` to `populateSettingsDefaults()`: `if (explicitValues.hooks === undefined) { defaults.hooks = ConfigurationUtils.getDefaultHooks(); }` — required for SettingsDrawer comparison and new-workflow pre-population from global default. |
| `src/flightpath/harness/shared/interfaces/INotificationMonitor.ts` | Add optional `userHooks` param to `buildHookConfig()` in interface and base |
| `src/flightpath/harness/qwen/QwenCliProvider.ts` | (1) Replace backup/restore with `SettingsJsonHooksTracker.registerWorkflow()` / `unregisterWorkflow()` under `mcpTracker.withLock()` (Section 11b). (2) Read `userHooks` from resolved properties; pass as `workflowUserHooks`. (3) Add user commands to `trusted_hooks.json`. |
| `src/flightpath/harness/qwen/QwenNotificationMonitor.ts` | No change to `buildHookConfig()` — user hooks are not injected here (see Section 5) |
| `src/flightpath/harness/gemini/GeminiCliProvider.ts` | (1) Replace backup/restore with `SettingsJsonHooksTracker` under `mcpTracker.withLock()` (Section 11b). (2) Read `userHooks` from resolved properties; pass as `workflowUserHooks`. |
| `src/flightpath/harness/gemini/GeminiNotificationMonitor.ts` | No change to `buildHookConfig()` — user hooks are not injected here (see Section 5) |
| `src/flightpath/harness/claude/ClaudeCliProvider.ts` | (1) Unique per-prompt settings filename `claude-hook-settings-<stem>-p<n>.json`; push to `interactiveHookSettingsPaths[]`; spread in `getAdditionalCleanupFilePaths()` (Section 11a). (2) Pass `userHooks` to `buildHookConfig`. |
| `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to Stop/SessionStart arrays |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts` | Pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to sessionEnd/sessionStart arrays |
| `src/flightpath/harness/shared/SettingsJsonHooksTracker.ts` | **New file:** ref-counted hook injection for Qwen/Gemini; singleton-per-tool; in-memory baseline; restore on last unregister (Section 11b) |
| `src/flightpath/harness/shared/CliProviderUtils.ts` | Remove `readSettingsAndBackupHooks()` and `restoreHooksFromBackup()` once both providers migrated to `SettingsJsonHooksTracker` |
| `src/flightpath/harness/codex/CodexCliProvider.ts` | Implement chain script generation when `userHooks` contains stop events |
| `src/flightpath/harness/codex/CodexNotificationMonitor.ts` | Accept `userHooks`, generate chain script if needed |
| `src/flightpath/harness/opencode/OpenCodeCliProvider.ts` | Replace static file copy with `OpenCodePluginGenerator.generate(userHooks)` call |
| `src/flightpath/harness/opencode/OpenCodePluginGenerator.ts` | **New file:** generates the plugin JS string with user hook commands embedded |
| `src/scripts/flightpath-opencode-plugin.js` | No change — remains static source/reference; generator uses it as a template base |
| `package.json` | Add `flightpath.hooks` array setting with inline item schema (key is `hooks`, NOT `defaultHooks`) |
| `src/utils/ConfigurationUtils.ts` | Add `getDefaultHooks()` reading `config.get("hooks")` and `setDefaultHooks()` calling `updateSetting("hooks", ...)` |
| `src/ui/WebviewSettingsSync.ts` | (1) Add `hooks: ConfigurationUtils.getDefaultHooks()` to `buildGlobalSettings()`. (2) Add `hooks` to `sendWorkflowPropertiesToSettings()`. (3) Add `hooks` branch to `handleSetAsDefault()`. Must update BOTH `InitMessageData.globalSettings` and `GlobalSettingsUpdatedMessage.globalSettings` — they have different shape declarations. |
| `src/ui/WorkflowSerializer.ts` | Add `"hooks"` to **both** `WORKFLOW_FIELDS` and `PROMPT_FIELDS` arrays — omitting either causes silent data loss during save |
| `src/types/DashboardConstants.ts` | Add `HOOKS: "hooks"` to `PROMPT_PROPERTIES` constant |
| `src/types/WebviewMessageTypes.ts` | (1) Add `hooks?: UserHookConfig[] \| null` to `PromptItem`. (2) Add `hooks: UserHookConfig[]` to `GlobalSettingsUpdatedMessage.globalSettings`. (3) Add `hooks: UserHookConfig[]` to `InitMessageData.globalSettings` (these two types have different shapes — both need updating). |
| `src/utils/ValidationUtils.ts` | Add `userHookConfig` shape + `hooks` array/null to AJV runtime schema |
| `src/ui/webview-react/types/drawerPages.ts` | Add `HOOKS` entry to `DRAWER_PAGES` |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx` | Add HOOKS tab page: Default/None/Custom mode, inline list editor with event dropdown + command input + timeout disclosure + Add/Remove (Section 7b) |
| `src/ui/webview-react/components/editor/PromptEditor.tsx` | Add prompt-level hooks editor (parallel to existing prompt-level `mcpServers` editor) |
| `src/ui/webview-react/components/layout/SettingsDrawer.tsx` | Add hooks inline list editor (no mode selector at global level); add `SetAsDefaultButton` for hooks; add `isDifferentFromGlobal("hooks")` with null/`[]` normalization |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx` | Add `hooks` badge in the prompt list (parallel to existing `mcpServers` badge) |
| `src/ui/webview-react/store/settingsStore.ts` | Add `hooks?: UserHookConfig[] \| null` to `WorkflowProperties`; add `hooks: UserHookConfig[]` to `GlobalSettings`; add `getEffectiveHooks()` action |
| `src/ui/webview-react/store/editorStore.ts` | Add `hooks` to `WorkflowProperties` interface, default state, `updatePromptData()`, and `buildRawPromptItem()` — all four locations that enumerate `mcpServers` |
| `src/ui/webview-react/utils/prompt.ts` | Add `hooks` to `WorkflowProperties` type (line 52), `EditablePromptItem` type (line 95), default value (line 140), mapping-from-prompt (line 157), and serialization-to-raw (line 182) |
| `src/test/unit/PropertyResolver.test.ts` | Add `resolveHooks()` tests: per-event override, null sentinel, empty array, two-tier inheritance (no tier-3 read at runtime) |
| `src/test/unit/SettingsJsonHooksTracker.test.ts` | **New test file:** ref-counting, baseline capture, parallel register/unregister, restore-on-last-unregister |
| `src/ui/webview-react/test/store/settingsStore.test.ts` | Add hooks defaults and effective-value tests |
| `src/ui/webview-react/test/hooks/useMessageHandler.test.ts` | Add hooks message handling test (parallel to mcpServers test at line 148) |
| `src/ui/webview-react/test/utils/prompt.test.ts` | Add hooks field round-trip test (parallel to mcpServers tests at lines 47, 56) |
| `docs/` + templates | Document `hooks` property in workflow YAML examples |

---

## 9. Implementation Order

### Phase 0 — Parallel Safety (prerequisite, no schema changes required)

0a. **Claude CLI — unique per-prompt settings file** (Section 11a): Generate `claude-hook-settings-<stem>-p<n>.json` in `ClaudeCliProvider`. Push path to `interactiveHookSettingsPaths[]`. Spread in `getAdditionalCleanupFilePaths()`. No interface changes needed.

0b. **`SettingsJsonHooksTracker`** (Section 11b): Implement new `src/flightpath/harness/shared/SettingsJsonHooksTracker.ts` — singleton-per-tool, in-memory baseline, ref counting, re-merge on register, restore on last unregister.

0c. **Qwen + Gemini — migrate to `SettingsJsonHooksTracker`**: Replace `readSettingsAndBackupHooks()` / `restoreHooksFromBackup()` calls with `hooksTracker.registerWorkflow()` / `unregisterWorkflow()` calls inside `mcpTracker.withLock()`. Remove the temp backup files. Delete backup/restore helpers from `CliProviderUtils` once unused.

> These three steps are independent of the `hooks` schema property and should be shipped as a standalone parallel-safety fix before the full `hooks` feature lands.

---

### Phase 1 — `hooks` Property

1. **Types + schema** — `HookEvent`, `UserHookConfig`, `ExecutionProperties.hooks?: UserHookConfig[] | null`, JSON schema with `oneOf` null support. Run `npm run generate-schema` after. Unblocks everything.

2. **VS Code setting + `ConfigurationUtils`** — Add `flightpath.hooks` array setting in `package.json`; add `getDefaultHooks()` / `setDefaultHooks()` to `ConfigurationUtils` (Section 7a).

3. **`PropertyResolver.resolveHooks()`** — per-event override semantics with three-tier fallback: prompt → workflow → `getDefaultHooks()` (Section 7).

4. **`PromptFileParser` + `WorkflowInstance` + `PromptFileLoader`** — propagate `hooks` array/null through parsing. `PromptFileLoader`: copy `hooks` in `extractWorkflowLevelUpdates()` only — do not add to `populateSettingsDefaults()` (Section 8 note).

5. **`INotificationMonitor` interface + base** — add `userHooks?: UserHookConfig[]` to `buildHookConfig()` signature (backward compatible; Qwen/Gemini monitors do not use this parameter — see Step 6).

6. **Harness implementations:**
   - **Claude, Copilot** — `userHooks` flows into `buildHookConfig()`; each monitor appends entries to the relevant event arrays.
   - **Qwen, Gemini** — `userHooks` flows into `SettingsJsonHooksTracker.registerWorkflow()` as the `workflowUserHooks` parameter (replaces the TODO comment in `buildInteractiveHookSettings()`). For Qwen, also write user commands to `trusted_hooks.json`.
   - **OpenCode** — generate plugin dynamically via `OpenCodePluginGenerator` (Section 5).

7. **Codex chain script** — generate per-run chain script when user stop hooks are present (Section 5).

8. **Types + webview plumbing** — `DashboardConstants` (`HOOKS` constant), `WebviewMessageTypes` (all three message type updates), `WebviewSettingsSync` (global settings + `handleSetAsDefault`), `WorkflowSerializer` (both `WORKFLOW_FIELDS` and `PROMPT_FIELDS`), `ValidationUtils`, `settingsStore.ts` (`WorkflowProperties`, `GlobalSettings`, `getEffectiveHooks`).

9. **PropertiesDrawer + SettingsDrawer UI** — `drawerPages.ts` (new HOOKS page), PropertiesDrawer HOOKS tab with Default/None/Custom mode and inline list editor (Section 7b), SettingsDrawer hooks editor with `SetAsDefaultButton` and `isDifferentFromGlobal` normalization.

10. **Tests** — `PropertyResolver.test.ts` covering per-event override, null/empty, inheritance, and three-tier fallback. `SettingsJsonHooksTracker.test.ts` covering ref counting, baseline capture, and parallel registration/unregistration scenarios.

11. **Templates + docs** — update workflow templates and documentation.

---

## 11. Parallel Workflow Safety

> **Status: Not yet implemented.** All three issues below must be resolved before the `hooks` property ships — parallel workflows are a supported scenario for all harnesses.

When multiple FlightPath workflows run simultaneously in the same workspace, each harness's hook injection mechanism must not corrupt the others' state. This section documents the exact failure mode for each affected harness and the required fix.

---

### 11a. Claude CLI — Unique Per-Prompt Temp Settings File

**Current problem:** `ClaudeNotificationMonitor.buildHookConfig()` returns a `json-string` config that `ClaudeCliProvider` writes to a **fixed path**: `.flightpath/temp/claude-hook-settings.json`. This file is passed via `--settings` to the Claude CLI process.

**Race condition:**

1. Workflow A starts prompt 0 → writes `claude-hook-settings.json` with `notifyDir` for A → spawns `claude --settings .flightpath/temp/claude-hook-settings.json`
2. Workflow B starts prompt 0 → **overwrites** `claude-hook-settings.json` with `notifyDir` for B → spawns its own `claude --settings ...`
3. If Claude re-reads the settings file after spawn (e.g., for hot-reload), or if the OS hasn't fully flushed A's file to the process before B writes, A's hooks point to B's notify directory — A's completion signal goes to the wrong directory and A hangs forever.

Even if the race window is narrow, the consequences (hung workflow, missed completion signal) are severe. This must be made deterministic.

**Required fix:** Same pattern as the Copilot unique-per-prompt fix (`ce423b7`).

Generate a unique settings filename per prompt invocation:

```
.flightpath/temp/claude-hook-settings-<stem>-p<promptIndex>.json
```

Where `stem` is derived from the working file's basename (same helper used by Copilot's `buildHookFileName()`), with `Date.now()` as fallback.

**Implementation changes:**

- `ClaudeCliProvider.buildSessionHookArgs()` (or equivalent method that writes the temp settings file) receives `promptIndex: number` and `workingFilePath?: string`, calls a new static `buildHookSettingsFileName(stem, promptIndex)` helper, and pushes the resulting path onto `this.interactiveHookSettingsPaths: string[]`.
- `getAdditionalCleanupFilePaths()` spreads `this.interactiveHookSettingsPaths` (same pattern as Copilot's `this.interactiveHookFilePaths`).
- `ClaudeNotificationMonitor.buildHookConfig()` signature unchanged — the unique path is determined by the provider, not the monitor.
- The `--settings` flag value passed to the Claude CLI uses the unique path.

No coordination between parallel workflows is needed — each Claude process reads only its own settings file, and each file is cleaned up after its prompt completes.

---

### 11b. Qwen CLI & Gemini CLI — Hooks Ref-Counting via `SettingsJsonHooksTracker`

**Current problem:** Both providers use a backup/restore pattern with a **single shared backup file** per workspace:

- Qwen: `.flightpath/temp/qwen-hooks-backup.json`
- Gemini: `.flightpath/temp/gemini-hooks-backup.json`

The "backup only once" guard (`if backup file does not exist: write backup`) prevents a second parallel workflow from overwriting the backup with already-mutated hooks. But the restore step **deletes the backup file** after use. This creates the following race:

**Race condition with two parallel workflows (A and B):**

1. **Workflow A starts** → reads `.qwen/settings.json` (original: `{hooks: null}`) → no backup file → writes backup `{hooks: null}` → merges FlightPath hooks → settings now: `{hooks: {SessionStart: [...A...], Stop: [...A...]}}`
2. **Workflow B starts** → reads settings → backup file **exists** → skips backup → merges FlightPath hooks on top → settings now: `{hooks: {SessionStart: [...A..., ...B...], Stop: [...A..., ...B...]}}`
3. **Workflow A completes** → reads backup `{hooks: null}` → restores → settings now: `{hooks: null}` → **deletes backup file** → **B's hooks are gone; B's completion detection is broken**
4. **Workflow B completes** → tries to read backup → **backup file does not exist** → no-op → FlightPath's hooks for B are not cleaned up if they somehow survived step 3 (they didn't — A's restore wiped them)

Result: Workflow B hangs (completion signal never arrives because its hooks were stripped in step 3), or completes by timeout rather than completion detection.

**Required fix:** Reference-counted hooks management via a new `SettingsJsonHooksTracker` class, modelled exactly on `SettingsJsonMcpTracker`.

---

**`SettingsJsonHooksTracker` design:**

```typescript
/**
 * Manages FlightPath hook injection into settings.json for Qwen and Gemini CLIs.
 *
 * Parallel safety guarantee: hooks injected by workflow A are preserved in
 * settings.json until workflow A unregisters, regardless of other workflows
 * registering or unregistering concurrently. The original (pre-FlightPath)
 * hooks are restored only when the last active workflow unregisters.
 *
 * Coordinates with SettingsJsonMcpTracker via shared mutex — both trackers
 * modify the same settings.json file and must not interleave reads/writes.
 */
export class SettingsJsonHooksTracker {
  private static instances = new Map<string, SettingsJsonHooksTracker>();

  static getInstance(toolName: string): SettingsJsonHooksTracker { ... }
  static resetAll(): void { ... }

  /**
   * Register a workflow's hook injection.
   *
   * - First registration: captures original hooks from settings.json as baseline.
   * - All registrations: increments ref count, merges FlightPath + user hooks
   *   into settings.json via 3-layer merge (FlightPath first, workflow user hooks
   *   middle, pre-existing settings-file hooks last).
   *
   * Must be called under mcpTracker.withLock() — shares file access with MCP tracker.
   */
  async registerWorkflow(
    workflowKey: string,
    workspaceRoot: string,
    flightpathHooksSection: Record<string, unknown[]>,
    workflowUserHooks: Record<string, unknown[]>  // pre-converted to native format
  ): Promise<void>;

  /**
   * Unregister a workflow.
   *
   * Decrements ref count. When count reaches 0: restores the original hooks
   * baseline captured at first registration, clearing all FlightPath-injected hooks.
   *
   * Must be called under mcpTracker.withLock() — shares file access with MCP tracker.
   */
  async unregisterWorkflow(
    workflowKey: string,
    workspaceRoot: string
  ): Promise<void>;

  /** Ref count for current active workflows (for testing/debugging). */
  getActiveWorkflowCount(): number;
}
```

**Key design decisions:**

1. **Shared mutex with `SettingsJsonMcpTracker`:** Both trackers operate on the same `settings.json` file. Rather than introducing a second mutex (risk of deadlock or interleaving), `SettingsJsonHooksTracker` operations are called inside `mcpTracker.withLock()` in the provider. Both the MCP and hooks phases of `buildInteractiveHookSettings()` execute under a single lock acquisition.

2. **Baseline captured at first registration (not from file backup):** The baseline is stored in-memory as a field on the tracker instance, not in a file. This eliminates the backup-file race entirely. The baseline is the hooks state before any FlightPath workflow touched the file. Because ref counting ensures the baseline is only captured once (when `activeCount === 0` before incrementing), subsequent registrations read the already-captured in-memory baseline — no file I/O for baseline capture on subsequent parallel workflows.

3. **Full re-merge on each registration:** When workflow B registers while A is already active, the tracker re-reads `settings.json`, and re-merges all currently-active workflows' FlightPath hooks plus the baseline. This is simpler than tracking incremental deltas and guarantees the file reflects the union of all active workflows' hooks at all times.

4. **On unregister with count > 0:** Re-write `settings.json` with the union of remaining active workflows' hooks (remove the unregistering workflow's FlightPath hooks, keep all others). This keeps the file clean even mid-flight.

5. **On unregister with count = 0:** Restore `settings.json` to the captured baseline hooks. Clear the in-memory baseline so the next registration cycle starts fresh.

**Updated `buildInteractiveHookSettings()` call sequence (Qwen & Gemini):**

```typescript
// In QwenCliProvider.buildInteractiveHookSettings() / GeminiCliProvider equivalent:
await mcpTracker.withLock(async () => {
  await hooksTracker.registerWorkflow(
    workflowKey,
    workspaceRoot,
    this.monitor.buildHookConfig(scriptPath, notifyDir, workspaceRoot)
      .flightpathHooks,
    convertedWorkflowUserHooks
  );
  // MCP registration (if any) happens in the same lock window
  await mcpTracker.registerServersUnderLock(
    workflowKey,
    workspaceRoot,
    mcpEntries
  );
});
```

```typescript
// In cleanupWorkspaceArtifacts():
await mcpTracker.withLock(async () => {
  await hooksTracker.unregisterWorkflow(workflowKey, workspaceRoot);
  await mcpTracker.unregisterWorkflowUnderLock(workflowKey, workspaceRoot);
});
```

> **Note:** `SettingsJsonMcpTracker.registerServers()` and `unregisterWorkflow()` currently acquire the mutex internally. For coordinated hooks+MCP operations in a single lock window, internal versions (`registerServersUnderLock`, `unregisterWorkflowUnderLock`) that skip the mutex acquire/release will be needed, called only from within `withLock()`. Alternatively, the existing public methods can be used in two separate lock windows if the timing guarantees are sufficient — but a single window is safer.

**Trusted hooks (Qwen only):** The `~/.qwen/trusted_hooks.json` pre-trust step is unchanged — it operates on a separate file and does not require the shared mutex.

---

### 11c. Summary — Parallel Safety Across All Harnesses (Post-Fix)

| Harness      | Parallel strategy                       | Shared resource                                  | Conflict resolution                                                                                 |
| ------------ | --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Copilot**  | Unique per-prompt hook files            | `.github/hooks/` directory                       | Each file independently discovered; no coordination needed                                          |
| **Claude**   | Unique per-prompt settings files        | `.flightpath/temp/` directory                    | Each `--settings` file independently consumed; no coordination needed                               |
| **Qwen**     | `SettingsJsonHooksTracker` ref-counting | `.qwen/settings.json`                            | In-memory baseline + ref count; restore only on last unregister                                     |
| **Gemini**   | `SettingsJsonHooksTracker` ref-counting | `.gemini/settings.json`                          | In-memory baseline + ref count; restore only on last unregister                                     |
| **Codex**    | Stateless CLI flag (`--config notify=`) | None                                             | No shared state; each invocation independent                                                        |
| **OpenCode** | Plugin file re-deployed per run         | `.opencode/plugin/flightpath-completion-hook.js` | Single plugin file, but overwritten atomically each run; parallel risk is low and acceptable for V1 |

---

## 10. Out of Scope for This Plan

- **Hook output capture** — surfacing user hook stdout/stderr in FlightPath output panel
- **Conditional hooks** — running a hook only when end condition fails (future: `onRetry` hook)
- **HTTP hooks** — webhook-style notification (POST to URL on stop). Only command hooks in V1.
- **Hook environment variables** — passing FlightPath context (session ID, prompt index, workflow name) as env vars to user hook scripts. The notification data files already contain this info, so user scripts can read the notification directory directly. May be added as a convenience in a future iteration.
- **UI hook editor** — visual editor in the FlightPath dashboard for managing hooks (future work, low priority vs. YAML editing which is the primary interface for power users)
