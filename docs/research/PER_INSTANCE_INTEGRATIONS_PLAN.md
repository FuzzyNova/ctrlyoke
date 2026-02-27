# Per-Instance Harness Integrations Plan

**Status**: Implemented
**Author**: Claude Code Planning Agent
**Date**: 2026-02-27

---

## The Problem

`WorkflowOrchestrator` creates 4 shared `HarnessIntegration` singletons at startup (copilot-cli, claude-cli, codex-cli, copilot-chat) and shares them across all `WorkflowInstance` objects. This makes parallel workflows with the same harness type completely broken.

### Failure modes with 10 parallel claude-cli workflows

| Shared field | Location | Failure |
|---|---|---|
| `responseCompleteEmitter` | `HarnessIntegration` base | All 10 workflows subscribe to `onResponseComplete` on the **same emitter**. When Claude finishes responding to workflow 1, all 10 receive the event and think they're done |
| `streamingChunkEmitter` | `HarnessIntegration` base | All streaming output from all 10 executions is broadcast to all 10 listeners — mixed output in every workflow |
| `streamingEventsEmitter` | `HarnessIntegration` base | Same for structured events |
| `isCancelling` | `HarnessIntegration` base | Cancelling any one workflow sets the flag for all 10 |
| `workflowStep` / `totalSteps` | `HarnessIntegration` base | Progress tracking is a single integer, last writer wins |
| `currentProcess?: ChildProcess` | `CliIntegration` | Only one process tracked. Workflow 2 overwrites workflow 1's reference. Workflow 1's process is now untrackable — can't be cancelled |
| `currentExecution?: TerminalShellExecution` | `CliIntegration` | Same for interactive mode |
| `lastResult` / `lastParsedOutput` | `CliIntegration` | Shared result storage, workflow 5 overwrites workflow 3's result before it's read |
| `processManager` (one terminal) | `CliIntegration` | Interactive mode: each new workflow calls `disposeTerminalIfExists()` → kills the previous workflow's terminal |

### Why it wasn't fixed in the parallel workflow migration

`IntegrationFactory.createForHarness()` already exists for this and has the Phase 2 comment. But `WorkflowOrchestrator.resolveIntegration()` still returns the shared singletons, and `WorkflowInstance.createIntegrationForMode()` just delegates back to `resolveIntegration()`.

---

## The Fix

Split each integration's role into two:

| Role | Instances | Lifetime | Used For |
|------|-----------|----------|----------|
| **Detector** | 4 singletons in `WorkflowOrchestrator` | Extension lifetime | `onDidChangeStatus`, status bar, harness availability UI, `getDetailedStatus()` pre-flight check |
| **Executor** | 1 created per workflow run | Duration of `startWorkflowExecution()` | `sendPrompt`, event streaming, `cancel`, process tracking |

The 4 detector singletons remain unchanged. Each `startWorkflowExecution()` call creates a fresh execution integration via `IntegrationFactory.createForExecution()`, uses it for the run, then disposes it in the `finally` block.

---

## Complication 1: The `context.subscriptions` Disposal Leak

`HarnessIntegration`'s constructor currently does:

```typescript
context.subscriptions.push(this.statusChangeEmitter);
context.subscriptions.push(this.responseCompleteEmitter);
context.subscriptions.push(this.streamingChunkEmitter);
context.subscriptions.push(this.streamingEventsEmitter);
context.subscriptions.push(this.promptReadyEmitter);
```

Per-execution integrations created at runtime would accumulate in `context.subscriptions` permanently (only cleaned at extension deactivation). Over a session with dozens of runs this leaks memory.

**Fix**: Add a `registerWithContext: boolean = true` parameter to the constructor. Detector integrations pass `true` (default, no change). Execution integrations pass `false`. Add a public `dispose()` method to `HarnessIntegration` that disposes all 5 emitters manually.

