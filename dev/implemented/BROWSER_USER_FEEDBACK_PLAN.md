# Browser User Feedback Plan

**Status (2026-08-17):** Phases 1, 2 (including 2.5), 3, 4, 5, and 6 are
complete.
The React dashboard renders a bounded, accessible transient toast queue in both
hosts, operational feedback reaches connected browsers independently of
notification settings, and the reusable direct-message migration is complete.
Phase 3
(client-scoped routing) completed per
[`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md)
Stage E, re-verified against `src/` on 2026-08-11 — this doc's Acceptance
Criteria below previously said otherwise and is corrected in this pass. Phase 4
was **redesigned 2026-08-17**: none of the six action-bearing sites need the
generic `USER_INTERACTION_REQUEST` contract after all — each has a decided
per-site disposition (four cut, two relocated into existing/inline UI) — all
six Phase 4 items have landed in Stage F.4–F.7. **Phase 6 (new, 2026-08-17) is
complete**: its dispatcher, Group A's 15 client-only call sites, and Group B's
12 scoped-reply handlers now use host-aware dispatch. See "The webview's own
toast calls are not host-aware" and "Phase 6" below.

**Related plans:**

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
- [`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md)

**Implementation order:**
[`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md)
— Phases 2, 2.5 Site 3, 3, and 4 are Stages C, E, and F there; the Phase 5
guards are Stage A. The completed Phase 1 and Phase 2.5 Site 2 sequencing is
recorded in
[`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](./COMPATIBILITY_AND_FEEDBACK_STAGING.md).

**Not a dependency of the 0.1.0 permission work.**
[`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
and [`TOOL_PERMISSION_PARITY_PLAN.md`](./TOOL_PERMISSION_PARITY_PLAN.md) both
render through persistent field diagnostics and the existing shared
`Modal.tsx`, and both explicitly forbid routing compatibility feedback through
toast. This plan can land before or after them without changing their scope.

## Decision

Browser toast support is the best next **user-visible** hosted-server slice. It
closes a real correctness gap in the already-shipped VS Code-hosted browser and
establishes the user-feedback seam the standalone server needs.

It is not the largest standalone-server blocker — adapter-first
`WorkflowOrchestrator` construction, watcher abstraction, and shared-router
decoupling remain the critical path — but it is **not merely cosmetic and not
purely optional ordering**, for two reasons found during review:

1. Two `platform.showChoice()` sites in `EndConditionHandler` blocked workflow
   execution on a modal a remote browser user cannot see — one of them on every
   end-condition failure under default settings. Both are deleted rather than
   ported (Phase 2.5); both deletions are complete and were cheaper than the
   toast work.
2. Narrowing `PlatformAdapter` is a prerequisite for the standalone
   `StandaloneServerAdapter` to compile at all, so this work gates
   `STANDALONE_SERVER_PLAN.md` Phase 5 regardless of sequencing preference.

The toast work should still establish a small reusable feedback contract without
expanding into a general-purpose replacement for every VS Code UI API.

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
  state update (`useMessageHandler.ts` ~line 996), unconditionally, in every
  host.
- `CtrlYokeHostedServer` emits `NOTIFICATION_EVENT` for structured workflow and
  prompt completion events.
- `NotificationManager` independently displays those completion events through
  native VS Code notifications. Both it and the panel webview receive the same
  event from the same `DashboardBroadcastHub` fanout.
- No component reads `uiStore.toast`, so setting it currently has no visible
  effect.
- The single-object model loses an earlier message whenever two events arrive
  close together.
- `isStandalone` (`@hooks/useVsCodeApi`) already discriminates hosted-browser
  from VS Code panel on the client, and `WebviewClientContext.clientId` /
  `PANEL_CLIENT_ID` already discriminate them on the server. Both gates exist;
  neither needs to be invented.

### `PlatformAdapter` is already a user-feedback port

This is the most important fact the AST audit missed, because these call sites
do not import `vscode`.

`src/platform/PlatformAdapter.ts` already declares five user-facing methods —
`log()`, `warn()`, `error()`, `showProgress()`, and `showChoice()` — documented
as mapping to `vscode.window.showInformationMessage` /
`showWarningMessage` / `showErrorMessage` in `VsCodeAdapter` and to `console.*`
in `CliAdapter`.

Counts re-verified against `src/` on 2026-08-01:

| Adapter method                 | Call sites | Where                                                                                                              |
| ------------------------------ | ---------: | ------------------------------------------------------------------------------------------------------------------ |
| `log()` / `warn()` / `error()` |         18 | `WorkflowInstance` ×9, `WorkflowExecutor` ×3, `PromptFileParser` ×4, `CliIntegration` ×1, `EndConditionHandler` ×1 |
| `showChoice()`                 |          1 | `CliIntegration` ×1                                                                                                |

`showChoice()` dropped from three sites to one when both Phase 2.5 sites were
deleted. `PromptFileParser` has four adapter-UI calls, not three.

Consequences:

- The real hosted-browser feedback gap is **63 direct calls plus these 20
  adapter-mediated calls**, and the adapter-mediated ones sit in the hottest
  execution paths (`WorkflowInstance`, `WorkflowExecutor`).
- A file being `vscode`-import-free does **not** mean it is host-neutral.
  `EndConditionHandler`, `WorkflowInstance`, `WorkflowExecutor`, and
  `PromptFileParser` appear in no `vscode` audit table yet all show native
  VS Code UI through the injected adapter.
- `UserFeedbackSink` is therefore not a greenfield contract. It is the
  destination these five methods move to. Treat this work as **relocating an
  existing port**, and delete the methods from `PlatformAdapter` once their
  callers migrate — leaving them in place is what allows a "decoupled" core to
  keep opening native dialogs.

### Execution-blocking interactions are the worst parity failure

`EndConditionHandler` called `platform.showChoice()` at two points that **halt
workflow execution until a human answers**. Both are now gone:

- ~~end-condition script failure → `Stop Workflow` / `Skip Condition` /
  `Open Script`~~ — **deleted; verified absent 2026-08-01** (Phase 2.5 Site 1);
- end-condition validation failure after retries → `Stop Workflow` /
  `Continue Anyway` / `Retry Once More` — **deleted; verified absent
  2026-08-01** (Phase 2.5 Site 2).

In the VS Code-hosted server these render as native modals **on the host
machine only**. A browser or phone user driving a workflow remotely sees the run
stop making progress with no visible cause and no way to answer. Missing toast
is a cosmetic gap; this is a functional dead-end that makes remote operation
unreliable.

**Both are deleted, not ported — see Phase 2.5.** The first
(`handleExecutionError`) turned out to have no callers at all and is already
gone; the second overrides the `endCondition.onFail` / `maxRetries` policy the
workflow author already declared, and fires on _every_ end-condition failure
under default settings. Neither should exist, in any host. They remain the
strongest argument for auditing this area — just not for building an
interaction protocol.

Because both sites are deleted, **no execution-blocking adapter prompt remains
in `EndConditionHandler`**. The deletion did not depend on any of the toast
transport work.

The original AST scan could not see these at all — it looked only for
`vscode.window.show*Message`, so adapter-mediated prompts were invisible. They
are folded into the "Action-Bearing Messages" inventory below. Scheduling
implication: they cannot wait for Phase 4. See "Phase 2.5".

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

**This count is a floor, not a total.** It counts only direct
`vscode.window.show*Message` calls. It excludes the 20 adapter-mediated calls
above, so the full inventory to migrate is **136 sites (116 direct + 20 via
`PlatformAdapter`)**, of which **19 are interactions** (17 direct + 2
`showChoice`).

Re-run the AST audit before the Phase 2 triage rather than trusting these
totals. A 2026-08-02 re-measure found the reusable group at **64** across 13
files and the boundary group at exactly **49** across 6 after the
`VsCodeAdapter` calls moved to the feedback sink; the adapter-mediated
table below is exact. **The boundary group has since grown to 54 across 7
files** (re-read from `FEEDBACK_SOURCE_AUDIT_BASELINES` on 2026-08-17:
`extension.ts` 20, `DevCommands` 12, `ContextMenuReferenceCommands` 6,
`ScmCommitCommand` 5, `WebviewMessageRouter` 5, `ExternalFileTrustPrompt` 3,
`NotificationManager` 3, `VsCodeAdapter` 0). That growth is legitimate —
these are all boundary-approved sites — but any doc or step that cites 49 as
the live baseline is stale. An earlier 2026-08-01 text scan found per-file drift
against the original table
(`WorkflowCommandHandler` at 13, `showErrorMessage` at 67 /
`showInformationMessage` at 24), and a naive `grep` both over-counts the four
doc-comment mentions in `PlatformAdapter.ts` and under-counts the three
multi-line calls in `NotificationManager.ts`. The architectural split below is
what matters; the exact totals are not load-bearing.

The calls split into two architectural groups:

| Disposition                                         | Calls | Files                                                                                                                      |
| --------------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------- |
| Keep as native VS Code UI at the extension boundary |    49 | `extension.ts`, `DevCommands`, context-menu commands, `ScmCommitCommand`, `ExternalFileTrustPrompt`, `NotificationManager` |
| Remove from reusable/core/router services           |    63 | `WorkflowOrchestrator`, orchestration helpers, shared webview services, and `FileSystemUtils`                              |

The exhaustive file-level dependency audit is in
[`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](../backlog/VSCODE_DEPENDENCY_DECOUPLING_PLAN.md).

