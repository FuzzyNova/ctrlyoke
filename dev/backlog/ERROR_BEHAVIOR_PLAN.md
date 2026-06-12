# Error Behavior Plan

## Progress Tracking

- [~] Phase 1 - Types, schemas, parser, serializer
- [x] Phase 2 - Failure classification plumbing
- [x] Phase 3 - Harness detection
- [x] Phase 4 - WorkflowExecutor routing
- [ ] Phase 5 - UI

### Phase 1 progress

- [x] Shared `errorBehavior` types and `PROMPT_PROPERTIES.ERROR_BEHAVIOR`
- [x] Prompt/settings schema support for `errorBehavior`
- [x] Hook metadata/schema support for logical `error` event
- [x] Parser / working-file default seeding / serializer wiring
- [x] Settings sync + YAML property completion wiring
- [ ] Remaining editor UI for authoring `errorBehavior`

### Phase 2 progress

- [x] Structured `FailureKind` tracker state in `CliFailureTracker`
- [x] Structured `NotificationResult.kind` + `-error.json` monitor detection
- [x] Structured `LogMonitorResult.failureKind` / `failureMessage`
- [x] Timeout routing stays structured instead of throwing from `CliExecutionRunner`
- [x] Headless non-zero exits classify as `processExit`
- [x] Failure classification persists into prompt `_runtime`

### Phase 3 progress

- [x] `ClaudeNotificationMonitor` registers logical `error` via Claude `StopFailure`
- [x] `flightpath-claude-hook.js` handles `StopFailure` and writes `{sessionId}-error.json`
- [x] `CopilotNotificationMonitor` registers logical `error` via Copilot `errorOccurred`
- [x] `flightpath-copilot-hook.js` handles `errorOccurred` and writes `{sessionId}-error.json`
- [x] `flightpath-opencode-plugin.ts` handles `session.error` and writes `{sessionId}-error.json`
- [x] Shared hook utility support for explicit error notification file naming
- [x] Interactive notification polling now treats `-error.json` as harness failure for Claude/Copilot/OpenCode
- [x] Logical user-facing `error` event is preserved through the same notification artifact path
- [ ] Harness-specific session-level log fallbacks remain intentionally deferred for Codex/Qwen/Gemini

### Phase 4 progress

- [x] `PropertyResolver` now resolves prompt/workflow `errorBehavior`
- [x] `WorkflowExecutor` routes `processExit` through `errorBehavior` instead of cancellation
- [x] `WorkflowExecutor` routes `harnessError` through `errorBehavior`
- [x] `WorkflowExecutor` routes `timeout` through `errorBehavior`
- [x] `userCancelled` stays on the existing cancellation path
- [x] `errorBehavior.retry` retries the same queue/finalStep target without advancing early
- [x] `errorBehavior.continue` finalizes the failed step and advances the queue
- [x] Default behavior with no resolved `errorBehavior` remains `stop`
- [x] Unit coverage updated for default stop, continue, and retry routing

## Problem

FlightPath currently has no configurable policy for harness-level execution failures.
When a harness fails, the workflow generally stops. That creates four gaps:

- **No retry policy for transient harness failures**: rate limits, server errors, and
  similar failures cannot be retried automatically.
- **No continue policy**: there is no supported way to mark a step failed and keep the
  workflow moving.
- **Interactive harness blind spot**: some CLIs can surface an error in the TUI without
  exiting the process. In that case FlightPath keeps waiting for completion instead of
  classifying the step as a harness failure. This is the actively-broken case today —
  Claude `StopFailure` is the most common trigger, but any harness that shows an error in
  the TUI and keeps running will hang indefinitely.
- **Process exit routes to cancellation, not error**: `WorkflowExecutor.handlePromptSendFailure()`
  currently treats process exit (`wasLastFailureProcessExit()`) as a cancel/stop, not a
  harness failure. This means no step failure is recorded and `errorBehavior` retry/continue
  logic cannot apply. This affects **all harnesses** equally — process exit is the universal
  fallback failure signal. Fixing this routing is the primary correctness fix.

This feature adds a new execution property, `errorBehavior`, that controls how FlightPath
responds when the **harness itself** fails.

---

## Scope

`errorBehavior` is for harness/session failures only. It does not replace the existing
step validation or script failure mechanisms.

| Situation                          | Mechanism       | Notes                         |
| ---------------------------------- | --------------- | ----------------------------- |
| End condition script returns false | `endCondition`  | Existing output validation    |
| Pre-condition script returns false | `preCondition`  | Existing pre-run gate         |
| `type: script` step fails          | `onFail`        | Existing script-step behavior |
| Harness/session failure            | `errorBehavior` | New harness failure policy    |

Examples of harness/session failures:

- CLI process exits before the prompt completes
- Harness-specific stop/error hook reports a session failure
- Headless harness output marks the overall run as an error
- Prompt execution times out while waiting for completion

Tool failures inside the agent session are **not automatically** harness failures. Several
harness logs contain tool-level errors that should not trigger retry or continue behavior.

---

## Proposed Schema

```yaml
steps:
  - name: implement
    prompt: Implement the feature.
    errorBehavior:
      onError: retry # stop | retry | continue
      maxRetries: 3
      retryDelayMs: 5000
```

### `onError`

