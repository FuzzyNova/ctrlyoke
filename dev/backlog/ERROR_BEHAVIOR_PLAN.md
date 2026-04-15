# Error Behavior Plan

## Problem

When a harness throws an error (rate limit, server timeout, network failure, invalid model,
API key error), FlightPath currently does one thing: stop the workflow. There is no way to
configure retry behavior or continue to the next step. Additionally, some error conditions
are not detected at all:

- **Interactive mode bug**: If a CLI harness surfaces an error inside its TUI while keeping
  the process alive (the TUI does not exit), FlightPath never receives a PTY exit event and
  just keeps waiting for the Stop hook forever. The error is visible to the user in the TUI
  but FlightPath is stuck.

- **Headless mode**: Claude CLI already emits `"type": "result", "is_error": true` in its
  JSON output — FlightPath's `ClaudeResponseParser` detects and surfaces this, but then
  always stops the workflow regardless.

- **No retry logic for transient errors**: Rate limits and server timeouts are transient.
  There is no mechanism to retry the same step after a brief delay.

---

## Scope of This Feature

`errorBehavior` is a new `ExecutionProperties` field that controls what happens when the
**harness itself** fails — not when an end condition script fails. The distinction matters:

| Situation                           | Mechanism           | Notes                                       |
| ----------------------------------- | ------------------- | ------------------------------------------- |
| End condition script returns false  | `endCondition`      | Existing — script-based validation          |
| Pre-condition script returns false  | `preCondition`      | Existing — gate before prompt runs          |
| `type: script` step fails           | `onFail`            | Existing — inline script step               |
| **Harness process errors/crashes**  | **`errorBehavior`** | New — "did the AI CLI itself fail?"         |

---

## Schema: `errorBehavior` on `PromptItem`

```yaml
steps:
  - name: implement
    prompt: Implement the feature.
    errorBehavior:
      onError: retry           # stop | retry | continue
      maxRetries: 3            # only relevant when onError: retry
      retryDelayMs: 5000       # optional, ms to wait before retry (default: 2000)
```

### `onError` Options

| Value      | Behavior                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `stop`     | Stop the workflow and mark the step as failed (current behavior — default)                      |
| `retry`    | Re-run the same step (with optional delay). After `maxRetries` exhausted, stops the workflow.   |
| `continue` | Log the error as a warning, mark step as failed, advance to the next step in the queue.         |

### Why Not Extend `endCondition`?

`endCondition` requires a script and operates on AI output, not on harness process state.
Detecting a rate limit error requires observing the process exit code or parsing JSON from
the harness itself — not running a user script against AI text. Combining them would make
`endCondition` a different kind of object depending on whether a script is provided, which
is clunky and confusing. Keep them separate.

---

## TypeScript Types

```typescript
// FlightPathTypes.ts additions

export type ErrorBehaviorAction = "stop" | "retry" | "continue";

export interface ErrorBehavior {
  /** What to do when the harness itself errors. Default: "stop". */
  onError: ErrorBehaviorAction;
  /** Maximum retry attempts when onError is "retry". Default: 1. */
  maxRetries?: number;
  /** Delay in ms before each retry. Default: 2000. */
  retryDelayMs?: number;
}

// Add to ExecutionProperties:
errorBehavior?: ErrorBehavior | null;
// null = explicitly disable inherited errorBehavior (same pattern as endCondition)
```

---

## Error Detection Research

### Current State

`CliFailureTracker` tracks one kind of harness failure: **PTY process exit before completion**.
When the PTY exits unexpectedly (non-zero exit code, crash), `WorkflowExecutor` calls
`wasLastFailureProcessExit()` and currently always stops the workflow.

The gap: some errors leave the TUI process alive. The process doesn't exit; the TUI just
renders an error message. FlightPath keeps waiting for the Stop hook indefinitely.

### Detection Strategy Per Harness

#### Claude CLI (interactive)

