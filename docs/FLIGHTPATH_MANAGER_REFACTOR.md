# FlightPathManager Refactoring Plan

This document outlines the refactoring plan for `FlightPathManager.ts`, which had grown to ~1,854 lines and violated the Single Responsibility Principle.

## Problem Analysis

### Original Responsibilities (All in One Class)

1. **Constructor/Initialization** (~80 lines) - Creates all dependencies, sets up event listeners
2. **Prompt File Loading/Execution** (~200 lines) - File parsing, validation, execution triggering
3. **Workflow Execution Loop** (~400 lines) - The massive `startWorkflowExecution()` function
4. **Response Handling & Pause/Resume** (~100 lines) - Promise management, state tracking
5. **End Condition Handling** (~350 lines) - Retry logic, validation failures, error handling
6. **UI/Dashboard Updates** (~100 lines) - Status bar, dashboard notifications
7. **File Creation** (~150 lines) - Creating new prompt files and scripts
8. **Status/Configuration Methods** (~150 lines) - Various getters and config reading
9. **Type Guards** (~20 lines) - `isChatIntegration()`, `isCliIntegration()`

### SOLID Violations

- **S (Single Responsibility)**: FlightPathManager did everything - orchestration, file operations, UI updates, retry logic, configuration
- **O (Open/Closed)**: Adding new features required modifying this massive class
- **D (Dependency Inversion)**: Tightly coupled to concrete integrations

---

## Refactoring Plan

### Priority 1: ✅ EndConditionHandler (COMPLETED)

**Location:** `src/flightpath/EndConditionHandler.ts`  
**Lines Extracted:** ~350 lines  
**Status:** ✅ Completed

Extracted methods:

- `handleEndConditionResult()` - Entry point, routes to success/error/validation
- `handleExecutionError()` - Handles script failures with user prompts
- `handleValidationFailure()` - Orchestrates retry logic
- `handleMaxRetriesExhausted()` - Final failure with user options
- `buildRetryPrompt()` - Template placeholder replacement

**Architecture decisions:**

- Uses `RetryContext` interface to bundle execution context
- Uses callback pattern (`SendRetryPromptCallback`) for sending retry prompts
- Avoids tight coupling - FlightPathManager owns prompt sending, handler orchestrates decisions

**Result:** FlightPathManager reduced from 1,854 to 1,426 lines (-428 lines)

---

### Priority 2: ✅ WorkflowExecutor (COMPLETED)

**Location:** `src/flightpath/WorkflowExecutor.ts`  
**Lines Extracted:** ~626 lines  
**Status:** ✅ Completed

Extracted:

- `execute()` - Main execution loop (formerly `startWorkflowExecution()`)
- `waitForResponseComplete()` - Response promise handling
- `evaluateEndCondition()` - End condition evaluation with retry callback
- `createSendRetryPromptCallback()` - Retry prompt callback factory
- Pause/resume state (`pendingResponseResolver`, `pendingResponseText`, `isWaitingForResponse`)
- CLI streaming setup and dashboard updates during execution
- Dynamic queue reload logic

**Architecture decisions:**

- Uses `WorkflowContext` interface to bundle all dependencies and config
- Exposes `hasPendingResponse()`, `isAwaitingResponse()`, `resumePendingResponse()`, `clearPendingState()` for pause/resume coordination
- Delegates end condition handling to `EndConditionHandler`
- FlightPathManager creates context and delegates execution

**Result:** FlightPathManager reduced from 1,426 to 842 lines (-584 lines)

---

### Priority 3: ✅ parseMarkdownPromptFile → PromptFileParser (COMPLETED)

**Current location:** PromptFileParser  
**Lines Moved:** ~30 lines  
**Status:** ✅ Completed

**Changes:**

- Added `parseMarkdownPromptFile()` method to PromptFileParser
- Updated `parsePromptFile()` to handle `.prompt.md` files automatically
- Updated `isPromptFile()` to include `.prompt.md` extension
- Removed duplicate method from FlightPathManager
- FlightPathManager now uses unified `parsePromptFile()` for all formats