| Value      | Behavior                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| `stop`     | Mark the step failed and stop the workflow. Default behavior.                   |
| `retry`    | Retry the same step. After retries are exhausted, stop the workflow.            |
| `continue` | Mark the step failed, record the harness failure, and advance to the next step. |

### TypeScript shape

```typescript
export type ErrorBehaviorAction = "stop" | "retry" | "continue";

export interface ErrorBehavior {
  onError: ErrorBehaviorAction;
  maxRetries?: number;
  retryDelayMs?: number;
}

// ExecutionProperties addition
errorBehavior?: ErrorBehavior | null;
```

`null` should follow the same inheritance semantics already used by nullable execution
properties in the UI: explicitly clear the inherited workflow-level value.

---

## Resolution Model

The original plan proposed `prompt > workflow > settings` resolution through a new
`PropertyResolver.resolveErrorBehavior()` path. That does not match how the current
codebase handles workflow defaults.

### Current pattern in the repo

- Prompt and workflow execution properties live in `ExecutionProperties`.
- `PromptFileLoader.populateSettingsDefaults()` seeds workflow defaults from
  `FlightPathSettings.defaults.*` when a workflow is loaded without explicit values.
- `PropertyResolver` resolves runtime execution properties such as harness/model/agent,
  but it does **not** currently resolve `endCondition` or `preCondition` from settings.
- `WebviewSettingsSync` already reads and writes workflow defaults under
  the structured `defaults.*` settings model.

### Recommended approach

Use the existing defaults architecture instead of introducing a one-off flat settings
path:

- Add `defaults.errorBehavior` to `FlightPathSettings`
- Add the corresponding schema entry to `schemas/settings-schema.json`
- Seed workflow defaults in `PromptFileLoader.populateSettingsDefaults()`
- Let prompt-level `errorBehavior` override workflow-level `errorBehavior`

That keeps `errorBehavior` aligned with the current `defaults.*` settings model and avoids
special-case runtime resolution logic. Do **not** add a new `workflow.*` settings section;
this repository currently stores workflow defaults under `FlightPathGlobalSettings.defaults`
and dot-notation keys such as `defaults.endCondition`.

---

## Current Failure Routing

Before implementation, the plan needs to reflect the code that already exists in
`WorkflowExecutor`.

### Current behavior

`handlePromptSendFailure()` currently distinguishes:

1. `wasLastFailureUserCancellation()`
2. `wasLastFailureProcessExit()`
3. everything else

Today, **process exit is not treated as a normal step failure**. It is routed through the
stop/cancel path:

- cancel attempt
- mark the prompt cancelled
- request workflow stop
- confirm stopped
- finalize cancelled prompt after stop

Everything else is treated as a hard failure:

- mark step failed
- fail attempt
- finalize failed in-flight prompt
- fail workflow

### Required adjustment

`errorBehavior` should apply to **harness failures**, which means at minimum:

- process exit
- harness-signaled session error
- prompt execution timeout

User cancellation must remain separate and must **not** be routed through `errorBehavior`.

This implies the current process-exit branch in `WorkflowExecutor` needs to move from the
cancel/stop path into the new harness-failure policy path.

---

## Detection Strategy

The fallback section of the original plan was too speculative. The local harness logs in
this environment show that generic keyword matching would create false positives, because
many harnesses log tool-level failures using common error fields.

### Research basis for this change

This plan is based on two kinds of evidence:

- direct local inspection of harness logs
- official hook/plugin documentation for harnesses that expose explicit error events

This recommendation is based on direct local inspection of the harness log locations that
FlightPath currently targets:

- Copilot: inspected local session-state and log files
- Claude: inspected local project transcript logs
- Codex: inspected local session logs
- Qwen: inspected local project logs
- Gemini: inspected local temp/chat logs
- OpenCode: no local logs were present to inspect in this environment

The result was not "no harness contains error lines". The result was narrower:

- Copilot had a verified session-level error event
- Claude had plausible session-level error shapes plus many tool-level error shapes
- Codex/Qwen/Gemini logs contained error-looking records, but the verified local examples
  were tool-level failures, not safe session-level harness-failure markers
- official docs confirm explicit interactive error signals for Copilot, Claude, and
  OpenCode, so those harnesses should use hook/plugin events as the primary detection path

That is why the generic fallback was removed. The issue is false positives, not absence of
error text.

### Key rule

Do **not** implement a generic cross-harness `BaseLogParser.isErrorEvent()` that matches
strings like `429`, `timeout`, or `error`.

Instead, only use:

- explicit harness/session error hooks
- explicit plugin session-error events
- verified session-level log events
- verified headless response-parser result objects and non-zero exits
- process exit and timeout as the universal fallback

### Failure classification

The implementation needs a structured failure kind instead of boolean checks:

```typescript
export type FailureKind =
  | "userCancelled"
  | "processExit"
  | "harnessError"
  | "timeout"
  | "unknown";
```

Recommended plumbing:

- extend `CliFailureTracker` to store `failureKind` and optional details
- extend `NotificationResult` to distinguish completion from error
- extend `LogMonitorResult` to return a structured failure kind when available
- keep user cancellation separate from harness failure handling

---

## Headless Scope

Headless execution should not use the new interactive notification-monitor error files for
failure detection.

