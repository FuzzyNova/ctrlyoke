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

| Harness | Hook Method | Conflict Risk | User Hooks Preserved? |
|---------|-------------|---------------|----------------------|
| **Copilot CLI** | Creates `.github/hooks/flightpath.json` (separate file) | None | YES — Copilot loads all JSON files in `.github/hooks/` |
| **Claude CLI** | Temp file via `--settings` flag (overlay, not replacement) | None | YES — `--settings` is additive in Claude's settings chain |
| **Codex CLI** | Inline `--config notify=[...]` argument | Partial | NO — only one `notify` command can be passed inline |
| **OpenCode CLI** | Plugin file deployment (not hook-based) | None | YES — plugin is separate; no hooks key used |
| **Qwen CLI** | Reads `.qwen/settings.json`, overwrites `hooks` key | **HIGH** | **NO** — entire `hooks` section replaced during run |
| **Gemini CLI** | Reads `.gemini/settings.json`, overwrites `hooks` key | **HIGH** | **NO** — entire `hooks` section replaced during run |

### The Core Bug (Qwen & Gemini)

```typescript
// Current code in QwenCliProvider and GeminiCliProvider:
const mergedSettings = {
  ...existingSettings,  // Non-hooks keys preserved ✅
  hooks: hooksSection,  // Entire hooks key REPLACED ❌
};
```

If a user has, for example, a custom Stop hook that runs their test suite or sends a notification, it **silently stops firing** during any FlightPath session. The backup/restore mechanism restores the file after the run completes, but the user's hook doesn't fire *during* the run.

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
      { "hooks": [{ "type": "command", "command": "node /path/to/flightpath-hook.js /notifyDir" }] },
      { "hooks": [{ "type": "command", "command": "node /path/to/user-script.js" }] }
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
      { "type": "command", "bash": "node ...", "powershell": "node ...", "timeoutSec": 10 }
    ],
    "sessionEnd": [
      { "type": "command", "bash": "node ...", "powershell": "node ...", "timeoutSec": 10 }
    ]
  }
}
```

**Key:** Each event is an array of objects. Copilot loads **all** JSON files under `.github/hooks/` — FlightPath's file (`flightpath.json`) coexists with any user-created files. User hooks should NOT go in `flightpath.json`; users can create their own `my-hooks.json` in `.github/hooks/`.

**Available events:** `sessionStart`, `sessionEnd`

### Gemini CLI

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/script" }] }
    ],
    "AfterAgent": [
      { "hooks": [{ "type": "command", "command": "node /path/to/flightpath-hook.js /notifyDir" }] }
    ]
  }
}
```

**Key:** Same array-of-groups format as Claude. `AfterAgent` is the completion event (not `Stop`).

