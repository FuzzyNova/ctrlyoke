# Per-Instance Harness Integrations

**Status**: Implemented
**Date**: 2026-02-27

---

## The Problem This Solves

`WorkflowOrchestrator` maintains 4 shared `HarnessIntegration` **detector singletons** at startup
(copilot-cli, claude-cli, codex-cli, copilot-chat). Without per-instance execution integrations,
parallel workflows sharing the same harness type would clash on these shared fields:

| Shared field                                | Location                  | Failure                                                                                                 |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `responseCompleteEmitter`                   | `HarnessIntegration` base | All N workflows subscribe to the **same emitter** — any completion fires all N                          |
| `streamingChunkEmitter`                     | `HarnessIntegration` base | All streaming output is broadcast to all listeners                                                      |
| `streamingEventsEmitter`                    | `HarnessIntegration` base | Same for structured events                                                                              |
| `isCancelling`                              | `HarnessIntegration` base | Cancelling one workflow cancels all                                                                     |
| `workflowStep` / `totalSteps`               | `HarnessIntegration` base | Last writer wins                                                                                        |
| `currentProcess?: ChildProcess`             | `CliIntegration`          | Workflow 2 overwrites workflow 1's process reference — unpausable/uncancellable                         |
| `currentExecution?: TerminalShellExecution` | `CliIntegration`          | Same for interactive mode                                                                               |
| `lastResult` / `lastParsedOutput`           | `CliIntegration`          | Workflow 5 overwrites workflow 3's result before it's read                                              |
| `processManager` (one terminal)             | `CliIntegration`          | Interactive mode: each new workflow calls `disposeTerminalIfExists()` → kills prior workflow's terminal |

---

## Architecture: Detector vs. Executor Split

| Role         | Instances                                     | Lifetime                               | Used For                                                                                         |
| ------------ | --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Detector** | 4 singletons in `WorkflowOrchestrator`        | Extension lifetime                     | `onDidChangeStatus`, status bar, harness availability UI, `getDetailedStatus()` pre-flight check |
| **Executor** | 1 created per workflow run (per harness used) | Duration of `startWorkflowExecution()` | `sendPrompt`, event streaming, `cancel`, process tracking                                        |

The 4 detector singletons are never used for execution. Each `startWorkflowExecution()` call
creates fresh execution integrations via `IntegrationFactory.createForExecution()`, uses them for
the run, then disposes them in the `finally` block.

---

## Key Implementation Details

### `HarnessIntegration.ts` — `registerWithContext` + `dispose()` + `markAsReady()`

The constructor accepts `registerWithContext: boolean = true`:

- Detector singletons pass `true` (default) — emitters registered with `context.subscriptions` so VS Code disposes them on deactivation.
- Execution integrations pass `false` — avoids accumulating disposables in `context.subscriptions` across many runs.

`dispose()` manually disposes all 5 emitters (`statusChangeEmitter`, `responseCompleteEmitter`,
`streamingChunkEmitter`, `streamingEventsEmitter`, `promptReadyEmitter`).

`markAsReady()` sets `isAvailable = true` and `initializationStatus = HarnessStatus.Ready` without
firing events, so execution integrations skip `initialize()` (the detector has already confirmed
harness availability).

### `IntegrationFactory.createForExecution(harness)`

```typescript
createForExecution(harness: Harness): HarnessIntegration {
  const integration = this.createForHarness(harness, false); // skip context registration
  integration.markAsReady(); // trust detector's confirmed status
  return integration;
}
```

### `WorkflowInstance` — Execution Integration Lifecycle

`WorkflowInstance` receives:

- `integrationFactory: IntegrationFactory` — for creating execution integrations
- `getDetectorIntegration: (harness?: Harness) => HarnessIntegration` — for pre-flight status
  checks only (reads already-initialized detector singletons)

`executionIntegrations: Map<Harness, HarnessIntegration>` tracks all integrations created during a
run. `createIntegrationForMode()` looks up or creates one per harness used:

```typescript
private createIntegrationForMode(modeOverride?: Harness): HarnessIntegration {
  const harness = modeOverride ?? ConfigurationUtils.getIntegrationMode();
  const cached = this.executionIntegrations.get(harness);
  if (cached) return cached;
  const integration = this.integrationFactory.createForExecution(harness);
  integration.setWorkflowName(this.workflowName);
  this.executionIntegrations.set(harness, integration);
  return integration;
}
```

The `finally` block in `startWorkflowExecution()` disposes all tracked execution integrations:

```typescript
} finally {
  for (const execIntegration of this.executionIntegrations.values()) {
    execIntegration.dispose();
  }
  // ... history finalization
}
```

### `WorkflowOrchestrator` — `buildWorkflowInstance()` + `resolveDetectorIntegration()`

`buildWorkflowInstance()` passes `this.integrationFactory` and a `getDetectorIntegration` lambda
to the `WorkflowInstance` constructor.

`resolveDetectorIntegration()` (formerly `resolveIntegration()`) returns the detector singletons.
It is never called from execution paths.

---

## Per-Prompt Harness Switching

When a prompt uses a harness override, `createIntegrationForMode()` creates a fresh execution
integration for that harness. All integrations created during the run are tracked in
`executionIntegrations` and disposed together in the `finally` block.

---

## What Does NOT Change

| Concern                                         | Status                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| Single-workflow UX                              | Identical                                           |
| Harness availability UI                         | Uses detector singletons unchanged                  |
| Status bar                                      | Uses `getDefaultIntegration()` → detector singleton |
| `openPanel()` / `retryHarnessDetection()`       | Detector singletons unchanged                       |
| `getDetailedStatus()` in settings panel         | Detector singleton state                            |
| `WorkflowExecutor`                              | No changes                                          |
| `EndConditionHandler` / `EndConditionEvaluator` | No changes                                          |
| `PromptQueue` / `PromptFileParser`              | No changes                                          |
| MCP server                                      | No changes                                          |
| React webview / dashboard                       | No changes                                          |

---

## Recommended Test Coverage (Not Yet Added)

| Test                                                      | What to verify                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution integration disposed after run completes        | Mock `IntegrationFactory.createForExecution()`, run `startWorkflowExecution()`, assert `dispose()` called                                           |
| Execution integration disposed after run errors           | Same, but integration throws — assert dispose still called in `finally`                                                                             |
| Detector singletons not disposed after workflow completes | Assert orchestrator's 4 singletons still alive after a workflow finishes                                                                            |
| Parallel event isolation                                  | Start two mock workflows, fire `responseCompleteEmitter` on workflow 1's execution integration, assert workflow 2's executor does NOT see the event |
| `createForExecution()` skips `initialize()`               | Assert `initializationStatus === HarnessStatus.Ready` immediately after creation, without `initialize()` call                                       |