### Existing request-scoped precedent

Some newer flows already return typed messages to the initiating client:

- `WORKFLOW_ACTION_FAILED`
- `WORKFLOW_SAVE_FAILED`
- `WORKSPACE_ACTION_FAILED`
- folder-open and developer-action result messages

These are the correct model for a browser-initiated operation. A failure caused
by one tab should not appear in every connected tab merely because the old
implementation used a process-global VS Code toast.

### The webview's own toast calls are not host-aware

**Found 2026-08-17, while auditing a live mismatch report:** clicking "Enable
performance profiling" in `DeveloperSection.tsx` shows an **in-app** toast even
when running inside the VS Code panel, where it should show a **native**
`vscode.window.showInformationMessage`. Every AST/text audit in this plan so
far scanned for `vscode.window.show*Message` and `PlatformAdapter` calls — both
miss this category entirely, because these call sites never call a VS Code API
at all. They call `useUiStore.getState().showToast(...)` /
`enqueueToast(...)` directly, and that store method has no concept of host: it
always pushes onto the in-app `toastQueue`, whether the surface is a browser
tab or the VS Code panel's own webview.

This is the mismatch the user is describing, and it is a **different gap**
from everything else in this plan. `UserFeedbackSink` (Phase 2) correctly
branches by host — `VsCodeUserFeedbackSink` for the panel,
`HostedWebSocketUserFeedbackSink` for browsers — but only for **backend**-
initiated feedback. Nothing plays that role on the **webview** side, so every
webview-local call to `showToast()` renders the same way regardless of host.

Two call-site shapes both fall into this gap:

**Group A — client-only actions with no backend round trip at all.** These
never touch `WorkflowOrchestrator` or `UserFeedbackSink` and never can, so
Phase 2's migration was structurally unable to reach them. 15 sites, 8 files
(the per-file rows below sum to 15; earlier prose in this plan said 14):

| File                                       | Lines            | Example                                                            |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `components/settings/DeveloperSection.tsx` | 127-132, 195-198 | "Performance profiling enabled/disabled.", "Layout state cleared." |
| `components/dev/UxSnapshotButton.tsx`      | 76               | "UX snapshot capture failed"                                       |
| `components/editor/CodeMirrorEditor.tsx`   | 1018, 1097, 2741 | Paste/drop image and invalid-reference errors                      |
| `components/editor/PromptEditor.tsx`       | 646, 686, 693    | Prompt-file conversion busy/error toasts                           |
| `hooks/useWorkflowContextMenu.tsx`         | 95, 103          | Copy/duplicate context-menu result toasts                          |
| `hooks/useStepContextMenu.tsx`             | 174, 352         | Step context-menu result toasts                                    |
| `hooks/useRunViewLoadWatchdog.ts`          | 72               | Run-view load timeout fallback                                     |
| `utils/workflowMutation.ts`                | 49               | Stale-revision guard toast                                         |

Group A counts were re-verified against the current source on 2026-08-17:
15 sites across these 8 files, with no action-bearing exceptions left behind.

**Group B — scoped-reply message handlers that already do the right thing on
the backend, then render unconditionally on arrival.** These are the Stage E
"Convert-scoped-reply" sites from the Phase 2 triage table above:
`WORKFLOW_ACTION_FAILED`, `WORKFLOW_SAVE_FAILED`, and similar typed replies
already travel over `ctx.postMessage`/`ctx.emit` to only the requesting
client — that part of the architecture is correct and complete. But the
webview-side handler for each one calls `showToast()` unconditionally in
`useMessageHandler.ts`, so the correctly-scoped reply still renders as an
in-app toast inside the VS Code panel. 12 handlers in one file:

|       Line | Handler                                                                                             |
| ---------: | --------------------------------------------------------------------------------------------------- |
|        603 | `DEV_BUILD_COMPLETED`                                                                               |
|        662 | `DEV_COMMAND_UNAVAILABLE`                                                                           |
|   672, 679 | `UX_SNAPSHOT_SAVED`                                                                                 |
|       1529 | `WORKFLOW_VARIANT_CREATED` (already special-cases `standalone` for its action button — see Phase 6) |
|       1742 | `OPEN_HARNESS_DIR_RESULT`                                                                           |
|       1912 | `MCP_CONFIG_PREVIEW_RESULT`                                                                         |
|       2031 | `WORKFLOW_ACTION_FAILED`                                                                            |
| 2444, 2446 | `WORKFLOW_SAVED`                                                                                    |
|       2464 | `WORKFLOW_SAVE_FAILED`                                                                              |
|       2482 | `WORKFLOW_SAVED_AS_TEMPLATE`                                                                        |

**Two handlers in the same file already prove the fix is cheap and the pattern
is known** — they are explicitly excluded from Groups A/B because they are
already correct:

- `NOTIFICATION_EVENT` (line ~1149) hand-writes `if (standalone) { ... showToast(...) }`.
- `USER_FEEDBACK` (line ~1170) is safe by construction, not by a host check:
  `HostedWebSocketUserFeedbackSink` only ever broadcasts to browser sockets
  (`extension.ts` wires it to `hostedServer?.broadcastUserFeedback`), so the
  panel's `postMessage` channel never receives a `USER_FEEDBACK` message to
  begin with.

Neither of these should be touched by Phase 6 — they are the reference for
what "correct" looks like, not additional migration targets. What's missing is
a single client-side entry point the other 27 sites can call instead of
hand-rolling the `standalone` check (or, in 25 of the 26 cases, not writing it
at all).

## Feedback Model

### Separate completion notifications from operational feedback

Keep `NOTIFICATION_EVENT` unchanged for workflow/prompt completion delivery.
Add a new protocol message for in-app operational feedback, using shared
constants and types.

**Single-source the severity vocabulary first.** The repo already has two
`info | warning | error` constant objects — `STATUS_MESSAGE_SEVERITY` and
`COMPLETION_NOTIFICATION_SEVERITY` (both in `DashboardConstants.ts`) — plus an
inline, constant-free `"info" | "success" | "warning" | "error"` union declared
twice in `uiStore.ts`. Adding a third raw union would violate the project's
single-source rule. Instead, add one constant that the toast layer and the
feedback protocol both derive from:

```typescript
// src/types/DashboardConstants.ts — the only place these strings are written.
export const USER_FEEDBACK_SEVERITY = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type UserFeedbackSeverity =
  (typeof USER_FEEDBACK_SEVERITY)[keyof typeof USER_FEEDBACK_SEVERITY];
```

`StatusMessageSeverity` and `CompletionNotificationSeverity` are assignable
subsets; keep them as-is and widen only if a real caller needs `success`.

```typescript
interface UserFeedbackMessage {
  type: typeof MESSAGE_TYPES.USER_FEEDBACK;
  id: string;
  severity: UserFeedbackSeverity;
  message: string;
  detail?: string;
  dedupeKey?: string;
}
```

