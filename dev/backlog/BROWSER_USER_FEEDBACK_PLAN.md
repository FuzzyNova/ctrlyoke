# Browser User Feedback Plan

**Status (2026-07-29):** Proposed. The React dashboard already has transient
toast state and receives structured workflow-completion notification events, but
there is no mounted toast renderer and ordinary `vscode.window.show*Message()`
calls never reach hosted browser clients.

**Related plans:**

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
- [`STANDALONE_SERVER_PLAN.md`](./STANDALONE_SERVER_PLAN.md)

## Decision

Browser toast support is the best next **user-visible** hosted-server slice. It
closes a real correctness gap in the already-shipped VS Code-hosted browser and
establishes the user-feedback seam the standalone server needs.

It is not the largest standalone-server blocker. Adapter-first
`WorkflowOrchestrator` construction, watcher abstraction, and shared-router
decoupling remain the critical path. The toast work should therefore establish a
small reusable feedback contract without expanding into a general-purpose
replacement for every VS Code UI API.

## Goals

- Show operational information, warning, error, and success messages in hosted
  browser/PWA clients.
- Preserve native VS Code notifications for the VS Code extension.
- Preserve console output and non-interactive fallbacks for `ctrlyoke run`.
- Give the future standalone server the same browser feedback path without a
  `vscode` import or the Node-side `vscode-shim`.
- Distinguish request-scoped feedback from process-wide/background feedback.
- Support queued, accessible messages instead of overwriting the current toast.
- Provide a safe path for the small set of notifications that currently ask the
  user to choose an action.

## Non-Goals

- Replacing browser push notifications or the Notifications settings.
- Turning arbitrary VS Code command IDs into browser-executable actions.
- Replacing file pickers, quick picks, input boxes, editor opening, or progress
  UI with toast messages.
- Showing every diagnostic log entry to the user.
- Adding multi-root requirements to the standalone server. A standalone server
  may expose one named root for its configured `cwd`.

## Current-State Audit

### Existing browser pieces

- `uiStore` has a single transient `toast` object and `showToast()` /
  `hideToast()` actions.
- Several React handlers call `showToast()` directly.
- `useMessageHandler` turns `MESSAGE_TYPES.NOTIFICATION_EVENT` into a toast
  state update.
- `CtrlYokeHostedServer` emits `NOTIFICATION_EVENT` for structured workflow and
  prompt completion events.
- `NotificationManager` independently displays those completion events through
  native VS Code notifications.
- No component reads `uiStore.toast`, so setting it currently has no visible
  effect.
- The single-object model loses an earlier message whenever two events arrive
  close together.

`NOTIFICATION_EVENT` is intentionally a completion-notification contract. Its
delivery is governed by notification settings and it may also invoke the
browser Notification API or push delivery. Operational feedback must use a
separate message type so an ordinary validation error is never filtered by
completion-notification preferences or sent as push.

### Native message inventory

The 2026-07-29 TypeScript AST audit found:

| API                        |   Count |
| -------------------------- | ------: |
| `showErrorMessage()`       |      66 |
| `showWarningMessage()`     |      25 |
| `showInformationMessage()` |      25 |
| **Total**                  | **116** |

Of those calls, 99 pass only a message and are candidates for fire-and-forget
feedback. Seventeen pass additional detail/actions or await a result and must be
reviewed as interactions, not mechanically converted to toast.

The calls split into two architectural groups:

| Disposition                                         | Calls | Files                                                                                                                                       |
| --------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep as native VS Code UI at the extension boundary |    53 | `extension.ts`, `DevCommands`, context-menu commands, `ScmCommitCommand`, `VsCodeAdapter`, `ExternalFileTrustPrompt`, `NotificationManager` |
| Remove from reusable/core/router services           |    63 | `WorkflowOrchestrator`, orchestration helpers, shared webview services, and `FileSystemUtils`                                               |