**Available events:** `SessionStart`, `AfterAgent` (and likely others from Gemini's documentation)

### Codex CLI

```
notify=['node','/path/to/hook']
```

**Key:** TOML inline format. Only one `notify` command can be set. FlightPath currently uses this as the sole completion signal. Adding user hooks here requires chaining scripts.

**Available events:** `notify` only (no named event system)

### OpenCode CLI

Uses a plugin system (not hooks). Separate plugin file deployed to `.opencode/plugin/`. Not relevant for this plan — no hook conflict exists.

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
const existingHooks = (existingSettings.hooks as Record<string, unknown[]> | undefined) ?? {};
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
        command: node ./scripts/extra-validation.js  # Replaces workflow's stop hook
    # sessionStart not listed → still inherits notify-start.js from workflow level

  - name: silent-step
    hooks: null  # No hooks at all — suppresses even the workflow's sessionStart hook
```

### TypeScript Types

**`src/types/FlightPathTypes.ts`:**

```typescript
/**
 * Logical hook event names — mapped to CLI-specific event names at inject time.
 *
 * | Logical name      | Claude/Qwen      | Copilot CLI  | Gemini CLI   | Codex  | OpenCode                |
 * |-------------------|------------------|--------------|--------------|--------|-------------------------|
 * | "stop"            | Stop             | sessionEnd   | AfterAgent   | notify | session.status idle     |
 * | "sessionStart"    | SessionStart     | sessionStart | SessionStart | (none) | session.created         |
 * | "preToolUse"      | PreToolUse       | (none)       | (none)       | (none) | (unknown)               |
 * | "postToolUse"     | PostToolUse      | (none)       | (none)       | (none) | (unknown)               |
 * | "userPromptSubmit"| UserPromptSubmit | (none)       | (none)       | (none) | (none)                  |
 *   (Qwen only)
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

Add to `$defs`:

```json
"UserHookConfig": {
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

The `hooks` property on both `PromptFile` and `PromptItem`:

```json
"hooks": {
  "oneOf": [
    {
      "type": "array",
      "items": { "$ref": "#/$defs/UserHookConfig" },
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

| Logical Event     | Claude CLI    | Qwen CLI           | Copilot CLI   | Gemini CLI   | Codex CLI | OpenCode CLI           |
|-------------------|---------------|--------------------|---------------|--------------|-----------|------------------------|
| `stop`            | `Stop`        | `Stop`             | `sessionEnd`  | `AfterAgent` | `notify`  | `session.status idle`  |
| `sessionStart`    | `SessionStart`| `SessionStart`     | `sessionStart`| `SessionStart`| (none)  | `session.created`      |
| `preToolUse`      | `PreToolUse`  | `PreToolUse` (?)   | (none)        | (none)       | (none)    | (unknown — no events observed yet) |
| `postToolUse`     | `PostToolUse` | `PostToolUse` (?)  | (none)        | (none)       | (none)    | (unknown — no events observed yet) |
| `userPromptSubmit`| (none)        | `UserPromptSubmit` | (none)        | (none)       | (none)    | (none)                 |

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
  const workflowUserHandlers = (workflowUserHooks[event] as unknown[] | undefined) ?? [];
  const existingUserHandlers = (existingHooks[event] as unknown[] | undefined) ?? [];
  mergedHooks[event] = [
    ...flightpathHandlers,      // FlightPath's completion detection (highest priority)
    ...workflowUserHandlers,    // From UserHookConfig in workflow YAML
    ...existingUserHandlers,    // From pre-existing settings file
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
  }
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
  "node /path/to/another-script.js"
];

// And at session.created handler:
const USER_SESSION_START_HOOKS = [
  "node /path/to/on-start.js"
];
```

The generated plugin executes each user command via `child_process.execSync` after the FlightPath notification file is written:

```javascript
// Generated inside the session.status idle block (after writing stop file):
const { execSync } = require('child_process');
for (const cmd of USER_STOP_HOOKS) {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: workspaceRoot });
  } catch (e) {
    // Silently swallow — user hook failure must not break completion detection
  }
}
```

**Event coverage:** OpenCode's plugin system receives all events from the OpenCode process. The current plugin uses `session.created` and `session.status idle`. If OpenCode emits tool-related events (e.g., `tool.before`, `tool.after`), they would map to `preToolUse`/`postToolUse` — but these event names are unconfirmed. Until observed in the wild, `preToolUse` and `postToolUse` should be documented as unsupported for OpenCode.

**No conflict with existing OpenCode configuration:** OpenCode's MCP config (`.opencode/opencode.json`) is unaffected — it's a separate concern from the plugin. The plugin file at `.opencode/plugin/flightpath-completion-hook.js` is written and cleaned up entirely by FlightPath. No merge needed.

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
const { execSync } = require('child_process');
require('./flightpath-codex-hook.js'); // Original FlightPath notify hook
// User hooks from workflow:
execSync('node /path/to/user-script.js', { stdio: 'inherit' });
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

| `hooks` value at a tier | Effect on that event at that tier |
|-------------------------|----------------------------------|
| Omitted (`undefined`) | No override — events inherit from the tier below |
| `null` or `[]` | All events explicitly cleared — return `[]` immediately, no further fallback |
| `[{ event: "stop", ... }]` | `stop` is overridden; all other events not mentioned still inherit from the tier below |

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
        command: node ./scripts/extra-validation.js  # Replaces workflow's stop hook
    # sessionStart not mentioned → still inherits from workflow level
```
Result for `risky-step`: `stop` runs `extra-validation.js` only; `sessionStart` still runs `notify-start.js`.

**Example — explicit clear:**
```yaml
  - name: cleanup-step
    hooks: null   # (or hooks: []) — no hooks at all for this prompt
```
Result: no user hooks fire for `cleanup-step` regardless of workflow or global defaults.

**Algorithm in `resolveHooks()`:**

```typescript
resolveHooks(promptItem: PromptItem, workflowFile: PromptFile): UserHookConfig[] {
  // Explicit null/empty at prompt level → no hooks, no fallback
  if (promptItem.hooks !== undefined) {
    if (promptItem.hooks === null || promptItem.hooks.length === 0) return [];
  }

  // Explicit null/empty at workflow level → no hooks, no fallback
  if (workflowFile.hooks !== undefined && promptItem.hooks === undefined) {
    if (workflowFile.hooks === null || workflowFile.hooks.length === 0) return [];
  }

  const promptHooks   = promptItem.hooks   ?? [];
  const workflowHooks = workflowFile.hooks  ?? [];
  const globalHooks   = ConfigurationUtils.getDefaultHooks();  // new method (Section 7a)

  // Build per-event map from lowest priority to highest
  const eventMap = new Map<HookEvent, UserHookConfig[]>();

  // Tier 3: global defaults (lowest priority)
  for (const hook of globalHooks) {
    if (!eventMap.has(hook.event)) eventMap.set(hook.event, []);
    eventMap.get(hook.event)!.push(hook);
  }

  // Tier 2: workflow overrides per event
  if (workflowFile.hooks !== undefined && workflowFile.hooks !== null) {
    const workflowEvents = new Set(workflowHooks.map(h => h.event));
    for (const event of workflowEvents) {
      eventMap.set(event, workflowHooks.filter(h => h.event === event));
    }
  }

  // Tier 1: prompt overrides per event (highest priority)
  if (promptItem.hooks !== undefined && promptItem.hooks !== null) {
    const promptEvents = new Set(promptHooks.map(h => h.event));
    for (const event of promptEvents) {
      eventMap.set(event, promptHooks.filter(h => h.event === event));
    }
  }

  return [...eventMap.values()].flat();
}
```

**Why per-event override, not simple merge:**
A workflow-level "always run tests on stop" hook should remain the default — but a specific prompt that defines its own stop hooks likely has a reason to run *different* validation, not additional validation on top. Simple merge would silently double-fire workflow hooks even when the prompt author intended to replace them. Per-event override is more predictable: if you define a hook for an event, you own that event at your tier.

---

## 7a. VS Code Setting — `flightpath.defaultHooks`

Analogous to `flightpath.mcpServers` — a global default array used to pre-populate new workflow files and as the ultimate fallback in `resolveHooks()`.

**`package.json` setting:**

```json
"flightpath.defaultHooks": {
  "type": "array",
  "default": [],
  "items": { "$ref": "#/$defs/UserHookConfig" },
  "description": "Default hooks injected for workflow prompts when no per-prompt or per-workflow hooks are specified. Used to pre-populate new workflow files. An empty array disables default injection."
}
```

**`ConfigurationUtils` addition:**

```typescript
getDefaultHooks(): UserHookConfig[] {
  return getConfig().get<UserHookConfig[]>("defaultHooks", []);
}

async setDefaultHooks(hooks: UserHookConfig[]): Promise<void> {
  await this.updateSetting("defaultHooks", hooks);
}
```

### "Set as Default" Action

The dashboard should expose a "Set as Default" action (matching the pattern used for Skills) that copies the current workflow's `hooks` array into `flightpath.defaultHooks`. This allows users to define hooks once in a workflow, validate them, then promote them to their global default for all future workflows.

### Single Array vs Per-Event Settings

A single `flightpath.defaultHooks` array is the right choice — not separate settings per event (e.g., `flightpath.defaultHooks.stop`, `flightpath.defaultHooks.sessionStart`). Reasons:
- Consistent with `flightpath.mcpServers` pattern
- Per-event settings would require users to understand all supported event names upfront when browsing VS Code's settings UI
- The settings UI can render the array; users who need fine-grained event control are already editing YAML
- Adding events later doesn't require new settings — the array extends naturally

The VS Code setting is intentionally **not** a place for sophisticated configuration. It holds a simple list of "always run these commands on these events." Complex per-prompt and per-workflow override logic lives in the YAML workflow files.

---

## 8. Complete File Change List

| File | Change |
|------|--------|
| `src/types/FlightPathTypes.ts` | Add `HookEvent` type, `UserHookConfig` interface, `hooks?: UserHookConfig[] \| null` to `ExecutionProperties` |
| `schemas/prompt-schema.json` | Add `UserHookConfig` def and `hooks` `oneOf` array/null property |
| `src/flightpath/PropertyResolver.ts` | Add `resolveHooks()` with per-event override semantics (Section 7) |
| `src/flightpath/PromptFileParser.ts` | Copy `hooks` array/null from source |
| `src/flightpath/WorkflowInstance.ts` | Add `hooks` array/null handling |
| `src/flightpath/orchestration/PromptFileLoader.ts` | Copy `hooks` from `promptFile` in `extractWorkflowLevelUpdates()` (like `mcpServers`). **Do NOT add `hooks` to `populateSettingsDefaults()`** — unlike `mcpServers`, the VS Code default fallback lives exclusively in `resolveHooks()`. Baking it into the loaded workflow object would collapse `undefined` (not set) and `[]` (explicitly empty) into the same value, breaking per-event inheritance. |
| `src/flightpath/harness/shared/interfaces/INotificationMonitor.ts` | Add optional `userHooks` param to `buildHookConfig()` in interface and base |
| `src/flightpath/harness/qwen/QwenCliProvider.ts` | Read `userHooks` from `workflowContext.resolvedProperties.hooks`; pass to `buildInteractiveHookSettings()`; add user commands to `trusted_hooks.json` pre-trust step (Section 5) |
| `src/flightpath/harness/qwen/QwenNotificationMonitor.ts` | No change to `buildHookConfig()` — user hooks are not injected here (see Section 5) |
| `src/flightpath/harness/gemini/GeminiCliProvider.ts` | Read `userHooks` from `workflowContext.resolvedProperties.hooks`; pass to `buildInteractiveHookSettings()` (Section 5) |
| `src/flightpath/harness/gemini/GeminiNotificationMonitor.ts` | No change to `buildHookConfig()` — user hooks are not injected here (see Section 5) |
| `src/flightpath/harness/claude/ClaudeCliProvider.ts` | Pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to Stop/SessionStart arrays |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts` | Pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to sessionEnd/sessionStart arrays |
| `src/flightpath/harness/codex/CodexCliProvider.ts` | Implement chain script generation when `userHooks` contains stop events |
| `src/flightpath/harness/codex/CodexNotificationMonitor.ts` | Accept `userHooks`, generate chain script if needed |
| `src/flightpath/harness/opencode/OpenCodeCliProvider.ts` | Replace static file copy with `OpenCodePluginGenerator.generate(userHooks)` call |
| `src/flightpath/harness/opencode/OpenCodePluginGenerator.ts` | **New file:** generates the plugin JS string with user hook commands embedded |
| `src/scripts/flightpath-opencode-plugin.js` | No change — remains static source/reference; generator uses it as a template base |
| `package.json` | Add `flightpath.defaultHooks` array setting (Section 7a) |
| `src/utils/ConfigurationUtils.ts` | Add `getDefaultHooks()` and `setDefaultHooks()` (Section 7a) |
| `src/ui/WebviewSettingsSync.ts` | Add `hooks` property handling; add `defaultHooks` to global settings sent to webview |
| `src/ui/WorkflowSerializer.ts` | Add `"hooks"` to property lists |
| `src/types/DashboardConstants.ts` | Add `HOOKS` constant |
| `src/types/WebviewMessageTypes.ts` | Add `hooks?: UserHookConfig[] \| null` to relevant interfaces; add `defaultHooks` to global settings interface |
| `src/utils/ValidationUtils.ts` | Add `UserHookConfig` shape + `hooks` array/null definition to AJV runtime schema |
| `src/test/unit/PropertyResolver.test.ts` | Add `resolveHooks()` tests covering per-event override, null/empty, and inheritance |
| `docs/` + templates | Document `hooks` property in workflow YAML examples |

---

## 9. Implementation Order

1. **Types + schema** — `HookEvent`, `UserHookConfig`, `ExecutionProperties.hooks?: UserHookConfig[] | null`, JSON schema with `oneOf` null support. Run `npm run generate-schema` after. Unblocks everything.

2. **VS Code setting + `ConfigurationUtils`** — Add `flightpath.defaultHooks` array setting in `package.json`; add `getDefaultHooks()` / `setDefaultHooks()` to `ConfigurationUtils` (Section 7a).

3. **`PropertyResolver.resolveHooks()`** — per-event override semantics with three-tier fallback: prompt → workflow → `getDefaultHooks()` (Section 7).

4. **`PromptFileParser` + `WorkflowInstance` + `PromptFileLoader`** — propagate `hooks` array/null through parsing. `PromptFileLoader`: copy `hooks` in `extractWorkflowLevelUpdates()` only — do not add to `populateSettingsDefaults()` (Section 8 note).

5. **`INotificationMonitor` interface + base** — add `userHooks?: UserHookConfig[]` to `buildHookConfig()` signature (backward compatible; Qwen/Gemini monitors do not use this parameter — see Step 6).

6. **Harness implementations:**
   - **Claude, Copilot** — `userHooks` flows into `buildHookConfig()`; each monitor appends entries to the relevant event arrays.
   - **Qwen, Gemini** — `userHooks` flows into `buildInteractiveHookSettings()` as the middle layer of the three-layer merge (Section 5). For Qwen, also write user commands to `trusted_hooks.json`.
   - **OpenCode** — generate plugin dynamically via `OpenCodePluginGenerator` (Section 5).

7. **Codex chain script** — generate per-run chain script when user stop hooks are present (Section 5).

8. **Webview layer** — `DashboardConstants`, `WebviewMessageTypes`, `WebviewSettingsSync`, `WorkflowSerializer`, `ValidationUtils`. "Set as Default" action in the dashboard. UI editing of hooks is low priority for V1.

9. **Tests** — `PropertyResolver.test.ts` covering per-event override, null/empty, inheritance, and three-tier fallback.

10. **Templates + docs** — update workflow templates and documentation.

---

## 10. Out of Scope for This Plan

- **Hook output capture** — surfacing user hook stdout/stderr in FlightPath output panel
- **Conditional hooks** — running a hook only when end condition fails (future: `onRetry` hook)
- **HTTP hooks** — webhook-style notification (POST to URL on stop). Only command hooks in V1.
- **Hook environment variables** — passing FlightPath context (session ID, prompt index, workflow name) as env vars to user hook scripts. The notification data files already contain this info, so user scripts can read the notification directory directly. May be added as a convenience in a future iteration.
- **UI hook editor** — visual editor in the FlightPath dashboard for managing hooks (future work, low priority vs. YAML editing which is the primary interface for power users)