Use the field name `severity` everywhere, including inside `ToastItem`. The
store's current field is named `type`, which collides conceptually with the
message-envelope `type` and forces a rename at every boundary; fix it during the
queue rewrite rather than preserving the collision.

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
  severity: UserFeedbackSeverity;
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
- translate `NOTIFICATION_EVENT` into the visual queue **only when
  `isStandalone`**, while preserving its separate browser-notification delivery;
  the VS Code panel keeps native `NotificationManager` delivery and must not show
  an in-app duplicate;
- ignore malformed payloads;
- avoid persisting operational messages in webview/browser storage.

⚠️ **This is a required code change, not a verification step.** The current
handler calls `showToast(...)` unconditionally, and `NotificationManager`
already fires natively for the same event off the same
`DashboardBroadcastHub` fanout. Mounting `ToastViewport` without gating this
handler on `isStandalone` **regresses the VS Code panel into showing every
completion twice** — once natively, once in-app. Gate the handler in the same
change that mounts the viewport, and cover it with a test that asserts no toast
is enqueued when `isStandalone` is false.

## Action-Bearing Messages

**Resolved 2026-08-17 — none of the six need the interaction contract below.**
Each of the six was re-examined site by site (full discussion in "Phase 4").
Every one either gets cut outright or relocates into a modal/inline control
that already exists (`DeleteConfirmModal`) or is a small, self-contained
addition next to existing UI (`ScriptConditionEditor`, `HarnessDropdown`,
`TemplateModal`). Nothing needs a new cross-cutting correlation contract.

Original six (all direct `vscode.window.show*Message` calls with actions):

- template overwrite confirmation — **cut** (same flow as the next item).
- post-import action — **cut**.
- post-script-create action — **moved in-app**.
- retry harness automation — **moved inline**.
- post-workspace-initialization action — **cut**.
- clear-all-workflows confirmation — **replaced with `DeleteConfirmModal`**.

See "Phase 4" below for the per-site findings and decisions. (The two
end-condition-failure dialogs were already deleted rather than migrated in
Phase 2.5, and the duplicate-running-workflow choice was already deleted as a
policy conflict during Phase 2 triage — neither was ever part of this six.)

**Superseded design, kept only as a record of what turned out not to be
needed — do not build this:**

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

The idea was: the browser responds with only `requestId` and the selected
choice ID, the host owns the meaning of that choice, with timeout/dismissal/
disconnect handling and a headless fallback per interaction. If a future
seventh site ever needs a true cross-host blocking choice with no existing
modal to reuse, this design is the starting point — but none of the six
audited here turned out to need it.

## Migration Plan

### Phase 1 — Make existing in-app toasts real

**Done 2026-08-01.**

1. Add `USER_FEEDBACK_SEVERITY` to `DashboardConstants.ts`.
2. Add the queue model and `ToastViewport`.
3. Mount it once in `App.tsx`.
4. Preserve existing `showToast()` callers (rename their severity argument to
   the shared constant).
5. Gate the `NOTIFICATION_EVENT` → toast translation on `isStandalone` **in the
   same change**, so the VS Code panel does not start double-notifying.
6. Add component/store accessibility and queue tests, including the
   panel-no-duplicate assertion.

#### Decided: a toast is not a notification

**Resolved 2026-07-29.** These are two channels with two different governance
rules, and an earlier draft of this plan conflated them.

| Channel                                 | Carries                                                            | Governed by                                                                               |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **Toast** (`USER_FEEDBACK`)             | Operational results: save failed, validation error, action outcome | Nothing. Never suppressed — it is the visible result of something the user just did       |
| **Notification** (`NOTIFICATION_EVENT`) | Completion alerts: workflow done, prompt done                      | `notifications.*` in full, including `browser.mode: never` meaning **no delivery at all** |

The existing early return in
`CtrlYokeHostedServer.dispatchCompletionNotification()` when
`browser.mode === NEVER` is therefore **correct and stays**. A user who selects
"Browser notifications: Off" gets no completion alerts in the browser — no OS
notification and no in-app toast. Off means off.

The earlier draft argued that `browser.mode` governs only OS/push delivery and
that in-app rendering should bypass it. That was wrong:
`BROWSER_MODE_OPTIONS` in `NotificationsSection.tsx` already labels
`CONNECTED_ONLY` as **"While dashboard is open"** — that _is_ the in-app
foreground mode. The three modes are already off / in-app / in-app+push, so
`NEVER` is unambiguous and needs no split.

Consequences for this phase:

- Do not change the server-side gate; there is no blocking decision here.
- Render `USER_FEEDBACK` unconditionally; render `NOTIFICATION_EVENT` only when
  notification settings permit. The rule is identical in both hosts — only the
  sink differs (native in the panel, in-app in the browser).
- Exercise Phase 1's browser rendering with `browser.mode: connectedOnly`. A
  completion toast _not_ appearing under `never` is a passing test, not a bug.
- Operational feedback added in Phase 2 must never be routed through
  `dispatchCompletionNotification()` — it would inherit this gate, and a
  validation error would silently vanish for anyone who turned notifications
  off.

This phase fixes the currently unrendered toast state but does not yet forward
ordinary native VS Code messages.

### Phase 2 — Add operational feedback transport

**Triage before migrating. Porting all 135 sites is the wrong default** — a
meaningful fraction should be deleted, and every one deleted is a message
contract, a test, and a translation that never has to be written. Classify each
site first:

| Class                        | Test                                                                      | Action                                                       |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Delete — policy conflict** | Asks at runtime what config already declares                              | Remove; honor the declared policy                            |
| **Delete — duplicate**       | The same event already produces a `Log.*` **and** a typed `ctx.emit(...)` | Remove the popup; keep log + typed reply                     |
| **Delete — noise**           | Routine success the dashboard already reflects visually                   | Remove; the UI state _is_ the feedback                       |
| **Convert — scoped reply**   | Result of one client's request                                            | `ctx.emit(...)` typed failure/success, not a broadcast toast |
| **Port — broadcast**         | Background event with no initiating client, user must know                | `USER_FEEDBACK` through the sink                             |

Sampling ~22 of the 63 reusable sites shows all five classes are well populated,
and that "convert to scoped reply" is the largest — not "port to toast":

- `WorkflowStepHandlers` (5) — every site already calls `Log.error` and at least
  one already calls `ctx.emit`; the popup is a redundant third channel.
- `UndoRedoCoordinator` (5) — "Undo complete: restored 3 files" as a native
  popup is noise given the dashboard shows undo state; the failure paths want
  scoped replies.
- `PromptFileLoader` (5) — parse/validation failures on a file the user just
  opened. Genuine, must reach the browser.
- `WorkflowOrchestrator` (7) — mixed: "No workspace folder open" and session
  load failures are real; the duplicate-running-workflow modal is a policy
  conflict like the end-condition dialogs.

Complete the classification as the first task of this phase and record the
per-site disposition. Expect the `vscode` and adapter-UI baselines from Stage 0
to fall partly through deletion rather than migration; the completed table
below records exactly where.

#### Phase 2 triage — complete 2026-08-02 (staging step C.4)

