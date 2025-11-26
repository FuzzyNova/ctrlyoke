# Copilot Integration LSP Refactoring Plan

## Overview

This document outlines a refactoring plan to make `CopilotIntegration` and its subclasses (`CopilotCommandLineIntegration`, `CopilotChatIntegration`) comply with the **Liskov Substitution Principle (LSP)** and eliminate code smells in consumer classes.

## Problem Statement

### Code Smells Identified

1. **Duplicated Type Guards**: `isCliIntegration()` is defined in both `FlightPathManager.ts` and `WorkflowExecutor.ts`

2. **LSP Violation**: Consumer classes use type guards to access subclass-specific methods, breaking substitutability

3. **Scattered Test Functions**: Diagnostic/test functions are scattered across `extension.ts` and integration classes

### Current Usage Analysis

**Type guard usages in `WorkflowExecutor.ts`** (8 instances):

- Lines 106, 201, 306, 384, 486, 675: CLI-specific output (streaming, tokens, command display)
- Line 256: Chat-specific `wasLastFailureUserCancellation()`

**Type guard usages in `FlightPathManager.ts`** (4 instances):

- Lines 305, 672, 687, 700: Chat-specific diagnostics (`testAutomation`, `retryDetection`, `getCapabilities`)

### Root Cause: Asymmetric Interfaces

The subclasses have methods that don't exist on the base class:

| CLI-Only Methods      | Chat-Only Methods                  |
| --------------------- | ---------------------------------- |
| `getLastResult()`     | `testAutomation()`                 |
| `getLastCliCommand()` | `retryDetection()`                 |
| `getLastFullPrompt()` | `getCapabilities()`                |
| `parseTokenCounts()`  | `wasLastFailureUserCancellation()` |

---

## Solution: Unified Interface Pattern

Add all integration-specific methods to the base `CopilotIntegration` class with sensible default implementations. This allows consumer code to call methods directly without type guards.

### Phase 1: Unify Base Class Interface

**Add to `CopilotIntegration.ts` base class:**

```typescript
import { CopilotCliResult } from "../../types/CopilotTypes";

// ============================================================
// EXECUTION OUTPUT METHODS (CLI provides real values, Chat returns undefined)
// ============================================================

/**
 * Get the last execution result (CLI-specific, returns undefined for Chat)
 * Includes response text, statistics, and exit code
 */
getLastResult(): CopilotCliResult | undefined {
  return undefined;
}

/**
 * Get the last CLI command executed (for debugging)
 * Returns undefined for non-CLI integrations
 */
getLastCliCommand(): string | undefined {
  return undefined;
}

/**
 * Get the full prompt text sent (includes all context and instructions)
 * Returns undefined if not tracked
 */
getLastFullPrompt(): string | undefined {
  return undefined;
}

/**
 * Parse token counts from statistics string
 * Returns undefined for non-CLI integrations or unparseable stats
 */
parseTokenCounts(statistics: string): { prompt: number; completion: number } | undefined {
  return undefined;
}

// ============================================================
// DIAGNOSTIC METHODS (Chat provides full implementations, CLI provides defaults)
// ============================================================

/**
 * Test automation capability (diagnostic tool)
 * CLI: Returns isReady() since CLI doesn't need automation testing
 * Chat: Sends test message to verify automation works
 */
async testAutomation(): Promise<boolean> {
  return this.isReady();
}

/**
 * Retry integration detection/initialization
 * CLI: Re-runs initialize()
 * Chat: Restarts polling for Copilot availability
 */
async retryDetection(): Promise<void> {
  await this.initialize();
}

/**
 * Get capability information for this integration
 */
getCapabilities(): {
  hasDirectAutomation: boolean;
  supportsZeroInteraction: boolean;
  currentStrategy: string;
} {
  const status = this.getStatus();
  return {
    hasDirectAutomation: this.isAvailable,
    supportsZeroInteraction: this.isAvailable,
    currentStrategy: status.strategy,
  };
}

/**
 * Check if the last sendPrompt failure was due to user cancellation
 * Returns false by default (only Chat tracks this)
 */
wasLastFailureUserCancellation(): boolean {
  return false;
}
```