Current headless behavior is fundamentally different from interactive TUI behavior:

- FlightPath does not wait for start/stop notification files to decide that a headless
  prompt completed.
- Headless runs complete when the child process exits.
- Harness response parsers receive `stdout`, `stderr`, and `exitCode` and already classify
  non-zero exits / parser-visible failures into a failed `CliResult`.
- The interactive hanging case exists because some TUIs stay open to display an error; the
  equivalent headless case usually exits the process instead.

Required headless changes are therefore limited to routing, not detection:

- do not attach FlightPath completion/error notification monitors for headless failure
  detection
- do not add headless polling for `{sessionId}-error.json`
- preserve the current response-parser path as the source of truth
- when a headless parser result fails because `exitCode !== 0`, classify it as
  `failureKind: "processExit"` for `errorBehavior` routing
- when a headless process times out via `maxPromptTimeout`, classify it as
  `failureKind: "timeout"`
- preserve any parsed response/error text so the failed attempt still has useful output in
  history and dashboard views

User-defined hooks are separate from FlightPath's completion detection. If a harness
supports user hooks in headless mode, an `error` user hook may run there as a native
harness hook, but it must not become the source of truth for headless failure detection.

---

## Harness Findings

### Claude

#### Interactive

Claude has a documented primary interactive error path.

Current state:

- `ClaudeNotificationMonitor` maps `Stop` and `SessionStart`
- `flightpath-claude-hook.js` only handles those events
- there is no current path for `StopFailure`

Recommended changes:

**`flightpath-claude-hook.js`**:

- add `"StopFailure"` to the `HANDLED_EVENTS` set
- on `StopFailure`, write `{safeSessionId}-error.json` with the same helper used for stop
  files: `{ hookEvent: "StopFailure", sessionId, status: "error" }`
- the payload format for `StopFailure` is identical to `Stop` (`session_id`,
  `transcript_path`, `hook_event_name: "StopFailure"`, etc.) — handle gracefully if
  fields differ

**`ClaudeNotificationMonitor`**:

- add `StopFailure` to the event map / hook config registration so the harness registers
  the hook at activation time
- the monitor's polling loop (`monitorForCompletion` in `NotificationMonitorBase`) must
  also scan for `{sessionId}-error.json` in addition to `{sessionId}-stop.json`
- surface a found error file as `{ kind: "error", ... }` in `NotificationResult`

Result: surface to executor as `failureKind: "harnessError"`

Research note:

- Claude's official hooks docs define `StopFailure` as the event that fires **instead of**
  `Stop` when a turn ends due to an API error — it is the primary interactive error signal
- `StopFailure` does not always fire for every unrecoverable interactive state; process
  exit and timeout remain the universal safety net for cases `StopFailure` misses

#### Headless response parser / verified log fallback

Verified and likely-useful signals:

- `result.is_error === true` is already handled in `ClaudeResponseParser`
- assistant transcript entries can contain top-level `error` plus `isApiErrorMessage`
- `system` entries with `subtype: "api_retry"` look like in-progress status, not terminal failure

Important constraint:

- many Claude logs contain `message.content[].is_error: true` and tool-use error payloads
- those are often tool-level failures, not session-level harness failures

Headless should continue to rely on the response parser first. Any log fallback must remain
session-level only. Do not treat generic tool result errors as harness failures.

### Copilot

#### Interactive

Copilot has a documented primary interactive error hook.

Current state:

- `CopilotNotificationMonitor` maps `agentStop` and `sessionStart`
- no current support for `errorOccurred`

Recommended changes:

**`flightpath-copilot-hook.js`**:

- add `errorOccurred` to the `LOGICAL_EVENT_MAP`
- on `errorOccurred`, write `{safeSessionId}-error.json` using the same helper as stop:
  `{ hookEvent: "errorOccurred", sessionId, status: "error" }`
- assume payload shape mirrors `agentStop` (`sessionId`, `timestamp`, `cwd`); extract
  `sessionId` defensively since field casing may differ — be defensive: fall back to
  `payload.sessionId || payload.session_id`

**`CopilotNotificationMonitor`**:

- add `errorOccurred` to the event map / hook config registration so the harness registers
  the hook in `.github/hooks/*.json` at activation time
- the polling loop (`monitorForCompletion` in `NotificationMonitorBase`) must also scan
  for `{sessionId}-error.json`
- surface a found error file as `{ kind: "error", ... }` in `NotificationResult`

Result: surface to executor as `failureKind: "harnessError"`

Research note:

- GitHub's hook documentation defines `errorOccurred` for Copilot agent execution
- this should be treated as the primary interactive error signal for Copilot harnesses
- the same Copilot hook model conceptually applies to `copilot-chat`, but the initial
  implementation scope here remains the CLI harness path

#### Log fallback

This environment has verified session-level Copilot errors in the local log/session state:

- `session.error`
- with fields such as `data.errorType`, `data.message`, and sometimes `data.statusCode`

Important constraint:

- `tool.execution_complete success:false` appears frequently and should not be treated as
  a harness failure

So Copilot can use a harness-specific log fallback based on `session.error`, but not on
generic tool failure events.

### Codex

Current state:

- local session logs did **not** reveal a verified session-level error event
- observed failures were mostly tool command failures such as `exec_command_end` with
  `status:"failed"`