The AST collector in `src/test/unit/SourceAuditCounters.test.ts`, adapted to
print arguments and source locations, found the expected 63 calls. The table
below is grouped by the file split used by staging steps C.5 and C.6. A
`Port-broadcast` row marked **interaction hold** remains an action-bearing
message reserved for Phase 4 — it must not be flattened into a fire-and-forget
toast. (At the time this table was executed, Phase 4 meant
`USER_INTERACTION_REQUEST`; Phase 4 was redesigned 2026-08-17 and no longer
uses that contract — see "Phase 4" for each site's actual disposition. The
"interaction hold" marker below still correctly means "do not touch this as
part of Phase 2," which is all it needs to mean here.)

The current source contains `WORKFLOW_ACTION_FAILED` and
`WORKFLOW_SAVE_FAILED`. It does **not** contain `WORKSPACE_ACTION_FAILED`,
despite that name appearing in the earlier plan text. The scoped rows below
name `WORKFLOW_ACTION_FAILED` where that existing generic addressed failure is
the fit; C.5/C.6 must either reconcile the workspace name with the existing
contract or add it deliberately. This triage does not add a message type.

| File                             |  Sites | Delete-policy-conflict | Delete-duplicate | Delete-noise | Convert-scoped-reply | Port-broadcast |
| -------------------------------- | -----: | ---------------------: | ---------------: | -----------: | -------------------: | -------------: |
| `WorkflowCommandHandler.ts`      |     13 |                      0 |                0 |            2 |                    9 |              2 |
| `TemplateImporter.ts`            |      7 |                      0 |                0 |            0 |                    5 |              2 |
| `WorkflowOrchestrator.ts`        |      7 |                      1 |                0 |            0 |                    4 |              2 |
| `PromptFileLoader.ts`            |      5 |                      0 |                0 |            0 |                    5 |              0 |
| `McpManagerService.ts`           |      8 |                      0 |                0 |            2 |                    6 |              0 |
| `WorkflowSerializer.ts`          |      8 |                      0 |                1 |            2 |                    4 |              1 |
| `UndoRedoCoordinator.ts`         |      5 |                      0 |                0 |            2 |                    3 |              0 |
| `WorkflowStepHandlers.ts`        |      5 |                      0 |                5 |            0 |                    0 |              0 |
| `TerminalMessageHandlers.ts`     |      2 |                      0 |                0 |            0 |                    2 |              0 |
| `PromptEditorSupportService.ts`  |      1 |                      0 |                0 |            0 |                    1 |              0 |
| `WorkflowMutationCoordinator.ts` |      1 |                      0 |                1 |            0 |                    0 |              0 |
| `FileSystemUtils.ts`             |      1 |                      0 |                0 |            0 |                    0 |              1 |
| **Total**                        | **63** |                  **1** |            **7** |        **8** |               **39** |          **8** |

The expected C.5/C.6 execution counts are therefore **32 sites in four
files** and **31 sites in eight files**, unchanged from the staging split. The
class totals are 1 policy deletion, 7 duplicate deletions, 8 noise deletions,
39 scoped replies, and 8 broadcast/interaction-held sites.

**C.5 execution complete 2026-08-02.** All 32 rows in the four core files are
marked below. The 23 recorded scoped-reply rows use `UserFeedbackSink` as a
broadcast fallback because these helpers do not receive `WebviewClientContext`;
Stage E must thread the initiating client through them before treating those
rows as truly scoped. The six port rows were split as recorded: initialization
failure uses `USER_FEEDBACK`, while the five interaction holds retain their
choices for Phase 4.

**C.6 execution complete 2026-08-02.** All 31 rows in the eight UI/utils
files are executed. Scoped UI failures use the initiating client's typed reply
path; the unscoped terminal-restart and auto-save infrastructure paths use the
composite `UserFeedbackSink` broadcast fallback. The AST counter is now 49
boundary / 6 reusable direct `show*Message` calls. The six survivors are the
intentional Phase 4 sites: template overwrite, post-import actions, end
condition script actions, harness detection retry, workspace initialization's
Reveal Folder action, and clear-history confirmation. They survived Phase 2
because they are interactions, not fire-and-forget feedback — see "Phase 4"
for each site's actual disposition (redesigned 2026-08-17; four are cut, two
relocate into existing/inline UI, none use `USER_INTERACTION_REQUEST`).

##### `src/core/orchestration/WorkflowCommandHandler.ts` — 13

| Line | Message                                                                                       | Disposition                                     | Justification                                                                                                                        | Status                                                |
| ---: | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
|   54 | `ctrlyoke: No workspace folder found`                                                         | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The create-prompt command has one initiating command client; return the failure to that client/panel rather than broadcast a toast.  | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  129 | `ctrlyoke: Created ${fileName}`                                                               | Delete-noise                                    | The newly created file is opened immediately; the editor state is the durable visual result.                                         | **DONE C.5**                                          |
|  132 | `ctrlyoke: Failed to create prompt file: ${error}`                                            | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | This is the failure result of the create-prompt request; retain `Log.error` and address the typed reply.                             | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  147 | `ctrlyoke: No workspace folder found`                                                         | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The draft-prompt command has one initiating client and needs an addressed failure.                                                   | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  193 | `ctrlyoke: Failed to create draft prompt: ${error}`                                           | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Return the failed draft creation to its requester; do not make it a global operational event.                                        | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  249 | `✅ Created end condition script: ${path.basename(scriptPath)}` + actions                     | Port-broadcast                                  | **Interaction hold:** preserve the Open Script/Show in Explorer choices for Phase 4; never replace this awaited result with a toast. | **DONE C.5** — retained for Phase 4                   |
|  265 | `❌ Failed to create end condition script. Check that you have a workspace folder open.`      | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The command failed before producing a script, so its requester needs a typed error.                                                  | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  271 | `❌ Failed to create end condition script: ${error}`                                          | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Return the script-creation exception to the initiating command client.                                                               | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  294 | `ctrlyoke: HarnessId automation is unavailable. Would you like to retry detection?` + actions | Port-broadcast                                  | **Interaction hold:** retain Retry Detection/Continue Anyway for Phase 4; the choice has execution meaning.                          | **DONE C.5** — retained for Phase 4                   |
|  322 | `ctrlyoke: No prompt file loaded. Use 'Select' button to choose a file first.`                | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | This is a rejected open-current-file request, not background status.                                                                 | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  333 | `ctrlyoke: Failed to open file: ${error}`                                                     | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Address the failed file-open operation to its requester.                                                                             | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  391 | `✅ Created custom template: ${path.basename(templatePath)}`                                  | Delete-noise                                    | The template is opened in the editor immediately; that visible state is the success acknowledgement.                                 | **DONE C.5**                                          |
|  396 | `Failed to create template: ${errorMsg}`                                                      | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Return the custom-template creation failure to the one command client.                                                               | **DONE C.5** — sink fallback; Stage E scope follow-up |

##### `src/core/orchestration/TemplateImporter.ts` — 7

| Line | Message                                                                            | Disposition                                     | Justification                                                                              | Status                                                |
| ---: | ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
|   52 | `ctrlyoke: No workspace folder open`                                               | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Import was requested by one command client; report the missing workspace to that client.   | **DONE C.5** — sink fallback; Stage E scope follow-up |
|   64 | `ctrlyoke: No workflow templates available to import`                              | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | This is the result of the import request, not a reusable background notification.          | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  128 | `❌ Failed to import workflow templates: ${error}`                                 | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Return the import operation's failure to its requester while retaining the diagnostic log. | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  155 | `❌ Failed to load ctrlyoke ${type}. The extension may not be properly installed.` | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Manifest loading failed as part of one import request; use its addressed failure path.     | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  187 | `"${item.label}" already exists. Overwrite?` + actions                             | Port-broadcast                                  | **Interaction hold:** preserve the overwrite decision for Phase 4; it is not feedback.     | **DONE C.5** — retained for Phase 4                   |
|  230 | `✅ Imported ${imported.length} item(s): ${imported.join(", ")}` + actions         | Port-broadcast                                  | **Interaction hold:** preserve Open Folder/View File semantics for Phase 4.                | **DONE C.5** — retained for Phase 4                   |
|  251 | `❌ Failed to import: ${failed.join(", ")}`                                        | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Partial import failure is the addressed result of the import command.                      | **DONE C.5** — sink fallback; Stage E scope follow-up |

##### `src/core/WorkflowOrchestrator.ts` — 7

