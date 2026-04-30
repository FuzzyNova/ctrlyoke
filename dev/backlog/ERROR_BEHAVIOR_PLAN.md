# Error Behavior Plan

## Problem

FlightPath currently has no configurable policy for harness-level execution failures.
When a harness fails, the workflow generally stops. That creates three gaps:

- **No retry policy for transient harness failures**: rate limits, server errors, and
  similar failures cannot be retried automatically.
- **No continue policy**: there is no supported way to mark a step failed and keep the
  workflow moving.
- **Interactive harness blind spot**: some CLIs can surface an error in the TUI without
  exiting the process. In that case FlightPath may keep waiting for completion instead of
  classifying the step as a harness failure.

This feature adds a new execution property, `errorBehavior`, that controls how FlightPath
responds when the **harness itself** fails.

---

## Scope

`errorBehavior` is for harness/session failures only. It does not replace the existing
step validation or script failure mechanisms.

| Situation | Mechanism | Notes |
| --- | --- | --- |
| End condition script returns false | `endCondition` | Existing output validation |
| Pre-condition script returns false | `preCondition` | Existing pre-run gate |
| `type: script` step fails | `onFail` | Existing script-step behavior |
| Harness/session failure | `errorBehavior` | New harness failure policy |

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

| Value | Behavior |
| --- | --- |
| `stop` | Mark the step failed and stop the workflow. Default behavior. |
| `retry` | Retry the same step. After retries are exhausted, stop the workflow. |
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
  `FlightPathSettings.workflow.*` when a workflow is loaded without explicit values.
- `PropertyResolver` resolves runtime execution properties such as harness/model/agent,
  but it does **not** currently resolve `endCondition` or `preCondition` from settings.
- `WebviewSettingsSync` already reads and writes workflow defaults under
  `flightpath.workflow.*`.

### Recommended approach

Use the existing workflow-default architecture instead of introducing a one-off flat
settings path:

- Add `workflow.defaultErrorBehavior` to `FlightPathSettings`
- Add the corresponding schema entry to `schemas/settings-schema.json`
- Seed workflow defaults in `PromptFileLoader.populateSettingsDefaults()`
- Let prompt-level `errorBehavior` override workflow-level `errorBehavior`

That keeps `errorBehavior` aligned with the rest of the workflow editing model and avoids
special-case runtime resolution logic.

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

That is why the generic fallback was removed. The issue is false positives, not absence of
error text.

### Key rule

Do **not** implement a generic cross-harness `BaseLogParser.isErrorEvent()` that matches
strings like `429`, `timeout`, or `error`.

Instead, only use:

- explicit harness/session error hooks
- verified session-level log events
- verified headless result objects
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

## Harness Findings

### Claude

#### Interactive

Claude is the strongest candidate for fixing the current hang case.

Current state:

- `ClaudeNotificationMonitor` maps `Stop` and `SessionStart`
- `flightpath-claude-hook.js` only handles those events
- there is no current path for `StopFailure`

Recommended change:

- add `StopFailure` notification support
- write a distinct error notification file
- surface it as `failureKind: "harnessError"`

#### Headless/log fallback

Verified and likely-useful signals:

- `result.is_error === true` is already handled in `ClaudeResponseParser`
- assistant transcript entries can contain top-level `error` plus `isApiErrorMessage`
- `system` entries with `subtype: "api_retry"` look like in-progress status, not terminal failure

Important constraint:

- many Claude logs contain `message.content[].is_error: true` and tool-use error payloads
- those are often tool-level failures, not session-level harness failures

So the log fallback for Claude must remain session-level only. Do not treat generic tool
result errors as harness failures.

### Copilot

#### Interactive

Current state:

- `CopilotNotificationMonitor` maps `agentStop` and `sessionStart`
- no current support for `errorOccurred`

Recommended change:

- add `errorOccurred` hook handling if the hook is available in the active Copilot CLI
- write a distinct error notification file
- surface it as `failureKind: "harnessError"`

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
- for now, rely on process exit and timeout
- only add a session-level fallback after the event shape is verified

### Qwen

Current state:

- local logs show tool and UI telemetry failures
- examples include `toolCallResult.status:"error"` and nested tool response errors

Important constraint:

- those are tool-level failures and would false-positive badly

Recommendation:

- do not implement log-based harness-error detection yet
- rely on process exit and timeout until a verified session-level signal is found

### Gemini

Current state:

- local logs show tool/function response errors
- examples include `functionResponse.response.error` and tool entries with `status:"error"`

Important constraint:

- these are not reliable harness/session failure markers

Recommendation:

- do not implement generic log-based harness-error detection
- rely on process exit and timeout until a verified session-level signal is found

### OpenCode

Current state:

- no local logs were available in this environment
- parser/source-based investigation suggests retry/error fields may exist, but that is not
  yet verified against real logs

Recommendation:

- leave OpenCode fallback unimplemented beyond process exit and timeout until verified

---

## Detection Architecture

### Notification monitors

Current state:

- `NotificationMonitorBase` assumes start/stop completion files
- `NotificationResult` only exposes `completed`, `error?`, and `data?`

Required changes:

- add a discriminator such as `kind: "completed" | "error"`
- allow monitors to watch for `{sessionId}-error.json` in addition to stop files
- map harness-specific error hooks into that structured result

This applies first to:

- Claude `StopFailure`
- Copilot `errorOccurred`