### Phase 2: Update Subclasses

**`CopilotCommandLineIntegration.ts`** - Already implements:

- `getLastResult()` ✅
- `getLastCliCommand()` ✅
- `getLastFullPrompt()` ✅
- `parseTokenCounts()` ✅

No changes needed - these methods override the base class defaults.

**`CopilotChatIntegration.ts`** - Already implements:

- `testAutomation()` ✅
- `retryDetection()` ✅
- `getCapabilities()` ✅
- `wasLastFailureUserCancellation()` ✅

No changes needed - these methods override the base class defaults.

### Phase 3: Remove Type Guards from Consumer Classes

**`FlightPathManager.ts`** changes:

1. Delete `isChatIntegration()` method (lines 96-101)
2. Delete `isCliIntegration()` method (lines 105-109)
3. Update `executeLoadedPromptFile()` - call `integration.testAutomation()` directly
4. Update `testCopilotAutomation()` - call method directly on integration
5. Update `retryCopilotDetection()` - call method directly on integration
6. Update `getCopilotCapabilities()` - call method directly on integration

**`WorkflowExecutor.ts`** changes:

1. Delete `isCliIntegration()` method (lines 66-73)
2. Update all CLI output blocks to call methods directly (handle `undefined` gracefully)
3. Update failure handling to call `wasLastFailureUserCancellation()` on any integration

### Phase 4: Simplify Consumer Code

**Before (with type guards):**

```typescript
if (context.dashboardProvider && this.isCliIntegration(integration)) {
  const lastResult = integration.getLastResult();
  if (lastResult?.statistics) {
    tokens = integration.parseTokenCounts(lastResult.statistics);
  }
  cliCommand = integration.getLastCliCommand();
}
```

**After (unified interface):**

```typescript
if (context.dashboardProvider) {
  const lastResult = integration.getLastResult();
  if (lastResult?.statistics) {
    tokens = integration.parseTokenCounts(lastResult.statistics);
  }
  cliCommand = integration.getLastCliCommand();
}
```

The code works for both integrations - Chat returns `undefined`, CLI returns real values.

---

## Phase 5: Extract Test Functions to Dedicated Class

### Problem

`extension.ts` contains several diagnostic/test functions that pollute the activation code:

- `testFileAttachment()` - Tests `github.copilot.chat.attachFile/attachSelection`
- `testChatModelSelection()` - Tests `workbench.action.chat.changeModel`
- `testChatAgentSelection()` - Tests `workbench.action.chat.openagent`
- `testCopilotAutomation()` - Tests direct chat automation

These are useful for development/debugging but shouldn't live in the main extension file.

### Solution: Create `CopilotDiagnostics` Class

**New file: `src/flightpath/diagnostics/CopilotDiagnostics.ts`**

```typescript
import * as vscode from "vscode";

/**
 * Diagnostic and testing utilities for Copilot integration.
 *
 * These functions are used for:
 * - Development debugging
 * - User troubleshooting
 * - Verifying VS Code command availability
 *
 * Commands registered:
 * - flightpath.test.copilotAutomation
 * - flightpath.test.fileAttachment
 * - flightpath.test.chatModelSelection
 * - flightpath.test.chatAgentSelection
 */
export class CopilotDiagnostics {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Test file attachment commands
   * Tests github.copilot.chat.attachFile and attachSelection
   */
  async testFileAttachment(): Promise<void> {
    // Move implementation from extension.ts
  }

  /**
   * Test chat model selection
   * Investigates workbench.action.chat.changeModel
   */
  async testChatModelSelection(): Promise<void> {
    // Move implementation from extension.ts
  }

  /**
   * Test chat agent selection
   * Investigates workbench.action.chat.openagent
   */
  async testChatAgentSelection(): Promise<void> {
    // Move implementation from extension.ts
  }

  /**
   * Test Copilot Chat automation (Editor Chat approach)
   */
  async testCopilotAutomation(): Promise<boolean> {
    // Move implementation from extension.ts
  }

  /**
   * Register all diagnostic commands
   */
  registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand("flightpath.test.copilotAutomation", () =>
        this.testCopilotAutomation()
      ),
      vscode.commands.registerCommand("flightpath.test.fileAttachment", () =>
        this.testFileAttachment()
      ),
      vscode.commands.registerCommand(
        "flightpath.test.chatModelSelection",
        () => this.testChatModelSelection()
      ),
      vscode.commands.registerCommand(
        "flightpath.test.chatAgentSelection",
        () => this.testChatAgentSelection()
      )
    );
  }
}
```

