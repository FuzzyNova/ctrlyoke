# Telemetry Plan

## Overview

Add opt-in telemetry to ctrlyoke using `@vscode/extension-telemetry`, which wraps
Azure Application Insights and automatically respects the user's VS Code
`telemetry.telemetryLevel` setting. No custom consent UI required — VS Code handles it.

**Azure Application Insights free tier:** 5 GB/month ingestion, 90-day retention.
Sufficient for a new extension with a modest user base.

---

## Setup

### 1. Azure

1. Create an Azure account (free tier)
2. Create an **Application Insights** resource (Classic or workspace-based)
3. Copy the **Connection String** (not the old Instrumentation Key — the connection string
   is the current standard and works with `@vscode/extension-telemetry` v0.9+)

### 2. Package

```bash
npm install @vscode/extension-telemetry
```

### 3. TelemetryReporter singleton

Create `src/utils/TelemetryReporter.ts`:

```typescript
import TelemetryReporter from "@vscode/extension-telemetry";

const CONNECTION_STRING = "InstrumentationKey=...;IngestionEndpoint=..."; // from Azure portal

let reporter: TelemetryReporter | undefined;

export function initTelemetry(
  extensionId: string,
  extensionVersion: string
): TelemetryReporter {
  reporter = new TelemetryReporter(CONNECTION_STRING);
  return reporter;
}

export function getTelemetry(): TelemetryReporter | undefined {
  return reporter;
}

export function disposeTelemetry(): void {
  reporter?.dispose();
  reporter = undefined;
}
```

Initialize in `extension.ts` `activate()`, dispose in `deactivate()`.

The reporter automatically:

- Checks `vscode.env.isTelemetryEnabled` before every send
- Respects `telemetry.telemetryLevel` (off / error / crash / all)
- Strips PII from stack traces
- Batches and retries sends

---

## Privacy Rules (Non-Negotiable)

**Never send:**

- Prompt text or content
- File paths or workspace names
- Model output or response text
- Session IDs or UUIDs
- Any user-generated string

**Safe to send:**

- Enum values (harness ID, execution mode, end condition result)
- Counts and durations (step count, token count, elapsed ms)
- Boolean flags (feature was enabled/disabled)
- Error type strings (not messages — messages may contain user data)
- Extension version, VS Code version, OS platform (auto-added by the reporter)

---

## Events to Track

> **Sanity-check pass (2026-09-08):** the schemas below were revised after reviewing actual
> insertion points in the codebase, not just the original speculative draft. Key changes:
> - Outcome/failure fields now reuse existing enums (`FAILURE_KINDS`, `STEP_STATUS`,
>   `WORKFLOW_RUNTIME_COMMANDS`) instead of inventing new string literals, per the project's
>   "no hardcoded strings for flow control" rule.
> - `prompt/completed` gained an `outcome`/`failureKind` pair — the original draft silently
>   assumed every prompt succeeds.
> - `continuationMode: "restart"|"inject"` was dropped: that setting exists
>   (`execution.continuationMode` from `CONTINUATION_MODE_PLAN.md`) but nothing in the
>   per-step runtime path exposes it as cheaply as the boolean `injectMode` signal
>   (`ConfigurationUtils.isInjectModeEnabled()` / `CliIntegration`'s per-call `injectMode`
>   flag) already used at the real per-step decision point — using that instead.
> - `dynamicQueueEnabled` was redefined to mean "workflow has parallel groups configured"
>   (`state.parallelGroups.length > 0`) — the original name didn't map to any single existing
>   flag; this is the closest real, cheap-to-read boolean.
> - Token usage (`inputTokens`/`outputTokens`/`cachedInputTokens`) is **not wired in the first
>   pass** — the cheapest correct hook for `prompt/completed` (`PromptQueue.markPromptCompleted`)
>   doesn't have per-step `TokenUsage` in scope, and reaching into the usage-tracking services
>   from there would be a much larger, riskier change. Tracked as a follow-up.
> - Added `extension/activationFailed` (see Error Events below) — the original list had no
>   signal for "the extension didn't come up," which the existing top-level catch in
>   `extension.ts`'s `activate()` currently swallows with just a log line + toast.
> - **Cut:** a generic command-handler error-wrapper (to catch errors in the ~10 individual
>   `vscode.commands.registerCommand` catch blocks in `extension.ts` uniformly) was considered
>   and deliberately deferred — touching every command registration is a much larger, separate
>   refactor with its own risk, disproportionate to this pass.
> - **Hard limit (not fixable by this plan):** true process crashes (extension-host V8 heap
>   OOM, native Electron crashes) cannot be captured by in-process telemetry at all — the
>   process dies before anything flushes. That failure mode is already covered separately by
>   VS Code/Electron's own crash reporter (see `copilot-instructions.md`'s crash-investigation
>   section on `%APPDATA%\Code\Crashpad\reports\*.dmp`). This plan only adds telemetry for
>   *handled* errors/exceptions.