```typescript
// HarnessIntegration constructor
constructor(context: vscode.ExtensionContext, registerWithContext: boolean = true) {
  this.context = context;
  if (registerWithContext) {
    context.subscriptions.push(this.statusChangeEmitter);
    // ... etc
  }
}

// New method
dispose(): void {
  this.statusChangeEmitter.dispose();
  this.responseCompleteEmitter.dispose();
  this.streamingChunkEmitter.dispose();
  this.streamingEventsEmitter.dispose();
  this.promptReadyEmitter.dispose();
}
```

Execution integrations are disposed in the `finally` block of `startWorkflowExecution()`:

```typescript
} finally {
  this.startPending = false;
  for (const integration of this.executionIntegrations) {
    integration.dispose();
  }
  this.executionIntegrations.clear();
  // ... existing history finalization
}
```

---

## Complication 2: Initialization

### What initialization does per harness

| Harness | `initialize()` cost | Per-run call? |
|---------|--------------------|-|
| `copilot-cli` | Fast PATH/version check (ms) | No — detector already confirmed availability; redundant |
| `claude-cli` | Fast PATH/version check (ms) | No — same |
| `codex-cli` | Fast PATH/version check (ms) | No — same |
| `copilot-chat` | Heavyweight polling loop | **Never** — Chat detection is singleton-only |

Execution integrations skip `initialize()` entirely. Instead, `IntegrationFactory.createForExecution()` calls a new `markAsReady()` method on the returned instance that sets `isAvailable = true` and `initializationStatus = HarnessStatus.Ready` directly, since the detector singleton has already confirmed the harness is available.

```typescript
// New on HarnessIntegration
protected markAsReady(): void {
  this.isAvailable = true;
  this.initializationStatus = HarnessStatus.Ready;
}
```

The pre-flight check in `executeLoadedPromptFile` (the "FlightPath is still initializing" / "Copilot unavailable" warnings) must use the **detector** integration's `getDetailedStatus()`, not the newly-created execution integration's. A separate injected callback `getDetectorIntegration(harness?)` is passed to `WorkflowInstance` for this purpose.

---

## File-by-File Changes

### `src/flightpath/HarnessIntegration.ts`
- Add `registerWithContext: boolean = true` to constructor; gate `context.subscriptions.push` on it
- Add `public dispose(): void` — disposes all 5 emitters
- Add `protected markAsReady(): void` — sets `isAvailable = true`, `initializationStatus = HarnessStatus.Ready` without firing events

### `src/flightpath/cli/CliIntegration.ts`
- Thread `registerWithContext` parameter to `super(context, registerWithContext)` in constructor
- Update `dispose()` to call `super.dispose()` before `this.processManager.dispose()`

### `src/flightpath/chat/CopilotChatIntegration.ts`
- Thread `registerWithContext` parameter to `super(context, registerWithContext)` in constructor
- Update `dispose()` to call `super.dispose()` and clear the polling timer

### `src/flightpath/IntegrationFactory.ts`
- Add optional `registerWithContext: boolean = true` to all four `create*()` methods, threaded to constructors
- Thread to `createForHarness()` as well
- Add `createForExecution(harness: Harness): HarnessIntegration`:
  ```typescript
  createForExecution(harness: Harness): HarnessIntegration {
    const integration = this.createForHarness(harness, false); // don't register with context
    integration.markAsReady(); // skip initialize(), trust detector's confirmed status
    return integration;
  }
  ```

### `src/flightpath/WorkflowInstance.ts`
**Constructor additions:**
- Inject `integrationFactory: IntegrationFactory` (for creating execution integrations)
- Inject `getDetectorIntegration: (harness?: Harness) => HarnessIntegration` (for pre-flight status checks only)
- Add `private executionIntegrations = new Set<HarnessIntegration>()` field

**`createIntegrationForMode()`** (current: returns shared singleton via `getIntegration` callback):
```typescript
private createIntegrationForMode(modeOverride?: Harness): HarnessIntegration {
  const harness = modeOverride ?? ConfigurationUtils.getIntegrationMode();
  const integration = this.integrationFactory.createForExecution(harness);
  integration.setWorkflowName(this.workflowName); // set terminal tab name
  this.executionIntegrations.add(integration);
  return integration;
}
```

