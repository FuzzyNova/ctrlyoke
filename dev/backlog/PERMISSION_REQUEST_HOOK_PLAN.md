# Permission Request Hook Support Plan

## Problem

Claude Code, Codex, and OpenCode all expose a `PermissionRequest` / `permission.asked`
hook event that fires when the AI is about to show the user an interactive permission
dialog (e.g. "allow this Bash command?"). FlightPath's existing hook scripts silently
ignore this event. Two things are lost:

1. **User hook scripts can't intercept it.** Users currently can enter hook scripts for
   `stop`, `sessionStart`, `preToolUse`, `postToolUse`, and `userPromptSubmit` via the
   HooksEditor. `permissionRequest` is a natural sixth entry that lets users write a
   script to auto-allow or auto-deny — the script's stdout JSON is what the harness
   reads as the decision.

2. **Hook notifications can't fire for it.** The `HOOK_EVENT_NOTIFICATIONS_PLAN.md`
   feature (hook-event notifications) can't cover permission requests until this event
   exists as a logical `HookEvent`. Notifications are especially valuable here because
   in interactive mode, a permission dialog means the AI is paused waiting for input.
   A "permission request" notification tells the user to open FlightPath and approve
   in the terminal view, rather than leaving the workflow stuck silently.

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

| Logical          | Claude            | Copilot    | Codex             | Qwen | Gemini | OpenCode          |
|------------------|-------------------|------------|-------------------|------|--------|-------------------|
| `permissionRequest` | PermissionRequest | n/a     | PermissionRequest | n/a  | n/a    | permission.asked  |

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
if (hookEvent === "SessionStart") { /* existing start logic */ }
else if (hookEvent === "Stop")    { /* existing stop logic */ }
else if (hookEvent === "PermissionRequest") { handlePermissionRequest(hookInput, debugLog, notifyDir); }
else { process.exit(0); }
```

`handlePermissionRequest(hookInput, debugLog, notifyDir)`:

1. Write a normalized hook-event notification file to `notifyDir` (same pattern as the
   hook notification plan uses for other events). This is what allows the notification
   system to fire a "permission request" toast.
2. Check `FLIGHTPATH_USER_HOOKS_JSON` env var (see §6) for a `permissionRequest` entry.
3. If found: run the user hook command with the full `hookInput` JSON on stdin, capture
   stdout, print it to process stdout, exit 0.
4. If not found: exit 0 with no stdout — harness shows the dialog normally.

The notification file should follow the same normalized format described in
`HOOK_EVENT_NOTIFICATIONS_PLAN.md`, including `toolName` from `hookInput.tool_name`
since that is directly available in the payload and is useful notification context
("FlightPath — Permission Request: Bash").

### 4. `src/scripts/flightpath-codex-notify.js`

Identical change. Replace the early-exit with a three-way branch and add
`handlePermissionRequest` using the same logic.

### 5. `src/scripts/flightpath-opencode-plugin.ts`

**Prerequisite**: install `@opencode-ai/plugin` locally and read the `permission.asked`
event type signature to determine the response contract.

Once confirmed, add a `permission.asked` handler in the `event()` callback (or as a
top-level key, depending on how OpenCode routes it). The handler should:

1. Write the normalized notification file.
2. If a `permissionRequest` user hook is configured in the sidecar JSON:
   run the user command, capture stdout, return/respond with it in whatever form
   OpenCode expects.
3. Otherwise: return nothing / proceed normally.

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

### 8. Hook Notification Plan Integration

`HOOK_EVENT_NOTIFICATIONS_PLAN.md` should include `permissionRequest` in the
`notifications.hookEvents` settings model:

```ts
hookEvents: {
  stop: false,
  sessionStart: false,
  preToolUse: false,
  postToolUse: false,
  userPromptSubmit: false,
  permissionRequest: false,  // ← add
}
```

And in `NotificationsSection.tsx` hook-event table, add a row:

| Permission Request | checkbox | AI paused waiting for tool approval |

The notification body should include `toolName` when available, e.g.:
> `workflow.flightpath.yaml — step 2 "implement" — Bash`

This makes it actionable: the user sees "permission request for Bash" in the
notification, opens FlightPath, switches to the terminal view, and approves.

---

## What Does NOT Change

- `IToolPermissionMapper` and spawn-time CLI args — unchanged, still the primary
  enforcement mechanism for FlightPath's own permission settings.
- `cliAllowedTools`, `cliDeniedTools`, `cliToolPermissions` — unchanged.
- The fire-and-forget user hook execution for all other events — unchanged.
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