Claude has two hook events:
- `Stop` — fires whenever the agent stops (normal completion OR error)
- `StopFailure` — fires specifically when the agent stopped due to an error

**Current state**: `ClaudeNotificationMonitor` only registers `Stop`. It does not register
`StopFailure`. This means:

1. Normal completion: `Stop` fires → FlightPath detects completion ✅
2. Error (TUI stays open): If only `StopFailure` fires but not `Stop`, FlightPath waits
   forever ❌
3. Error (process exits): PTY exit detected → stop workflow ✅

**Fix**: Register `StopFailure` in `ClaudeNotificationMonitor`. When `StopFailure` is
received instead of `Stop`, signal a harness error (not just a completion). This is the
primary fix for the interactive hang bug.

The `StopFailure` hook payload (from Claude's source) looks like:
```json
{
  "hook_event_name": "StopFailure",
  "error": "rate_limit",  // same enum as assistant.error
  "error_details": "HTTP 429: Too many requests",
  "last_assistant_message": "...",
  "session_id": "..."
}
```

The `flightpath-claude-hook.js` script needs to write a notification file that:
- Uses a distinct filename suffix: `{sessionId}-error.json`
- Includes `{ hookEvent: "StopFailure", sessionId, status: "error", errorType: "rate_limit", errorDetails: "..." }`

`CliLogMonitor` / `ClaudeNotificationMonitor` needs to distinguish error notifications from
completion notifications when reading the notification directory. The `NotificationResult`
type needs an `isError` flag or a `kind: "completed" | "error"` discriminator.

#### Claude CLI (headless)

`ClaudeResponseParser.parse()` already detects `is_error: true` in the `result` JSON object.
Based on Claude's source code, the `result` type has specific error subtypes:

```json
{
  "type": "result",
  "subtype": "error_during_execution",  // or error_max_turns, error_max_budget_usd
  "is_error": true,
  "errors": ["[ede_diagnostic] result_type=X last_content_type=Y stop_reason=Z"],
  "session_id": "..."
}
```

There's also a `system` message type for **in-progress** API retries that Claude handles
internally:
```json
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 2,
  "max_retries": 5,
  "retry_delay_ms": 10000,
  "error_status": 429,
  "error": "rate_limit",
  "session_id": "..."
}
```
This fires while Claude is internally retrying — FlightPath could surface this to the user
("Claude is retrying due to rate limit, attempt 2/5") rather than just showing a frozen TUI.

And the `assistant` message itself has an `error` field (non-null on error):
```json
{
  "type": "assistant",
  "message": { ... },
  "error": "rate_limit",   // "authentication_failed" | "billing_error" | "rate_limit" |
                            // "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  "session_id": "..."
}
```

**Current detection gaps in `ClaudeResponseParser`**:
- Does not check `result.subtype` (only `is_error`)
- Does not check `assistant.error` field
- Does not surface `system/api_retry` events to the user

**Recommended additions to `ClaudeResponseParser`**:
1. Check `json.subtype` on result objects for error classification (rate_limit vs. execution error)
2. Check `json.error` on assistant messages as an early error signal
3. Emit a user-visible status event for `api_retry` system messages

**No changes needed for base detection** — just routing changes in `WorkflowExecutor` and
enhanced classification.

#### Copilot CLI (interactive)

Copilot CLI has an `errorOccurred` hook event (distinct from `agentStop`). This hook fires
when an error occurs during agent execution, giving us a clean signal.

**Current state**: `CopilotNotificationMonitor.EVENT_MAP` does not include `errorOccurred`.
The stop hook (`agentStop`) may or may not fire on error.

**Fix**: Add `errorOccurred` to Copilot's hook config and notification monitoring. When
`errorOccurred` fires, signal a harness error. This requires:
1. Adding `errorOccurred` to `CopilotNotificationMonitor.EVENT_MAP`
2. Updating `buildHookConfig()` to register an `errorOccurred` handler
3. Writing `{sessionId}-error.json` notification from the hook script

**Note**: Copilot's `errorOccurred` is documented but untested. Manual testing with internet
disconnection mid-prompt is the only reliable way to verify the payload format and confirm
it fires before vs. after `agentStop`.

#### Copilot CLI (headless)

Copilot uses JSONL log files monitored by `CopilotLogParser`. Error events in the log likely
have a `turn.error` or similar event type. **Research needed**: manually test a Copilot
failure and inspect the log file in `~/.vscode-copilot/logs/`. The process exit code
(non-zero) is a reliable fallback.

#### Codex CLI

Codex uses JSONL streaming events. The `notify` hook fires on completion. For errors, the
process likely exits with a non-zero code — check `CodexNotificationMonitor`. The `exitCode`
from PTY exit is the primary detection mechanism for Codex.

The Codex source is open source. Its error event format should be checkable in the Codex
repository. Error events in JSONL likely appear as `{ "type": "error", "message": "..." }`.

#### OpenCode CLI (open source)

OpenCode uses JSONL events + a plugin for completion detection. Its source code can be
explored at the OpenCode repository. Error events in its JSONL stream likely include an
`error` type or a `state: "error"` field. OpenCode is open source — check the JSONL
event schema before implementing.

#### Qwen Code CLI (open source)

Similar JSONL event stream as OpenCode. Check source code for error event types. Qwen's
log parser (`QwenLogParser`) already reads JSONL events — extend `isError()` detection
there.

#### Gemini CLI (open source)

Gemini uses JSON streaming similar to Claude. Check its source for error event types in
the streaming output. `GeminiLogParser` and `GeminiResponseParser` are the relevant files.

### Log-Based Error Pattern (Cross-Harness Fallback)

As a last resort, all harnesses write to log files. Common error patterns across logs:

- Rate limit: typically contains "rate limit", "429", "too many requests"
- Server timeout: "timeout", "503", "service unavailable"
- Invalid model: "model not found", "invalid model"
- Auth failure: "401", "unauthorized", "authentication"

A `BaseLogParser.isErrorEvent()` method can be added as a hook for harnesses to override,
parsing error-type events from their logs. This is a fallback for harnesses where dedicated
error hooks are unavailable or untested.

### The "TUI Stays Open" Bug (Root Cause)

In interactive mode, when a harness encounters a recoverable error (e.g., a rate limit that
it will retry internally), it may:
1. Show the error in the TUI
2. Retry automatically (without exiting)
3. Eventually succeed → Stop hook fires normally ✅

But when the error is unrecoverable:
1. Show the error in the TUI
2. Keep the TUI open (waiting for user input, or in a broken state)
3. Stop hook may or may not fire

The `StopFailure` hook (Claude) and `errorOccurred` hook (Copilot) are specifically designed
for case 2. Wiring them up is the fix. For harnesses without dedicated error hooks, we need
a log-based polling approach or a timeout mechanism.

**Potential timeout approach**: If a `maxPromptExecutionTime` passes with no Stop hook and
no completion event in the log, treat it as a harness error. This is already partially
implemented (`ConfigurationUtils.getMaxPromptExecutionTimeMs()`), but it just rejects with
"Log monitoring timeout" which is caught and treated as a hard failure. With `errorBehavior`,
a timeout could trigger retry logic.

---

## WorkflowExecutor Changes

Currently, all harness errors go through one of two paths:
1. `wasLastFailureProcessExit()` → stop workflow
2. `wasLastFailureUserCancellation()` → cancel, stop workflow
3. Neither (general failure) → `markErrored()`, stop workflow

With `errorBehavior`, path 1 and 3 need to be intercepted:

```typescript
// Conceptual change in WorkflowExecutor.executeStep()

const resolvedErrorBehavior = propertyResolver.resolveErrorBehavior(prompt, workflow);
const onError = resolvedErrorBehavior?.onError ?? "stop";

if (harnessErrored) {
  if (onError === "continue") {
    // Mark step as failed, log warning, advance to next step
    runtime.failAttempt(target, attemptIndex, failureReason);
    // Do NOT call runtime.fail() — continue queue
    continue;
  }
  
  if (onError === "retry") {
    const maxRetries = resolvedErrorBehavior?.maxRetries ?? 1;
    const retryDelayMs = resolvedErrorBehavior?.retryDelayMs ?? 2000;
    if (attemptIndex < maxRetries) {
      await delay(retryDelayMs);
      continue; // retry the same step
    }
    // Exhausted retries — fall through to stop
  }
  
  // Default: stop
  runtime.failAttempt(target, attemptIndex, failureReason);
  runtime.fail();
  return;
}
```

The `propertyResolver` gets a new `resolveErrorBehavior()` method following the three-tier
precedence (prompt > workflow > settings). A global default can be added to VS Code settings.

---

## HarnessIntegration Classification

`HarnessIntegration` needs a way to distinguish harness errors from other failures.
Add a method or property:

```typescript
// HarnessIntegration.ts (abstract base)
abstract wasLastFailureHarnessError(): boolean;
getLastHarnessErrorMessage(): string | undefined;
```

Or, extend the existing failure reason system with an error kind enum:

```typescript
export type FailureKind = 
  | "userCancelled"
  | "processExit"
  | "harnessError"     // NEW: harness signaled error via hook or JSON
  | "timeout"          // NEW: prompt execution timed out
  | "unknown";
```

`CliFailureTracker` currently tracks `processExitTermination` (number) and derives
`wasLastFailureProcessExit()`. Extend it to also track `harnessError` state with an
optional error message.

---

## UI Changes

### WorkflowPropertiesPanel and PropertiesDrawer

Both panels share the validation/execution section. Add below the existing `endCondition`
section:

**`errorBehavior` dropdown** (replaces old hardcoded "stop" behavior):
- Label: "On Harness Error"
- Options: "Stop Workflow" (default), "Retry", "Continue to Next Step"
- Applies to prompt steps only (not script steps — those already have `onFail`)

**`maxRetries` number input** (shown only when option is "Retry"):
- Label: "Max Retries"
- Default: 1
- Min: 1, Max: 10

**`retryDelayMs` number input** (shown only when option is "Retry", optional):
- Label: "Retry Delay (ms)"
- Default: 2000
- Only shown if user wants to customize; could be an expandable advanced section

The UI pattern follows the existing `endCondition` section layout:
- Collapsed/hidden when `onError: "stop"` (the default, no additional config needed)
- Expanded with `maxRetries` + `retryDelayMs` inputs when `onError: "retry"`

### Step Status Display

When a step fails with a harness error and `onError: "continue"`, the step icon should
show a distinct warning state (yellow, not red) — "error but continued" vs. "error that
stopped everything". This requires a new `STEP_STATUS.ERROR_CONTINUED` or similar, or
reuse the existing `STEP_STATUS.FAILED` with a different message.

When retrying, show `STEP_STATUS.RUNNING` on the retry attempt. The step label should
show "Retry 1/3" similar to how `endCondition` retries are displayed.

---

## Settings

Add global defaults to VS Code settings:

```json
"flightpath.errorBehavior.onError": {
  "type": "string",
  "enum": ["stop", "retry", "continue"],
  "default": "stop",
  "description": "Default action when a harness error occurs. Can be overridden per-workflow or per-step."
},
"flightpath.errorBehavior.maxRetries": {
  "type": "number",
  "default": 1,
  "description": "Default maximum retries when errorBehavior.onError is 'retry'."
},
"flightpath.errorBehavior.retryDelayMs": {
  "type": "number", 
  "default": 2000,
  "description": "Default delay (ms) between error retries."
}
```

---

## Implementation Order

### Phase 1 — Schema + Types (no behavior change)
1. Add `ErrorBehavior` interface and `ErrorBehaviorAction` type to `FlightPathTypes.ts`
2. Add `errorBehavior?: ErrorBehavior | null` to `ExecutionProperties`
3. Add to `schemas/prompt-schema.json` with descriptions and enum
4. Run `npm run generate-schema`
5. Add to `PropertyResolver.resolveErrorBehavior()`

### Phase 2 — Error Detection (Claude first)
1. Add `StopFailure` to `ClaudeNotificationMonitor.buildHookConfig()`
2. Update `flightpath-claude-hook.js` to write `{sessionId}-error.json` for `StopFailure`
3. Update `NotificationMonitorBase.monitorForCompletion()` to distinguish completion vs. error
4. Extend `CliFailureTracker` with `harnessError` state + message
5. Thread the error kind through `CliLogMonitor` result → `WorkflowExecutor`
6. Test with internet disconnection mid-prompt (Claude)

### Phase 3 — Error Detection (other harnesses)
1. Copilot: Add `errorOccurred` hook + notification file
2. Research Codex/OpenCode/Qwen/Gemini error event formats (open source codebases)
3. Add log-based `isErrorEvent()` to each log parser for cross-harness fallback
4. Headless: `ClaudeResponseParser` already works — just ensure error kind is set

### Phase 4 — WorkflowExecutor Routing
1. Extend `executeStep()` to read resolved `errorBehavior`
2. Implement `continue` path (skip `runtime.fail()`, advance queue)
3. Implement `retry` path (loop with delay, up to maxRetries)
4. Add retry attempt counter to `PromptRuntimeMetadata`
5. Update step status messages for retry/continue cases

### Phase 5 — UI
1. Add `errorBehavior` dropdown to `WorkflowPropertiesPanel`
2. Add `errorBehavior` dropdown to `PropertiesDrawer`
3. Conditional `maxRetries` + `retryDelayMs` inputs
4. Step retry display in prompt list ("Retry 2/3")
5. VS Code settings additions

---

## What NOT to Build (Now)

- **Smart backoff**: Fixed delay only. Exponential backoff or jitter can be added later.
- **Error type discrimination**: Don't try to classify rate limits vs. timeouts vs. auth
  failures differently in the schema. One `onError` action applies to all harness errors.
  Users who need different behavior for different error types can use `endCondition` with
  a script that inspects the AI's output.
- **Circuit breaker**: Don't add a "pause workflow for N minutes then retry" mechanism.
- **Session recovery on retry**: When retrying after a harness error, do NOT resume the
  errored session. Start a fresh session. The errored session may be in a broken state.

---

## Open Questions

1. **Does Claude's `StopFailure` hook actually fire when the TUI stays open?** This needs
   manual testing — connect Claude, start a long prompt, kill the network, observe whether
   `StopFailure` fires while the TUI is still visible. The Claude source code at
   `C:\dev\claude-code-main` should be explored to understand the hook firing conditions.

2. **What does Copilot's `errorOccurred` hook payload look like?** The hook is documented
   but not tested in FlightPath. Manual testing required.

3. **Does the PTY exit always occur after `StopFailure`, or can they be independent?**
   If both fire, we need to handle the race condition where `StopFailure` (harness error)
   and PTY exit (process died) both arrive.

4. **Codex/OpenCode/Qwen/Gemini error formats**: Need source code exploration or manual
   testing to determine reliable error event signatures before implementing log parsers.

---

## Effort Estimate

- Phase 1 (schema + types): ~2h
- Phase 2 (Claude error detection + bug fix): ~1 day (includes testing)
- Phase 3 (other harnesses): ~1.5 days (research + implementation)
- Phase 4 (WorkflowExecutor routing): ~4h
- Phase 5 (UI): ~4h

Total: ~3.5 days for full feature. Phase 2 alone (Claude fix for the TUI hang bug) is
the highest priority and can ship independently before the `errorBehavior` schema is
complete.
