# Telemetry Plan

## Overview

Add opt-in telemetry to FlightPath using `@vscode/extension-telemetry`, which wraps
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

export function initTelemetry(extensionId: string, extensionVersion: string): TelemetryReporter {
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

### `workflow/started`
```typescript
reporter.sendTelemetryEvent("workflow/started", {
  harness: "claude-cli",           // HarnessId enum value
  executionMode: "interactive",    // "interactive" | "headless"
  stepCount: "3",                  // number of queued prompts (as string — telemetry values are strings)
  hasFinalStep: "true",
  hasEndCondition: "true",
  resumeSession: "false",
  dynamicQueueEnabled: "false",
  mcpEnabled: "false",
});
```

### `workflow/completed`
```typescript
reporter.sendTelemetryEvent("workflow/completed", {
  harness: "claude-cli",
  executionMode: "interactive",
  outcome: "success",              // "success" | "error" | "cancelled"
  stepCount: "3",
  totalDurationMs: "42000",        // total wall-clock ms
});
```

### `prompt/completed`
Fired once per prompt step. Most granular event — drives per-harness usage analytics.
```typescript
reporter.sendTelemetryEvent("prompt/completed", {
  harness: "claude-cli",
  executionMode: "interactive",
  promptIndex: "0",                // 0-based position in workflow
  durationMs: "14200",
  inputTokens: "8400",             // omit if unavailable for this harness
  outputTokens: "1200",
  cachedInputTokens: "6000",       // omit if 0 or unavailable
  endConditionUsed: "false",
  resumeSession: "false",
  continuationMode: "restart",     // "restart" | "inject" (when CONTINUATION_MODE_PLAN ships)
});
```

### `endcondition/evaluated`
```typescript
reporter.sendTelemetryEvent("endcondition/evaluated", {
  harness: "claude-cli",
  result: "pass",                  // "pass" | "fail"
  attempt: "1",                    // which retry attempt (1 = first try)
  maxRetries: "3",
  durationMs: "850",
});
```

### `cli/not_found`
Signals which harness CLIs users are missing — helps prioritize install docs.
```typescript
reporter.sendTelemetryEvent("cli/not_found", {
  harness: "claude-cli",
});
```

### `error` (use `sendTelemetryErrorEvent`)
```typescript
reporter.sendTelemetryErrorEvent("workflow/error", {
  harness: "claude-cli",
  errorType: "CliProcessCrashed",  // type/class name only, never message
  executionMode: "headless",
});
```

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

Add to `package.json` under `contributes`:
```json
"telemetry": {
  "telemetryLevel": "all"
}
```

Add a brief note to the README and marketplace description:
> FlightPath collects anonymous usage telemetry (harness type, step counts, durations,
> error types) to improve the extension. No prompt content, file paths, or personal data
> are collected. Telemetry respects your VS Code `telemetry.telemetryLevel` setting.

---

## Implementation Checklist

- [ ] Create Azure Application Insights resource, store connection string in `.env` (never commit)
  - Use esbuild `define` to inject `TELEMETRY_CONNECTION_STRING` at build time (same pattern as `IS_DEV_MODE`)
  - In dev builds, use a separate dev Application Insights resource so dev noise is isolated
- [ ] Add `@vscode/extension-telemetry` dependency
- [ ] Create `src/utils/TelemetryReporter.ts` singleton
- [ ] Initialize in `extension.ts` activate, dispose in deactivate
- [ ] Add `workflow/started` + `workflow/completed` events to `WorkflowExecutor`
- [ ] Add `prompt/completed` event to `CliIntegration` / `HarnessIntegration` after each step
- [ ] Add `endcondition/evaluated` to `EndConditionHandler`
- [ ] Add `cli/not_found` to harness availability checks
- [ ] Add error events to key catch blocks
- [ ] Update README + marketplace description with disclosure text
- [ ] Verify events appear in Application Insights Live Metrics before shipping