### CLI log monitor

Current state:

- `CliLogMonitor` can resolve success, parsed headless output, or `processExited`
- timeout currently rejects with `"Log monitoring timeout"`

Required changes:

- return a structured timeout failure instead of a generic thrown error
- thread `failureKind` and optional details into the monitor result
- keep notification-monitor completion authoritative where applicable

Recommended `LogMonitorResult` direction:

```typescript
interface LogMonitorResult {
  success: boolean;
  sessionId?: string;
  parsedOutput?: string;
  cliResult?: CliResult;
  failureKind?: FailureKind;
  failureMessage?: string;
  processExited?: { exitCode: number };
}
```

### Failure tracker

Current state:

- `CliFailureTracker` only has process-exit-oriented state

Required changes:

- replace or extend the current booleans with structured failure kind tracking
- preserve the existing user-cancel path
- capture optional harness error details for runtime messages and logs

---

## Workflow Routing

### Desired behavior

When a prompt attempt fails with `failureKind` in:

- `processExit`
- `harnessError`
- `timeout`

then `WorkflowExecutor` should resolve `errorBehavior` and route accordingly.

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

- `src/types/FlightPathTypes.ts`
- `src/types/DashboardConstants.ts`
- `src/types/FlightPathSettings.ts`
- `schemas/prompt-schema.json`
- `schemas/settings-schema.json`
- `src/flightpath/PromptFileParser.ts`
- `src/flightpath/orchestration/PromptFileLoader.ts`
- `src/flightpath/WorkflowInstance.ts`
- `src/ui/WorkflowSerializer.ts`
- `src/completions/PromptPropertyCompletionProvider.ts`
- `src/ui/WebviewSettingsSync.ts`
- `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`

Likely supporting updates:

- prompt/workflow property key lists
- serializer field allowlists
- settings synchronization
- prompt property completions

If the workflow-level default is exposed in the UI, the relevant webview state/types will
need to be updated as well.

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
"flightpath.workflow.defaultErrorBehavior": {
  "type": "object",
  "default": null,
  "description": "Default error behavior for workflow steps when a harness/session failure occurs."
}
```

Schema details should validate:

- `onError`: `"stop" | "retry" | "continue"`
- `maxRetries`: integer, minimum `1`
- `retryDelayMs`: integer, minimum `0`

This should be wired through `FlightPathSettings.workflow.defaultErrorBehavior`, not
through new flat settings like `flightpath.errorBehavior.onError`.

---

## Implementation Order

### Phase 1 - Types, schemas, parser, serializer

1. Add `ErrorBehavior` types to shared workflow types
2. Add `errorBehavior` to execution properties
3. Update prompt schema, settings schema, parser, serializer, and completion plumbing
4. Add `workflow.defaultErrorBehavior` to settings types and settings sync
5. Seed workflow defaults in `PromptFileLoader.populateSettingsDefaults()`

This phase should make the property round-trip correctly before any runtime behavior
changes are introduced.

### Phase 2 - Failure classification plumbing

1. Introduce structured `FailureKind`
2. Extend `CliFailureTracker`
3. Extend `NotificationResult`
4. Extend `CliLogMonitor` result shape
5. Treat prompt timeout as structured failure instead of a generic thrown error

This phase should not yet change retry/continue behavior. It should only make failure
classification explicit.

### Phase 3 - Harness detection

1. Claude: add `StopFailure` notification support
2. Copilot: add `errorOccurred` notification support if supported by the active CLI
3. Claude: tighten session-level fallback parsing only
4. Copilot: add `session.error` fallback parsing only
5. Leave Codex/Qwen/Gemini/OpenCode on process-exit/timeout fallback until verified

This is the smallest safe implementation slice that fixes the known blind spots without
adding broad false-positive log parsing.

### Phase 4 - WorkflowExecutor routing

1. Route `processExit`, `harnessError`, and `timeout` through `errorBehavior`
2. Keep `userCancelled` on the existing cancellation path
3. Implement `retry`
4. Implement `continue`
5. Preserve existing stop behavior as the default

### Phase 5 - UI

1. Add workflow-level default editing
2. Add prompt-level inherit/none/custom editing
3. Add retry-related inputs
4. Add status messaging for retry and continue outcomes

---

## What Not To Build Yet

- generic keyword-based cross-harness error detection
- per-error-type policy branching in the schema
- exponential backoff or jitter
- automatic resume of an errored harness session on retry
- new step status enums unless the existing `FAILED` state proves insufficient

Retries should start a fresh harness attempt, not attempt to recover the broken session.

---

## Open Questions

1. Does Claude `StopFailure` always fire for the interactive unrecoverable-error case, or
   are there cases where only transcript/log evidence is available?
2. Is Copilot `errorOccurred` available and stable in the CLI version FlightPath targets,
   and what exact payload does it provide?
3. For Codex/OpenCode, is there a verified session-level error event that is distinct from
   tool failures? If so, capture the exact event shape before implementing a parser.
4. Should timeout be user-configurable per step in the future, or is routing the existing
   global timeout through `errorBehavior` sufficient for now?

---

## Recommended Shipping Sequence

The highest-value safe slice is:

1. land the schema/parser/serializer/settings work
2. add structured failure classification
3. wire Claude `StopFailure`
4. route process exit and timeout through `errorBehavior`

That fixes the biggest execution gap without depending on speculative log parsing for every
harness.