**`executeLoadedPromptFile()` pre-flight check** — replace `integration.getDetailedStatus()` calls with `this.getDetectorIntegration(resolvedHarness).getDetailedStatus()` so the check reads from the already-initialized detector singleton.

**`startWorkflowExecution()` `finally` block** — add disposal of all tracked execution integrations.

### `src/flightpath/WorkflowOrchestrator.ts`
**`buildWorkflowInstance()`** — pass `this.integrationFactory` and a new `getDetectorIntegration` lambda to the `WorkflowInstance` constructor:
```typescript
(harnessOverride?: Harness) => this.resolveDetectorIntegration(harnessOverride)
```

**`resolveIntegration()`** — rename to `resolveDetectorIntegration()`, update JSDoc to make clear it returns detector singletons only. Remove any use in execution paths.

**`propagateWorkflowNameToIntegrations()`** — continues to target the 3 CLI detector singletons (for terminal naming consistency). Execution integration naming is handled in `createIntegrationForMode()` as shown above.

**No change to:** the 4 singleton fields, their `onDidChangeStatus` subscriptions, `initialize()` calling all four, `getDefaultIntegration()`, `retryHarnessDetection()`, `getHarnessDetailedStatus()`, `updateStatusBar()`.

---

## Per-Prompt Harness Switching

The `getIntegrationForPrompt` callback in `workflowContext` can return a different integration per prompt (harness overrides). After this fix, each harness-switching prompt creates a fresh execution integration via `createIntegrationForMode()`. All created integrations are tracked in `this.executionIntegrations` and disposed together in the `finally` block.

---

## What Does NOT Change

| Concern | Status |
|---------|--------|
| Single-workflow UX | Identical |
| Harness availability UI | Uses detector singletons unchanged |
| Status bar | Uses `getDefaultIntegration()` → detector singleton |
| `openPanel()` / `retryHarnessDetection()` | Detector singletons unchanged |
| `getDetailedStatus()` in settings panel | Detector singleton state |
| `WorkflowExecutor` | No changes |
| `EndConditionHandler` / `EndConditionEvaluator` | No changes |
| `PromptQueue` / `PromptFileParser` | No changes |
| MCP server | No changes |
| React webview / dashboard | No changes |

---

## Test Coverage

### Existing tests — no changes expected
All 19 test files cover parsing, state machines, and CLI output parsers — none construct `HarnessIntegration` or touch `context.subscriptions`. No changes required.

### Tests to add

| Test | What to verify |
|------|----------------|
| Execution integration disposed after run completes | Mock `IntegrationFactory.createForExecution()`, run `startWorkflowExecution()`, assert `dispose()` called |
| Execution integration disposed after run errors | Same, but integration throws — assert dispose still called in `finally` |
| Detector singletons not disposed after workflow completes | Assert orchestrator's 4 singletons still alive after a workflow finishes |
| Parallel event isolation | Start two mock workflows, fire `responseCompleteEmitter` on workflow 1's execution integration, assert workflow 2's executor does NOT see the event |
| `createForExecution()` skips `initialize()` | Assert `initializationStatus === HarnessStatus.Ready` immediately after creation, without `initialize()` call |

---

## Implementation Sequence

Execute in this order — each step is independently committable except 5+6 which must go together:

1. `HarnessIntegration.ts` — add `registerWithContext`, `dispose()`, `markAsReady()` (no behavior change for existing callers)
2. `CliIntegration.ts` — thread `registerWithContext`, update `dispose()`
3. `CopilotChatIntegration.ts` — thread `registerWithContext`, update `dispose()`
4. `IntegrationFactory.ts` — add `registerWithContext` to all create methods, add `createForExecution()`
5. `WorkflowInstance.ts` — inject factory + detector callback, update `createIntegrationForMode()`, update pre-flight check, add disposal in `finally`
6. `WorkflowOrchestrator.ts` — update `buildWorkflowInstance()`, rename `resolveIntegration()` to `resolveDetectorIntegration()`
7. Add tests
