# Workflow Completion Notifications Plan

## Problem

When a workflow runs in the background — headless mode, or even interactive mode while the
user has switched focus to another file — there is no signal when it finishes. The user has
to keep checking the dashboard or status bar. For workflows that take 5–30+ minutes this is
a significant friction point.

---

## Notification Surfaces

### 1. VS Code Toast Notification (`vscode.window.showInformationMessage`)

The most natural VS Code-native surface. Appears as a popup in the bottom-right corner of
the window. Supports action buttons ("Open Dashboard", "View Output").

**When to show:**
- Workflow completes successfully (all prompts done, final prompt done)
- Workflow fails (error state or end condition max retries exceeded)
- Workflow is stopped by timeout

**Not when:**
- User manually paused or cancelled — they took the action, no need to notify
- Workflow is still running (no mid-progress toasts)

### 2. Status Bar Pulse (already exists)

The status bar already shows state. On completion it could briefly show a "✓ Done" or
"✗ Failed" state before returning to idle. This is a passive signal, not a notification.
No new work needed for this — it may already work.

### 3. OS-Level Notification (future / optional)

VS Code's notification API only fires within the VS Code window. A true OS notification
(macOS Notification Center, Windows toast) would alert the user even if VS Code is not
the focused app. This requires the `vscode.env.openExternal` or a native module — out of
scope for the initial implementation.

---

## Settings

Add two new settings to `ConfigurationUtils` / `package.json`:

```json
"flightpath.notifications.onComplete": {
  "type": "string",
  "enum": ["always", "errorsOnly", "never"],
  "default": "always",
  "description": "Show a VS Code notification when a workflow finishes.",
  "enumDescriptions": [
    "Notify on both success and failure",
    "Notify only when a workflow fails or times out",
    "Never show completion notifications"
  ]
},
"flightpath.notifications.includeWorkflowName": {
  "type": "boolean",
  "default": true,
  "description": "Include the workflow file name in the completion notification."
}
```

---

## Notification Content

### Success

> **FlightPath — Workflow Complete**  
> `refactor.flightpath.yaml` — 4 prompts completed in 3m 42s  
> [Open Dashboard]

### Failure

> **FlightPath — Workflow Failed**  
> `refactor.flightpath.yaml` — failed at step 2 "implement" after 2 retries  
> [Open Dashboard] [View Output]

### Timeout

> **FlightPath — Workflow Timed Out**  
> `refactor.flightpath.yaml` — completed 2 of 4 prompts before timeout  
> [Open Dashboard]

The "Open Dashboard" action calls the existing `flightpath.openDashboard` command and
promotes the relevant workflow tab.

---

## Implementation

### Where to fire

Workflow completion is already detected in `WorkflowExecutor.ts` where status transitions
to `EXECUTION_STATES.COMPLETED`, `EXECUTION_STATES.ERROR`, or `EXECUTION_STATES.STOPPED`
(timeout). The `MESSAGE_TYPES.EXECUTION_COMPLETED` message is already broadcast via
`DashboardBroadcastHub`.

Add a `NotificationManager` (or thin helper) that:
1. Subscribes to `DashboardBroadcastHub` as a sink
2. Listens for `EXECUTION_COMPLETED` / `EXECUTION_STATE_CHANGED` messages
3. Reads the `notifications.onComplete` setting
4. Fires `vscode.window.showInformationMessage` with the appropriate message and actions

Keep it in `src/ui/` — it's a UI concern, not a core concern.

### Avoiding double-notification

If multiple workflows complete simultaneously (parallel execution), each gets its own
notification. The VS Code notification queue handles stacking gracefully.

### CLI mode

The CLI binary (`src/cli.ts`) already prints completion status to stdout/stderr. No
VS Code notification API is available in CLI mode. No changes needed there — the exit
code and `--json` output are the CLI's notification surface.

---

## What NOT to build

- Mid-workflow step-level notifications — too noisy
- OS-level notifications (out of scope for v1)
- Email / Slack / webhook notifications — belongs in a later "external integrations" plan
- Sound effects

---

## Effort

~half a day. The infrastructure (completion detection, broadcast hub) already exists.
The main work is the `NotificationManager` class, settings wiring, and the action button
handler.