### `workflow/started`

Fired from `WorkflowInstance.onRuntimeTransition` on `WORKFLOW_RUNTIME_COMMANDS.START_EXECUTION`
(the one-shot true start; `RESUME` from a pause is a separate command and does not refire this).

```typescript
reporter.sendTelemetryEvent("workflow/started", {
  harness: "claude-cli", // PropertyResolver.resolveHarnessValue(undefined, workflowFile.harness)
  executionMode: "interactive", // PropertyResolver.resolveExecutionMode(...)
  stepCount: "3", // state.steps.length
  hasFinalStep: "true", // workflowFile.finalStep present and enabled !== false
  hasEndCondition: "true", // workflow- or any step-level endCondition set
  resumeSession: "false", // workflow-level default
  dynamicQueueEnabled: "false", // state.parallelGroups.length > 0 (see note above)
  mcpEnabled: "false", // workflowFile.mcpServers non-empty
});
```

### `workflow/completed`

Fired from the same `onRuntimeTransition` funnel, only on the true terminal commands:
`COMPLETE` → success, `FAIL` → error, `CONFIRM_STOPPED` → cancelled. (`REQUEST_STOP` is the
request, not yet applied, and must not fire this.)

```typescript
reporter.sendTelemetryEvent("workflow/completed", {
  harness: "claude-cli",
  executionMode: "interactive",
  outcome: "success", // "success" | "error" | "cancelled", mapped from WORKFLOW_RUNTIME_COMMANDS
  stepCount: "3",
  totalDurationMs: "42000", // workflowRuntime.getActiveExecutionTime() — excludes paused time
});
```

### `prompt/completed`

Fired once per prompt step from `PromptQueue.markPromptCompleted()` — the single funnel already
called by `completeStepState`/`failStepState`/`cancelStepState`/`skipStepState`, so no new call
sites are needed inside `WorkflowExecutor`'s many status-transition branches.

```typescript
reporter.sendTelemetryEvent("prompt/completed", {
  harness: "claude-cli", // from the merged PromptRuntimeMetadata (ExecutionProperties)
  executionMode: "interactive",
  promptIndex: "0", // the stepIndex passed to markPromptCompleted
  durationMs: "14200", // completedAt - startedAt, both already on PromptRuntimeMetadata
  outcome: "completed", // terminalStatus: "completed" | "failed" | "cancelled" | "skipped"
  failureKind: "harnessError", // PromptRuntimeMetadata.failureKind (FAILURE_KINDS), omitted when outcome is not "failed"
  endConditionUsed: "false", // step.endCondition != null
  resumeSession: "false",
  injectMode: "false", // whether this attempt reused a live PTY via inject mode
  // inputTokens / outputTokens / cachedInputTokens: deferred, see note above
});
```

### `endcondition/evaluated`

Fired from `EndConditionHandler.recordEndConditionEvaluation()` — the single funnel already
shared by the passing, failing, and errored paths.

```typescript
reporter.sendTelemetryEvent("endcondition/evaluated", {
  harness: "claude-cli", // PropertyResolver.resolveHarnessValue(prompt.harness, undefined)
  result: "pass", // "pass" | "fail" | "error" (evaluationResult.errored adds a third state the original draft missed)
  attempt: "1", // promptQueue.getCurrentRetryCount(target) + 1 (1 = first evaluation)
  maxRetries: "3", // promptQueue.getEffectiveMaxRetries(prompt)
  durationMs: "850", // evaluationResult.duration
});
```

### `cli/not_found`

Signals which harness CLIs users are missing — helps prioritize install docs. Fired from
`CliIntegration.handleInitializationError()`, the single funnel for both the "not available"
and "exception during check" branches of `initialize()`.