Important constraint:

- those command failures are not equivalent to harness/session failure

Recommendation:

- do not assume a generic `{ type: "error" }` session event
- for now, rely on **process exit and timeout** as the primary detection mechanism
- these two paths already cover the most common Codex failure mode (process crash)
- only add a session-level event fallback after the exact event shape is verified in a
  live session

### Qwen

Current state:

- local logs show tool and UI telemetry failures
- examples include `toolCallResult.status:"error"` and nested tool response errors

Important constraint:

- those are tool-level failures and would false-positive badly

Recommendation:

- do not implement log-based harness-error detection yet
- rely on **process exit and timeout** — the universal fallback for all harnesses without
  a dedicated error hook — until a verified session-level signal is found

### Gemini

Current state:

- local logs show tool/function response errors
- examples include `functionResponse.response.error` and tool entries with `status:"error"`

Important constraint:

- these are not reliable harness/session failure markers

Recommendation:

- do not implement generic log-based harness-error detection
- rely on **process exit and timeout** until a verified session-level signal is found

### OpenCode

Current state:

- local logs were not available in this environment
- FlightPath already uses an OpenCode plugin for interactive lifecycle detection
- the current plugin and monitor handle `session.created`, `session.updated`,
  `session.status`, and completion via `session.idle`
- the current plugin does not yet emit a structured error notification

Recommendation:

- treat OpenCode plugin events as the primary interactive error path
- extend the plugin (`flightpath-opencode-plugin.ts`) to handle `session.error` events:
  `if (event.type === "session.error")` alongside the existing `session.status` handler
- write `{sessionId}-error.json` from the plugin: `{ hookEvent: "session.error", sessionId, status: "error" }`
  using the session ID from `event.properties.sessionID` (or equivalent)
- the `OpenCodeNotificationMonitor` polling loop must scan for `{sessionId}-error.json`
  in addition to `{sessionId}-stop.json`
- surface a found error file as `{ kind: "error", ... }` in `NotificationResult`
- surface to executor as `failureKind: "harnessError"`
- keep process exit and timeout as the universal fallback

Research note:

- OpenCode's official plugin docs list `session.error` as a supported session event
- this makes OpenCode the third harness with a first-class interactive error signal
- if `event.properties.sessionID` is missing, fall back to any `sessionId`/`session_id`
  field in the event payload and log a warning

---

## Detection Architecture

### Error notification file convention

All three interactive harnesses (Claude, Copilot, OpenCode) write notification files
into the same temp directory that stop files land in. The file naming convention is:

```
{sessionId}-stop.json   ← existing: successful completion
{sessionId}-error.json  ← new: harness-reported error
```

Error file payload:

```json
{
  "hookEvent": "<StopFailure|errorOccurred|session.error>",
  "sessionId": "...",
  "status": "error"
}
```

The harness-specific hook/plugin value for `hookEvent` is kept verbatim to aid
debugging. The polling logic in `NotificationMonitorBase` treats any found error file as
an error result regardless of `hookEvent` value.

### Notification monitors

Current state:

- `NotificationMonitorBase` assumes start/stop completion files
- `NotificationResult` only exposes `completed`, `error?`, and `data?`
- the `error?` field is currently used only for timeout strings, not structured failure kinds

Required changes:

**`NotificationResult`** — add `kind` discriminator:

```typescript
interface NotificationResult {
  completed: boolean;
  kind?: "completed" | "error"; // "error" when harness reported a failure
  error?: string; // timeout or internal error message
  data?: any;
}
```

**`NotificationMonitorBase.monitorForCompletion()`** — the polling loop currently only
checks for `{sessionId}-stop.json`. It must also check for `{sessionId}-error.json`.
When an error file is found:

- return `{ completed: false, kind: "error", data: <parsed error file content> }`

When a stop file is found (existing behavior):

- return `{ completed: true, kind: "completed", data: <parsed stop file content> }`

This applies first to:

- Claude: `ClaudeNotificationMonitor`
- Copilot: `CopilotNotificationMonitor`
- OpenCode: `OpenCodeNotificationMonitor`

Harnesses without interactive error hooks (Codex, Qwen, Gemini) inherit the base class
changes at no cost — `monitorForCompletion` never finds an error file for them and behaves
identically to today.

### Notification cleanup

The notification file cleanup path must be updated at the same time as error-file polling.
`NotificationMonitorBase.cleanupNotificationFiles()` currently removes only start/stop
files. It must remove all three standard notification files:

```
{sessionId}-start.json
{sessionId}-stop.json
{sessionId}-error.json
```

`CliExecutionRunner` also performs stale notification cleanup before interactive runs when
a known session ID is reused. That pre-run cleanup must delete both stale `-stop.json` and
stale `-error.json` files so an old error notification cannot fail a new attempt.

### Notification-to-failure propagation

`CliExecutionRunner` does **not** call `monitorForCompletion()` directly. The call lives
inside `CliLogMonitor`, so the structured error result must be converted there:

1. `NotificationMonitorBase.monitorForCompletion()` returns
   `{ completed: false, kind: "error", data }` when an error file is found.
2. `CliLogMonitor` receives that `NotificationResult`, drains/parses any partial output,
   and resolves `LogMonitorResult` with `failureKind: "harnessError"` and an optional
   `failureMessage`.
