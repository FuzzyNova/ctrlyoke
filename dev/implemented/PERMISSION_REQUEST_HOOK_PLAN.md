# Permission Request Hook Support Plan

## Problem

Claude Code, Codex, and OpenCode all expose a `PermissionRequest` / `permission.asked`
hook event that fires when the AI is about to show the user an interactive permission
dialog (e.g. "allow this Bash command?"). FlightPath's existing hook scripts silently
ignore this event. The immediate gap is:

1. **User hook scripts can't intercept it.** Users currently can enter hook scripts for
   `stop`, `sessionStart`, `preToolUse`, `postToolUse`, and `userPromptSubmit` via the
   HooksEditor. `permissionRequest` is a natural sixth entry that lets users write a
   script to auto-allow or auto-deny — the script's stdout JSON is what the harness
   reads as the decision.

**Hook-event notifications are out of scope for this plan.** That is future work under
`HOOK_EVENT_NOTIFICATIONS_PLAN.md`. This plan does **not** introduce any FlightPath
notification-file writes for permission requests. It only exposes the hook override so
user-defined scripts can participate in the harness's native permission decision flow.

**FlightPath's own tool permission settings (`cliAllowedTools`, `cliDeniedTools`) are
out of scope.** Those are already enforced by CLI args at spawn time via
`IToolPermissionMapper`. This plan is solely about surfacing `PermissionRequest` as a
user-visible hook event, consistent with how all other hook events work.

---

## How PermissionRequest Differs from Other Hook Events

For `stop`, `preToolUse`, etc., user hook scripts are fire-and-forget: the harness
does not read their stdout.

For `PermissionRequest`, **the hook script's stdout is the decision**. The harness
reads a JSON blob from the hook command's stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

or

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Blocked by policy."
    }
  }
}
```

Exit code 0 with no stdout → harness shows the dialog normally (correct default when
no user hook is configured).

This means running the user's `permissionRequest` hook script requires capturing its
stdout and echoing it — not the `execSync(..., { stdio: 'inherit' })` pattern used for
other hook events.

**Important pass-through rule:** FlightPath should not inspect, suppress, or transform
the user hook's stdout. It should forward stdout exactly as emitted and let the harness
apply its own semantics. For example, Codex's hooks docs say plain text stdout is
ignored for `PermissionRequest`, and only a supported JSON decision changes behavior.

### Payload Fields

**Claude** (hook_event_name = `"PermissionRequest"`):

- `session_id`, `transcript_path`, `cwd`, `permission_mode`
- `tool_name` (e.g. `"Bash"`, `"Edit"`, `"mcp__memory__write"`)
- `tool_input` (tool-specific object)
- `permission_suggestions` (optional array of "always allow" options)

**Codex** (same envelope, extra fields):

- `model`, `turn_id`
- `tool_input.description` (human-readable approval reason)

**OpenCode**: `permission.asked` event via the plugin event callback. Payload and
response contract must be verified against the `@opencode-ai/plugin` SDK types before
implementation — the docs don't include the full shape.

---

## Changes Required

### 1. `src/types/FlightPathTypes.ts`

Add `"permissionRequest"` to `HookEvent` and extend the mapping table comment:

```ts
export type HookEvent =
  | "stop"
  | "sessionStart"
  | "preToolUse"
  | "postToolUse"
  | "userPromptSubmit"
  | "permissionRequest";
