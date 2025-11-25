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

### Priority 4: ✅ StatusBarManager Integration (COMPLETED)

**Location:** `src/ui/StatusBarManager.ts`  
**Lines Extracted:** ~45 lines (updateStatusBar logic moved to delegation)  
**Status:** ✅ Completed

**Changes:**

- StatusBarManager already existed but wasn't being used by FlightPathManager
- Updated StatusBarManager to use `EXECUTION_STATES` constants instead of hardcoded strings
- Added `CopilotDetailedStatus` interface for Copilot initialization status display
- Added `getCopilotStatusDisplay()` method for Copilot status text/tooltip generation
- FlightPathManager now delegates to StatusBarManager via `updateStatusBar()` method
- Removed duplicate status bar creation/management from FlightPathManager

**Architecture decisions:**

- StatusBarManager handles all display logic (icons, text, tooltips, backgrounds)
- FlightPathManager provides state data (QueueState, CopilotDetailedStatus)
- Single source of truth for status bar presentation

**Hardcoded String Fixes:**

- Fixed hardcoded `"running"`, `"paused"`, `"completed"`, `"error"`, `"idle"` status strings in:
  - `FlightPathManager.ts` - Now uses `EXECUTION_STATES.*` constants
  - `WorkflowExecutor.ts` - Now uses `EXECUTION_STATES.*` constants
  - `PromptQueue.ts` - Now uses `EXECUTION_STATES.*` and `STEP_STATUS.*` constants
  - `StatusBarManager.ts` - Now uses `EXECUTION_STATES.*` constants

**Result:** FlightPathManager reduced from 842 to ~796 lines. Status bar logic properly separated.

---

### Priority 5: ✅ ConfigurationUtils (COMPLETED)

**Location:** `src/utils/ConfigurationUtils.ts`  
**Lines Created:** ~120 lines (comprehensive configuration utility)  
**Status:** ✅ Completed

**Extracted/Centralized:**

- `shouldShowCliCommand()` - Check CLI command display setting
- `shouldShowCliOutput()` - Check CLI output display setting
- `getIntegrationMode()` - Get default integration mode (CLI/Chat)
- `getDynamicQueueConfig()` - Get dynamic queue configuration
- `getPromptsDirectory()` - Get prompts directory path
- `getScriptTimeout()` - Get script timeout setting
- `getDefaultMaxRetries()` - Get default retry count
- `getDefaultRetryPrompt()` - Get default retry prompt template
- `shouldAutoAttachFiles()` - Check auto-attach files setting
- `getCliModel()` - Get default CLI model
- `getCliAllowedDirs()` - Get CLI allowed directories
- `getCliToolPermissions()` - Get CLI tool permissions mode
- `getChatWindowLocation()` - Get chat window location preference

**Architecture decisions:**

- Object-based API (`ConfigurationUtils.methodName()`) for easy discoverability
- All methods read from single `"flightpath"` config namespace
- Default values centralized in one place
- Enables future migration of other files' config reads

**Result:** FlightPathManager configuration methods now thin wrappers that delegate to ConfigurationUtils.

---

## Current Structure

```
src/flightpath/
├── base/
├── chat/
├── cli/
├── EndConditionEvaluator.ts    (existing - script execution)
├── EndConditionHandler.ts      ✅ NEW (retry/validation logic) - 324 lines
├── FlightPathManager.ts        ✅ REDUCED - 780 lines (from 1,854!)
├── PromptFileParser.ts         ✅ UPDATED (+ parseMarkdownPromptFile) - 208 lines
├── PromptQueue.ts              ✅ UPDATED (uses EXECUTION_STATES/STEP_STATUS)
└── WorkflowExecutor.ts         ✅ NEW (execution loop) - 626 lines

src/ui/
├── FlightPathDashboardProvider.ts
└── StatusBarManager.ts         ✅ UPDATED (uses EXECUTION_STATES, supports CopilotStatus)

src/utils/
├── ConfigurationUtils.ts       ✅ NEW (centralized settings access) - 120 lines
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

| Priority | Component                                  | Status      | Lines Saved/Created |
| -------- | ------------------------------------------ | ----------- | ------------------- |
| 1        | EndConditionHandler                        | ✅ Complete | ~350 saved          |
| 2        | WorkflowExecutor                           | ✅ Complete | ~584 saved          |
| 3        | parseMarkdownPromptFile → PromptFileParser | ✅ Complete | ~30 saved           |
| 4        | StatusBarManager Integration               | ✅ Complete | ~45 saved           |
| 5        | ConfigurationUtils                         | ✅ Complete | 120 created         |

**Original FlightPathManager size:** 1,854 lines  
**Current FlightPathManager size:** 780 lines  
**Total reduction:** 1,074 lines (58% smaller!)

**Additional improvements:**

- Fixed all hardcoded status strings across 4 files
- Centralized configuration access in ConfigurationUtils
- StatusBarManager properly integrated and updated with constants

---

## Notes

- **Type guards** (`isChatIntegration()`, `isCliIntegration()`) remain in FlightPathManager - only ~10 lines, tightly coupled to integration selection logic
- All extractions follow existing project patterns (base/, cli/, chat/ structure)
- Each extracted class has a single responsibility and is independently testable
- All 33 tests pass after refactoring
- **NO HARDCODED STRINGS**: All status values now use constants from `DashboardConstants.ts`