The exhaustive file-level dependency audit is in
[`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md).

### Existing request-scoped precedent

Some newer flows already return typed messages to the initiating client:

- `WORKFLOW_ACTION_FAILED`
- `WORKFLOW_SAVE_FAILED`
- `WORKSPACE_ACTION_FAILED`
- folder-open and developer-action result messages

These are the correct model for a browser-initiated operation. A failure caused
by one tab should not appear in every connected tab merely because the old
implementation used a process-global VS Code toast.

## Feedback Model

### Separate completion notifications from operational feedback

Keep `NOTIFICATION_EVENT` unchanged for workflow/prompt completion delivery.
Add a new protocol message for in-app operational feedback, using shared
constants and types:

```typescript
interface UserFeedbackMessage {
  type: typeof MESSAGE_TYPES.USER_FEEDBACK;
  id: string;
  severity: "info" | "success" | "warning" | "error";
  message: string;
  detail?: string;
  dedupeKey?: string;
}
```

Do not put callback functions, VS Code command IDs, filesystem objects, or raw
`Error` objects in the payload.

### Delivery scopes

Every feedback emission must choose one scope:

1. **Originating client** — validation and operation results caused by one
   webview/browser request. Emit through `WebviewClientContext.postMessage`.
2. **All browser clients** — background runtime events that every connected
   browser should know about. Broadcast through the hosted/standalone server's
   WebSocket feedback sink.
3. **Native extension** — show through the VS Code feedback sink.
4. **CLI/server console** — log when there is no graphical client.

The VS Code-hosted process composes both a native VS Code sink and a browser
WebSocket sink. The browser sink sends only to browser sockets, not back to the
VS Code panel, so the panel does not display both a native notification and an
in-app duplicate.

### Feedback port

Keep this concern separate from the small workspace-oriented
`PlatformAdapter`. Introduce a narrow contract such as:

```typescript
interface UserFeedbackSink {
  notify(message: UserFeedback): void;
}
```

Composition roots provide implementations:

- `VsCodeUserFeedbackSink`
- `ConsoleUserFeedbackSink`
- hosted/standalone WebSocket feedback sink
- a composite sink for background notifications in the hosted extension

Request handlers should prefer `ctx.emit(...)` for client-scoped results rather
than using the process-wide composite.

Do not preserve the ambiguous meaning of `PlatformAdapter.log()`: operational
user feedback and diagnostic logging are different channels.

## Toast UI

### Store

Replace the single `toast` value with a bounded queue:

```typescript
interface ToastItem {
  id: string;
  message: string;
  detail?: string;
  type: "info" | "success" | "warning" | "error";
  createdAt: number;
  dedupeKey?: string;
}
```

Keep `showToast()` as a convenience wrapper so existing React call sites do not
all need to change at once. Add explicit enqueue/dismiss/clear actions and cap
the queue to prevent an event storm from growing memory indefinitely.

Queue policy:

- Deduplicate by `dedupeKey` when provided.
- Show a small bounded number simultaneously; keep later messages queued.
- Auto-dismiss success/info messages.
- Give warning/error messages a longer timeout and an explicit close button.
- Pause dismissal while hovered or keyboard-focused.
- Clear transient toasts on the existing transient-state reset path.

Timing and queue limits belong in shared UI constants, not scattered component
literals.

### Component

Add one `ToastViewport`/`ToastRegion` mounted once at the application root in
both desktop and mobile layouts.

Requirements:

- Render through the shared React bundle in both hosts.
- Use semantic theme tokens and existing z-index tokens.
- Respect iOS safe areas and avoid covering the editor footer or mobile
  navigation.
- Use `role="status"` / polite live regions for information and success.
- Use `role="alert"` or an assertive live region for warning/error.
- Make close controls keyboard and screen-reader accessible.
- Keep message text selectable when it contains a useful path or diagnostic.
- Expand/collapse optional detail without rendering untrusted HTML.
- Honor reduced-motion preferences.

### Handler

`useMessageHandler` should:

- enqueue `USER_FEEDBACK` directly;
- translate `NOTIFICATION_EVENT` into the visual queue only in hosted/
  standalone browser mode while preserving its separate browser-notification
  delivery; the VS Code panel keeps native `NotificationManager` delivery and
  must not show an in-app duplicate;
- ignore malformed payloads;
- avoid persisting operational messages in webview/browser storage.

## Action-Bearing Messages

Seven action-bearing calls currently live in reusable code:

- template overwrite confirmation;
- post-import action;
- post-script-create action;
- retry harness automation;
- duplicate-running-workflow choice;
- post-workspace-initialization action;
- clear-all-workflows confirmation.

These must not be flattened into fire-and-forget toast. Implement them after the
basic toast slice through a correlated interaction request:

```typescript
interface UserInteractionRequest {
  type: typeof MESSAGE_TYPES.USER_INTERACTION_REQUEST;
  requestId: string;
  severity: "info" | "warning";
  message: string;
  detail?: string;
  choices: Array<{ id: string; label: string; primary?: boolean }>;
}
```

The browser responds with only `requestId` and the selected choice ID. The host
owns the meaning of that choice.

Safety and lifecycle requirements:

- never transmit an arbitrary command/callback for browser execution;
- target the initiating/controller client, not every tab;
- time out and resolve as dismissed when the client disconnects;
- do not queue interaction responses across WebSocket reconnects;
- use the existing shared modal primitives for choices that block an operation;
- define an explicit headless fallback for every interaction;
- reject duplicate or expired responses.

Domain-specific confirmations may keep their existing typed modal/result
messages when those are clearer than the generic interaction contract.

## Migration Plan

### Phase 1 — Make existing in-app toasts real

1. Add the queue model and `ToastViewport`.
2. Mount it once in `App.tsx`.
3. Preserve existing `showToast()` callers.
4. Add component/store accessibility and queue tests.
5. Verify existing `NOTIFICATION_EVENT` completion messages visibly render in
   the hosted browser while the VS Code panel continues using its native
   notification without an in-app duplicate.

This phase fixes the currently unrendered toast state but does not yet forward
ordinary native VS Code messages.

### Phase 2 — Add operational feedback transport

1. Add `MESSAGE_TYPES.USER_FEEDBACK` and its shared payload type.
2. Add the browser handler.
3. Add the feedback sink contract and VS Code/console/WebSocket
   implementations.
4. Add browser-only broadcasting to `CtrlYokeHostedServer`.
5. Migrate the 63 direct message calls in reusable code, starting with the
   one-argument error paths.
6. Prefer existing typed success/failure replies for browser-initiated actions.

### Phase 3 — Client-scoped routing

1. Thread `WebviewClientContext` or a scoped feedback callback into router
   delegates that currently show process-global messages.
2. Ensure browser-originated failures return only to their origin.
3. Keep true background events on the composite/broadcast feedback path.
4. Add two-tab tests proving one tab's validation error does not leak to the
   other.

### Phase 4 — Interactive choices

1. Inventory the seven reusable action-bearing messages and choose generic
   interaction requests versus existing domain modals.
2. Add correlation, timeout, dismissal, and disconnect handling.
3. Preserve native VS Code choices for panel/Command Palette flows.
4. Add explicit CLI/server-headless fallback tests.

### Phase 5 — Enforce the boundary

1. Add a lint/import-boundary rule that disallows `vscode.window.show*Message`
   in shared core/router/service paths.
2. Keep a narrow allowlist for VS Code composition and UI adapter files.
3. Add a source audit test so a new direct call cannot silently recreate the
   hosted-browser gap.

## Test Plan

### React

- queue ordering, deduplication, cap, dismissal, and transient reset;
- severity styling and live-region roles;
- timeout pause on hover/focus;
- reduced-motion behavior;
- `USER_FEEDBACK` and `NOTIFICATION_EVENT` both render;
- malformed messages are ignored;
- mobile viewport/safe-area placement;
- keyboard dismissal and detail expansion.

### Extension/server

- VS Code sink maps severities to the matching native API;
- console sink preserves severity without requiring `vscode`;
- hosted WebSocket sink reaches every browser connection but not the panel;
- scoped feedback reaches only the initiating socket;
- a disconnected socket cannot complete a pending interaction;
- duplicate/expired interaction responses are rejected;
- completion notifications remain governed by notification settings while
  operational feedback is not.

### Manual

- Trigger representative information, warning, and error paths from a browser
  tab while the VS Code sidebar is open.
- Confirm the VS Code user sees a native message and the browser user sees an
  in-app toast, without duplicates in either surface.
- Repeat with two browser tabs and verify request-scoped versus broadcast
  behavior.
- Verify phone/PWA placement with the keyboard open and with the workspace
  viewer modal active.

## Acceptance Criteria

- Existing `uiStore.showToast()` calls are visibly rendered.
- Hosted browser users see operational errors that were previously visible only
  through `vscode.window`.
- Completion events render once per surface: in-app in a browser, native in the
  VS Code extension.
- No operational feedback is incorrectly delivered as browser push.
- Browser request failures are scoped to the initiating client.
- Native VS Code notifications remain native.
- CLI behavior remains non-interactive unless an explicit interactive prompt
  implementation is selected.
- Reusable code no longer calls `vscode.window.showErrorMessage`,
  `showWarningMessage`, or `showInformationMessage` directly.
- Action-bearing messages retain real choice semantics and safe dismissal
  fallbacks.