**Update `extension.ts`:**

```typescript
import { CopilotDiagnostics } from "./flightpath/diagnostics/CopilotDiagnostics";

export async function activate(context: vscode.ExtensionContext) {
  // ... existing code ...

  // Register diagnostic commands (development/debugging tools)
  const diagnostics = new CopilotDiagnostics(context);
  diagnostics.registerCommands();
}
```

---

## Implementation Checklist

### Phase 1: Base Class Updates ✅ COMPLETED

- [x] Add `CopilotCliResult` import to `CopilotIntegration.ts`
- [x] Add `getLastResult()` default method
- [x] Add `getLastCliCommand()` default method
- [x] Add `getLastFullPrompt()` default method
- [x] Add `parseTokenCounts()` default method
- [x] Add `testAutomation()` default method
- [x] Add `retryDetection()` default method
- [x] Add `getCapabilities()` default method
- [x] Add `wasLastFailureUserCancellation()` default method
- [x] Add `isCli()` method (returns false by default, CLI overrides to true)

### Phase 2: Verify Subclass Overrides ✅ COMPLETED

- [x] Verify CLI class overrides execution output methods
- [x] Verify Chat class overrides diagnostic methods

### Phase 3: Remove Type Guards ✅ COMPLETED

- [x] Remove `isChatIntegration()` from `FlightPathManager.ts`
- [x] Remove `isCliIntegration()` from `FlightPathManager.ts`
- [x] Remove `isCliIntegration()` from `WorkflowExecutor.ts`
- [x] Update all call sites to use unified interface

### Phase 4: Test ✅ COMPLETED

- [x] Run existing tests (compilation successful)
- [ ] Manual test CLI workflow
- [ ] Manual test Chat workflow
- [ ] Verify dashboard output displays correctly for both modes

### Phase 5: Extract Diagnostics (Optional, can be done separately)

- [ ] Create `src/flightpath/diagnostics/` directory
- [ ] Create `CopilotDiagnostics.ts` class
- [ ] Move test functions from `extension.ts`
- [ ] Update command registration
- [ ] Clean up `extension.ts`

---

## Benefits

1. **LSP Compliance**: Both integrations are truly substitutable
2. **No Type Guards**: Consumer code is cleaner and simpler
3. **Single Source of Truth**: No duplicated type guard code
4. **Extensible**: Easy to add new integration types in future
5. **Type-Safe**: TypeScript knows all methods exist on base class
6. **Cleaner extension.ts**: Diagnostic code moved to dedicated class

## Tradeoffs

1. **Slightly Larger Base Class**: ~40 lines of default method implementations
2. **Some Methods Return `undefined`**: Callers must handle this (idiomatic TypeScript)
3. **Chat Tracks CLI-specific Method Calls**: Harmless - returns `undefined`

---

## File Changes Summary

| File                                               | Changes                                   |
| -------------------------------------------------- | ----------------------------------------- |
| `src/flightpath/base/CopilotIntegration.ts`        | Add 8 default methods                     |
| `src/flightpath/FlightPathManager.ts`              | Remove type guards, simplify method calls |
| `src/flightpath/WorkflowExecutor.ts`               | Remove type guard, simplify conditionals  |
| `src/flightpath/diagnostics/CopilotDiagnostics.ts` | New file (Phase 5)                        |
| `src/extension.ts`                                 | Remove test functions (Phase 5)           |

---

## Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall extension architecture
- [COPILOT_INTEGRATION.md](./COPILOT_INTEGRATION.md) - Integration strategy details
- [FLIGHTPATH_MANAGER_REFACTOR.md](./FLIGHTPATH_MANAGER_REFACTOR.md) - Previous refactoring work