| Line | Message                                                                                                                                                     | Disposition                                     | Justification                                                                                                                                                                              | Status                                                |
| ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
|  520 | `This workflow is already running and ${existingStatus}. Switch to it or create a new instance?` + actions                                                  | Delete-policy-conflict                          | The workflow's running-instance policy already determines the safe behavior; the modal lets a runtime answer override that policy. Explicitly remove this from Stage F's action inventory. | **DONE C.5** — reuse existing running instance        |
| 1180 | `ctrlyoke: Initialization failed: ${error}`                                                                                                                 | Port-broadcast                                  | Initialization is a startup/background event with no initiating webview request; every connected dashboard must see the failure.                                                           | **DONE C.5** — `USER_FEEDBACK` sink                   |
| 1259 | `ctrlyoke: Workspace initialized! A ${PATH_CONSTANTS.CTRLYOKE_DIR}/ directory has been created with your workflows, prompts, and scripts folders.` + action | Port-broadcast                                  | **Interaction hold:** workspace initialization is a shared lifecycle event; retain Reveal Folder for Phase 4.                                                                              | **DONE C.5** — retained for Phase 4                   |
| 4408 | `No workspace folder open`                                                                                                                                  | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Resume was requested by one command client; return the rejected operation to that client/panel.                                                                                            | **DONE C.5** — sink fallback; Stage E scope follow-up |
| 4418 | `No previous sessions found. Run a workflow first to create a session.`                                                                                     | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | This is the addressed result of the resume request, not a background broadcast.                                                                                                            | **DONE C.5** — sink fallback; Stage E scope follow-up |
| 4442 | `Failed to load session: ${getErrorMessage(loadError)}`                                                                                                     | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The selected session load failed for the requester and should be scoped to it.                                                                                                             | **DONE C.5** — sink fallback; Stage E scope follow-up |
| 4449 | `Failed to resume session: ${getErrorMessage(error)}`                                                                                                       | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The resume operation's outer failure has one initiating client.                                                                                                                            | **DONE C.5** — sink fallback; Stage E scope follow-up |

##### `src/core/orchestration/PromptFileLoader.ts` — 5

| Line | Message                                         | Disposition                                     | Justification                                                                                                            | Status                                                |
| ---: | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
|   69 | `ctrlyoke: Failed to parse prompt file`         | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | A browser/client-initiated file load must deliver its parse failure to that client; this is genuine feedback, not noise. | **DONE C.5** — sink fallback; Stage E scope follow-up |
|   81 | `ctrlyoke: Failed to load file: ${error}`       | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Return the source-file load exception to the client that requested the load.                                             | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  110 | `ctrlyoke: Failed to create workflow: ${error}` | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Template creation is a client request; the browser must receive the failure rather than only the host popup.             | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  129 | `ctrlyoke: Failed to parse prompt file`         | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The shared in-memory/file path validation failure still belongs to the initiating load request.                          | **DONE C.5** — sink fallback; Stage E scope follow-up |
|  142 | `ctrlyoke: Validation failed:\n${errors}`       | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Validation diagnostics are genuine and must reach the browser that loaded the workflow.                                  | **DONE C.5** — sink fallback; Stage E scope follow-up |

##### `src/ui/McpManagerService.ts` — 8

| Line | Message                                                                                                      | Disposition                                     | Justification                                                                                                                |
| ---: | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
|   67 | `Failed to load MCP registry servers: ${getErrorMessage(error)}`                                             | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The service already receives `ctx`; return the registry request failure only to its caller.                                  |
|   85 | `Failed to save MCP registry server: ${getErrorMessage(error)}`                                              | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Save is a single-client mutation; retain the log and send an addressed typed failure.                                        |
|   99 | `Failed to delete MCP registry server: ${getErrorMessage(error)}`                                            | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Delete is a single-client mutation and must not become a broadcast toast.                                                    |
|  135 | `No stdio MCP servers were exported to ${result.filePath}.`                                                  | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The export request completed with no applicable entries; tell the requesting manager view through its typed result path.     |
|  140 | `Exported ${result.exportedCount} MCP server${result.exportedCount === 1 ? "" : "s"} to ${result.filePath}.` | Delete-noise                                    | The subsequent `MCP_LOCAL_SCAN_RESULT` refreshes the dashboard's authoritative state; the success toast adds no information. |
|  147 | `Failed to export MCP servers: ${getErrorMessage(error)}`                                                    | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Export failure is scoped to the manager request and must remain visible in the browser.                                      |
|  162 | `Removed ... from ${result.filePath}.` / `No matching MCP servers were found in ${result.filePath}.`         | Delete-noise                                    | The subsequent local scan is the visual state/result for the manager; do not duplicate it with a success/info popup.         |
|  171 | `Failed to delete MCP servers from harness config: ${getErrorMessage(error)}`                                | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Harness-config deletion is a single-client operation; use the existing addressed failure precedent.                          |

##### `src/ui/WorkflowSerializer.ts` — 8

| Line | Message                                                        | Disposition                                     | Justification                                                                                                                              |
| ---: | -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
|  648 | `Output exported to ${uri.fsPath}`                             | Delete-noise                                    | The file-save operation itself and the browser's direct-download fallback are the success result; no dashboard state needs a second toast. |
|  657 | `Failed to export output: ${msg}`                              | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Export failure is the result of one client's request; return it through the addressed reply path.                                          |
|  690 | `Failed to load templates: ${errorMsg}`                        | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | New-workflow template loading is a client request and already has a supplied `postMessage` channel.                                        |
|  765 | `Failed to create workflow: ${errorMsg}`                       | Delete-duplicate                                | The same catch already sends typed `WORKFLOW_CREATED` with `error` after logging; the native popup is a third channel.                     |
| 1135 | `Failed to load workflow: ${getErrorMessage(error)}`           | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The fallback load path has one requester; the primary route already uses the addressed orchestrator path.                                  |
| 1161 | `Delete all workflows and their run history?` + action         | Port-broadcast                                  | **Interaction hold:** preserve the destructive confirmation for Phase 4; it cannot be a toast.                                             |
| 1190 | `Deleted ${workflowKeys.length} workflow lineage(s)`           | Delete-noise                                    | `RECENT_WORKFLOWS` is emitted with the empty authoritative list immediately afterward.                                                     |
| 1201 | `Failed to delete workflow history: ${getErrorMessage(error)}` | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | The clear-history request has a supplied post-message path; return the failure to its initiator.                                           |

##### `src/ui/UndoRedoCoordinator.ts` — 5

| Line | Message                                                                                                  | Disposition                                 | Justification                                                                                                         |
| ---: | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
|  213 | `Undo complete: restored ${result.restoredFiles.length} file(s).`                                        | Delete-noise                                | `UNDO_PROMPT_RESULT` and the updated undo record already make the restored state visible.                             |
|  217 | `Undo partially complete: ${result.restoredFiles.length} restored, ${result.failedFiles.length} failed.` | Convert-scoped-reply — `UNDO_PROMPT_RESULT` | The existing request-correlated typed result already carries both restored and failed files to the initiating client. |
|  221 | `Undo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`                                        | Convert-scoped-reply — `UNDO_PROMPT_RESULT` | Preserve the existing typed result as the scoped failure channel; the popup duplicates it.                            |
|  231 | `Redo complete: re-applied ${result.restoredFiles.length} file change(s).`                               | Delete-noise                                | The updated undo record/dashboard state is the success feedback.                                                      |
|  235 | `Redo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`                                        | Convert-scoped-reply — `UNDO_PROMPT_RESULT` | The existing typed result is already addressed by the request ID and carries the failure.                             |

##### `src/ui/WorkflowStepHandlers.ts` — 5

| Line | Message                                                     | Disposition      | Justification                                                                                                   |
| ---: | ----------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
|   60 | `Failed to execute prompt: ${getErrorMessage(error)}`       | Delete-duplicate | The catch already logs and emits typed `EXECUTE_PROMPT_ERROR`; the popup is a redundant third channel.          |
|  129 | `Failed to update prompt: ${getErrorMessage(error)}`        | Delete-duplicate | The mutation path already logs and the router/mutation contract emits the addressed failure/revision response.  |
|  160 | `Failed to insert workflow step: ${getErrorMessage(error)}` | Delete-duplicate | The mutation path already logs and reports the rejected addressed operation through the typed mutation channel. |
|  191 | `Failed to update finalStep: ${getErrorMessage(error)}`     | Delete-duplicate | The typed mutation response and log already cover this failure; no native third channel is needed.              |
|  223 | `Failed to delete prompt: ${getErrorMessage(error)}`        | Delete-duplicate | The addressed mutation failure is already represented by the log and typed router response.                     |

##### `src/ui/TerminalMessageHandlers.ts` — 2