3. `CliExecutionRunner.monitorLogFile()` reads `LogMonitorResult.failureKind`, calls
   `failureTracker.markHarnessError()` for `"harnessError"`, and sets the user-facing
   failure reason.

Do not put `NotificationResult.kind` handling only in `CliExecutionRunner`; that layer
cannot see the raw notification result.

### User-facing error hooks and notifications

The settings UI already renders hook notification toggles from `HOOK_EVENT_ORDER` /
`HOOK_EVENT_METADATA`, and `HooksEditor` already renders hook script event choices from
`HOOK_EVENT_METADATA`. Do not build bespoke controls in
`NotificationsSection.tsx` or `HooksEditor.tsx` for this feature.

Instead, add a logical hook event:

```typescript
type HookEvent = ... | "error";
```

Required changes:

- add `"error"` to `HOOK_EVENT_ORDER`
- add `HOOK_EVENT_METADATA` entry:
  - label: `Error`
  - description: fires when the harness reports a session-level error
  - supported harnesses: Claude CLI, Copilot CLI, OpenCode CLI initially
- add `notifications.events.hookEvents.error: false` to
  `FLIGHTPATH_SETTINGS_DEFAULTS`
- add `error` to `schemas/prompt-schema.json` and `schemas/settings-schema.json` hook
  event enums / notification settings
- map logical user hook event `error` to native events:
  - Claude: `StopFailure`
  - Copilot CLI: `errorOccurred`
  - OpenCode: `session.error`
- update hook notification artifact mapping so those native error events can emit
  `hookEvent: "error"` for notification preferences
- keep unsupported harness behavior unchanged: unsupported user hook events are skipped

This gives users both requested controls through the existing UI surfaces:

- `NotificationsSection.tsx`: users can opt into browser / VS Code notifications for
  error hook events because the section iterates `HOOK_EVENT_ORDER`
- `HooksEditor.tsx`: users can attach a hook script on `error` because the editor
  iterates `HOOK_EVENT_METADATA`

The user-facing `error` hook event is related to, but separate from, runtime
`errorBehavior`. A user hook failure must not override the workflow's structured
`errorBehavior` decision.

### CLI log monitor

Current state:

- `CliLogMonitor` can resolve success, parsed headless output, or `processExited`
- `LogMonitorResult` already has `timedOut?: boolean` and `processExited?: { exitCode: number }`
- **timeout currently throws** (`throw new Error("Log monitoring timeout")`) in
  `CliExecutionRunner` (line ~634) rather than returning a structured result

Required changes:

- change timeout handling to remain structured all the way through `CliLogMonitor` →
  `CliExecutionRunner` → `CliFailureTracker`; do not throw `"Log monitoring timeout"` after
  the monitor already returned a `timedOut` result
- thread `failureKind` and optional `failureMessage` into the result shape

Recommended `LogMonitorResult` direction:

```typescript
interface LogMonitorResult {
  success: boolean;
  sessionId?: string;
  parsedOutput?: string;
  cliResult?: CliResult;
  failureKind?: FailureKind;
  failureMessage?: string;
  timedOut?: boolean; // keep for backward compat, redundant with failureKind
  processExited?: { exitCode: number };
}
```

`CliExecutionRunner` — current code at line ~634:

```typescript
if (result.timedOut) {
  throw new Error("Log monitoring timeout");
}
```

Must become:

```typescript
if (result.timedOut) {
  this.deps.failureTracker.markTimeout("Log monitoring timeout");
  this.deps.runtimeState.setFailureReason("Log monitoring timeout");
  return { success: false, sessionId: result.sessionId };
}
```

### Failure tracker

Current state:

- `CliFailureTracker` has `InteractiveAbortState` with `USER_CANCELLED` and
  `PROCESS_EXITED` — already a discriminated union
- `wasLastFailureProcessExit()` returns `true` when `processExitTermination !== null`
- no field for harness-reported errors (i.e. an error file was found by the notification
  monitor before the process exited)

Required changes:

- add a `harnessErrorDetails?: { message: string }` field
- add `wasLastFailureHarnessError()` alongside `wasLastFailureProcessExit()`
- add `markHarnessError(message: string)` method — called by `CliExecutionRunner` when
  `CliLogMonitor` returns `failureKind: "harnessError"`
- add timeout tracking: `timeoutDetails?: { message: string }`,
  `markTimeout(message: string)`, and `wasLastFailureTimeout()`
- define a separate `FAILURE_KINDS` const map in `DashboardConstants.ts` for
  `userCancelled`, `processExit`, `harnessError`, `timeout`, and `unknown`; use the
  derived `FailureKind` type for structured runtime failure routing
- do not use `INTERACTIVE_ABORT_KINDS` as the primary harness-failure model; add
  `"HARNESS_ERROR"` there only if the existing interactive abort state is intentionally
  reused for UI-facing state, and keep runtime routing on `FAILURE_KINDS`

Preserve the existing user-cancel path; `wasLastFailureUserCancellation()` must remain
unchanged.

---

## Workflow Routing

### Current process-exit routing bug (ALL harnesses)

`WorkflowExecutor.handlePromptSendFailure()` currently has three branches in order:

