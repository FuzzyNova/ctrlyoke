# `hooks` Property — User Hook Exposure Plan

**Date:** 2026-03-27
**Inspired by:** `MCP_SERVERS_PROPERTY_PLAN.md`
**Problem:** FlightPath silently clobbers user-defined hooks in `.qwen/settings.json` and `.gemini/settings.json` during interactive runs, and offers no way for users to add their own scripts alongside FlightPath's completion detection hooks.

> **Note on the deep-merge fix (Section 3):** This is a permanent, necessary part of the implementation — not an interim workaround. Even after the full `hooks` property ships, three independent layers of hooks must coexist: (1) FlightPath's completion-detection handlers, (2) commands declared in the workflow `hooks` YAML property, and (3) commands already present in the user's settings file before FlightPath runs. The full feature implementation handles layer 2; the deep-merge fix handles layer 3. Both are required.

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

## 3. Deep-Merge Fix (Qwen & Gemini) — Permanent, Required

Fix the merge strategy for Qwen and Gemini so all three layers of user hooks are preserved and execute during FlightPath runs. This fix is a prerequisite for the full `hooks` property: you cannot append user workflow hooks to the event arrays without first replacing the wholesale-replace approach with deep-merge.

### Fix: Deep-merge hook event arrays instead of replacing the hooks key

```typescript
// In QwenCliProvider.buildInteractiveHookSettings() and GeminiCliProvider equivalent:

// Current (broken):
const mergedSettings = {
  ...existingSettings,
  hooks: hooksSection,  // ❌ Replaces all user hooks
};

// Fixed:
const existingHooks = (existingSettings.hooks as Record<string, unknown[]> | undefined) ?? {};
const flightpathHooks = hooksSection as Record<string, unknown[]>;

// Merge: append user's existing handlers AFTER FlightPath's handlers for each event
const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
for (const [event, handlers] of Object.entries(flightpathHooks)) {
  const userHandlers = (existingHooks[event] as unknown[] | undefined) ?? [];
  // FlightPath handlers first (completion detection must fire reliably)
  mergedHooks[event] = [...handlers, ...userHandlers];
}

const mergedSettings = {
  ...existingSettings,
  hooks: mergedHooks,  // ✅ Preserves all user hooks, adds FlightPath's
};
```

This fix:
- Preserves all user hook entries for all events
- Appends user's handlers after FlightPath's (FlightPath fires first for reliability)
- Zero user-visible behavior change for existing users (existing hooks now fire instead of being silently dropped)

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

# Workflow-level default, overridden at prompt level
hooks:
  - event: stop
    command: node ./scripts/default-check.js
prompts:
  - name: risky-step
    hooks:
      - event: stop
        command: node ./scripts/extra-validation.js  # Only on this prompt
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
 * Merged with workflow-level hooks (prompt-level overrides workflow-level).
 */
hooks?: UserHookConfig[];
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
  "type": "array",
  "items": { "$ref": "#/$defs/UserHookConfig" },
  "description": "User-defined hooks run alongside FlightPath's completion-detection hooks. Supported events vary by harness; unsupported events are silently skipped."
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

### Qwen CLI & Gemini CLI (after bug fix)

Same deep-merge strategy from Section 3, but now ALSO include user hooks from the `hooks` workflow property, placed after FlightPath's handlers:

```typescript
// Precedence: FlightPath handlers → workflow hooks → existing settings hooks
mergedHooks[event] = [
  ...flightpathHandlers,    // FlightPath's completion detection (highest priority)
  ...workflowUserHandlers,  // From UserHookConfig in workflow YAML
  ...existingUserHandlers,  // From pre-existing settings file
];
```

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

Add `resolveHooks()` analogous to `resolveMcpServers()`:

```typescript
// Three-tier: prompt-level → workflow-level → empty array (no global default needed)
resolveHooks(
  promptItem: PromptItem,
  workflowFile: PromptFile
): UserHookConfig[]
```

Hooks from prompt-level and workflow-level are **merged** (both fire), not overridden. This differs from most properties where prompt-level overrides workflow-level. Rationale: a workflow-level "always run tests on stop" hook should still fire even if a specific prompt adds its own stop hook.

---

## 8. Complete File Change List