| Line | Message                                              | Disposition                                     | Justification                                                                                                                      |
| ---: | ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
|  141 | `${errorMessage}` (failed to spawn embedded shell)   | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Spawn has the initiating `ctx`; return the failure to that controller instead of broadcasting a host-only warning.                 |
|  171 | `${errorMessage}` (failed to restart embedded shell) | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | Restart is one client's action; thread its context through the currently unscoped handler and use the addressed failure precedent. |

##### `src/ui/PromptEditorSupportService.ts` — 1

| Line | Message                           | Disposition                                     | Justification                                                                                                                    |
| ---: | --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|  719 | `Failed to open: ${relativePath}` | Convert-scoped-reply — `WORKFLOW_ACTION_FAILED` | `OPEN_FILE` originates in a webview request; pass its context into this currently unscoped helper and reply only to that client. |

##### `src/ui/WorkflowMutationCoordinator.ts` — 1

| Line | Message                                          | Disposition      | Justification                                                                                                                    |
| ---: | ------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|  189 | `Failed to ${action}: ${getErrorMessage(error)}` | Delete-duplicate | `reportActionFailure(ctx, ...)` immediately emits `WORKFLOW_ACTION_FAILED`; the native popup duplicates the log and typed reply. |

##### `src/utils/FileSystemUtils.ts` — 1

| Line | Message                                                                | Disposition    | Justification                                                                                                                                      |
| ---: | ---------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
|   33 | `ctrlyoke: Could not auto-save file. Running with last saved version.` | Port-broadcast | Auto-save can run as infrastructure work without a requesting client; the stale-version warning is a genuine background event that users must see. |

**Triage totals:** Delete-policy-conflict **1**, Delete-duplicate **7**,
Delete-noise **8**, Convert-scoped-reply **39**, and Port-broadcast **8**.
The duplicate-running-workflow modal at `WorkflowOrchestrator.ts:520` is
explicitly deleted from the Stage F inventory, so Stage F has **six** surviving
action-bearing sites: the two `WorkflowCommandHandler` actions, the two
`TemplateImporter` actions, workspace initialization's Reveal Folder action,
and clear-history confirmation.

**Execute the triage file by file, not class by class.** The disposition classes
cut across files — `WorkflowCommandHandler` alone has 13 sites that will land in
several classes — so migrating "all the deletions", then "all the broadcasts",
edits most of the 12 files twice from two sessions each holding half the plan.
Grouping by file finishes each one once and keeps the diff reviewable.

**Lower the Stage 0 baselines in the same commit.** `assertShrinkOnly` in
`src/test/unit/SourceAuditCounters.test.ts` fails when a count drops below its
committed baseline just as loudly as when it grows, so a correct migration that
leaves `FEEDBACK_SOURCE_AUDIT_BASELINES` untouched breaks `npm test`.

1. Add `MESSAGE_TYPES.USER_FEEDBACK` and its shared payload type.
2. Add the browser handler.
3. Add the feedback sink contract and VS Code/console/WebSocket
   implementations.
4. Add browser-only broadcasting to `CtrlYokeHostedServer`.
5. Migrate the surviving direct message calls in reusable code, starting with
   the one-argument error paths.
6. **DONE 2026-08-02 (staging step C.3).** Migrate the 18 `platform.log()` /
   `warn()` / `error()` calls in `WorkflowInstance`, `WorkflowExecutor`,
   `PromptFileParser`, `CliIntegration`, and `EndConditionHandler` to the
   feedback sink, migrate the final `showChoice()` site, then delete all five
   UI methods from `PlatformAdapter`. Deleting them is what prevents the native
   path from being silently reintroduced.
7. Prefer existing typed success/failure replies for browser-initiated actions.

### Phase 2.5 — Delete the end-condition dialogs (do not port them)

**Resolved 2026-07-29: both `EndConditionHandler` dialogs are deleted, not
migrated.** They ask the user at runtime a question the workflow author has
already answered declaratively in `schemas/workflow-schema.json`.

#### Site 1 — `handleExecutionError` — DONE

**Implemented 2026-07-29; absence re-verified 2026-08-01: method deleted**,
along with its now-unreachable
`looksLikeFilePath` helper, the unused `openFile` constructor parameter, the
`SKIP_CONDITION`/`OPEN_SCRIPT` dialog actions, and the `SCRIPT_EXTENSIONS`
export it was the last external consumer of.

**Dead code. Delete the whole method.** A repo-wide search finds no caller.
`handleEndConditionResult` returns early for evaluator errors at line 130 with
an explicit comment — _"Evaluation errors are internal failures, not condition
outcomes. The executor owns their policy because retry must re-enter the whole
step."_ — so internal errors already route to `errorBehavior.onError`
(`stop | retry | continue`) in the executor. This method, its `showChoice`, and
its `Open Script` / `looksLikeFilePath` / `openTextFile` support code are
unreachable.

#### Site 2 — `handleMaxRetriesExhausted` — DONE

**Implemented 2026-08-01; method and `showChoice` call deleted.** The live
exhaustion path now honors the resolved `endCondition.onFail` / `maxRetries`
policy and reports expected, actual, and script output through the existing
dashboard status/output path.

**The surrounding code has been refactored since this plan was written.**
`handleValidationFailureIterative` (line 290) is now a thin
backward-compatible wrapper that delegates to `handleEndConditionIterative`,
which serves both the pass-retry and failure-retry paths. The exhaustion
branch, the `manualRetryRequested` flag it sets, and the retry loop all live in
that private method now — plan the deletion against it, not against the public
wrapper.

Every one of those choices is already declarable, and the modal **overrides the
author's declaration**:

| Modal choice    | Already expressed by                                |
| --------------- | --------------------------------------------------- |
| Stop Workflow   | `endCondition.onFail: "stopWorkflow"` (the default) |
| Continue Anyway | `endCondition.onFail: "continue"`                   |
| Retry Once More | `endCondition.maxRetries`                           |

Note the reach: `canRetry` is false when retries are exhausted **or when no
retry is configured**, and `maxRetries` defaults to `0` while `onFail` defaults
to `stopWorkflow`. So in the default configuration **every end-condition failure
raises a blocking modal** that offers to contradict the default policy. This is
not an edge case.

The `retryOnceMore` branch and `manualRetryRequested` local were removed with
the modal. Retry bookkeeping now uses one incrementing path for both retry
directions.

If the "nudge a stuck run" affordance is still wanted, it belongs in the
dashboard as a **non-blocking action on an already-stopped workflow**, not as a
modal that halts the run and is invisible to remote clients. Track that
separately; it is not required to close this gap.

#### Site 3 — `CliIntegration.ts:1381`

A "don't show again" harness warning. Not execution-blocking and not
policy-contradicting. Migrate normally as feedback plus a persisted
suppression flag.

**DONE 2026-08-02 (staging step C.3).** The suppression flag already exists — `warnIfHeadlessWithoutPermissions()`
gates on `ConfigurationUtils.shouldShowHeadlessPermissionWarning()` and the
dialog's only effect is `setShowHeadlessPermissionWarning(false)`. So this is a
feedback emission, not new persistence, and the setting stays reachable through
the settings UI once the inline action is gone.

**Migrate it in the same step that deletes `showChoice` from `PlatformAdapter`**
(staging step 12), not later. It is that method's only surviving caller, so the
deletion and this migration are one change, and splitting them leaves an
uncompilable intermediate state.

#### Why this is the better outcome

The earlier draft of this phase proposed bounded waits and routing the choice to
the controller client. That was the right treatment for a prompt that needs to
exist — but these two do not. Deleting them removes the remote-blocking failure
mode, the headless ambiguity, and two interaction contracts, and it makes
declared workflow policy authoritative. Verified fall-through (both sites
already default to "stop workflow" on `undefined`) means deletion preserves the
current effective behavior for every workflow that does not click a button.

### Phase 3 — Client-scoped routing