1. `runtime.stopped` — stopped by user
2. `wasLastFailureUserCancellation()` — user cancelled
3. **`wasLastFailureProcessExit()`** — calls `runtime.cancelAttempt()` then
   `promptQueue.markInFlightPromptCancelled()` then **stops the workflow**

Branch 3 is the bug: process exit is treated as a **cancellation**, not a failure. The
prompt is marked cancelled, the workflow stops, and no error policy is consulted. This
affects all seven harnesses — any unexpected crash currently silently looks like a user
cancel.

### Desired routing after fix

When a prompt attempt fails with `failureKind` in:

- `processExit` — process exited before completion (currently routed to cancel)
- `harnessError` — harness wrote an error file (Claude `StopFailure`, Copilot
  `errorOccurred`, OpenCode `session.error`)
- `timeout` — log monitor timed out (currently thrown as an error)

…then `WorkflowExecutor` should resolve `errorBehavior` from the resolved prompt
properties and route accordingly.

`userCancelled` remains on the existing cancellation path — unchanged.

### `stop`

- fail the attempt
- mark the step failed
- finalize the failed prompt
- fail the workflow

### `retry`

- fail the current attempt
- wait `retryDelayMs` if configured
- re-run the same step until `maxRetries` is exhausted
- after retries are exhausted, fail the workflow

Important implementation detail: do not call
`PromptQueue.finalizeFailedInFlightPrompt()` before deciding whether a harness failure will
retry. That method advances `currentIndex`, so calling it too early would move the queue
past the failed step. Harness-level retry handling should wrap the prompt send attempt and
only finalize the step when the policy outcome is final:

- `retry` with attempts remaining: record/fail the attempt, emit retry status, leave the
  queue index on the same step, then send the same prompt again with a fresh harness
  attempt
- `retry` exhausted or `stop`: record/fail the attempt, finalize the prompt as failed,
  then fail the workflow
- `continue`: record/fail the attempt, finalize the prompt as failed, keep workflow state
  running, then advance to the next queued step

This is intentionally separate from end-condition retries. End-condition retry sends a
recovery prompt after a completed harness turn; `errorBehavior.retry` starts a fresh harness
attempt because the previous harness/session attempt failed.

### `continue`

- fail the attempt
- mark the step failed
- finalize the prompt as failed
- keep the workflow runtime running
- continue to the next queued step

`continue` does **not** require a new step status. The current failed step status is
already sufficient. The UI/runtime messaging should explain that the workflow continued
after the failure.

---

## Parser, Schema, and Serialization Touchpoints

The original Phase 1 was incomplete for this repository. Adding a new execution property
requires updates in the prompt parser and editor plumbing, not just shared types.

Expected touchpoints:

- `src/types/FlightPathTypes.ts` — `ErrorBehavior`, `ErrorBehaviorAction` types, `errorBehavior` on `ExecutionProperties`
- `src/types/DashboardConstants.ts` — new `FailureKind` const map; add logical `HookEvent` `"error"` and metadata; add `"HARNESS_ERROR"` to `INTERACTIVE_ABORT_KINDS` only if the UI-facing interactive abort channel is reused
- `src/types/FlightPathSettings.ts` — `defaults.errorBehavior` field; default `notifications.events.hookEvents.error: false`
- `schemas/prompt-schema.json` — `errorBehavior` property on prompt items; add `"error"` to user hook event enum
- `schemas/settings-schema.json` — `defaults.errorBehavior`; add `"error"` to notification hook events
- `src/flightpath/PromptFileParser.ts` — parse `errorBehavior`
- `src/flightpath/orchestration/PromptFileLoader.ts` — seed workflow defaults
- `src/flightpath/harness/shared/CliFailureTracker.ts` — add `harnessErrorDetails`, `markHarnessError()`, `wasLastFailureHarnessError()`
- `src/flightpath/harness/CliLogMonitor.ts` — convert notification error files and timeouts into structured `failureKind` results
- `src/flightpath/harness/shared/CliExecutionRunner.ts` — remove timeout throw; call `markHarnessError()` / `markTimeout()` from structured log monitor results; classify failed headless non-zero exits from response parser results as `processExit`
- `src/flightpath/harness/shared/interfaces/INotificationMonitor.ts` — add `kind` to `NotificationResult`
- `src/flightpath/harness/claude/ClaudeNotificationMonitor.ts` — register `StopFailure` in hook config
- `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts` — register `errorOccurred` in hook config
- `src/scripts/flightpath-claude-hook.js` — add `StopFailure` to `HANDLED_EVENTS`, write error file, map notification artifact to logical `error`
- `src/scripts/flightpath-copilot-hook.js` — add `errorOccurred` to `LOGICAL_EVENT_MAP`, write error file, map notification artifact to logical `error`
- `src/scripts/flightpath-opencode-plugin.ts` — handle `session.error` event, write error file, map notification artifact to logical `error`
- harness user-hook builders / native event maps — map logical user hook event `error` to `StopFailure`, `errorOccurred`, or `session.error` where supported
- `src/flightpath/WorkflowExecutor.ts` — route `processExit`/`harnessError`/`timeout` through `errorBehavior`; move process exit off the cancel path
- `src/flightpath/WorkflowInstance.ts` — prompt/workflow property key lists and webview update plumbing
- `src/ui/WorkflowSerializer.ts` — serializer field allowlists
- `src/types/DashboardConstants.ts` — add `PROMPT_PROPERTIES.ERROR_BEHAVIOR` and use it in allowlists instead of hardcoded strings
- `src/completions/PromptPropertyCompletionProvider.ts` — property key completions
- `src/ui/WebviewSettingsSync.ts` — settings synchronization
- `src/ui/webview-react/components/editor/PropertiesDrawer.tsx` — UI editing