```

Mapping table row to add:

| Logical             | Claude            | Copilot | Codex             | Qwen | Gemini | OpenCode         |
| ------------------- | ----------------- | ------- | ----------------- | ---- | ------ | ---------------- |
| `permissionRequest` | PermissionRequest | n/a     | PermissionRequest | n/a  | n/a    | permission.asked |

Copilot CLI, Qwen, and Gemini do not expose this hook — unsupported events are already
silently skipped by the harness layer.

### 2. `src/ui/webview-react/components/editor/HooksEditor.tsx`

Add the new entry to `HOOK_EVENTS`:

```ts
{ value: "permissionRequest", label: "Permission Request" },
```

No other changes needed — the editor already handles arbitrary hook entries generically.

### 3. `src/scripts/flightpath-claude-hook.js`

Replace the early-exit for unknown events with a three-way branch:

```js
if (hookEvent === "SessionStart") {
  /* existing start logic */
} else if (hookEvent === "Stop") {
  /* existing stop logic */
} else if (hookEvent === "PermissionRequest") {
  handlePermissionRequest(hookInput, debugLog);
} else {
  process.exit(0);
}
```

`handlePermissionRequest(hookInput, debugLog)`:

1. Check `FLIGHTPATH_USER_HOOKS_JSON` env var (see §6) for a `permissionRequest` entry.
2. If found: run the user hook command with the full `hookInput` JSON on stdin, capture
   stdout, print it to process stdout unchanged, and preserve the child's exit behavior
   so the harness receives the same decision payload the user script produced.
3. If not found: exit 0 with no stdout — harness shows the dialog normally.

No notification artifact is written here. `notifyDir` remains relevant only for
FlightPath's own start/stop completion detection hooks.

### 4. `src/scripts/flightpath-codex-notify.js`

Identical change. Replace the early-exit with a three-way branch and add
`handlePermissionRequest` using the same pass-through logic.

### 5. `src/scripts/flightpath-opencode-plugin.ts`

**Prerequisite**: install `@opencode-ai/plugin` locally and read the `permission.asked`
event type signature to determine the response contract.

Once confirmed, add a `permission.asked` handler in the `event()` callback (or as a
top-level key, depending on how OpenCode routes it). The handler should:

1. If a `permissionRequest` user hook is configured in the sidecar JSON:
   run the user command, capture stdout, return/respond with it in whatever form
   OpenCode expects.
2. Otherwise: return nothing / proceed normally.

Again: no FlightPath notification file is written for this event in this plan.

### 6. User Hook Forwarding via `flightpath-hook-utils.js`

Add a shared utility for running a user hook that needs its stdout captured and
forwarded:

```js
/**
 * Run a user hook command with JSON payload on stdin.
 * Captures the child's stdout and prints it to this process's stdout
 * so the harness receives it as the hook decision.
 * Returns the exit code of the child.
 */
function runDecisionHook(command, payloadJson, debugLog) { ... }
```

This is distinct from the existing fire-and-forget pattern (`execSync(..., { stdio: 'inherit' })`). The Claude and Codex hook scripts call this when handling `PermissionRequest`.

### 7. Hook Registration (Claude and Codex)

Verify whether `PermissionRequest` is already included in the hook registrations:

- **Claude**: The `--settings` JSON built by `ClaudeNotificationMonitor` / the
  `SettingsJsonHooksTracker`. If the hook entry uses `"*"` as the matcher or lists all
  events, the script already receives `PermissionRequest` and just needs to stop
  ignoring it. If it lists only `SessionStart`/`Stop`, add `PermissionRequest`.
- **Codex**: The `.codex/hooks.json` written by `CodexCliProvider`. Same check.

### 8. Future Notification Work

If/when `HOOK_EVENT_NOTIFICATIONS_PLAN.md` grows permission-request coverage, that
should be implemented as a separate FlightPath-specific notification branch. It should
not reuse the start/stop notification-file mechanism used for completion detection, and
it should not change the user-hook pass-through behavior described in this plan.

---

## What Does NOT Change

- `IToolPermissionMapper` and spawn-time CLI args — unchanged, still the primary
  enforcement mechanism for FlightPath's own permission settings.
- `cliAllowedTools`, `cliDeniedTools`, `cliToolPermissions` — unchanged.
- The fire-and-forget user hook execution for all other events — unchanged.
- FlightPath start/stop notification-file writes — unchanged; this plan does not add
  permission-request file writes.
- Copilot CLI, Qwen CLI, Gemini CLI — no equivalent hook, silently skipped as today.

---

## Open Questions

1. **Is `PermissionRequest` already in the Claude/Codex hook registration configs?**
   Check `ClaudeNotificationMonitor.ts` and `CodexCliProvider.ts` before adding
   registration code that may already be there.

2. **OpenCode `permission.asked` response contract** — requires reading
   `@opencode-ai/plugin` type definitions before implementing §5.

3. **`FLIGHTPATH_USER_HOOKS_JSON` injection** — today the hook sidecar JSON for
   OpenCode is written to disk (`.opencode/plugin/flightpath-hooks.json`). For Claude
   and Codex, user hooks may be delivered via a different mechanism (env var or a
   parallel sidecar file). Verify the current injection path and use the same one.