**Result:** Single source of truth for all prompt file parsing. PromptFileParser now at 208 lines.

---

### Priority 4: StatusBarManager (NOT STARTED)

**Location:** `src/ui/StatusBarManager.ts`  
**Estimated Lines:** ~80 lines  
**Status:** ⏳ Pending

Extract:

- Status bar creation and disposal
- `updateStatusBar()` logic
- Status bar command handling

**Why:** This is a UI concern and belongs in `src/ui/` with other UI code. Independent from execution logic.

---

### Priority 5: ConfigurationUtils (NOT STARTED)

**Location:** `src/utils/ConfigurationUtils.ts`  
**Estimated Lines:** ~50 lines  
**Status:** ⏳ Pending

Extract:

- `getDynamicQueueConfig()`
- `shouldShowCliCommand()`
- Other settings reading can migrate here over time

**Why:** Consolidates VS Code settings access into a reusable utility.

---

## Current Structure

```
src/flightpath/
├── base/
├── chat/
├── cli/
├── EndConditionEvaluator.ts    (existing - script execution)
├── EndConditionHandler.ts      ✅ NEW (retry/validation logic) - 324 lines
├── FlightPathManager.ts        ✅ REDUCED - 842 lines
├── PromptFileParser.ts         ✅ UPDATED (+ parseMarkdownPromptFile) - 208 lines
├── PromptQueue.ts
└── WorkflowExecutor.ts         ✅ NEW (execution loop) - 626 lines

src/ui/
├── FlightPathDashboardProvider.ts
└── StatusBarManager.ts         ⏳ PLANNED

src/utils/
├── ConfigurationUtils.ts       ⏳ PLANNED
├── FileSystemUtils.ts
├── LoggingUtils.ts
├── PromptIdentity.ts
└── ValidationUtils.ts
```

---

## Post-Refactoring FlightPathManager (Current State)

After Priorities 1-3, FlightPathManager is now a **cleaner orchestrator** (~842 lines):

```typescript
class FlightPathManager {
  private workflowExecutor: WorkflowExecutor;
  private endConditionHandler: EndConditionHandler;

  // Public API (thin delegations)
  async takeOff(): Promise<void> { ... }
  pause(): void { this.promptQueue.pause(); }
  resume(): void { /* delegates to workflowExecutor for state */ }
  stop(): void { this.workflowExecutor.clearPendingState(); ... }

  // Execution (delegates to WorkflowExecutor)
  private async startWorkflowExecution(): Promise<void> {
    const context = this.buildWorkflowContext();
    await this.workflowExecutor.execute(integration, context);
  }

  // Status getters
  getQueueState(): QueueState { ... }
  getCopilotStatus(): { ... } { ... }

  dispose(): void { /* cleanup all components */ }
}
```

---

## Progress Tracking

| Priority | Component                                  | Status      | Lines Saved |
| -------- | ------------------------------------------ | ----------- | ----------- |
| 1        | EndConditionHandler                        | ✅ Complete | ~350        |
| 2        | WorkflowExecutor                           | ✅ Complete | ~584        |
| 3        | parseMarkdownPromptFile → PromptFileParser | ✅ Complete | ~30         |
| 4        | StatusBarManager                           | ⏳ Pending  | ~80 (est)   |
| 5        | ConfigurationUtils                         | ⏳ Pending  | ~50 (est)   |

**Original FlightPathManager size:** 1,854 lines  
**Current FlightPathManager size:** 842 lines  
**Total reduction:** 1,012 lines (55% smaller!)

**Remaining to extract:** ~130 lines (StatusBar + Config utilities)

---

## Notes

- **Type guards** (`isChatIntegration()`, `isCliIntegration()`) remain in FlightPathManager - only ~10 lines, tightly coupled to integration selection logic
- All extractions follow existing project patterns (base/, cli/, chat/ structure)
- Each extracted class has a single responsibility and is independently testable
- All 33 tests pass after refactoring