---

## UI Plan

The prompt-level UI should follow the existing nullable execution-property pattern used for
`endCondition` and `preCondition`, rather than introducing a one-off dropdown.

### Prompt step editor

For prompt steps:

- inheritance mode
- explicit none/clear mode
- custom `errorBehavior`

When custom is selected:

- show `On Harness Error`
- show `Max Retries` when `retry` is selected
- show `Retry Delay (ms)` when `retry` is selected

### Workflow-level editor

At the workflow level, expose the default `errorBehavior` in the execution/settings area so
steps can inherit it.

### Status display

- keep failed steps as `FAILED`
- show retry progress using attempt/status messaging
- for continue behavior, show a warning/status message that the workflow advanced after the
  step failed

No new shared `STEP_STATUS` value is necessary for the first implementation.

---

## Settings

Use the existing structured settings model:

```json
"defaults.errorBehavior": {
  "type": "object",
  "default": null,
  "description": "Default error behavior for workflow steps when a harness/session failure occurs."
}
```

Schema details should validate:

- `onError`: `"stop" | "retry" | "continue"`
- `maxRetries`: integer, minimum `1`
- `retryDelayMs`: integer, minimum `0`

This should be wired through `FlightPathSettings.defaults.errorBehavior`, not through a
new `workflow.*` section and not through new flat settings like
`flightpath.errorBehavior.onError`.

---

## Implementation Order

### Phase 1 - Types, schemas, parser, serializer

1. Add `ErrorBehavior` types to shared workflow types
2. Add `errorBehavior` to execution properties
3. Update prompt schema, settings schema, parser, serializer, and completion plumbing
4. Add `defaults.errorBehavior` to settings types and settings sync
5. Add logical hook event `error` to shared hook metadata, hook schemas, and notification
   settings defaults
6. Seed workflow defaults in `PromptFileLoader.populateSettingsDefaults()`

This phase should make the property round-trip correctly before any runtime behavior
changes are introduced.

### Phase 2 - Failure classification plumbing

1. Introduce structured `FailureKind`
2. Extend `CliFailureTracker`
3. Extend `NotificationResult`
4. Extend `CliLogMonitor` result shape
5. Treat prompt timeout as structured failure instead of a generic thrown error
6. Preserve headless response-parser detection; classify failed non-zero headless results
   as `processExit` and headless prompt timeouts as `timeout`

This phase should not yet change retry/continue behavior. It should only make failure
classification explicit.

### Phase 3 - Harness detection

1. [x] `flightpath-claude-hook.js`: add `StopFailure` to `HANDLED_EVENTS`, write error file
2. [x] `ClaudeNotificationMonitor`: register `StopFailure` in hook config
3. [x] `flightpath-copilot-hook.js`: add `errorOccurred` to `LOGICAL_EVENT_MAP`, write error file
4. [x] `CopilotNotificationMonitor`: register `errorOccurred` in hook config
5. [x] `flightpath-opencode-plugin.ts`: handle `session.error` event, write error file
6. [x] `OpenCodeNotificationMonitor`: scan for error files alongside stop files
7. [x] Map the logical user hook/notification event `error` to Claude `StopFailure`, Copilot
   `errorOccurred`, and OpenCode `session.error`
8. [ ] `ClaudeNotificationMonitor`/`CopilotNotificationMonitor`: tighten log fallback to session-level only
9. [x] Leave Codex/Qwen/Gemini on process-exit/timeout fallback — no changes needed; they
   inherit Phase 2's structured classification automatically

This is the smallest safe implementation slice that fixes the known blind spots without
adding broad false-positive log parsing.

### Phase 4 - WorkflowExecutor routing

1. [x] Move process exit off the cancel path — change `wasLastFailureProcessExit()` branch to
   route through `errorBehavior` instead of calling `runtime.cancelAttempt()` + stop
2. [x] Wire `wasLastFailureHarnessError()` as a new route (same policy lookup)
3. [x] Wire timeout (`failureKind: "timeout"`) as a new route
4. [x] Keep `userCancelled` on the existing cancellation path — unchanged
5. [x] Implement `retry` behavior
6. [x] Implement `continue` behavior
7. [x] Preserve existing `stop` behavior as the default when `errorBehavior` is not set

### Phase 5 - UI

1. Add workflow-level `errorBehavior` editing in the Validation section of
   `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx`
2. Add prompt-level `errorBehavior` editing in the Validation section of
   `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`
3. Add global default `errorBehavior` editing in the Validation section of
   `src/ui/webview-react/components/settings/defaults/DefaultsValidationPage.tsx`
4. Use the existing nullable execution-property pattern in `PropertiesDrawer.tsx`:
   dropdown options should include inherit / explicit none / custom behavior, matching the
   workflow-inheritance semantics already used for `endCondition` and `preCondition`