> **Same work as `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 5 item 1** — both
> describe threading scope into `WorkflowMutationCoordinator`,
> `WorkflowStepHandlers`, `UndoRedoCoordinator`, and the terminal handlers.
> Execute once, as canonical Stage 6.

1. Thread `WebviewClientContext` or a scoped feedback callback into router
   delegates that currently show process-global messages.
2. Ensure browser-originated failures return only to their origin.
3. Keep true background events on the composite/broadcast feedback path.
4. Add two-tab tests proving one tab's validation error does not leak to the
   other.

### Phase 4 — Interactive choices → resolved as six per-site dispositions

**Resolved 2026-08-17; items 1–6 implemented in Stage F.4–F.7.** Re-examined each of the six action-bearing sites
individually against the actual code, instead of building a shared
correlation contract for all of them. None of the six need
`USER_INTERACTION_REQUEST` — each has a decided disposition below. Items 1,
3, 4, 5, and 6 are implemented; item 2 is implemented in Stage F.7.

1. **End-condition script created** (formerly
   `WorkflowCommandHandler.ts:99`, command
   `ctrlyoke.createEndConditionScript`). Before F.6 this used two chained
   native-only calls: `showQuickPick` (script type) then
   `showInformationMessage` (Open Script / Show in Explorer). The generator
   underneath, `EndConditionEvaluator.createSampleScript(type)`, copies a
   real starter file from `src/templates/check_condition.*` into
   `.ctrlyoke/scripts/` — genuine boilerplate generation (the exit-code/
   stdout contract baked in), not just a doc link.
   **Decision: move in-app — DONE F.6.** `ScriptConditionEditor.tsx` now
   owns the inline type picker and a scoped webview request that calls the
   existing `createSampleScript()`. The
   `ctrlyoke.createEndConditionScript` VS Code command and its `package.json`
   entries are deleted; native Open Script / Show in Explorer actions are not
   reproduced.

2. **Harness detection failed** (`WorkflowCommandHandler.ts:148`, inside
   `openPanel()`). Fires only when "Open ctrlyoke Panel" runs from the
   Command Palette while harness status is `unavailable` — a narrow,
   VS-Code-only trigger that duplicates status `HarnessDropdown` already
   shows via its status dot and tooltip. `WorkflowOrchestrator.
retryHarnessDetection()` already exists but today is reachable only from
   this native prompt's "Retry Detection" button — no webview message calls
   it.
   **Decision: cut the gate, move retry inline — DONE F.7.** Delete the
   `showWarningMessage` call from `openPanel()` — it opens unconditionally
   now. Add an inline "unavailable — Retry" affordance next to
   `HarnessDropdown`'s status indicator, wired to a new webview message that
   calls the existing `retryHarnessDetection()`.

3. **Template overwrite** (`TemplateImporter.ts:200`) and
4. **Template import succeeded** (`TemplateImporter.ts:243`) are **the same
   method** — one is the per-item prompt inside the import loop, the other
   is the final summary of that same `importWorkflowTemplates()` call, so
   they share one disposition. Checked whether `TemplateModal`'s
   "New template..." flow needs its own overwrite handling: it doesn't —
   `TemplateManager.createCustomTemplate()` already rejects a name collision
   with `Error("Template already exists: X")`, which `TemplateModal.tsx`
   already surfaces as an inline field error under the name input (no
   dialog, and no silent overwrite either). There is a second, now-redundant
   native-only path to that same backend call:
   `WorkflowCommandHandler.createNewTemplate()`
   (`ctrlyoke.createNewTemplate`, QuickPick + InputBox).
   **Decision: cut both sites and the redundant command.** Delete
   `TemplateImporter.ts`, the `ctrlyoke.importWorkflowTemplates` command, and
   its `package.json` entry — this removes items 3 and 4 together, since
   they're one flow. Repoint `ctrlyoke.createNewTemplate` to focus the
   dashboard and open `TemplateModal` with "New template..." pre-expanded
   instead of running its own QuickPick/InputBox sequence. **DONE F.5.**

5. **Post-workspace-initialization action** — actually **two**
   near-duplicate native toasts, not one: `extension.ts` fires one at
   activation (idempotent re-scaffold of an already-initialized workspace)
   and `WorkflowOrchestrator.handleInitializeWorkspace()` fires another
   immediately after the user already clicked "Initialize" inside
   `StartupOverlay.tsx` — the dashboard's own not-yet-initialized gate.
   **Decision: cut both.** No replacement needed; the dashboard rendering
   normally (`StartupOverlay` clearing) is itself the confirmation. **DONE F.4.**

6. **Clear all workflow history** (`WorkflowSerializer.ts:1375`,
   `{ modal: true }`). Confirmed this is **not** already funneled through
   `DeleteConfirmModal` and is a real live gap today:
   `WorkflowStatus.tsx`'s `handleClearHistory` posts
   `CLEAR_WORKFLOW_HISTORY` immediately with zero local confirmation, unlike
   its sibling `handleRemoveWorkflow` in the same file, which already does
   the right thing (`pendingDelete` state → `DeleteConfirmModal`, gated on
   `confirmDeleteOperations`). The backend's native `{ modal: true }` dialog
   is the _only_ confirmation today and is invisible to browser clients.
   **Decision: funnel through `DeleteConfirmModal`.** Mirror
   `handleRemoveWorkflow`'s exact pattern for clear-all, and delete the
   native confirm from `WorkflowSerializer.handleClearWorkflowHistory()` —
   trust the caller already confirmed, same as `REMOVE_WORKFLOW_HISTORY` /
   `DELETE_RUN_HISTORY` already do. **DONE F.4.**

   Verified 2026-08-17: the activation toast is `extension.ts:177` and the
   post-`StartupOverlay` one is `WorkflowOrchestrator.ts:1344`. A **third**
   initialization message at `extension.ts:1107` (the `ctrlyoke.initWorkspace`
   command-palette command, "…and its .gitignore are up to date") is a
   different, action-free boundary site and is **not** cut.

**Net effect:** the cut dispositions are complete for items 3/4 and 5, while
items 1, 2, and 6 relocate into modal/inline UI. All six items are implemented.
None need
`USER_INTERACTION_REQUEST` — see "Action-Bearing Messages" above.

#### Baseline impact of Phase 4 — both counters move

After Stage F.7, the committed baselines are `directMessage.boundary: 53` and
`directMessage.reusable: 0`. `assertShrinkOnly` fails when a count drops below its committed baseline just
as loudly as when it grows, so **every Phase 4 step must lower
`FEEDBACK_SOURCE_AUDIT_BASELINES` in `src/test/unit/SourceAuditCounters.test.ts`
in the same commit that removes call sites**, or `npm test` fails on an
otherwise-correct change.

- `directMessage.reusable` is now **0**: items 3/4 removed 2
  (`TemplateImporter.ts`), item 1 removed 1 (`WorkflowCommandHandler.ts`),
  and item 2 removed the final 1 (`WorkflowCommandHandler.ts`).
- `directMessage.boundary` goes **54 → 53**, once, in the step that deletes
  `extension.ts:177`; that move landed in F.4 and no other Phase 4 step moves
  it.

Each step lowers only by what it actually removed; do not pre-lower to the end
state.

### Phase 5 — Enforce the boundary — DONE, via a different mechanism than written

> **Moved to Stage 0.** These rules land _before_ the migration, not after, so
> the baseline cannot grow while the work is in flight. They are folded into
> `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 0 alongside the `vscode`-import
> guards and the adapter-UI counter. Retained here for traceability.