```typescript
reporter.sendTelemetryEvent("cli/not_found", {
  harness: "claude-cli", // this.provider.config.harnessId
});
```

### Error events (use `sendTelemetryErrorEvent`)

```typescript
reporter.sendTelemetryErrorEvent("extension/activationFailed", {
  errorType: "TypeError", // error.constructor.name — never the message
});
```

`extension/activationFailed` fires from `extension.ts`'s top-level `activate()` catch block
(previously just `Log.error` + a toast, no telemetry — the extension failing to come up at all
had zero signal). A generic `workflow/error`/per-command error event was considered for the
~10 scattered command-handler catch blocks but deferred — see the sanity-check note above.

---

## What NOT to Track (Deferred)

These are tempting but premature or risky:

- **Terminal follow-up detection** — requires passive observation; revisit after
  TERMINAL_FOLLOWUP_TRACKING_PLAN is evaluated
- **Prompt content or length** — PII risk; token counts are a safe proxy for size
- **Agent/skill names** — user-defined strings; could contain PII
- **MCP server IDs** — same risk
- **End condition script names** — file path fragments; PII risk

---

## Disclosure

> **Correction (verified 2026-09-08):** there is no `contributes.telemetry.telemetryLevel`
> field in the VS Code extension manifest — this was not a real contribution point. The
> actual optional mechanism is a `telemetry.json` file at the extension root, which lets
> users dump declared telemetry events via the `--telemetry` CLI flag. Add it once real
> events exist (it documents event schemas), not as part of the foundation work. See
> https://code.visualstudio.com/api/extension-guides/telemetry.

Add a brief note to the README and marketplace description:

> ctrlyoke collects limited usage telemetry (harness type, step counts, durations, error
> types, and standard environment metadata such as extension/VS Code version and OS) to
> improve the extension. It does not collect prompt content, code, file paths, or workspace
> names. Telemetry respects your VS Code `telemetry.telemetryLevel` setting — set it to `off`
> to disable. See our Privacy Policy at `ctrlyoke.dev/privacy` for details.

> **Wording note:** Do not describe the telemetry as "anonymous" or claim "no personal data
> is collected." The `@vscode/extension-telemetry` library attaches a VS Code machine
> identifier, which is pseudonymous personal data. `PRIVACY_POLICY_FINAL.md` §3.1
> deliberately avoids the "anonymous" framing — README, marketplace, and any marketing copy
> must match it to avoid contradicting the published policy.

---

## Implementation Checklist

- [x] Create Azure Application Insights resource, store connection string in `.env` (never commit)
  - Use esbuild `define` to inject `TELEMETRY_CONNECTION_STRING` at build time (same pattern as `IS_DEV_MODE`)
  - In dev builds, use a separate dev Application Insights resource so dev noise is isolated
  - Resource group `ctrlyoke` (Azure subscription 1, East US): `ctrlyoke-telemetry` (prod) + `ctrlyoke-telemetry-dev` (dev)
- [x] Add `@vscode/extension-telemetry` dependency
- [x] Create `src/utils/TelemetryReporter.ts` singleton
- [x] Initialize in `extension.ts` activate, dispose in deactivate
- [x] Add `workflow/started` + `workflow/completed` events to `WorkflowInstance.onRuntimeTransition`
- [x] Add `prompt/completed` event to `PromptQueue.markPromptCompleted`
- [x] Add `endcondition/evaluated` to `EndConditionHandler.recordEndConditionEvaluation`
- [x] Add `cli/not_found` to `CliIntegration.handleInitializationError`
- [x] Add `extension/activationFailed` to `extension.ts`'s top-level activate() catch
- [x] Update README with disclosure text (marketplace listing renders the README directly, so no separate marketplace-only copy is needed; `PRIVACY.md` §3.1 already covered this accurately)
- [ ] Optionally add a `telemetry.json` at the extension root once events are defined (not a package.json field — see Disclosure note above)
- [ ] Verify events appear in Application Insights Live Metrics before shipping
- [ ] Follow-up (not in this pass): wire `inputTokens`/`outputTokens`/`cachedInputTokens` into `prompt/completed`
- [ ] Follow-up (not in this pass): generic command-handler error telemetry across `extension.ts`'s `registerCommand` catch blocks