5. Show `maxRetries` and `retryDelayMs` only when the selected `onError` value is `retry`
6. Keep workflow/default-level controls simpler: `onError` selector always visible, with
   `maxRetries` and `retryDelayMs` conditionally rendered under it when `retry` is selected
7. Add status messaging for retry and continue outcomes where the current Validation UI
   already surfaces execution/attempt state
8. Do not add bespoke error controls to `NotificationsSection.tsx` or `HooksEditor.tsx`;
   the new logical `error` hook event should appear there through `HOOK_EVENT_METADATA`

---

## Verification Plan

Add or update focused tests for the behavior boundaries that can regress independently:

- parser/schema/serializer round trip:
  - workflow-level `defaults.errorBehavior`
  - prompt-level `errorBehavior`
  - prompt-level `errorBehavior: null` inheritance
  - invalid `errorBehavior.action`
  - user hook event `error` is accepted in prompt and settings schemas
- `PromptFileLoader` default seeding:
  - `defaults.errorBehavior` is applied from global settings when the prompt file omits it
  - prompt-level values override workflow/global defaults
- hook metadata/UI plumbing:
  - `HOOK_EVENT_ORDER` and `HOOK_EVENT_METADATA` include `error`
  - notification settings defaults include `notifications.events.hookEvents.error: false`
  - `NotificationsSection.tsx` and `HooksEditor.tsx` surface `error` through metadata,
    without bespoke per-component event lists
- notification monitoring:
  - `NotificationMonitorBase` detects `{sessionId}-error.json` and returns
    `kind: "error"` without waiting for timeout
  - cleanup removes stale `-start.json`, `-stop.json`, and `-error.json`
- CLI monitor/runner classification:
  - notification error maps to `failureKind: "harnessError"` and calls
    `markHarnessError()`
  - log-monitor timeout maps to `failureKind: "timeout"` and calls `markTimeout()`
  - process exit still maps to `processExit`
  - failed headless non-zero parser results map to `processExit` without using
    notification files
- workflow routing:
  - `processExit`, `harnessError`, and `timeout` all consult resolved `errorBehavior`
  - `userCancelled` still follows the existing cancellation path
  - `retry` does not call `PromptQueue.finalizeFailedInFlightPrompt()` before the final
    retry outcome, so the same queued step is retried
  - `continue` finalizes the failed prompt and advances to the next queued step
  - missing `errorBehavior` defaults to `stop`

---

## What Not To Build Yet

- generic keyword-based cross-harness error detection
- per-error-type policy branching in the schema
- exponential backoff or jitter
- automatic resume of an errored harness session on retry
- new step status enums unless the existing `FAILED` state proves insufficient

Retries should start a fresh harness attempt, not attempt to recover the broken session.

---

## Implementation Guidance (Open Questions Resolved)

### Q1: Does Claude `StopFailure` always fire for interactive errors?

**Assumption**: `StopFailure` fires instead of `Stop` when a turn ends due to an API error.
It is the primary signal for the hanging-workflow case. It will not catch every failure
mode (e.g. cases where Claude exits the process rather than showing an error in the TUI).
The existing process-exit path covers those cases. No log-based fallback is needed for
the interactive hanging case.

**Implementation decision**: handle `StopFailure`, log-based session error fallback
is not needed for the interactive hanging case. Headless remains on process-exit /
response-parser classification rather than notification-monitor error files.

### Q2: What exact payload shape does Copilot `errorOccurred` provide?

**Assumption**: payload mirrors `agentStop` — `{ sessionId, timestamp, cwd }`. Extract
`sessionId` defensively (`payload.sessionId ?? payload.session_id`). Any extra fields
(e.g., `errorType`, `errorMessage`) should be preserved in the error file for debugging
but are not required for the core error routing.

**Implementation decision**: write the full raw payload into the error file alongside the
normalized `{ hookEvent, sessionId, status: "error" }` envelope.

### Q3: What exact payload shape does OpenCode `session.error` provide?

**Assumption**: follows the same pattern as other session events — `event.properties`
contains session details. Extract `sessionID` from `event.properties.sessionID` with a
fallback to `event.properties.sessionId`. Log a warning and skip if session ID cannot
be resolved.

**Implementation decision**: handle gracefully; write error file when session ID is
resolvable, otherwise log and fall through to the process-exit fallback.

### Q4: Should timeout be user-configurable per step?

**Decision**: route the existing prompt execution timeout,
`FlightPathGlobalSettings.execution.maxPromptTimeout`, through `errorBehavior` for the
initial implementation. This is the setting currently read by
`ConfigurationUtils.getMaxPromptExecutionTimeMs()` in `CliLogMonitor`.

Do **not** use `scriptTimeout` for harness failures; `scriptTimeout` applies to
end-condition, pre-condition, and script-step execution.

Per-step prompt timeout override is deferred to a future enhancement and can be added as a
new `timeout?` field on `ExecutionProperties` later without breaking changes.

---

## Recommended Shipping Sequence

The highest-value safe slice is:

1. land the schema/parser/serializer/settings work
2. add structured failure classification
3. add the logical user-facing `error` hook/notification event
4. wire Claude `StopFailure`
5. wire Copilot `errorOccurred`
6. wire OpenCode `session.error`
7. route process exit and timeout through `errorBehavior`

That fixes the biggest execution gap without depending on speculative log parsing for every
harness.
