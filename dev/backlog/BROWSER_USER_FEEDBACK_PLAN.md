# Browser User Feedback Plan

**Status (2026-08-01):** Phase 1 complete; Phases 2–4 remain proposed. The
React dashboard now renders a bounded, accessible transient toast queue in both
hosts and keeps completion notifications separate from operational feedback.
Ordinary `vscode.window.show*Message()` calls still do not reach hosted browser
clients; that migration remains Phase 2.

**Related plans:**

- [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](./VSCODE_DEPENDENCY_DECOUPLING_PLAN.md)
- [`STANDALONE_SERVER_PLAN.md`](./STANDALONE_SERVER_PLAN.md)

**Implementation order:**
[`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md)
— Phases 2, 2.5 Site 3, 3, and 4 are Stages C, E, and F there; the Phase 5
guards are Stage A. The completed Phase 1 and Phase 2.5 Site 2 sequencing is
recorded in
[`COMPATIBILITY_AND_FEEDBACK_STAGING.md`](../active/COMPATIBILITY_AND_FEEDBACK_STAGING.md).

**Not a dependency of the 0.1.0 permission work.**
[`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](./HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
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
table below is exact. An earlier 2026-08-01 text scan found per-file drift
against the original table
(`WorkflowCommandHandler` at 13, `showErrorMessage` at 67 /
`showInformationMessage` at 24), and a naive `grep` both over-counts the four
doc-comment mentions in `PlatformAdapter.ts` and under-counts the three
multi-line calls in `NotificationManager.ts`. The architectural split below is
what matters; the exact totals are not load-bearing.

The calls split into two architectural groups:

| Disposition                                         | Calls | Files                                                                                                                                       |
| --------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep as native VS Code UI at the extension boundary |    49 | `extension.ts`, `DevCommands`, context-menu commands, `ScmCommitCommand`, `ExternalFileTrustPrompt`, `NotificationManager` |
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

Eight action-bearing calls currently live in reusable code — seven direct, one
adapter-mediated:

Direct (`vscode.window.show*Message` with actions):

- template overwrite confirmation;
- post-import action;
- post-script-create action;
- retry harness automation;
- duplicate-running-workflow choice;
- post-workspace-initialization action;
- clear-all-workflows confirmation.

Adapter-mediated (`platform.showChoice`):

- harness warning "don't show again" (`CliIntegration.ts:1381`) — migrate
  normally.

(The two end-condition dialogs were deleted rather than migrated in Phase 2.5.)

So seven of the eight need an interaction contract, not eight — and the
duplicate-running-workflow choice in the direct list above should be re-examined
against the same policy-conflict test.

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
per-site disposition; the remaining ~41 sites are unclassified. Expect the
`vscode` and adapter-UI baselines from Stage 0 to fall partly through deletion
rather than migration.

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

### Phase 4 — Interactive choices

1. Inventory the seven reusable action-bearing messages and choose generic
   interaction requests versus existing domain modals.
2. Add correlation, timeout, dismissal, and disconnect handling.
3. Preserve native VS Code choices for panel/Command Palette flows.
4. Add explicit CLI/server-headless fallback tests.

### Phase 5 — Enforce the boundary

> **Moved to Stage 0.** These rules land _before_ the migration, not after, so
> the baseline cannot grow while the work is in flight. They are folded into
> `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 0 alongside the `vscode`-import
> guards and the adapter-UI counter. Retained here for traceability.

1. Add a lint/import-boundary rule that disallows `vscode.window.show*Message`
   in shared core/router/service paths.
2. Keep a narrow allowlist for VS Code composition and UI adapter files.
3. Add a source audit test so a new direct call cannot silently recreate the
   hosted-browser gap.

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

- Existing `uiStore.showToast()` calls are visibly rendered.
- Hosted browser users see operational errors that were previously visible only
  through `vscode.window`.
- Completion events render **exactly once per surface**: in-app in a browser,
  native in the VS Code extension. The VS Code panel shows no in-app duplicate.
- Completion events reach the hosted browser whenever notification settings
  permit, and reach it in **no** form — toast or OS — when
  `browser.mode: never`.
- Operational feedback is never suppressed by notification settings.
- No operational feedback is incorrectly delivered as browser push.
- Browser request failures are scoped to the initiating client.
- Native VS Code notifications remain native.
- CLI behavior remains non-interactive unless an explicit interactive prompt
  implementation is selected.
- Reusable code no longer calls `vscode.window.showErrorMessage`,
  `showWarningMessage`, or `showInformationMessage` directly.
- `PlatformAdapter` no longer declares `log()`, `warn()`, `error()`,
  `showProgress()`, or `showChoice()`; all 20 callers use the feedback or
  interaction port. `CliAdapter`, `VsCodeAdapter`, and
  `src/test/helpers/mockHarness.ts` all implement `showChoice()` today and must
  be updated together.
- **No workflow can block on a prompt that the client driving it cannot see.**
  Every `showChoice` site either reaches the initiating client or resolves to
  its existing safe default within a bounded time while emitting visible
  feedback.
- Severity strings are declared once in `DashboardConstants.ts` and nowhere
  else.
- Action-bearing messages retain real choice semantics and safe dismissal
  fallbacks.