**Confirmed shipped, checked 2026-08-17.** Item 3 landed as
`src/test/unit/SourceAuditCounters.test.ts`'s shrink-only, AST-based
`assertShrinkOnly` counters (**current baselines re-read from the test file
2026-08-17: 53 boundary / 4 reusable / 0 adapter-UI**) — these fail the build
in _either_ direction, so the boundary
cannot silently grow. **Items 1 and 2 (a literal ESLint import-boundary rule
and allowlist) were never built and are not planned** —
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` line 219-220 explicitly reasons that a
lint rule can't catch this class of regression the way the AST test can, and
deliberately supersedes 1 and 2 with the test-based approach rather than
building both. Nothing outstanding here.

1. ~~Add a lint/import-boundary rule that disallows `vscode.window.show*Message`
   in shared core/router/service paths.~~ Superseded by the AST test below.
2. ~~Keep a narrow allowlist for VS Code composition and UI adapter files.~~
   Superseded by the same test's boundary-file allowlist.
3. Add a source audit test so a new direct call cannot silently recreate the
   hosted-browser gap. — **DONE.**

### Phase 6 — Single-source the webview's own toast dispatch

**New 2026-08-17.** Closes "The webview's own toast calls are not host-aware"
above. This is the client-side counterpart to Phase 2's `UserFeedbackSink`:
one function every webview-originated toast call goes through, so callers stop
caring whether they're rendering inside the VS Code panel or a browser tab.

1. **DONE** — Add the webview→extension message,
   `MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK`, in
   `src/types/DashboardConstants.ts` and its payload type in
   `src/types/WebviewMessageTypes.ts`.
   (payload: `severity`, `message`, optional `detail` — the same shape as
   `UserFeedback` in `src/core/UserFeedbackSink.ts`; no `id`/`dedupeKey`,
   since native VS Code messages don't dedupe or queue).
2. **DONE** — Add the handler in `src/ui/WebviewMessageRouter.ts`, thread the
   callback through `src/ui/CtrlYokeWebviewProvider.ts`, and wire the shared
   sink instance from `src/extension.ts`; cover it in
   `src/test/unit/WebviewMessageRouter.test.ts`; it delegates to the
   **existing** `VsCodeUserFeedbackSink` instance already constructed in
   `extension.ts` (thread it through `WebviewRouterCallbacks`, the same
   mechanism `handleDevAction`/`handleUxSnapshot` already use). Do not
   construct a second instance or re-implement the severity→API mapping —
   `VsCodeUserFeedbackSink.notify()` is the single source for that mapping and
   already exists.
3. **DONE** — Add `notifyUser(message, severity, detail?)` in
   `src/ui/webview-react/utils/notifyUser.ts` with coverage in
   `src/ui/webview-react/test/utils/notifyUser.test.ts`,
   colocated near `useVsCodeApi`. Its entire job:
   - `isStandalone` → `useUiStore.getState().showToast(message, severity, { detail })` (unchanged, in-app).
   - otherwise → `getVsCodeApi().postMessage({ type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK, severity, message, detail })`.
4. **DONE (2026-08-17)** — Migrate Group A's 15 client-only call sites (8
   files) to `notifyUser()`. The re-verified count matched the table exactly;
   no action-bearing exceptions were left behind.
5. **DONE (2026-08-17)** — Migrate Group B's 12 scoped-reply call sites in
   `useMessageHandler.ts` to `notifyUser()`. At `WORKFLOW_VARIANT_CREATED`, the
   existing standalone-only `Open in New Tab` action remains on the in-app
   toast path rather than crossing the native-message boundary.
6. **DONE (2026-08-17)** — Leave `NOTIFICATION_EVENT` and `USER_FEEDBACK`
   untouched; they already do the right thing through a different mechanism
   and are not part of this migration.
7. **DONE (2026-08-17)** — Keep `showToast()`/`enqueueToast()` on `uiStore` as
   the in-app-only primitives they already are. `notifyUser()` is additive —
   the one thing that decides _which_ rendering path a caller should use — not
   a replacement for the queue API itself.

**Non-goals for Phase 6:**

- No native equivalent for `ToastItem.action`. A closure (`onClick`) cannot
  cross the `postMessage` boundary to the extension host, so action buttons
  stay in-app/browser-only, exactly as `WORKFLOW_VARIANT_CREATED` already
  special-cases today. `notifyUser()` intentionally does not accept an
  `action` parameter.
- No change to `UserFeedbackSink`, `CompositeUserFeedbackSink`, or either sink
  implementation (Phase 2, already correct/complete).
- No change to the 53 boundary-approved direct `vscode.window.show*Message`
  calls or the completed Phase 4 action-bearing sites. Phase 6 adds a
  `SHOW_NATIVE_FEEDBACK` handler to `WebviewMessageRouter.ts` (already a
  `boundaryFiles` entry), but it delegates to `VsCodeUserFeedbackSink` rather
  than calling `vscode.window.show*Message` directly, so the boundary baseline
  does not move.

**Tests:**

- `notifyUser()` unit test: asserts the standalone branch calls
  `showToast`/`enqueueToast` and never posts a message; asserts the panel
  branch posts `SHOW_NATIVE_FEEDBACK` and never touches `toastQueue`.
- `WebviewMessageRouter` test: `SHOW_NATIVE_FEEDBACK` with each severity calls
  the matching `VsCodeUserFeedbackSink` API (reuse the existing
  `VsCodeUserFeedbackSink` test's severity→API table rather than duplicating
  it).
- Regression test for one Group A site (`DeveloperSection` profiler toggle)
  and one Group B site (`WORKFLOW_ACTION_FAILED`) each asserting: panel mode
  produces zero `toastQueue` entries, standalone mode produces exactly one.
- Extend `SourceAuditCounters.test.ts`-style shrink-only baseline to cover
  direct `showToast(`/`enqueueToast(` calls outside `uiStore.ts`,
  `notifyUser.ts`, `NOTIFICATION_EVENT`, and `USER_FEEDBACK`, so a new
  unconditional call site cannot silently recreate this gap. The committed
  post-migration baseline is **1**: the standalone action-bearing
  `WORKFLOW_VARIANT_CREATED` toast.

## Test Plan

### React

- queue ordering, deduplication, cap, dismissal, and transient reset;
- `NOTIFICATION_EVENT` enqueues a toast when `isStandalone` is true and enqueues
  nothing when it is false (the panel-duplicate regression guard);
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
- an end-condition failure in a browser-driven run produces visible feedback and
  a bounded resolution instead of an indefinite block — assert this with the
  VS Code sink absent and with no interactive client attached;
- `NOTIFICATION_EVENT` reaches a connected browser client under
  `browser.mode: connectedOnly` and is fully suppressed under `never`;
- `USER_FEEDBACK` reaches a connected browser client regardless of
  `browser.mode`;
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

- **MET —** Existing `uiStore.showToast()` calls are visibly rendered.
- **MET —** Hosted browser users see operational errors that were previously
  visible only through `vscode.window`.
- **MET —** Completion events render **exactly once per surface**: in-app in a
  browser, native in the VS Code extension. The VS Code panel shows no in-app
  duplicate.
- **MET —** Completion events reach the hosted browser whenever notification
  settings permit, and reach it in **no** form — toast or OS — when
  `browser.mode: never`.
- **MET —** Operational feedback is never suppressed by notification settings;
  `USER_FEEDBACK` is delivered under `browser.mode: never` as well as
  `connectedOnly`.
- **MET —** No operational feedback is incorrectly delivered as browser push.
- **MET (corrected 2026-08-17) —** Browser request failures are scoped to the
  initiating client. `WebviewClientContext` is threaded through
  `WorkflowMutationCoordinator`, `WorkflowStepHandlers`,
  `UndoRedoCoordinator`, and the terminal handlers, with a two-tab isolation
  test in `CoreFeedbackMigration.test.ts`. This line previously read
  "OUTSTANDING"; `FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md` re-verified
  the work against `src/` on 2026-08-11 and this plan was not updated to
  match until now.
- **MET —** Native VS Code notifications remain native at the extension
  boundary.
- **MET —** CLI behavior remains non-interactive unless an explicit interactive
  prompt implementation is selected.
- **MET — Phase 4 (redesigned 2026-08-17):** Reusable direct
  `vscode.window.show*Message()` calls are now **0**. All six action-bearing
  sites have decided per-site dispositions (four cut, two relocated into
  modal/inline UI) without a shared `USER_INTERACTION_REQUEST` contract. See
  "Action-Bearing Messages" and "Phase 4" for the six decisions.
- **MET —** `PlatformAdapter` no longer declares `log()`, `warn()`, `error()`,
  `showProgress()`, or `showChoice()`; the adapter-mediated UI baseline is 0.
- **MET —** Severity strings are declared once in `DashboardConstants.ts` and
  nowhere else.
- **MET — Phase 6 (2026-08-17):** All 15 Group A client-only webview toast
  calls and all 12 Group B scoped-reply handlers route through `notifyUser()`;
  panel mode therefore reaches the native host and standalone mode keeps the
  in-app queue. The one deliberate standalone action-bearing toast is covered
  by the shrink-only audit baseline recorded above.