| File | Change |
|------|--------|
| `src/types/FlightPathTypes.ts` | Add `HookEvent` type, `UserHookConfig` interface, `hooks?: UserHookConfig[]` to `ExecutionProperties` |
| `schemas/prompt-schema.json` | Add `UserHookConfig` def and `hooks` array property |
| `src/flightpath/PropertyResolver.ts` | Add `resolveHooks()` merging prompt+workflow arrays |
| `src/flightpath/PromptFileParser.ts` | Copy `hooks` array from source |
| `src/flightpath/WorkflowInstance.ts` | Add `hooks` array handling |
| `src/flightpath/harness/shared/interfaces/INotificationMonitor.ts` | Add optional `userHooks` param to `buildHookConfig()` in interface and base |
| `src/flightpath/harness/qwen/QwenCliProvider.ts` | **Bug fix:** deep-merge hook event arrays; pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/qwen/QwenNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to Stop/SessionStart arrays |
| `src/flightpath/harness/gemini/GeminiCliProvider.ts` | **Bug fix:** deep-merge hook event arrays; pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/gemini/GeminiNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to AfterAgent/SessionStart arrays |
| `src/flightpath/harness/claude/ClaudeCliProvider.ts` | Pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to Stop/SessionStart arrays |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts` | Pass `userHooks` to `buildHookConfig` |
| `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts` | Accept `userHooks` in `buildHookConfig`, append to sessionEnd/sessionStart arrays |
| `src/flightpath/harness/codex/CodexCliProvider.ts` | Implement chain script generation when `userHooks` contains stop events |
| `src/flightpath/harness/codex/CodexNotificationMonitor.ts` | Accept `userHooks`, generate chain script if needed |
| `src/flightpath/harness/opencode/OpenCodeCliProvider.ts` | Replace static file copy with `OpenCodePluginGenerator.generate(userHooks)` call |
| `src/flightpath/harness/opencode/OpenCodePluginGenerator.ts` | **New file:** generates the plugin JS string with user hook commands embedded |
| `src/scripts/flightpath-opencode-plugin.js` | No change — remains static source/reference; generator uses it as a template base |
| `src/ui/WebviewSettingsSync.ts` | Add `hooks` property handling |
| `src/ui/WorkflowSerializer.ts` | Add `"hooks"` to property lists |
| `src/types/DashboardConstants.ts` | Add `HOOKS` constant |
| `src/types/WebviewMessageTypes.ts` | Add `hooks?: UserHookConfig[]` to relevant interfaces |
| `src/test/unit/PropertyResolver.test.ts` | Add `resolveHooks()` tests |
| `docs/` + templates | Document `hooks` property in workflow YAML examples |

---

## 9. Implementation Order

1. **Bug fix first** — Fix Qwen and Gemini to deep-merge hook arrays (Section 3). This is a standalone, low-risk fix that resolves the existing user impact immediately. No schema or type changes required.

2. **Types + schema** — `HookEvent`, `UserHookConfig`, `ExecutionProperties.hooks`, JSON schema. Unblocks everything.

3. **`PropertyResolver.resolveHooks()`** — merge arrays from both levels.

4. **`PromptFileParser` + `WorkflowInstance`** — propagate `hooks` array through parsing.

5. **`INotificationMonitor` interface + base** — add optional `userHooks` parameter (backward compatible).

6. **Harness implementations** — Claude, Copilot, Qwen, Gemini. Each appends user hook entries to their respective event arrays. OpenCode next (cleanest: generate plugin dynamically via `OpenCodePluginGenerator`). Codex last (chain script is more involved).

7. **Codex chain script** — generate per-run chain script when user stop hooks are present.

8. **Webview layer** — `WebviewSettingsSync`, `WorkflowSerializer`, `DashboardConstants`, `WebviewMessageTypes`. UI editing of hooks is low priority for V1.

9. **Tests** — `PropertyResolver.test.ts` and hook injection unit tests.

10. **Templates + docs** — update workflow templates and documentation.

---

## 10. Out of Scope for This Plan

- **Global VS Code setting for default hooks** — always-on hooks independent of workflow YAML (future: `flightpath.defaultHooks` setting)
- **Hook output capture** — surfacing user hook stdout/stderr in FlightPath output panel
- **Conditional hooks** — running a hook only when end condition fails (future: `onRetry` hook)
- **HTTP hooks** — webhook-style notification (POST to URL on stop). Only command hooks in V1.
- **Hook environment variables** — passing FlightPath context (session ID, prompt index, workflow name) as env vars to user hook scripts. The notification data files already contain this info, so user scripts can read the notification directory directly. May be added as a convenience in a future iteration.
- **UI hook editor** — visual editor in the FlightPath dashboard for managing hooks (future work, low priority vs. YAML editing which is the primary interface for power users)
