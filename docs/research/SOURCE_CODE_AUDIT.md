# FlightPath Source Code Audit

**Date:** February 27, 2026  
**Scope:** Full `src/` directory (excluding `webview-react/` bundled UI)  
**Methodology:** Automated multi-agent review for dead code, code smells, SOLID/DRY violations, security issues, and general correctness.

---

## Table of Contents

1. [Entry Points & Types](#1-entry-points--types)
2. [Core Flightpath Modules](#2-core-flightpath-modules)
3. [CLI Integration](#3-cli-integration)
4. [Chat & Orchestration](#4-chat--orchestration)
5. [Utilities](#5-utilities)
6. [UI & Completions](#6-ui--completions)
7. [Templates, Scripts & Dev](#7-templates-scripts--dev)
8. [Cross-Cutting Concerns](#8-cross-cutting-concerns)
9. [Prioritized Recommendations](#9-prioritized-recommendations)

---

## 1. Entry Points & Types

### 1.1 extension.ts

- **[HIGH]** Hardcoded string `"completed"` instead of `EXECUTION_STATES.COMPLETED` (line ~103). The project's core principle is no hardcoded strings for shared constants. Should be `queueState.status === EXECUTION_STATES.COMPLETED`.
- **[HIGH]** Unsafe `(flightPathManager as any).promptQueue` cast used twice (lines ~43, ~76). This breaks type safety and creates tight coupling to internal implementation details. `WorkflowOrchestrator` should expose a public method (e.g., `getPromptQueue()`) or the LM Tools should use `QueueOperations` through a proper API rather than reaching into private members.
- **[MEDIUM]** `require()` used for dynamic import of `QueueOperations` (line ~26) instead of a static `import`. While this is inside a try/catch, it defeats tree-shaking and static analysis. Since `registerLanguageModelTools` is always called, this could be a static import.
- **[MEDIUM]** `selectPromptFile` command (line ~412) uses glob `**/*.{prompt.json,flightpath.json,prompt.md}` which **misses YAML workflow files** (`.flightpath.yaml`, `.flightpath.yml`). The `appendFromDashboard` command (line ~449) correctly includes YAML. This inconsistency means users can't select YAML workflows via the Select command.
- **[MEDIUM]** `parameters: any` on LM Tool invoke (line ~73) — untyped input from external callers. Should validate/parse against an expected schema rather than trusting arbitrary input with `.prompts`, `.position`, `.source`, `.reason` fields.
- **[LOW]** `_parameters: unknown` is declared but unused in both `prepareInvocation` callbacks (lines ~33, ~69). This is fine for interface compliance but the callbacks themselves do essentially nothing — `prepareInvocation` for `flightpath_queue_status` could be removed if the API allows it.
- **[LOW]** The `registerCommands` function (lines ~226–600) is a single ~370-line function that registers ~20+ commands. While each command body is small, the function itself has high line count. Consider grouping related commands into sub-functions (e.g., `registerContextMenuCommands`, `registerDashboardCommands`) for readability.
- **[INFO]** Dev-mode commands use `require()` (line ~599) which is correct for conditional loading with dead-code elimination.

### 1.2 mcp-server.ts

- **[HIGH]** Unused import: `hashPromptContent` is imported (line ~36) but never used anywhere in the file. It was likely used in a previous deduplication check that was removed. Dead import.
- **[MEDIUM]** `generateId()` method (line ~653) is defined in `FlightPathMCPServer` but never called anywhere in the class. Dead code that should be removed.
- **[MEDIUM]** Magic number `100` for `maxQueueSize` appears in two places (lines ~235, ~305) with `// TODO: Read from config` comments. This should be a named constant or read from configuration. The TODO suggests this was always intended to be configurable.
- **[MEDIUM]** Mixed module systems: uses `require()` for MCP SDK imports (lines ~16–23) with TypeScript `import` for everything else. The comment explains this is for CJS compatibility, but the inconsistency makes the file harder to reason about. Consider `import type` + dynamic `require` pattern consistently.
- **[MEDIUM]** `private server: typeof Server` (line ~82) — using `typeof` on a `require`'d value gives `any`. This effectively makes the server field untyped. The MCP SDK types should be imported separately for proper typing.
- **[LOW]** Path constants `FLIGHTPATH_DIR`, `LOGS_DIR`, `QUEUE_DIR` (lines ~40–42) are duplicated from `ConfigurationUtils.PATH_CONSTANTS` with a comment saying "must match". This is a DRY violation — if the constants change in `ConfigurationUtils`, this file won't be updated. However, since MCP server is a standalone binary that can't import VS Code extension code, this duplication may be unavoidable. Consider extracting shared constants to a standalone module importable by both.
- **[LOW]** `log()` function (line ~55) uses `any[]` parameter type. Could use `unknown[]` for better type safety.
- **[LOW]** The `queueOperation` pattern (lines ~184–207) correctly serializes operations, but the error path re-throws after calling `rejecter`, which means the `operationQueue` promise chain would break on error (subsequent operations would execute immediately since the rejected promise was already awaited). This is acceptable since append failures are typically terminal, but could cause subtle issues if multiple rapid appends fail.
- **[INFO]** Atomic file writes via temp file + rename (line ~334) is good practice for preventing corruption.

### 1.3 FlightPathTypes.ts

- **[HIGH]** `ClaudeCliStatus` type (line ~22) is exported but **never imported or used** anywhere in the codebase. Dead code.
- **[MEDIUM]** `WorkflowContext` interface (lines ~101–108) has `promptQueue?: any` with comment "Avoid circular dependency with PromptQueue". Using `any` here defeats type safety. Consider using a minimal interface type (e.g., `{ getState(): QueueState }`) or restructuring to break the circular dependency.
- **[MEDIUM]** `QueueState.completedIds` (line ~138) is typed as `Set<string>` but stores index strings (`"0"`, `"1"`, ...) rather than actual IDs. The naming is misleading — it would be clearer as `completedIndices` or should store actual prompt identifiers.
- **[LOW]** `WorkflowContext` in FlightPathTypes (line ~101) and `WorkflowContext` in WorkflowExecutor (line ~39) are **two different interfaces** with the same name in the same project. The FlightPathTypes version is never imported from this module — the WorkflowExecutor version is used throughout. The FlightPathTypes version appears to be dead code or a stale remnant.
- **[INFO]** `EXECUTION_STATES` and `STEP_STATUS` are re-exported from DashboardConstants at the bottom (line ~186). This is convenient but creates two import paths for the same constants, which could lead to inconsistent import styles.

### 1.4 DashboardConstants.ts

- **[MEDIUM]** `PROMPT_PROPERTIES` constant (lines ~297–313) and `END_CONDITION_PROPERTIES` (lines ~318–324) are duplicated in the React webview code (`webview-react/utils/prompt.ts` and `webview-react/utils/endCondition.ts`). The webview copies have comments saying "matches PROMPT_PROPERTIES from DashboardConstants" but are independent copies — a DRY violation. If the extension-side constants change, the webview copies could drift. Since the webview is bundled separately with Vite, consider a shared importable module or build-time code generation.
- **[MEDIUM]** `PROMPTS_APPENDED` message type (line ~27) is defined but only referenced in the constant definition — no handler for it exists in the webview's `useMessageHandler.ts` or in `FlightPathWebviewProvider.ts`. Appears to be dead/unused message type.
- **[LOW]** `DEFAULT_MODELS` (lines ~247–252) stores model strings that will inevitably become stale as new models are released. The sync-models script helps, but this is a maintainability surface area.
- **[INFO]** The file is well-structured with clear section separators and comprehensive type helpers. The `as const` assertions throughout are correct and enable proper type narrowing.

### 1.5 WebviewMessageTypes.ts

- **[MEDIUM]** `PromptItem` interface (lines ~233–260) is a **parallel definition** of `FlightPathTypes.PromptItem`. It uses `harness?: string` instead of `harness?: Harness` (the enum), and `_runtime` has different optional fields (e.g., `isRetry?: boolean` which doesn't exist in the original). This creates drift risk — changes to one won't automatically apply to the other. However, this appears intentional for the webview boundary (webview can't import VS Code extension types directly).
- **[MEDIUM]** `EndConditionConfig` (lines ~223–229) is yet another definition of the same concept as `EndCondition` in FlightPathTypes. Different name, `returns` is optional here but required in `EndCondition`. Also duplicated a third time in `editorStore.ts`. Three definitions of the same concept.
- **[MEDIUM]** 12 backward-compatibility type aliases (lines ~195–206): `BaseEventData`, `TextEventData`, `ThinkingEventData`, `BashCommandEventData`, etc. These all alias types from `CliOutputTypes`. While they serve the webview, the naming is inconsistent (original: `TextData`, alias: `TextEventData`). These are used in the webview's `outputUtils.ts` but could be migrated to use the original names.
- **[MEDIUM]** `CliEventData` union type (lines ~174–184) duplicates the identical union from `CliOutputTypes.ts` (lines ~31–42). Both files define the exact same union. The WebviewMessageTypes version should re-export from CliOutputTypes instead of redefining.
- **[LOW]** `CliOutputData` and `CliOutputItem` (lines ~128, ~134) are backward-compatibility aliases for `CliOutput`. They are actually used in some places (`FlightPathWebviewProvider` uses `CliOutputData`, webview components use `CliOutputItem`), but ideally code should migrate to `CliOutput`.
- **[LOW]** `DiffHunk` (line ~166) is an alias for `UnifiedDiffHunk`. Used in webview code. Minor indirection.
- **[LOW]** `IncomingMessage` union type (lines ~554–596) does not include the multi-workflow message types (`WORKFLOWS_LIST`, `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `WORKFLOW_SUMMARY_UPDATED`, `ACTIVE_WORKFLOW_CHANGED`) or several other newer messages (`GLOBAL_SETTINGS_UPDATED`, `RESET_WORKFLOW_STATE`, `RUN_HISTORY_UPDATED`, `OUTPUT_HISTORY_LOADED`). The webview's `useMessageHandler.ts` handles these messages, so the union is incomplete. This means the discriminated union doesn't provide type safety for newer messages.
- **[INFO]** The file correctly serves as the serialization boundary between extension and webview, which justifies some type duplication.

### 1.6 CliOutputTypes.ts

- **[LOW]** `CLI_EVENT_TYPES` is re-exported (line ~10) with comment "for backward compatibility (CLI parsers import from this file)". This creates two import paths for the same constant. CLI parsers should migrate to importing from `DashboardConstants` directly.
- **[INFO]** The file is clean and well-documented. Types are comprehensive and the universal output structure is well-designed. No significant issues found.

### 1.7 OutputHistoryTypes.ts

- **[INFO]** Clean, minimal file. `schemaVersion: "1.0.0"` as a string literal type is good for future migration support. No issues found.

---

## 2. Core Flightpath Modules

### 2.1 HarnessIntegration.ts

- **[MEDIUM]** `getCapabilities()` (line ~581) is defined with a concrete implementation and overridden in `CopilotChatIntegration`, but **never called** anywhere outside those two definitions. No call site in the entire `src/` directory invokes `.getCapabilities()`. Dead code.
- **[MEDIUM]** `getLastFullPrompt()` (line ~542) returns `undefined` in the base class, is overridden in `CliIntegration`, but **never called** by any consumer. Dead code — likely a debugging artifact.
- **[LOW]** `effectiveMaxSize` computed in `QueueOperations.getQueueStatus()` (line ~91) is assigned but never used — the function uses `maxQueueSize` and `remainingSlots` directly. Dead variable.
- **[LOW]** `buildPromptWithInstructions()` (line ~292) accepts `filePath?: string` with the doc comment "(unused, kept for compatibility)". If unused, remove it rather than carrying dead parameters indefinitely.
- **[LOW]** The base class creates five `EventEmitter` instances in the constructor (lines ~48–65). The `registerWithContext` boolean determines whether they are added to `context.subscriptions`. If `registerWithContext` is false, there is no automatic disposal path — the caller must manually call `dispose()`. This is documented but fragile; a forgotten `dispose()` leaks resources. Consider a `Disposable` pattern that returns a cleanup handle.
- **[INFO]** Clean abstract class design with sensible base-class defaults for optional methods (`isCli()`, `wasLastFailureUserCancellation()`, `getLastResult()`). No SOLID violations.

### 2.2 PromptQueue.ts

- **[HIGH]** **DRY violation — duplicate merge logic**: The "find new prompts from disk by hash" pattern appears **three times** in nearly identical form:
  1. `reloadAndMergeQueue()` (lines ~873–906) — builds `currentPromptHashes`, iterates disk prompts, filters by hash
  2. `mergePromptsFromDisk()` (lines ~973–1060) — builds `memoryPromptMap`, iterates disk prompts, filters by hash, then rebuilds results with same hash-or-text match
  3. `_updateWorkingFileInternal()` (lines ~1358–1430) — exact same `memoryPromptMap` + `newPromptsFromDisk` + results-rebuild pattern as `mergePromptsFromDisk()`

  Methods 2 and 3 are **nearly line-for-line identical** (both build `memoryPromptMap`, iterate `diskPrompts`, check `existsInMemory`, rebuild `newResults` with `findIndex` by hash-or-text). This should be extracted into a shared `mergeDiskPrompts()` helper.

- **[HIGH]** `reloadAndMergeQueue()` (line ~845) has a `parser: any` parameter typed as `any` with comment "kept for compatibility". The `any` type defeats all safety, and the method isn't called anywhere in production code (only in tests and docs). If it's dead code, remove it; if needed, properly type the parameter.
- **[MEDIUM]** `clear()` (line ~563) calls `this.stop()` (which fires events and sets CANCELLING state) before clearing prompts. However, `clear()` has **no callers** in production code — callers use `clearQueue()` instead. Both `clear()` and `clearQueue()` exist with overlapping but different behavior (clear calls stop first; clearQueue just resets). One should be removed to avoid confusion.
- **[MEDIUM]** Inconsistent logging: Some methods use `Log.error()` (e.g., `markCurrentAsFailed` line ~620: `Log.error` but also `console.error` on lines ~635, ~638), others use just `console.error` without `Log`. Three `console.error` calls (lines ~635, ~638, ~1466) bypass the centralized `Log` utility, violating the project's logging pattern. Use `Log.error()` consistently.
- **[MEDIUM]** `isCompleted()` (line ~1179) checks for `COMPLETED || IDLE`, which means an empty, never-started queue is considered "completed". This is semantically misleading. No callers exist in production code, so this may also be dead code.
- **[MEDIUM]** `getQueueExtensionStats()` (line ~952) is only called from tests, never from production code. Consider marking it as test-only or removing.
- **[MEDIUM]** `restart()` (line ~487) uses `as any` cast to strip `_runtime` from prompts: `const { _runtime: _, ...rest } = prompt as any`. This loses type safety. A typed approach like `Omit<PromptItem, '_runtime'>` would be cleaner.
- **[MEDIUM]** The `operationQueue` serialization pattern (line ~88) chains promises but never catches errors in the chain. If one operation throws, subsequent operations chained with `.then()` may execute out-of-order or stall. This is partially mitigated by try/catch inside each operation, but the queue promise chain itself could enter a broken state.
- **[LOW]** `getFailedCount()` (line ~712) is only called from tests, never from production code. Potential dead code.
- **[LOW]** The class is ~1,689 lines — the largest in the codebase. While it's a state container (appropriate for cohesive state), the file I/O operations (`createWorkingFile`, `readWorkingFile`, `writeWorkingFileAtomic`, `updateWorkingFile`, `_updateWorkingFileInternal`, `updateWorkingFileProperties`, `generateWorkingFilePath`) account for ~400+ lines and could be extracted into a `WorkingFileManager` class to improve separation of concerns. The queue is both a state machine AND a file persistence layer.
- **[LOW]** `getDefaultModelForHarness()` (line ~1590) duplicates model-resolution logic from `ConfigurationUtils`/`PropertyResolver`. This coupling means model-retrieval logic lives in two places.
- **[INFO]** Good use of `withFileLock()` wrapper for concurrent file access protection. Hash-based deduplication for merge operations is well-designed.

### 2.3 WorkflowExecutor.ts

- **[MEDIUM]** `waitForResponseComplete()` (line ~472) creates a Promise with an `onResponseComplete` listener but has **no timeout or cancellation mechanism**. If the integration never fires `onResponseComplete` (e.g., process crashes silently), the promise hangs forever. The executor loop will block indefinitely. Consider adding a safety timeout.
- **[MEDIUM]** `waitForResponseComplete()` has an unused `reject` parameter in the Promise constructor — `new Promise<string>((resolve, reject) => {` — `reject` is never called. If the listener somehow fails, there's no error path. If not needed, remove or add error handling via a timeout.
- **[MEDIUM]** `logWorkflowCompletion()` (line ~784) always logs `${totalPrompts}/${totalPrompts} prompts completed` regardless of actual completion count. If execution was paused/stopped early, this message is misleading. Should use `getCompletedCount()` instead.
- **[LOW]** `stepStatusMessages` map (line ~122) accumulates messages per step but is only cleared in `execute()` at the start. If the same `WorkflowExecutor` instance is reused across runs (which can happen via `resume()`), old status messages from previous runs could bleed into new ones. The map should be cleared per-step or scoped to the step.
- **[LOW]** The `executeWithStreaming()` method (line ~500) is ~130 lines with multiple concerns: dashboard init, listener setup, prompt sending, response waiting, listener cleanup. Consider extracting listener setup/teardown into a helper.
- **[INFO]** Good separation of concerns — the executor is focused on the execution loop and delegates end conditions to `EndConditionHandler`. The `WorkflowContext` bundle pattern avoids long parameter lists. Clean overall design.

### 2.4 WorkflowInstance.ts

- **[HIGH]** **Resource leak in `stop()`** (line ~845): Two separate `onResponseComplete` listeners are registered:
  1. Line ~855: `const responseCompleteDisposable = integration.onResponseComplete(...)` — disposed after first fire.
  2. Line ~870: `integration.onResponseComplete(() => { clearTimeout(timeoutHandle); })` — **never disposed**. This second listener leaks. It should be captured and disposed (or both callbacks merged into one listener).

- **[MEDIUM]** `isDashboardReady()` (line ~1194) always returns `true` with a comment saying the real check is upstream. This method is called in `executeLoadedPromptFile()` (line ~609) and gates execution with a dialog. Since it always returns `true`, the check is dead code — the `if (!this.isDashboardReady())` branch is unreachable.
- **[MEDIUM]** `console.log()` in `deletePromptFromQueue()` (line ~1042) uses `console.log` directly instead of `Log.info()`. Inconsistent with the rest of the codebase.
- **[MEDIUM]** `executeLoadedPromptFile()` (lines ~567–802) is ~235 lines with high cyclomatic complexity — multiple branching paths for `continueFromCurrent`, `isAppendContinuation`, queue status checks, history file initialization, dashboard state. This method handles too many concerns and would benefit from decomposition.
- **[MEDIUM]** `startWorkflowExecution()` (line ~1232) builds a `WorkflowContext` object with **four callback closures** that capture `self` (line ~1263). The `captureOutputInit` callback (line ~1291) modifies `completedStepOutputs.retryState` as a side effect. These closures create implicit coupling between `WorkflowInstance` and `WorkflowExecutor` that's hard to trace.
- **[LOW]** `bufferedEvents` array (line ~100) has a `MAX_BUFFER_SIZE` of 500, but the buffer is only replayed via `sendFullStateToDashboard()` which doesn't use the buffer contents — it does a full state sync regardless. The buffer captures event objects but `flushBufferedEvents()` (line ~253) just calls `sendFullStateToDashboard()` and clears the array without iterating. The buffering mechanism is effectively unused beyond cap enforcement.
- **[LOW]** `buildPromptItemProperties()` (line ~1544) uses a generic `coerce<T>` helper with `v as T` cast — this is an unsafe cast that provides no runtime validation. If the webview sends malformed data, it silently passes through.
- **[INFO]** The Phase 1 / Phase 2 architecture comments are helpful for understanding the roadmap. The `activeDashboard` getter pattern for lazy evaluation is clever.

### 2.5 WorkflowOrchestrator.ts

- **[MEDIUM]** **DRY violation** — `resolveDetectorIntegration()` (line ~941) and `getDefaultIntegration()` (line ~921) contain nearly identical switch statements mapping `Harness` enum values to integration instances. The only difference is that `resolveDetectorIntegration` has an optional harness override. These could be merged: `getDefaultIntegration` could call `resolveDetectorIntegration(undefined)`.
- **[MEDIUM]** `saveState()` (line ~346) and `restoreState()` (line ~354) are documented as no-ops. `saveState()` still writes an empty array to workspace state (`flightpath.loadedWorkflows`). Either remove the workspace state write entirely or document why clearing stale state is still needed.
- **[MEDIUM]** `createDraftPrompt()` (line ~766) reaches into `instance`'s private members via bracket notation: `instance["currentPromptFile"]` and `instance["setupPromptFileWatcher"]`. This violates encapsulation — these should be exposed as public/protected methods on `WorkflowInstance` if the orchestrator needs them.
- **[LOW]** The orchestrator holds four detector integrations (copilotCli, chat, claudeCli, codexCli) that are initialized at startup and live for the extension's lifetime. If the user only uses one harness, three integrations consume resources unnecessarily. Consider lazy initialization.
- **[LOW]** `executePromptFile()` (line ~464) creates a new workflow via `createWorkflow(filePath)` then calls `executeWorkflow(undefined, modeOverride)` — but `executeWorkflow(undefined, ...)` operates on the **viewed** instance, not necessarily the one just created. If `createWorkflow` returned a different instance (e.g., switched to existing), this could execute the wrong workflow. However, `createWorkflow` sets `viewedInstance`, so this is safe in practice but fragile.
- **[INFO]** Clean orchestrator pattern. The `buildWorkflowInstance()` method with queue state listener for auto-registration is well-designed. The retirement of completed workflows is clean.

### 2.6 PromptFileParser.ts

- **[MEDIUM]** **DRY violation** — Workflow-level property copying is duplicated verbatim in `normalizePromptFile()` at lines ~369–377 (single prompt format) and lines ~400–408 (multi prompt format). The same six `if (parsed.X !== undefined) promptFile.X = parsed.X` lines appear twice. Extract into a `copyWorkflowLevelProperties(parsed, promptFile)` helper.
- **[MEDIUM]** Schema loaded synchronously via `require("fs").readFileSync()` (line ~37) inside a class that otherwise uses async `fs/promises`. This is noted as intentional (avoid race condition) but mixes sync and async I/O patterns. A lazy-load pattern with async initialization would be cleaner.
- **[LOW]** `looksLikeFilePath()` heuristic (line ~155) doesn't account for Windows UNC paths (`\\server\share\file.md`) or home-relative paths (`~/file.md`). Edge case but could cause false negatives.
- **[LOW]** `PROMPT_FILE_EXTENSIONS` array (line ~17) has `".prompt"` extension which is not a documented format. Unclear if this is intentional or dead.
- **[INFO]** The three-tier path resolution in `resolvePromptFilePath()` (directory-relative → workspace-relative → .flightpath-relative) is well-designed and documented. AJV validation is correctly applied. Clean file overall.

### 2.7 EndConditionEvaluator.ts

- **[MEDIUM]** **Security concern** — `resolveScriptPath()` resolves paths relative to workspace but does not validate that the final resolved path is **within** the workspace. A crafted script path like `../../etc/passwd` or `../../../some/script.py` could escape the workspace boundary. The path resolution tries workspace-relative and `.flightpath`-relative, but `path.resolve()` with `../` can escape. Add a check that the resolved path starts with the workspace root.
- **[MEDIUM]** `getScriptCommand()` for `.ps1` files uses `powershell` (line ~237) instead of `pwsh`. Modern PowerShell 7+ is `pwsh`; `powershell` is Windows PowerShell 5.1 only. On systems with only `pwsh`, PowerShell scripts would fail. Consider checking for `pwsh` first, falling back to `powershell`.
- **[MEDIUM]** The `checkResult()` method (line ~321) has ambiguous matching semantics: it tries exact match, then boolean interpretation, then numeric comparison (`actual >= expected`), then substring match. The numeric `>=` comparison means `checkResult("50", "80")` returns `false` but `checkResult("90", "80")` returns `true` — this is intentional for coverage percentages but isn't documented in the schema or user-facing docs. The substring fallback means `checkResult("true_but_not_really", "true")` would match via contains, bypassing the boolean check that already passed.
- **[LOW]** Hardcoded `Log.info(\`Cleaned ${5} VS Code env vars...\`)`(line ~290) — the`5` is a hardcoded magic number that would be wrong if env var cleanup lines are added/removed. Should derive from the actual count of deleted keys.
- **[LOW]** `parseScriptCommand()` (line ~42) only handles space-separated arguments. Quoted paths with spaces (e.g., `"C:\My Scripts\check.py" --flag`) would be incorrectly split. However, this is documented as a simple parser.
- **[INFO]** Good process isolation with `CliProcessManager`. Clean env variable sanitization for nested VS Code instances. The template-based retry prompt builder is well-factored.

### 2.8 EndConditionHandler.ts

- **[MEDIUM]** **Recursive retry** — `handleValidationFailure()` (line ~215) calls `handleEndConditionResult()` recursively after each retry. With high `maxRetries` (or `-1` for unlimited), this builds up a deep call stack. For `-1` (unlimited retries), this could potentially cause a stack overflow if the condition never passes. An iterative loop would be safer.
- **[LOW]** `handleMaxRetriesExhausted()` (line ~270) offers "Retry Once More" in the dialog, but the handler returns `{ shouldContinue: false }` for that action — the comment says "Don't increment retry count, just return false to re-evaluate" but the calling code doesn't act on this. The "Retry Once More" button effectively does nothing different from "Stop Workflow". This appears to be a bug — the intent was to allow one more retry, but the implementation stops the workflow.
- **[LOW]** `handleExecutionError()` (line ~146) offers "Open Script" which tries to open `prompt.endCondition.script` as a raw file path. But the script path might be a shell command (e.g., `npm test`), not a file. This would show a confusing error when trying to open `npm` as a file.
- **[INFO]** Clean separation of execution errors vs. validation failures. The callback pattern for retry prompts avoids circular dependencies. Well-structured overall.

### 2.9 IntegrationFactory.ts

- **[INFO]** Clean, focused factory class. Short file (~83 lines) with single responsibility. The `createForExecution()` method correctly skips initialization and calls `markAsReady()`. No issues found.

### 2.10 QueueOperations.ts

- **[MEDIUM]** Deprecated type alias `AppendPosition` (line ~22) is declared with a `@deprecated` tag but is still exported. Check if any consumers still import it; if not, remove it.
- **[MEDIUM]** `endCondition: any` in `AppendPromptsRequest.prompts` (line ~56) uses `any` type for end conditions. Should use the `EndCondition` type from `FlightPathTypes` for type safety.
- **[LOW]** `effectiveMaxSize` variable (line ~91) is computed but never referenced — only `maxQueueSize` and `remainingSlots` are used in the return value. Dead variable.
- **[INFO]** Well-documented single-source-of-truth pattern for both MCP and LM Tool consumers. Clean functional API.

### 2.11 TemplateManager.ts

- **[MEDIUM]** Uses synchronous `fs.readFileSync()`, `fs.existsSync()`, `fs.writeFileSync()`, `fs.mkdirSync()`, and `fs.readdirSync()` throughout (lines ~128, ~139, ~229, etc.). This blocks the extension host thread during file I/O. The rest of the codebase uses `fs/promises` or `vscode.workspace.fs`. Should migrate to async I/O for consistency and to prevent UI freezes with large template directories.
- **[MEDIUM]** `console.warn()` used twice (lines ~327, ~332) instead of `Log.warn()`. Inconsistent with the codebase's centralized logging.
- **[LOW]** `CREATE_TEMPLATE_ACTION` (line ~65) uses emoji `➕` in the template name. While this works in QuickPick, it's an indirect UI concern embedded in a data model. Consider separating display formatting from data.
- **[LOW]** `extractVariables()` regex `{([a-z][a-zA-Z0-9]*)}` (line ~180) only matches camelCase identifiers starting with lowercase. Variable names like `FeatureDescription` or `FEATURE` would not be matched. This may be intentional but isn't documented.
- **[INFO]** Built-in template definitions are cleanly separated from custom template discovery. Variable substitution is simple and effective.

---

## 3. CLI Integration

**Scope:** 28 files across `src/flightpath/cli/` — core `CliIntegration.ts`, 7 shared utilities, 6 shared interfaces, and 15 provider-specific files (5 each for Copilot, Claude, Codex).

### 3.1 CliIntegration.ts (1,954 lines)

- **[HIGH]** **Massive duplication in headless retry callback** (lines ~1740–1860): The `onRetryResponse()` callback inside `executeHeadless()` duplicates the entire primary `onResponseComplete()` callback — approximately 40 lines of identical logic for constructing `UniversalCliOutput`, extracting session IDs, computing token usage, and emitting events. Extract a shared `buildResponseOutput(stdout, stderr, exitCode)` helper that both callbacks invoke.
- **[HIGH]** **God class characteristics**: `CliIntegration` handles initialization, execution mode selection, prompt sending (interactive + headless), log file monitoring, session management, MCP config generation, process lifecycle, cleanup, and notification monitoring. At 1,954 lines, it's the second-largest file in the codebase. The log monitoring subsystem (~300 lines: `monitorLogFile()`, `processNewEvents()`, `getEntryTimestamp()`) and MCP config subsystem (~100 lines) could be extracted into focused helper classes without breaking the composition architecture.
- **[MEDIUM]** **Dead code — `generateMcpConfigFile()`** (lines ~280–310): Placeholder method that always returns `null` with a TODO comment. The method is declared in the class, called during `buildCliArgs()`, but its result is immediately discarded when `null`. Either implement it or remove the dead path.
- **[MEDIUM]** **Duplicated timestamp extraction** — `getEntryTimestamp()` helper inside `monitorLogFile()` (line ~1168) duplicates `BaseLogParser.extractTimestamp()`. Both perform the same `entry.timestamp || entry.time || entry.ts` cascading lookup with `Date.parse()` validation. The `monitorLogFile` method should delegate to the log parser's implementation.
- **[MEDIUM]** **Redundant character checks in `isSimplePrompt()`** (line ~685): After the regex `/^[a-zA-Z0-9\s.,!?;:'\-()]+$/` already validates that the string contains only safe characters, there are additional explicit checks for `"`, `'`, `\`, `` ` ``, and `$` — all of which are already excluded by the regex character class. Remove the redundant checks or simplify to regex-only.
- **[MEDIUM]** **`currentProcess` field never assigned**: The field is declared (line ~75) and checked in `cancelExecution()` (line ~890) but never populated. The comment says "headless mode never sets it" — but headless mode _does_ spawn a process via `CliProcessManager`. The field should either be removed (since cancellation works via `CliProcessManager.kill()` directly) or properly wired to the spawned process.
- **[LOW]** **Pervasive `any` types in event processing**: `processNewEvents()` (line ~1200) accepts `events: any[]` and accesses `.type`, `.text`, `.content` properties without type guards. The events come from typed log parsers that return `any[]` — the `any` propagates from the `ILogParser` interface. Should use a minimal event interface (e.g., `{ type: string; [key: string]: unknown }`).
- **[LOW]** **Magic numbers in retry timing**: `monitorLogFile()` uses hardcoded polling intervals (500ms, 1000ms, 2000ms) and retry counts (10, 20) without named constants. These should be extracted to configurable constants at class level.
- **[INFO]** The composition architecture is sound — `CliIntegration` correctly delegates to `ICliProvider` components without knowing provider specifics. The interactive vs. headless execution mode split is clean.

### 3.2 Shared Utilities & Base Classes

#### 3.2.1 BaseLogParser.ts (470 lines)

- **[MEDIUM]** **All abstract methods use `any` types**: `extractResponse(events: any[])`, `extractEvents(content: string): any[]`, `discoverSessionLog(...): Promise<string | undefined>` — the `any` type propagates to all three provider log parsers and through `CliIntegration.processNewEvents()`. These should use a base event type like `{ type: string; timestamp?: number; [key: string]: unknown }`.
- **[MEDIUM]** **`readJsonlEvents()` returns `any[]`** (line ~180): Parses JSONL and returns untyped objects. Since each provider has its own event structure, this could use a generic `T extends BaseEvent` parameter to propagate provider-specific types.
- **[LOW]** **`normalizePromptForMatching()`** (line ~350) lowercases, trims, and collapses whitespace. This is a good shared utility, but it's only used by the log parsers during `discoverSessionLog()`. Consider whether it belongs in a general string utility instead of a log-parser base class.
- **[INFO]** Good base class design with shared JSONL reading, file watching, and session discovery scaffolding. The `watchForNewEntries()` file-watcher pattern is well-implemented with debouncing.

#### 3.2.2 CliOutputFormatter.ts (217 lines)

- **[INFO]** Clean static utility class. Formatting methods are well-separated by event type (text, tool call, bash command, file operation). ANSI stripping is correctly applied. No issues found.

#### 3.2.3 CliResponseParser.ts (214 lines)

- **[HIGH]** **`extractJsonObjectsFromStream()` duplicated by Claude provider** — This exact algorithm (buffer incomplete JSON, brace-depth tracking, handle strings/escapes) is reimplemented in `ClaudeResponseParser.extractJsonObjectsFromStream()` (lines ~870–949). The Claude version is a direct copy with minor variable naming differences. The Claude parser should import and use this shared utility.
- **[LOW]** **`parseJsonlContent()` returns `any[]`** — Same `any` propagation issue as `BaseLogParser.readJsonlEvents()`. Should use a generic type parameter.
- **[INFO]** The streaming JSON extractor is well-implemented with proper escape handling and nested brace tracking.

#### 3.2.4 CliNotificationMonitor.ts (305 lines)

- **[MEDIUM]** **`NotificationConfig` interface duplicated** — The `NotificationConfig` type is defined here (line ~18) AND in `INotificationMonitor.ts` (line ~24). Both have identical fields (`notifyDir`, `notifyScript`, `pollInterval`, `timeout`). The shared utility should import from the interface file rather than defining its own.
- **[MEDIUM]** **Static `extractSessionId()` / `extractThreadId()` methods unused by providers** — These utility methods (lines ~240, ~260) extract session IDs from notification file content, but all three provider notification monitors implement their own `extractSessionId()` instance methods instead. Either the providers should delegate to these shared statics, or the statics should be removed.
- **[LOW]** **Polling-based file detection** — `monitorForCompletion()` polls the notification directory every `pollInterval` ms. For systems generating high notification volume, `fs.watch()` would be more efficient. However, polling is simpler and more reliable across platforms, so this is a reasonable trade-off.

#### 3.2.5 CliToolPermissionMapper.ts (183 lines)

- **[MEDIUM]** **`ToolPermissionMode` type duplicated** — Defined here (line ~12) as `"dangerouslyAllowAll" | "allowAll" | "custom"` AND in `IToolPermissionMapper.ts` (line ~10). Both are identical. Single-source this in the interface file.
- **[MEDIUM]** **`COPILOT_TO_CLAUDE_MAP` duplicated** — This constant map (line ~25) converting Copilot tool patterns to Claude patterns is duplicated in `ClaudeToolPermissionMapper.ts` (line ~30). The shared utility defines the canonical mapping, but Claude's mapper defines its own independent copy. Use the shared one.
- **[MEDIUM]** **`validatePatterns()` incomplete** — The validation method (line ~140) generates warnings for patterns but never returns structured validation errors. The method signature suggests it should check pattern validity, but it only logs warnings to `Log.warn()` and returns nothing. Either make it void with clear side-effect documentation, or return a `ValidationResult` array.
- **[LOW]** **`CLAUDE_TO_COPILOT_MAP`** (line ~45) is defined but appears unused in the shared utility — no method calls it. It exists for potential future reverse mapping but is dead code in this file.

#### 3.2.6 CliMcpConfigGenerator.ts (134 lines)

- **[LOW]** **`any` type on `mcpServers`** (line ~40): `const mcpServers: any = settings.get("mcpServers")`. Should use a typed interface matching the expected MCP server configuration shape.
- **[INFO]** Clean, focused utility. Single responsibility of generating MCP config JSON for CLI harnesses. Good path normalization for cross-platform support.

### 3.3 Shared Interfaces

#### 3.3.1 ICliProvider.ts (175 lines)

- **[MEDIUM]** **`buildCliArgs()` uses `any` for `prompt` and `context` parameters** (line ~68): `buildCliArgs(prompt: any, context: any): Promise<string[]>`. These are the core data structures of the system — `prompt` is always a `PromptItem` and `context` is always a `WorkflowContext`. Using `any` means providers receive no type checking on their most important inputs.
- **[LOW]** **`getWorkspaceDirs()` is declared optional** (line ~120) but all three providers implement it identically. If it's always needed, make it required and extract the common implementation to a base class or shared utility.

#### 3.3.2 ILogParser.ts (252 lines)

- **[MEDIUM]** **All method signatures use `any[]`** — `extractResponse(events: any[])`, `extractEvents(content: string): any[]`, `processEvent(event: any)`, `formatStatistics(events: any[])`. This is the root cause of `any` propagation throughout the entire CLI layer. Define a minimal `BaseCliEvent = { type: string; timestamp?: number; [key: string]: unknown }` and use it as the bound.
- **[LOW]** **`LogParserBase` abstract class** (line ~130) provides default no-op implementations for optional methods. This is good defensive design but means concrete parsers may silently inherit no-op behavior for methods they should override (e.g., `processEvent()` in Codex).

#### 3.3.3 IResponseParser.ts (153 lines)

- **[INFO]** Clean interface with well-structured `ResponseParserBase` abstract class. The `stripAnsiCodes()` utility in the base class prevents duplication. No significant issues.

#### 3.3.4 INotificationMonitor.ts (247 lines)

- **[MEDIUM]** **`NotificationConfig` and `NotificationResult` types duplicated** — Both are defined here AND in `CliNotificationMonitor.ts`. The shared utility file should import from here, not redefine. This creates drift risk if one definition is updated without the other.
- **[LOW]** **`NotificationMonitorBase` abstract class** provides a `waitForNotificationFile()` utility (line ~160) that reimplements file-polling logic similar to `CliNotificationMonitor.monitorForCompletion()`. Two implementations of the same polling pattern exist in the notification monitoring subsystem.

#### 3.3.5 IToolPermissionMapper.ts (149 lines)

- **[MEDIUM]** **`ToolPermissionMode` duplicated** — Same type defined here and in `CliToolPermissionMapper.ts`. Remove the duplicate.
- **[INFO]** `ToolPermissionMapperBase` provides a useful `parsePattern()` method for tool pattern parsing. Good base class design.

#### 3.3.6 shared/interfaces/index.ts

- **[INFO]** Clean barrel re-export file. No issues.

### 3.4 Copilot Provider

#### 3.4.1 CopilotCliProvider.ts (507 lines)

- **[HIGH]** **`getWorkspaceDirs()` duplicated across all providers** — This method (line ~380) retrieves workspace folders from VS Code API plus `cliAdditionalDirs` settings, formats them into `--add-dir` flags, and returns the array. The identical logic is copy-pasted in `ClaudeCliProvider` (line ~340) and `CodexCliProvider` (line ~290). This is ~30 lines duplicated three times. Extract to a shared utility function (e.g., `CliProviderUtils.getWorkspaceDirs()`).
- **[HIGH]** **MCP configuration block duplicated** — The `buildCliArgs()` method contains a ~20-line MCP config block (lines ~155–175) that generates `--mcp-config` arguments. The same block (read settings, generate JSON, write temp file, append args) is copy-pasted across all three providers. Extract to a shared helper or delegate to `CliMcpConfigGenerator`.
- **[MEDIUM]** **Shell injection risk in `buildInteractiveTuiCommand()`** (line ~230): Uses basic double-quote escaping (`prompt.replace(/"/g, '\\"')`) for prompt text embedded in shell commands. While `isSimplePrompt()` pre-filters most dangerous characters, complex prompts that pass the filter could still contain sequences like `$(...)` or backticks that are interpreted by the shell. Consider using a temp file for prompt passing in all cases (not just when `isSimplePrompt()` returns false).
- **[MEDIUM]** **`createHookFile()`** (line ~280) writes JSON files to `.github/hooks/` directory. The path is constructed from `workspaceRoot` + `.github/hooks/` + hook filename, but there's no validation that `workspaceRoot` doesn't contain path traversal components. In practice `workspaceRoot` comes from VS Code's trusted workspace API, but defense-in-depth is warranted.
- **[LOW]** **`COPILOT_DEFAULT_MODEL` imported but overridable** — The default model is set from `ModelConstants` but can be overridden at three levels (settings, workflow, prompt). The resolution chain is correct but spread across PropertyResolver, ConfigurationUtils, and this provider.

#### 3.4.2 CopilotLogParser.ts (1,285 lines)

- **[HIGH]** **`mapToolToSemanticEvent()` duplicated 4+ times** — This method (line ~600) maps tool names to semantic CLI event types (bash→BASH_COMMAND, read_file→FILE_READ, write/edit→FILE_WRITE/FILE_EDIT, delete→FILE_DELETE, MCP→MCP_TOOL_CALL, web_search→WEB_SEARCH). The exact same mapping logic is reimplemented in `ClaudeLogParser` (line ~500), `ClaudeResponseParser` (line ~400), `CodexLogParser` (lines ~300, ~500, ~700 — three times within the same file!). This is the single largest source of duplication in the entire CLI layer (~100 lines × 6 instances = ~600 lines of duplicated code). Extract to a shared `CliEventMapper.mapToolToSemanticEvent()` utility.
- **[MEDIUM]** **`eventBuffer` field declared but never used** (line ~45): Instance field `private eventBuffer: any[] = []` is initialized in the constructor but never populated, read, or referenced by any method. Dead code — remove it.
- **[MEDIUM]** **`readFirstEvents()` helper duplicated** (line ~900): Private method that reads the first N JSONL events from a file. Nearly identical implementations exist in `ClaudeLogParser.readFirstNEvents()` and `CodexLogParser.readFirstEvents()`. Should be in `BaseLogParser`.
- **[LOW]** **`formatStatistics()` nearly identical across parsers** — The token counting and statistics formatting logic (line ~1050) follows the same pattern in all three parsers: iterate events, sum input/output tokens, format with commas. Minor differences in token field names (`input_tokens` vs `prompt_tokens`). Could be generalized in `BaseLogParser` with a token-field configuration object.
- **[LOW]** **Large `extractResponse()` method** (~200 lines): Handles multiple event types with nested conditionals for tool_calls, function_calls, and different message roles. The method is readable but could benefit from extracting event-type handlers into separate methods.

#### 3.4.3 CopilotResponseParser.ts (126 lines)

- **[INFO]** Clean, focused parser. Correctly delegates to shared utilities for ANSI stripping. Uses proper `CodexCliJsonEvent`-style typed events. No issues found.

#### 3.4.4 CopilotNotificationMonitor.ts (171 lines)

- **[INFO]** Clean delegation to shared `CliNotificationMonitor` utility. Hook configuration for sessionEnd is well-structured. No issues.

#### 3.4.5 CopilotToolPermissionMapper.ts (171 lines)

- **[MEDIUM]** **`parsePattern()` reimplements base class logic** — This class does NOT extend `ToolPermissionMapperBase` (it directly implements `IToolPermissionMapper`). Its `parsePattern()` method (line ~110) reimplements the same pattern-parsing logic that `ToolPermissionMapperBase.parsePattern()` provides. Either extend the base class or extract `parsePattern()` to a standalone utility.
- **[LOW]** **Copilot-specific pattern format undocumented** — The `buildArgs()` method constructs `--allow` and `--deny` flags with specific pattern syntax (`tool(name)`, `mcp(server:tool)`). The format is specific to GitHub Copilot CLI but only documented in inline comments. Consider adding a reference to Copilot CLI docs.

### 3.5 Claude Provider

#### 3.5.1 ClaudeCliProvider.ts (423 lines)

- **[HIGH]** **`getWorkspaceDirs()` duplication** — Same issue as CopilotCliProvider (see 3.4.1). Identical implementation copy-pasted.
- **[HIGH]** **MCP configuration block duplication** — Same issue as CopilotCliProvider (see 3.4.1). Copy-pasted `--mcp-config` arg generation.
- **[MEDIUM]** **Redundant `require()` inside method body** — `getMcpConfigArgs()` (line ~200) uses `const fs = require("fs/promises")` and `const path = require("path")` inside the method body, but both `fs` and `path` are already imported at the top of the file via static `import` statements. This creates unnecessary local require shadows and defeats bundler optimizations. Use the existing imports.
- **[LOW]** **`shouldStartNewSession()` pattern duplicated** — The logic for determining whether to start a new CLI session vs. resume an existing one (check `resumeSession`, `sessionId`, working file state) is similar across all three providers. The nuances differ per CLI (e.g., Claude uses `--resume`, Copilot uses `--session-id`), but the decision logic is largely shared.

#### 3.5.2 ClaudeLogParser.ts (975 lines)

- **[HIGH]** **`mapToolToSemanticEvent()` duplication** — Same tool-to-event mapping as CopilotLogParser (see 3.4.2). Identical pattern matching for bash/read/write/edit/delete/MCP/search tools with only tool-name differences (Claude uses `Bash`, `Read`, `Write` vs. Copilot's `bash`, `read_file`, `write_to_file`).
- **[MEDIUM]** **`readFirstNEvents()` duplication** — Same helper as CopilotLogParser.readFirstEvents() and CodexLogParser.readFirstEvents(). Should be in BaseLogParser.
- **[MEDIUM]** **`extractResponse()` tool-result handling duplicated with `ClaudeResponseParser`** — Both ClaudeLogParser.extractResponse() and ClaudeResponseParser.processStreamingChunk() contain nearly identical logic for processing `tool_result` content blocks (text extraction, error detection, result formatting). ~50 lines duplicated.
- **[LOW]** **Claude-specific tool names hardcoded** — Tool name matching (e.g., `"Bash"`, `"Read"`, `"Write"`, `"Edit"`, `"MultiEdit"`) is hardcoded as string literals rather than constants. If Claude CLI renames tools, every occurrence must be found and updated manually.

#### 3.5.3 ClaudeResponseParser.ts (949 lines)

- **[CRITICAL]** **`extractJsonObjectsFromStream()` is a full reimplementation of `CliResponseParser.extractJsonObjectsFromStream()`** (lines ~870–949). The shared utility in `CliResponseParser` provides this exact functionality — streaming JSON extraction with brace-depth tracking, string escape handling, and buffer management. The Claude-specific version is algorithmically identical with cosmetic differences (variable names, comments). This is ~80 lines of duplicated algorithmic code. **Remove the local version and use the shared utility.**
- **[HIGH]** **`mapToolToSemanticEvent()` duplication** — Third instance of this mapping (see 3.4.2). This response parser has its own copy in addition to ClaudeLogParser's copy. Within the Claude provider alone, the tool mapping exists twice.
- **[MEDIUM]** **`processUserContent()` duplicated with `ClaudeLogParser.extractResponse()`** — Both handle `tool_result` type content blocks with the same extraction logic for `text`, `is_error`, and result text formatting. ~40 lines duplicated between response parser and log parser within the same provider.
- **[LOW]** **File is 949 lines** — Large for a response parser. The bulk comes from the duplicated `extractJsonObjectsFromStream()` (~80 lines) and `mapToolToSemanticEvent()` (~100 lines). Removing these duplications would reduce the file to ~770 lines.

#### 3.5.4 ClaudeNotificationMonitor.ts (320 lines)

- **[MEDIUM]** **`isFileNewerThan()` method referenced** (line ~180) but not visible as an inherited method from `NotificationMonitorBase`. If this is inherited, the call chain is hard to trace; if it's not, it will throw at runtime. Verify this method exists in the base class chain.
- **[LOW]** **`waitForSessionStart()` complex retry logic** — The method has nested retry loops with exponential backoff and multiple timeout mechanisms (overall timeout + per-poll timeout + file-age check). While functionally correct, the complexity makes it difficult to reason about timing edge cases. Consider simplifying with a single polling loop.

#### 3.5.5 ClaudeToolPermissionMapper.ts (158 lines)

- **[HIGH]** **`hasFullPermissions()` always returns `true`** (line ~120): `hasFullPermissions(config: ToolPermissionConfig): boolean { return true; }`. This completely ignores the configuration, including denial patterns. If a user configures `deniedTools: ["Bash(*)"]`, the system will incorrectly report full permissions are granted. This defeats the purpose of permission checking and could lead to unexpected tool execution behavior.
- **[MEDIUM]** **`COPILOT_TO_CLAUDE_MAP` duplicated from shared utility** — The constant (line ~30) is a copy of `CliToolPermissionMapper.COPILOT_TO_CLAUDE_MAP`. Changes to one won't propagate to the other. Import from the shared utility or extract to a constants file.
- **[LOW]** **`buildArgs()` generates `--allowedTools` / `--disallowedTools`** — Uses comma-separated tool lists. The CLI flag names should be verified against current Claude CLI documentation; Claude CLI has changed flag names between versions.

### 3.6 Codex Provider

#### 3.6.1 CodexCliProvider.ts (392 lines)

- **[HIGH]** **`getWorkspaceDirs()` partial duplication** — Similar to other providers but with a key difference: Codex's version (line ~290) only includes VS Code workspace folders and does NOT include `cliAdditionalDirs` from settings. This inconsistency means Codex users can't add extra directories via settings while Copilot and Claude users can. If intentional, it should be documented; if a bug, add the missing setting support.
- **[HIGH]** **MCP configuration block duplication** — Same copy-paste as other providers (see 3.4.1).
- **[LOW]** **`shouldStartNewSession()` logic simpler** — Codex's session management is simpler (Codex uses thread IDs), but the overall decision pattern still overlaps with the other providers.

#### 3.6.2 CodexLogParser.ts (1,943 lines — LARGEST FILE)

- **[CRITICAL]** **Tool mapping duplicated THREE TIMES within the same file** — The tool-name-to-semantic-event mapping appears for `tool_use` events (line ~300), `function_call` events (line ~500), and `custom_tool_call` events (line ~700). Each block is ~100 lines of identical switch/if-else logic mapping bash→BASH_COMMAND, read→FILE_READ, write→FILE_WRITE, etc. This is ~300 lines of internal duplication that should be a single shared method. This single issue accounts for approximately 15% of the file's total line count.
- **[HIGH]** **`mapToolToSemanticEvent()` (if extracted) would be the 7th instance** — Including the three internal copies, this file contributes three of the six-plus copies of tool mapping across the codebase.
- **[MEDIUM]** **Stateful instance fields leak across calls** — `eventBuffer` (line ~50), `sessionMeta` (line ~55), and `toolCallMap` (line ~60) are mutable instance fields that accumulate state across calls. If the same `CodexLogParser` instance is reused across workflow runs (which happens when the integration persists), stale state from previous runs could contaminate new parsing operations. These should be cleared at the start of each `extractResponse()` call or scoped per-invocation.
- **[MEDIUM]** **`processEvent()` appears unused** (line ~1250): The method buffers events into `eventBuffer` and updates `sessionMeta`, but no caller invokes it. `extractResponse()` processes events directly without calling `processEvent()`. Dead code.
- **[MEDIUM]** **`readFirstEvents()` duplicated** — Same helper as Copilot and Claude parsers (see 3.4.2). Reads first N JSONL lines from a file. Should be in `BaseLogParser`.
- **[LOW]** **File could be ~800 lines** — After extracting the shared tool mapping (~300 lines internal duplication), removing `processEvent()` dead code (~50 lines), moving `readFirstEvents()` to base class (~40 lines), and extracting `formatStatistics()` to base class (~50 lines), the file would be approximately 800–900 lines — less than half its current size.

#### 3.6.3 CodexResponseParser.ts (645 lines)

- **[MEDIUM]** **`parseJsonLines()` duplicates `CliResponseParser.parseJsonlContent()`** — Private method (line ~590) implements JSONL parsing (split by newline, trim, JSON.parse, skip errors). The shared `CliResponseParser.parseJsonlContent()` does the same thing. The Codex version returns typed `CodexCliJsonEvent[]` — this could be achieved by calling the shared version and casting, or by making the shared version generic.
- **[MEDIUM]** **`parseItemToEvents()` partially duplicated in `processStreamingChunk()`** — The `item.completed` handling in `processStreamingChunk()` delegates to `parseItemToEvents()`, but `item.started` handling (line ~490) reimplements a subset of the same event-creation logic (bash command INITIATED, reasoning THINKING). This is minor internal duplication but adds maintenance surface.
- **[LOW]** **Empty `formatCommandExecution()` method** (line ~645): Documented but has an empty body. Dead code or incomplete implementation.
- **[INFO]** The response parser is well-structured with comprehensive handling of all 8 Codex item types (agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error). The `processStreamingChunk()` delta-tracking for command output is a clever approach.

#### 3.6.4 CodexNotificationMonitor.ts (145 lines)

- **[LOW]** **`waitForSessionStart` commented as "intentionally not implemented"** — The method signature is absent (only a comment exists). Codex falls back to log file discovery. This is acceptable but means Codex has slower session detection than providers with start hooks. When Codex adds start hook support, this would be the place to implement it.
- **[INFO]** Clean, minimal implementation. Good delegation to shared `CliNotificationMonitor` utility. TOML hook config format is correctly implemented.

#### 3.6.5 CodexToolPermissionMapper.ts (138 lines)

- **[MEDIUM]** **`buildCodexSpecificArgs()` duplicates `buildArgs()` logic** — Both methods (lines ~48 and ~100) contain the same switch statement over `config.mode` with the same `dangerouslyAllowAll`→bypass, `allowAll`→full-auto mappings. The custom mode differs (sandboxMode/approvalPolicy parameters), but the duplicated branches should be extracted. `buildArgs()` could delegate to `buildCodexSpecificArgs(config, undefined, undefined)`.
- **[LOW]** **Custom mode falls back silently** — When `mode === "custom"` but no `sandboxMode`/`approvalPolicy` are provided, it logs a warning and falls back to `--full-auto`. This silent fallback could surprise users who expect custom restrictions. Consider throwing or sending a visible notification.
- **[INFO]** Correctly documents that Codex CLI does not support granular tool patterns. The warning for unsupported `allowedTools`/`deniedTools` is appropriate user feedback.

### 3.7 Cross-Cutting Concerns

#### 3.7.1 DRY Violations — Quantified Impact

| Duplication Pattern                       | Instances                                                                                   | Lines Each | Total Waste | Severity     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- | ----------- | ------------ |
| `mapToolToSemanticEvent()` tool mapping   | 6+ (3 in CodexLogParser, 1 each in CopilotLogParser, ClaudeLogParser, ClaudeResponseParser) | ~100       | ~500+       | **CRITICAL** |
| `getWorkspaceDirs()` across providers     | 3 (Copilot, Claude, Codex)                                                                  | ~30        | ~60         | **HIGH**     |
| MCP config block in `buildCliArgs()`      | 3 (all providers)                                                                           | ~20        | ~40         | **HIGH**     |
| `readFirstEvents()`/`readFirstNEvents()`  | 3 (all log parsers)                                                                         | ~40        | ~80         | **MEDIUM**   |
| `extractJsonObjectsFromStream()`          | 2 (shared + Claude reimplementation)                                                        | ~80        | ~80         | **CRITICAL** |
| `formatStatistics()`                      | 3 (all log parsers)                                                                         | ~50        | ~100        | **MEDIUM**   |
| Headless retry callback in CliIntegration | 2 (primary + retry)                                                                         | ~40        | ~40         | **HIGH**     |
| `NotificationConfig` type                 | 2 (shared + interface)                                                                      | ~8         | ~8          | **MEDIUM**   |
| `ToolPermissionMode` type                 | 2 (shared + interface)                                                                      | ~3         | ~3          | **MEDIUM**   |
| `COPILOT_TO_CLAUDE_MAP` constant          | 2 (shared + Claude mapper)                                                                  | ~15        | ~15         | **MEDIUM**   |
| `shouldStartNewSession()` pattern         | 3 (all providers)                                                                           | ~25        | ~50         | **LOW**      |
| **Total estimated duplicated lines**      |                                                                                             |            | **~976+**   |              |

#### 3.7.2 Type Safety

- **[HIGH]** The `any` type flows from `ILogParser` interface methods through `BaseLogParser` abstract methods, into all three concrete log parsers, and up into `CliIntegration.processNewEvents()`. This creates a pipeline where event data is completely untyped across ~3,000 lines of code. A single `BaseCliEvent` interface at the root would provide incremental safety without requiring provider-specific types.
- **[MEDIUM]** `ICliProvider.buildCliArgs(prompt: any, context: any)` — The two most important parameters in the entire CLI layer are untyped. Every provider implementation casts and accesses properties with no compile-time checking.

#### 3.7.3 Architecture Recommendations

1. **Extract `CliEventMapper`** — A single static utility class with `mapToolToSemanticEvent(toolName: string, harnessId: string): CLI_EVENT_TYPES` would eliminate ~500+ lines of duplication. The harness-specific tool names (Copilot: `bash`, Claude: `Bash`, Codex: `shell`) can be mapped via a configuration object.
2. **Extract `CliProviderUtils`** — Move `getWorkspaceDirs()` and MCP config generation to a shared utility, saving ~100 lines across providers and ensuring consistent behavior (e.g., the Codex `cliAdditionalDirs` gap).
3. **Move `readFirstEvents()` to `BaseLogParser`** — All three parsers have identical implementations. The base class already has `readJsonlEvents()` — add a `readFirstNJsonlEvents(filePath, count)` variant.
4. **Define `BaseCliEvent` type** — Replace `any[]` in `ILogParser` with `{ type: string; timestamp?: number; [key: string]: unknown }`. This provides minimal type safety without constraining provider-specific event structures.
5. **Split `CliIntegration.ts`** — Extract log monitoring (~300 lines) into `CliLogMonitor` and MCP config (~100 lines) into the existing `CliMcpConfigGenerator`. This would bring the core class to ~1,500 lines with cleaner separation of concerns.

---

## 4. Chat & Orchestration

### 4.1 CopilotChatIntegration.ts

- **[HIGH]** **`ChatLogMonitor` is dead code** — The class is imported in the instructions and documented as a "legacy fallback", but `CopilotChatIntegration` never instantiates or references it. No file in `src/` imports `ChatLogMonitor`. The entire `ChatLogMonitor.ts` file (249 lines) is unreachable dead code. Either integrate it as an actual fallback or remove it entirely.
- **[MEDIUM]** **DRY violation — `commandMap` duplicated** (lines ~56 and ~69): `getChatWindowCommand()` and `startNewChatSession()` both define independent `commandMap: Record<string, string>` objects mapping `chatPanel`/`newTab`/`newWindow` to VS Code commands. While the commands differ between the two methods, the pattern of reading `ConfigurationUtils.getChatWindowLocation()` and applying a map is duplicated. Extract a shared `getChatCommand(purpose: 'focus' | 'new')` helper.
- **[MEDIUM]** **`getCapabilities()` is dead code** (line ~803): Defined as an override but never called by any consumer in the entire `src/` directory. The base class `HarnessIntegration.getCapabilities()` is also never called. Both should be removed.
- **[MEDIUM]** **`getStatus()` return type is an anonymous object** (line ~701): Returns `{ available: boolean; message: string; strategy: string }` — should use a named interface or the one declared in `HarnessIntegration`. The same anonymous type appears in the base class declaration. This is not technically a bug but makes the API harder to reference.
- **[MEDIUM]** **`resolvedProperties?: any`** in `sendPrompt()` workflow context (line ~310): The `resolvedProperties` parameter uses `any`, bypassing type safety for the most important input to the method. This should be typed as `ResolvedProperties` from `PropertyResolver`.
- **[LOW]** **`isIntegrationAvailable()` and `isReady()` overlap** (lines ~720, ~733): `isIntegrationAvailable()` returns `this.isAvailable`, while `isReady()` checks `initializationStatus === Ready`. Both are called from different places for essentially the same purpose. The semantics should be clarified or unified.
- **[LOW]** **Magic numbers in timing** — `200ms` for mode switch (line ~96), `300ms` for model switch (line ~131), `1000ms`/`1500ms` for focus (line ~602), `300ms` for selectAll (line ~609), `500ms` for type (line ~617) are all scattered as inline constants. The comment "PROVEN" adds confidence but these should be named constants for maintainability.
- **[LOW]** **`.then()` fire-and-forget on error dialog** (line ~631): `vscode.window.showErrorMessage(...).then(...)` has no `.catch()` handler. While VS Code's `showErrorMessage` doesn't reject in practice, the fire-and-forget pattern is inconsistent with `await` used elsewhere.
- **[INFO]** The `buildCopilotChatPrompt()` → `buildPromptWithInstructions()` → `buildPromptText()` hierarchy is clean and well-factored. Session file verification via `submitWithRetry()` is a sound design.

### 4.2 ChatSessionMonitor.ts

- **[HIGH]** **`getRequestCount()` duplicated between `ChatSessionMonitor` and `ChatSessionParser`** — `ChatSessionMonitor.getRequestCount()` (line ~372) is a private method that reads/parses a session file and returns `session.requests.length`. `ChatSessionParser.getRequestCount()` (line ~636) is a public method that does exactly the same thing. Both call `ChatSessionParser.parseSessionFile()` internally. The monitor should delegate to the parser's method, eliminating a DRY violation.
- **[HIGH]** **`isLastRequestComplete()` duplicated with `ChatSessionParser.isSessionComplete()`** — `ChatSessionMonitor.isLastRequestComplete()` (line ~395) and `ChatSessionParser.isSessionComplete()` (line ~608) both parse a session file, get the last request, and check `result.timings.totalElapsed > 0`. The monitor adds `cancelled` detection and debug logging, but the core completion logic is identical. The monitor should extend or delegate to the parser's implementation.
- **[MEDIUM]** **Synchronous `fs.existsSync` / `fs.statSync` / `fs.readdirSync` in hot path** — `findAllSessionFiles()` (line ~125) uses synchronous file system operations to enumerate potentially hundreds of workspace storage directories and session files. This blocks the extension host thread during every poll cycle (500ms intervals). In `waitForCompletion()`, `fs.statSync()` is called every 500ms (line ~652). These should use async equivalents (`fs.promises.stat`, `fs.promises.readdir`) to prevent UI jank during long-running monitoring.
- **[MEDIUM]** **`findAllSessionFiles()` has no caching of directory structure** — Every call enumerates all workspace storage directories, reads all `chatSessions/` folders, and stats every `.json`/`.jsonl` file. During `waitForCompletion()`, this happens every 500ms. While session file _content_ is cached via `sessionCache`, the _directory listing_ is re-scanned from scratch each time. Consider caching the directory structure and only refreshing on mtime changes to the parent directory.
- **[MEDIUM]** **`getSessionCompletionState()` parses full file just to check completion** (line ~338) — Reads and parses the entire session file to determine which request indices are complete. For large session files with many requests, this is wasteful when only the last request's completion state is needed. However, the full parse is justified for the caching strategy that tracks all completed indices.
- **[LOW]** **Unused `context` field** — `private context: vscode.ExtensionContext` is stored (line ~55) but never referenced by any method. The constructor accepts it but no method uses `this.context`. Dead field — remove or use for session storage.
- **[LOW]** **`sessionsBeforeSend` cleared but never used for anything beyond logging** — The `sessionsBeforeSend` set (line ~53) tracks which sessions existed before sending, used only for "NEW vs EXISTING" log labels. This is purely diagnostic and adds memory overhead without functional impact. Acceptable as-is but could be gated behind a debug flag.
- **[INFO]** The session caching strategy (persistent across workflows, parse only new/modified files) is well-designed and documented. The inactivity-based timeout with mtime tracking is a clever approach that handles long-running responses correctly.

### 4.3 ChatSessionParser.ts

- **[MEDIUM]** **`isSessionComplete()` and `getRequestCount()` are instance methods but share no state** — Both methods (lines ~608, ~636) are stateless — they just read a file and return a value. They should be `static` methods (like `parseSessionFile()`) for consistency and to enable use without instantiation. Currently, callers must hold a `ChatSessionParser` instance just to call these utility methods.
- **[MEDIUM]** **`replayJsonl()` uses broad `any` typing** — `const state: any = first.v` (line ~123) and `const patch = JSON.parse(lines[i]) as { kind: number; k: (string | number)[]; v: any }` (line ~134). The JSONL replay operates entirely on untyped data, which means malformed patches silently corrupt state. Consider adding defensive checks after replay (e.g., validate `state.requests` is an array).
- **[MEDIUM]** **`extractThinkingText()` encrypted content detection is fragile** (line ~570): Uses regex `/^[A-Za-z0-9+/]{100,}/` to detect encrypted thinking blocks. This could false-positive on legitimate thinking content that starts with a long base64-like string, or false-negative on shorter encrypted blocks. The detection heuristic should be documented with the VS Code encryption format it targets.
- **[LOW]** **`COPILOT_TOOL_ID_MAP` is incomplete** — The static map (line ~411) only covers 7 Copilot tool IDs (`createFile`, `replaceString`, `multiReplaceString`, `readFile`, `deleteFile`, `renameFile`, `moveFile`). Missing common tools: `run_in_terminal` (mapped as `copilot_runTerminal`?), `grep_search`, `semantic_search`, `file_search`, `list_dir`. Any unmapped tools fall through to the ID-based matching, which works but produces less readable tool names in output.
- **[LOW]** **`normalizeModelId()` only strips `copilot/` prefix** (line ~582): `modelId?.replace(/^copilot\//, "")`. This handles the current format but is fragile if VS Code changes the model ID format. Also, `modelId` could be `undefined` (the `?.` handles it but returns `undefined`, then `|| "unknown"` catches it — redundant chaining).
- **[LOW]** **`upgradeToolCallEvent()` doesn't handle `rename_file` or `move_file`** — These tools are in `COPILOT_TOOL_ID_MAP` (line ~417) but have no corresponding case in `upgradeToolCallEvent()` (line ~441). They fall through to the generic `TOOL_CALL` event, losing the opportunity to emit `FILE_WRITE`/`FILE_DELETE` pairs or a dedicated event type.
- **[INFO]** The JSONL replay implementation (`replayJsonl`, `jsonlSetAtPath`, `jsonlAppendAtPath`) is well-designed for handling VS Code's incremental patch format. The tool call upgrade pipeline (normalize → match → upgrade) is a clean design pattern.

### 4.4 ChatLogMonitor.ts

- **[CRITICAL]** **Entire class is dead code** — `ChatLogMonitor` is not imported or instantiated anywhere in `src/`. No file references it except documentation. The class should be removed or properly integrated as the documented "legacy fallback" for session file monitoring. Keeping 249 lines of unreachable code is a maintenance burden.
- **[MEDIUM]** **`process.env.APPDATA!` non-null assertion** (line ~151): `getLogBaseDirectory()` uses `process.env.APPDATA!` on Windows, which crashes with a null pointer if `APPDATA` is not set (e.g., in some CI environments or containerized VS Code). `ChatSessionMonitor` handles this correctly with `process.env.APPDATA || ""` (line ~94). Use the same safe fallback.
- **[MEDIUM]** **Recursive file search is unbounded** — `findFilesRecursive()` (line ~163) recursively traverses the entire VS Code logs directory tree with no depth limit or timeout. On systems with many VS Code instances or large log directories, this could be slow or hit file descriptor limits.
- **[LOW]** **`os` import is unused** — `import * as os from "os"` (line ~4) is imported but `os.homedir()` is used only in `getLogBaseDirectory()` where `process.env.HOME` or `process.env.USERPROFILE` would suffice (and is already used in `ChatSessionMonitor`). The `os` import works but is inconsistent with the rest of the chat module.
- **[LOW]** **No dispose pattern** — The class has no `dispose()` method despite holding state (`logFilePath`, `lastReadPosition`). If the class were actually used and the log file were deleted/rotated, stale state could cause incorrect behavior.
- **[INFO]** If this class is resurrected as a fallback, the log polling approach (read from `lastReadPosition`) is efficient and the completion markers (`finish reason: [stop]`, `| cancelled |`) are correct per VS Code's Copilot Chat log format.

### 4.5 NativeAttachmentHandler.ts

- **[MEDIUM]** **Side-effect-heavy UI automation without error recovery** — `withFocusedDocument()` (line ~22) opens a document, runs an action, then closes it. If the action throws, the document is left open (the `finally` pattern is not used). This could leave orphaned editor tabs during attachment failures.
- **[MEDIUM]** **Fixed 200ms delays** — Three `setTimeout(200)` calls: one in `withFocusedDocument()` (line ~31), one between attachments (line ~131), and these are not configurable. On slow machines or remote VS Code instances, 200ms may not be sufficient for the editor to be ready.
- **[LOW]** **`processAttachments()` returns prompt unchanged** (line ~135): After attaching files natively, the method returns the original prompt text including `#file:` references. The comment says "Keep #file: references in prompt for context" — but this means the AI sees both the native attachment AND the `#file:` reference text, potentially causing duplicate context. This appears to be intentional but could be confusing.
- **[LOW]** **`resolveSymbol()` import from `AttachmentBuilders`** — The `resolveSymbol` function (line ~7) is used for `#sym:` references. If symbol resolution fails, the reference is silently dropped with a `Log.warn`. Consider including a fallback that at minimum preserves the text reference.
- **[INFO]** The class is well-focused with a single responsibility. The delegation pattern with `PathResolver` callback is clean. The distinction between directory, whole-file, and line-range attachments is well-handled.

### 4.6 WorkflowCommandHandler.ts

- **[MEDIUM]** **Inconsistent logging — `console.error`/`console.log` instead of `Log`** — 8 instances of `console.error` (lines ~122, ~183, ~261, ~299, ~321, ~429) and 2 instances of `console.log` (lines ~179, ~319) bypass the centralized `Log` utility. The project standard is to use `Log.info()`, `Log.error()`, etc. All should be migrated.
- **[MEDIUM]** **`createDraftPrompt()` hardcodes `.flightpath/prompts/` path** (line ~163): Uses `path.join(workspaceFolder, ".flightpath", "prompts")` directly instead of using `PATH_CONSTANTS.FLIGHTPATH_DIR` and `PATH_CONSTANTS.PROMPTS_DIR` (or `ConfigurationUtils.getPromptsDirectory()`). The `createPromptFile()` method correctly uses `ConfigurationUtils.getPromptsDirectory()` (line ~95), making this an inconsistency within the same class.
- **[MEDIUM]** **`createNewTemplate()` instantiates `TemplateManager` inline** (line ~395): Creates `new TemplateManager(this.context)` each time the command is invoked. The `TemplateManager` instance is not reused or disposed. If `TemplateManager` had initialization cost or resources, this would be wasteful. Consider injecting `TemplateManager` as a constructor dependency.
- **[LOW]** **Template content methods are tightly coupled** — `createExampleFlightPathYAML()`, `createExampleFlightPathJSON()`, and `createExampleMarkdownPrompt()` (lines ~438–507) are private methods that return hardcoded template strings. These belong in a templates/constants module, not in a command handler. If the template format changes, a UI command handler file must be edited.
- **[LOW]** **`openPanel()` callback signature is loosely typed** (line ~281): `getHarnessStatus: () => { initializationStatus: string }` — the `initializationStatus` is typed as `string` instead of `HarnessStatus` enum. The comparison `=== "unavailable"` uses a hardcoded string rather than `HarnessStatus.Unavailable`.
- **[LOW]** **`endConditionEvaluator` dependency unused except for `createSampleScript()`** (line ~24): The handler receives a full `EndConditionEvaluator` but only calls `.createSampleScript()`. This couples the command handler to the full evaluator when only the template creation capability is needed. Consider accepting a narrower interface.
- **[INFO]** The class correctly houses all user-facing command implementations with clean separation from business logic. The `openPromptFile()` helper with `openPromptsInSecondGroup` setting support is well-implemented.

### 4.7 OutputHistoryManager.ts

- **[MEDIUM]** **Verbose debug logging left in production code** — 8 instances of `[APPEND-DEBUG]` tagged log messages (lines ~143, ~150, ~154, ~163, ~263, ~270, ~274, ~282) using `Log.info` and `Log.warn`. These are development/debugging artifacts that should be removed or gated behind a debug flag. They pollute the output channel with implementation details (e.g., `"saveStepOutput: Reading history file..."`) that are not actionable for users.
- **[MEDIUM]** **Race condition in `initializeRun()`** — Between `getRunsForWorkflow()` (line ~90) and `writeFile()` (line ~103), another process could create a run file, causing duplicate run IDs or unexpected pruning behavior. The `withFileLock()` pattern used in `PromptQueue` is not applied here. While unlikely in single-VS-Code setups, MCP server access from external tools could trigger this.
- **[MEDIUM]** **`extractWorkflowId()` doesn't handle all file extensions** (line ~50): Only strips `.flightpath.json` and `.flightpath.yaml` extensions. Missing `.flightpath.yml` (the alternative YAML extension). A working file named `workflow.flightpath.yml` would produce ID `workflow.flightpath` instead of `workflow`.
- **[LOW]** **`executionState` typed as `ExecutionState` but cast to string** (line ~100): `executionState: "running" as ExecutionState` — uses a hardcoded string literal cast to `ExecutionState` instead of using `EXECUTION_STATES.RUNNING` constant. This violates the project's "no hardcoded strings" principle.
- **[LOW]** **`getRunTimestamps()` and `getRunStates()` read all history files** (lines ~289, ~309): Both methods read every history file for a workflow, parse the full JSON, and extract a single field. For workflows with many runs, this could be slow. Consider storing run metadata in an index file or extracting only the needed field.
- **[LOW]** **`schemaVersion: "1.0.0"` hardcoded** (line ~98): No migration logic exists for future schema versions. When `schemaVersion` changes, `loadHistory()` should validate the version and apply migrations. Currently, any version is accepted silently.
- **[INFO]** The file-based history storage with pruning is well-designed. The `mergeCliOutputs()` approach for retry handling is clean. The `extractRunTimestamp()` regex for both old and new filename formats is robust.

### 4.8 PromptFileLoader.ts

- **[MEDIUM]** **`(promptFile as any)[key]` unsafe cast** (line ~89): When copying workflow-level properties, the code uses `(promptFile as any)[key]` to access properties dynamically. This bypasses TypeScript's type checking entirely. A type-safe approach would use a typed lookup or explicit field access.
- **[MEDIUM]** **Large method — `loadPromptFile()` is ~150 lines** (lines ~40–185): Handles parsing, validation, working file creation, property copying, default population, queue loading, and dashboard notification — too many responsibilities for a single method. The property-copying logic (lines ~78–125) and default-population logic (lines ~128–150) should be extracted into helper methods.
- **[LOW]** **`getDashboard` callback pattern could return stale reference** — The `getDashboard: () => FlightPathWebviewProvider | undefined` callback is stored at construction time. If the dashboard provider is replaced or recreated, the callback could return `undefined` or an outdated reference. In practice this is stable because the dashboard is created once per extension lifecycle, but the pattern is fragile.
- **[LOW]** **Inconsistent error handling between `loadPromptFile` and `reloadFromWorkingFile`** — `loadPromptFile()` catches errors and shows `vscode.window.showErrorMessage` (line ~190), while `reloadFromWorkingFile()` re-throws errors for the caller to handle (line ~294). This inconsistency means callers must know which method swallows errors and which propagates them.
- **[INFO]** The three-scenario reload logic (replace/merge/auto) is well-documented and correctly handles the different use cases. The default population flow ensures the SettingsDrawer stays in sync with actual configuration.

### 4.9 TemplateImporter.ts

- **[MEDIUM]** **Inconsistent logging — `console.error` throughout** — 4 instances of `console.error` (lines ~139, ~230, ~259, ~311) instead of `Log.error()`. Unlike `WorkflowCommandHandler` which has the same issue, `TemplateImporter` doesn't even import `Log`.
- **[MEDIUM]** **Misleading variable names in `importWorkflowTemplates()`** (lines ~218–219): The destructured result uses `importedAgents` and `failedAgents` variable names for _workflow_ imports: `const { importedAgents: importedWorkflows, failedAgents: failedWorkflows } = ...`. The `copyTemplateFiles()` method returns `{ importedAgents, failedAgents }` regardless of what type of item is being copied. The shared method should use generic names like `importedItems` / `failedItems`.
- **[LOW]** **`copyTemplateFiles()` uses sequential file operations** — Each file copy involves `stat` → check existence → prompt overwrite → read source → write destination. For importing many templates, this could be slow. These operations could be parallelized with `Promise.all()` for non-conflicting files, though the sequential overwrite prompts make parallelization complex.
- **[LOW]** **`showImportResult()` "View File" action only works for single imports** (line ~337): `imported.length === 1 && firstFile` — if the user imports multiple templates, the "View File" button is hidden. Consider opening the first file regardless, or showing a multi-file picker.
- **[INFO]** The manifest-based discovery pattern is clean. The overwrite confirmation per file is good UX. The separation between agent and workflow import flows with a shared `copyTemplateFiles()` helper is well-designed.

### 4.10 WorkspaceSessionManager.ts

- **[MEDIUM]** **Inconsistent logging — `console.log`/`console.error`/`console.warn` throughout** — 8 instances (lines ~61, ~70, ~87, ~90, ~139, ~150, ~267, ~273) bypass the centralized `Log` utility. This class has the highest density of direct `console` usage in the orchestration module.
- **[MEDIUM]** **`findMostRecentWorkingFile()` reads ALL working files** (line ~105): Reads and JSON-parses every `.flightpath.json` file in the queue directory to extract timestamps. For workspaces with many accumulated working files, this could be slow at startup. Consider using file system timestamps (`mtime`) as the primary sort key and only parsing the most recent N files, or limiting queue directory size.
- **[MEDIUM]** **`discoverSessions()` reads and parses ALL session files** (line ~178): Similar to `findMostRecentWorkingFile()`, reads every working file to extract metadata. The `sortedFiles` sorting (line ~235) uses filename string sort, which may not correctly order ISO timestamp-based filenames (e.g., `T10` sorts before `T9` lexicographically because `1 < 9`).
- **[LOW]** **`discoverPromptFiles()` is a thin passthrough** (line ~81): The method just calls `this.promptFileParser.discoverPromptFiles(workspaceFolder)` with no additional logic beyond logging. Consider whether this indirection adds value or just obscures the call chain.
- **[LOW]** **Commented-out code** (lines ~66–68): `// vscode.window.showInformationMessage(...)` is commented out. Either remove the dead code or add a configuration option to control the notification.
- **[LOW]** **`_runtime` field access uses `any` cast** — `workingFile.prompts?.filter((p: any) => p._runtime?.sessionId)` (line ~251) casts prompt items to `any` to access `_runtime`. Should use the typed `PromptItem` interface which includes `_runtime`.
- **[INFO]** The auto-load recent session feature is well-designed for seamless VS Code restart recovery. The non-intrusive error handling (log and continue) is appropriate for startup operations.

### 4.11 PromptFileWatcher.ts

- **[LOW]** **`path` import potentially unused** — `import * as path from "path"` (line ~2) is used only in `setupFileWatcher()` for `path.dirname()` and `path.basename()`. This is valid usage, but worth noting that the import is required.
- **[LOW]** **`onFileDeleted()` disposes the watcher but doesn't clear dashboard state** — When a working file is deleted (line ~105), the method calls the `onDelete` callback and disposes the watcher, but the dashboard is only updated via the `onDelete` callback's implementation. If the callback doesn't update the dashboard, stale file info could remain visible.
- **[LOW]** **No debouncing on file change events** — `onDidChange` fires for every file modification. If a tool makes rapid sequential writes to the working file (e.g., MCP appending multiple prompts), each write triggers `onFileChanged()`, potentially causing multiple unnecessary reloads. A debounce (e.g., 100–200ms) would coalesce rapid changes.
- **[INFO]** Clean, focused class with single responsibility. The state-aware reload logic (only reload during RUNNING/PAUSED/CANCELLING) prevents unnecessary dashboard updates. Good use of `vscode.RelativePattern` for targeted file watching. The class is well-designed at 127 lines.

### 4.12 Cross-Cutting Concerns

#### Logging Inconsistency

| File                       | `console.*` calls | Should use `Log.*`     |
| -------------------------- | ----------------- | ---------------------- |
| WorkflowCommandHandler.ts  | 10                | Yes                    |
| WorkspaceSessionManager.ts | 8                 | Yes                    |
| TemplateImporter.ts        | 4                 | Yes                    |
| PromptFileLoader.ts        | 0                 | ✅ Already using `Log` |
| OutputHistoryManager.ts    | 0                 | ✅ Already using `Log` |
| PromptFileWatcher.ts       | 0                 | ✅ Already using `Log` |

**22 total `console.*` calls** in the orchestration module should be migrated to `Log.*` for consistent output-channel routing.

#### DRY Violations — Quantified

| Duplication                                       | Files                                  | Lines    | Severity   |
| ------------------------------------------------- | -------------------------------------- | -------- | ---------- |
| `getRequestCount()` logic                         | ChatSessionMonitor + ChatSessionParser | ~20      | **HIGH**   |
| `isLastRequestComplete()` / `isSessionComplete()` | ChatSessionMonitor + ChatSessionParser | ~40      | **HIGH**   |
| `commandMap` pattern                              | CopilotChatIntegration (2 methods)     | ~16      | **MEDIUM** |
| `console.*` vs `Log.*` logging                    | 3 orchestration files                  | 22 calls | **MEDIUM** |

#### Type Safety

- `(promptFile as any)[key]` in PromptFileLoader (dynamic property access)
- `resolvedProperties?: any` in CopilotChatIntegration's `sendPrompt()` signature
- `(p: any)` cast in WorkspaceSessionManager for `_runtime` access
- `state: any` in ChatSessionParser JSONL replay

---

## 5. Utilities

### 5.1 ConfigurationUtils.ts

- **[LOW]** Redundant double-mapping in `getIntegrationMode()` (lines ~106-122): The switch statement handles both literal strings (`"copilot-chat"`) and enum values (`Harness.CopilotChat`) for each branch. Since `Harness.CopilotChat` already equals the string `"copilot-chat"`, the literal string cases are redundant and just add noise. The `default` fallback to CopilotCli is fine.
- **[LOW]** Private helper `getModelSettingKeyForHarness()` (line ~63) duplicates the harness→setting mapping that `getModelForHarness()` (line ~195) already provides via individual getter calls. The two functions use different strategies for the same mapping — one returns a setting key string, the other calls specific getters. Not a bug, but a minor DRY violation.
- **[INFO]** The file is well-structured with clear section separators. All settings access is centralized as intended. No security issues.

### 5.2 FileSystemUtils.ts

- **[MEDIUM]** Several methods appear to be dead code — no callers found outside the class itself:
  - `findFiles()` / `findFilesRecursive()` (lines ~76-120): Never called from any source file. All callers use `vscode.workspace.findFiles()` instead.
  - `watchDirectory()` / `stopWatching()` (lines ~148-209): Never called. Only `stopAllWatchers()` is called internally from `dispose()`.
  - `getFileStats()` (line ~222): No callers found.
  - `createBackup()` (line ~247): No callers found.
  - `getDirectoryContents()` (line ~283): No callers found.
  - `getWorkspaceRelativePath()` (line ~267): No callers found outside this file.
    These methods (combined ~180 lines) are unreachable utility code that should be pruned.
- **[MEDIUM]** The class is instantiated only once (`CliNotificationMonitor`) solely for its `readJsonFileAndDelete()` method. That one method could be a standalone function. The class carries a chokidar dependency and an EventEmitter for file watching infrastructure that no one uses.
- **[LOW]** `readJsonFileAndDelete()` (line ~344) returns `Promise<any | null>` — the `any` return type loses type safety. Callers must cast unsafely.
- **[LOW]** `shouldIgnoreDirectory()` (line ~128) skips all dotfiles/directories, which collides with the workspace structure (`.flightpath/`, `.github/`). If `findFiles` were actually used, it would skip FlightPath's own directories.
- **[INFO]** `saveIfDirty()` is a well-designed static utility. No security concerns with the file operations since callers are expected to pass validated paths.

### 5.3 ValidationUtils.ts

- **[HIGH]** DRY violation / Sync Risk: The model enum array in `promptItemSchema` (lines ~30-52) is a hardcoded copy of model IDs that must be manually kept in sync with `ModelConstants.ts`. The comment at line ~10 acknowledges this. The list is already stale — it contains models no longer in `ModelConstants` (e.g., `gpt-4`, `gpt-4-0125-preview`, `gpt-3.5-turbo`) and is missing newer models (e.g., `claude-opus-4.6`, `claude-sonnet-4.6`, `gpt-5.2-codex`, `gpt-5.3-codex`). This means AJV validation rejects valid model names and accepts invalid ones.
- **[MEDIUM]** `sanitizePromptText()` (line ~290) is only called from tests, never from production code. The template variable logging (`Log.info`) on every match is a potential log spam issue if it were used.
- **[MEDIUM]** Type safety: `sessionId` schema uses `type: ["string", "number"] as any` (line ~97) to work around AJV's strict typing. The `as any` cast silences the type checker but defeats the purpose of `JSONSchemaType`.
- **[LOW]** `_runtime` schema (lines ~100-130) duplicates all `ExecutionProperties` fields inline. If `ExecutionProperties` or runtime metadata change, this schema must be manually updated — another sync risk.
- **[LOW]** `validateScriptPath()` (line ~306) rejects `..` (directory traversal) which is correct for security, but this also rejects legitimate relative paths like `../shared/validate.py` that a workspace might use. The security intent is good but may be overly restrictive.
- **[INFO]** `validateEndCondition()` properly validates all fields with clear error messages. The maxRetries range check (−1 to 100) is well thought out.

### 5.4 SessionResolver.ts

- **[LOW]** `areHarnessesCompatible()` (line ~65) returns `false` when both harnesses are `undefined`, which is technically a design decision but could be surprising — two prompts with no harness set would be considered incompatible for session sharing, even though they'd both resolve to the same default harness.
- **[INFO]** Well-structured with clear JSDoc. The three-tier resolution (numeric reference → exact string → auto-resume) is clean. The backward-search in `autoResumeFromPrevious()` correctly handles multi-harness workflows.

### 5.5 PropertyResolver.ts

- **[MEDIUM]** Semantic inconsistency in `resolveAllowDynamicExtension()` (lines ~273-280): The JSDoc says "three-tier precedence: prompt → workflow → default false", but the implementation uses `Boolean(prompt.allowDynamicExtension || workflow.allowDynamicExtension || globalEnabled)` — an OR-merge, not a precedence chain. This means workflow-level `false` cannot override a global `true`. Every other resolver in this class uses proper precedence (check prompt first, then workflow, then settings). This method should follow the same pattern.
- **[LOW]** `getModelForHarness()` (line ~360) is a trivial one-line wrapper around `ConfigurationUtils.getModelForHarness()`. It adds indirection without value.
- **[INFO]** The class cleanly implements three-tier resolution. `resolveEndCondition()` correctly distinguishes `null` (explicit disable) from `undefined` (inherit) using `hasOwnProperty`.

### 5.6 CliProcessManager.ts

- **[MEDIUM]** Race condition in `spawn()` timeout handler (lines ~118-126): The timeout calls `this.killGracefully(child)` and then `reject()`, but the `child.on('close')` handler will also fire and call `resolve()` after the kill. This means the Promise both rejects AND resolves — while JS ignores the second settlement, it's a latent bug pattern. The timeout `setTimeout` is also never cleared if the process exits normally before timeout.
- **[MEDIUM]** Same issue in `spawnSimple()` (lines ~149-153): The timeout `setTimeout` is never cleared on normal completion. If the process exits quickly, the timeout still fires and calls `child.kill()` on an already-dead process, then `reject()` on an already-resolved promise.
- **[LOW]** `cancel()` method (line ~232) races with itself: the two `setTimeout` for second Ctrl+C (100ms) and terminal dispose (800ms) can fire after `this.terminal` is already nulled by `disposeTerminal()`. The null-guard `if (this.terminal)` protects against the crash, but the timing depends on execution order.
- **[INFO]** The SIGTERM → SIGKILL escalation pattern in `killGracefully()` is well-implemented with proper timeout cleanup. Using `tree-kill` for cross-platform process tree handling is the right approach.

### 5.7 TempFileManager.ts

- **[LOW]** The class stores `TEMP_DIR_NAME = ".flightpath"` as its own constant (line ~23), duplicating `PATH_CONSTANTS.FLIGHTPATH_DIR` from ConfigurationUtils. Should import and use the single source of truth.
- **[LOW]** `cleanupOrphanedFiles()` (line ~196) uses a 24-hour age threshold (`MAX_FILE_AGE_MS`) that's a private constant. This should arguably be configurable or at least shared if other cleanup routines need the same threshold.
- **[INFO]** Good error handling — cleanup never throws, partial failure in `createSplitPromptFiles` properly rolls back. File naming with timestamps is practical for debugging.

### 5.8 ModelRegistry.ts

- **[MEDIUM]** Dead code — several exported functions have zero callers in production code:
  - `getModelIds()` (line ~246): No imports found.
  - `getCliSupportedModels()` (line ~283): No imports found.
  - `getModelIdsSync()` (line ~256): No imports found.
    These are public API surface with no consumers — dead exports.
- **[LOW]** Module-level mutable state (`cachedModels`, `cachedCopilotCliModelIds`, `isInitialized`, `initializationPromise`) works fine as a singleton but makes testing harder. No reset mechanism exists except `refreshModelRegistry()`.
- **[LOW]** `queryCopilotCliModels()` (line ~117) uses `execAsync("copilot help config")` with `shell: true` implicitly (via `child_process.exec`). The command string is hardcoded so no injection risk, but it's worth noting `exec` uses shell by default.
- **[INFO]** The retry-with-backoff for Windows file locks on `copilot.ps1` is a well-documented workaround.

### 5.9 ModelConstants.ts

- **[LOW]** `CLAUDE_CLI_MODEL_ALIASES` (line ~110) is a trivial alias for `CLAUDE_CLI_MODELS` with no callers found — dead export.
- **[LOW]** `isKnownCopilotModel()` (line ~185) has no callers outside this file — dead export.
- **[LOW]** The `COPILOT_CLI_MODEL_IDS` "Last updated" comment says 2025-11-30, but the list includes models like `claude-opus-4.6` that were added later. Minor documentation staleness.
- **[INFO]** Well-organized with clear separation of Copilot/Claude/Codex models. The `getModelDisplayName()` fallback formatter is a nice touch.

### 5.10 SkillDiscovery.ts

- **[LOW]** `findGitRoot()` (line ~245) uses synchronous `fs.existsSync()` in a tight loop walking up the directory tree. Given that this is called once during skill discovery and the traversal is bounded by filesystem depth, the practical impact is negligible, but it's inconsistent with the async pattern used everywhere else.
- **[LOW]** `discoverSkillsInDirectory()` (line ~211) also mixes `fs.existsSync()` (synchronous, line ~231) with `fs.promises.readdir()` (asynchronous). Should use `fs.promises.access()` consistently.
- **[INFO]** Path deduplication via `scannedPaths` set is clean. The 9-location discovery order is well-documented.

### 5.11 AttachmentBuilders.ts

- **[LOW]** `getWorkspaceSymbols()` (line ~283) is exported from this file but is unrelated to "attachment building" — it's a completion helper used only by `CompletionHelpers.ts`. This is a cohesion issue; the function belongs in a completions utility.
- **[INFO]** `resolveSymbol()` and `findSymbolAtLine()` are well-implemented with proper recursive search and normalized name matching.

### 5.12 ContextExpander.ts

- **[LOW]** `attachmentIds` and `symbolResolutionCache` are instance-level sets/maps (lines ~40-43) but are never cleared between expansions. If a `ContextExpander` instance is reused across multiple prompts, the deduplication set accumulates entries from all previous prompts, potentially skipping attachments that should be re-included in a new prompt context. The cache behavior is likely intentional for performance, but the deduplication set should be reset per-expansion.
- **[INFO]** Good use of parallel `Promise.all` for building attachments. Error handling correctly falls back to original prompt text.

### 5.13 PromptFileSplitter.ts

- **[LOW]** `countTokens()` (line ~115) is called many times during splitting (once per paragraph, once per line) with no caching. For very large prompts, this could be expensive since `gpt-tokenizer` processes the full text each time.
- **[INFO]** The three-stage splitting strategy (paragraphs → lines → characters) is well-designed. The `minChunkSize` threshold prevents tiny fragments.

### 5.14 AgentDiscovery.ts

- **[MEDIUM]** `filterAgentsByHarness()` (line ~229) is dead code — no callers found. The method also only handles `"copilot-cli"` and `"claude-cli"` harnesses (ignoring `"codex-cli"` and `"copilot-chat"`), but since `supportsCopilotCli` and `supportsClaudeCli` are always `true`, the entire method is effectively a no-op even if called.
- **[INFO]** Clean discovery pattern with dedicated user vs. workspace vs. FlightPath-exclusive locations.

### 5.15 FileReferenceParser.ts

- **[MEDIUM]** `convertToAtSyntax()` (line ~221) is exported but has zero callers anywhere in the codebase — dead export.
- **[INFO]** The regex patterns are well-documented. The trailing punctuation stripping in `parseAtReferences()` is thorough.

### 5.16 RetryUtils.ts

- **[MEDIUM]** Documentation/code mismatch: The JSDoc for `maxAttempts` says `@default 15` (line ~40) and the `@default` for delays says "total ~10s with maxAttempts=15" (line ~54), but the implementation defaults to `maxAttempts = 60` (line ~128) with delays `[100, 200, 500, 1000, 1500]`. With 60 attempts and the last delay repeating at 1500ms, the actual total worst-case wait is ~87 seconds, not ~10s. This is a significant documentation error that could mislead callers about retry duration.
- **[INFO]** The `PermanentFailureError` pattern for stopping retries early is well-designed.

### 5.17 Log.ts

- **[LOW]** `writeLog()` (line ~124) always calls `console.log()` in production as well as dev mode (line ~137). In a VS Code extension, `console.log` writes to the Extension Host log, which is separate from the output channel. This dual-logging is likely intentional for debugging but could be noisy in production.
- **[LOW]** File I/O in `appendLine()` and `append()` (lines ~105-115) uses synchronous `fs.appendFileSync()`. For high-frequency logging during CLI output streaming, this could cause micro-blocks on the event loop. Only active in dev mode so production impact is zero.
- **[INFO]** Clean singleton pattern. The output channel is properly registered as a disposable.

### 5.18 SessionValidator.ts

- **[INFO]** Clean and focused. UUID regex is correct. Codex thread ID validation is intentionally permissive. No issues found.

### 5.19 Small / Clean Utilities

- **AgentExpander.ts**: Clean. `stripFrontmatter()` properly warns about ignored `model` and `tools` overrides. No issues.
- **FileLockUtils.ts**: Well-implemented advisory file lock with stale lock detection. Race conditions are handled correctly with ENOENT guards. No issues.
- **SkillExpander.ts**: Clean and focused. Progressive disclosure design (metadata only, not full content) is well-documented. No issues.
- **DiscoveryUtils.ts**: Clean shared helpers. `isAccessibleDirectory()` mixes sync `existsSync` with async `stat` (minor inconsistency noted in SkillDiscovery above). No other issues.
- **PromptIdentity.ts**: `hashPromptContent()` has callers in `mcp-server.ts` and `PromptQueue.ts`. `shouldInjectExtensionInstructions()` has a caller in `HarnessIntegration.ts`. Both functions are live. No issues.
- **BuildConfig.ts**: Clean build-time constant pattern. The `typeof` check prevents runtime errors if esbuild replacement fails. No issues.

### 5.20 Cross-Cutting Concerns

- **[MEDIUM]** DRY violation across discovery/expansion pairs: `AgentExpander` re-discovers all agents via `AgentDiscovery.discoverAgents()` every time `expandAgent()` is called. Similarly, `SkillExpander.expandSkills()` calls `SkillDiscovery.discoverSkills()` on every invocation. If agents/skills are expanded for multiple prompts in a workflow, the same filesystem scan happens repeatedly. Should accept a pre-discovered list or use a cached discovery result.
- **[MEDIUM]** FileSystemUtils vs. direct `fs` usage: The codebase has a `FileSystemUtils` class, but almost all file I/O throughout the project uses `fs.promises` directly (TempFileManager, PromptFileParser, PromptQueue, OutputHistoryManager, etc.). The class exists as dead infrastructure — only one consumer (`CliNotificationMonitor`) instantiates it, and only for one method. This should be resolved: either adopt the class throughout or remove it and make `readJsonFileAndDelete` a standalone function.
- **[LOW]** Inconsistent `fs` import style: Some files use `import * as fs from "fs"` (TempFileManager, SkillDiscovery), others use `import * as fs from "fs/promises"` (FileLockUtils, FileSystemUtils). Both styles work but the inconsistency makes it unclear which API surface a file uses without reading the imports.

---

## 6. UI & Completions

### 6.1 FlightPathWebviewProvider.ts (~2381 lines)

**God class / SRP violation — this is the largest file in the repo and the single biggest architectural concern.**

- **[HIGH]** God class: 2,381 lines with ~60 methods spanning 7+ responsibilities — webview lifecycle, HTML generation, message routing (40+ message types), workflow CRUD, template management, output history, settings sync, completion forwarding, file I/O, save/export workflows. This violates Single Responsibility hard. Recommend extracting: (1) message handlers into a `WebviewMessageRouter` class, (2) workflow file/history operations into a dedicated handler, (3) settings sync into a `SettingsSync` helper, (4) save/export to a `WorkflowSerializer`. (entire file)
- **[HIGH]** CSP uses `'unsafe-inline'` for **both** `script-src` and `style-src` (line ~277). `'unsafe-inline'` on `script-src` weakens XSS protection significantly — it allows any inline `<script>` to execute. The `vscodeApiScript` injection (line ~260) drives this need, but a nonce-based approach would be safer. `'unsafe-inline'` on `style-src` is acceptable for Tailwind's runtime styles but should be documented as intentional.
- **[HIGH]** `handleGetConfig` and `handleUpdateConfig` (lines ~2072-2083) accept arbitrary config keys from the webview with no allowlist validation. A compromised webview could read or write ANY VS Code setting, not just `flightpath.*` settings. Should validate that `key` starts with `"flightpath."` or is in an explicit allowlist.
- **[MEDIUM]** Excessive `any` usage: 20+ instances of `any` types across public API methods — `postMessage(message: any)`, `handleWebviewMessage(message: any)`, `getCurrentState(): any`, `updateStepStatus(status: any, details?: any)`, `prompts: any[]` in multiple signatures. The `message` parameter should use a discriminated union from `WebviewMessageTypes.ts`; `prompts` should use `PromptItem[]`; `status` should use `StepStatus`. (lines ~299, 613, 636, 690, 762, 977, 1095)
- **[MEDIUM]** `pendingWorkflowProperties.endCondition` typed as `any` (line ~110). Should use the `EndCondition` type from `FlightPathTypes.ts`.
- **[MEDIUM]** DRY violation: `sendInitialState()` and `sendGlobalSettingsUpdate()` (lines ~981-1090) duplicate the entire global settings construction — both build the same `harness`, `model`, `agent`, `skills`, `executionMode`, `resumeSession`, `allowDynamicExtension`, `respectGitignore`, `harnessDefaultModels`, and `confirmDeleteOperations` object. Extract a `buildGlobalSettings()` helper.
- **[MEDIUM]** `sendWorkflowPropertiesToSettings()` (line ~1212) uses **synchronous** `fsSync.readFileSync()` to read working files from disk. This blocks the extension host thread. Should use `fs.readFile()` (async) and make the method `async`.
- **[MEDIUM]** `handleCreateWorkflow` (line ~1616) contains a TODO and shows "not yet implemented" warning — dead handler that should either be implemented or removed along with its message type.
- **[MEDIUM]** `handleRemoveWorkflowHistory` (lines ~1789-1843) uses a fragile stem-based heuristic to find working files (`startsWith(stem)`) instead of an exact match. This could accidentally delete unrelated working files with similar name prefixes.
- **[LOW]** Unused imports: `DashboardOutput` (line ~41) is imported but never used anywhere in the file. `TemplateInfo` (line ~21) is imported as a type but only used via `this.templateManager.getTemplateInfo()` return type inference — the named import is unnecessary. `isRegistryInitialized` (line ~32) is imported but never referenced.
- **[LOW]** Dead re-export: `export type { CliOutputData }` (line ~49) re-exports `CliOutputData` "for external use" but no other file in the codebase imports `CliOutputData` from `FlightPathWebviewProvider` — they import it directly from `WebviewMessageTypes.ts`.
- **[LOW]** `currentWorkflowName` field (line ~80) is written to in `getCurrentState()` (line ~1103) but never read anywhere — dead stored state.
- **[LOW]** `handleSelectPromptForEdit` (line ~1358) immediately echoes the message back to the webview with the same type it received. The comment says "handled by React state" — if React already handles this, the round-trip is unnecessary overhead.
- **[LOW]** `getModelForHarness` (line ~2321) casts `DEFAULT_MODELS` to `any` to index by `harness` string, then falls back to a hardcoded `"claude-sonnet-4.5"` string. The fallback should use a constant from `DashboardConstants` or `ModelConstants`.
- **[INFO]** The `resolveWebviewView` method (line ~152) sends an early `sendInitialState()` that may be lost (per the comment), then sends it again on READY. This is documented and intentional but adds complexity — consider removing the early send since it's unreliable.
- **[INFO]** `img-src` in CSP allows `https:` scheme (line ~277), which permits loading images from any HTTPS URL. This is broader than necessary for a local extension.

### 6.2 StatusBarManager.ts (~297 lines)

- **[MEDIUM]** Dead code: `showSuccess()`, `showError()`, `showWarning()`, `showProgress()`, `setCustomStatus()`, `updateCommand()`, and `getText()` are all public methods but **none** of them are called anywhere outside the class (confirmed via grep). Only `updateStatusBar()`, `dispose()`, `show()`, and `hide()` are used externally (by `WorkflowOrchestrator`). These 7 methods are dead code — carried forward from an earlier design or reserved for future use. (~60 lines of dead code)
- **[MEDIUM]** DRY violation: `showSuccess()`, `showError()`, and `showWarning()` (lines ~165-230) are nearly identical — each saves original state, sets new text/tooltip/backgroundColor, and restores after timeout. Only the icon, color, and default duration differ. Should be refactored to a single `showTemporaryStatus(icon, message, color, duration)` method.
- **[LOW]** `HarnessDetailedStatus` interface (line ~8) is exported from `StatusBarManager.ts` but the `WorkflowOrchestrator` references it as a structural type via `getHarnessDetailedStatus()` without explicitly importing `HarnessDetailedStatus`. The interface is only used inside `StatusBarManager.ts` itself, making the export unnecessary.
- **[LOW]** `calculateProgress` (line ~243) returns `current = state.currentIndex`. During execution, `currentIndex` is the index of the prompt being executed (0-based), not the count of completed prompts. The status bar shows `0/N` at start and never reaches `N/N` since `currentIndex` tops at `N-1`. Verify intended behavior vs. displaying completed count.
- **[INFO]** `showSuccess` inside `updateStatusBar` for `COMPLETED` state (line ~73) starts a 5-second timer, but if `updateStatusBar()` is called again before the timer fires, the stale timer will overwrite the new state. No timer cleanup.

### 6.3 CompletionHelpers.ts (~608 lines)

- **[MEDIUM]** Module-level mutable state: `filesCache`, `filesCacheTimestamp`, `isFiltering`, and `configWatcher` are module-level variables (lines ~92-94, ~141, ~292). This makes the module stateful and hard to test. If the extension is ever instantiated in a way that shares modules (e.g., test suites), this shared mutable state causes subtle bugs. Consider encapsulating in a class.
- **[MEDIUM]** `disposeCompletionHelpers()` (line ~317) is exported but never called anywhere in the codebase. The `configWatcher` is pushed to `context.subscriptions` in `initializeCompletionHelpers()` so VS Code handles disposal, but the explicit `dispose` function is dead code that suggests incomplete cleanup design.
- **[MEDIUM]** `getWorkspaceFiles()` (line ~96) is exported but only called internally within `CompletionHelpers.ts` itself (in `getFileCompletions`). The export is unnecessary and exposes an internal implementation detail.
- **[LOW]** `filterGitIgnoredFiles` uses `repo: any` type for Git repository objects (line ~169, via `Map<string, { repo: any; files: vscode.Uri[] }>`). The Git extension API types could be properly typed.
- **[LOW]** The `mapSymbolKindToCompletionKind` function (lines ~28-82) is a 55-line exhaustive switch statement. While complete, several cases map to the same value (`Module`, `Value`). Could be simplified with a `Map<SymbolKind, CompletionItemKind>` lookup table.
- **[INFO]** `CACHE_DURATION_MS = 5000` (line ~91) is hardcoded. For large workspaces, a longer cache or configurable duration might be more appropriate.

### 6.4 PromptCompletionProvider.ts (~438 lines)

- **[MEDIUM]** `isInsidePromptString` (line ~241) checks if cursor is after the opening quote but does **not** properly verify it's before the closing quote. The method returns `charIndex > openQuoteIndex` regardless of the closing quote position (the `closeQuoteIndex` variable is computed at line ~254 but never used in the return condition). This means completions could trigger after the string value is closed if the cursor is on the same line.
- **[LOW]** `isInsideYamlPromptValue` (line ~161) uses `Log.info()` for debug-level tracing (lines ~176, ~244). These fire on every keystroke during YAML editing. Should be `Log.debug()` to avoid polluting the output channel.
- **[LOW]** The method `calculateCompletionRange` (line ~416) accesses `vscode.window.activeTextEditor` directly, which may not match the `document` parameter passed to `provideCompletionItems`. In multi-editor scenarios, the active editor might differ from the document being completed.
- **[INFO]** `clearCache()` method (line ~401) is a public instance method that delegates to the module-level `clearFilesCache()`. Since `PromptCompletionProvider` has no instance-level cache, this method is redundant — callers could invoke `clearFilesCache()` directly.

### 6.5 PromptLinkProvider.ts (~250 lines)

- **[MEDIUM]** No path traversal protection: `path.join(workspaceRoot, relativePath)` (lines ~117, 148, 187, 228) is called on regex-captured paths without validating that the result stays within the workspace. A prompt containing `@../../etc/passwd` would resolve to an absolute path outside the workspace. While the link only opens files (not executing or reading contents server-side), it could reveal workspace root layout via the VS Code file opener. Should verify `absolutePath.startsWith(workspaceRoot)` after resolution.
- **[LOW]** `isPromptFile` (line ~76) activates for **all** Markdown and YAML files (`document.languageId === "markdown"` or `"yaml"`), not just FlightPath prompt files. This means every Markdown or YAML file in the workspace gets link detection applied, which could produce false-positive links for `@mentions` and `#references` in non-FlightPath files.
- **[LOW]** Regex patterns stored as class fields with `/g` flag (lines ~33-44) are never used directly — each `find*Links` method creates a fresh `RegExp` from `this.patterns.*.source`. The class fields could store just the source strings instead of compiled `RegExp` objects, avoiding the conceptual confusion of global-flag regexes that are never exec'd.
- **[INFO]** The `fullFile` regex `/@([^\s@#]+\.[a-zA-Z0-9]+)/g` (line ~35) requires a file extension. Files without extensions (e.g., `@Makefile`, `@Dockerfile`, `@LICENSE`) won't get clickable links. This may be intentional to avoid false positives with `@mentions` in prose.

---

## 7. Templates, Scripts & Dev

### 7.1 Hook Scripts

- **[MEDIUM]** **Path traversal via unsanitized IDs in notification filenames** (`flightpath-copilot-hook.js` line ~201, `flightpath-claude-hook.js` line ~191, `flightpath-codex-notify.js` line ~183). All three scripts use externally-supplied identifiers (session ID, thread ID) directly in `path.join(notifyDir, \`${sessionId}.json\`)`without sanitizing path separators. A malicious or malformed`session_id`containing`../../`could write the notification file outside the intended notification directory. Should validate that the ID contains only alphanumeric/hyphen/underscore characters, or use`path.basename()` to strip directory components.

- **[MEDIUM]** **DRY violation — ~80 lines of boilerplate duplicated across all three hooks** (`flightpath-copilot-hook.js`, `flightpath-claude-hook.js`, `flightpath-codex-notify.js`). The `getDebugLogPath()`, `getTempLogPath()`, and `debugLog()` functions are copied verbatim (identical signatures, identical logic) across all three files. The instruction file says "Keep scripts self-contained" which justifies no external npm dependencies, but a shared `flightpath-hook-utils.js` file shipped alongside them (also plain CJS, also copied to `out/scripts/`) would eliminate this duplication while staying within the "only Node.js built-ins" constraint.

- **[LOW]** **Environment variable key leakage in debug logs** (`flightpath-copilot-hook.js` line ~113, `flightpath-claude-hook.js` line ~106). Both scripts log `Object.keys(process.env)` to the debug file. While only keys (not values) are logged, this can reveal the presence of secret-bearing environment variables (e.g., `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`) to anyone reading the debug log file. The Codex notify script does not log env keys — follow that pattern.

- **[LOW]** **Codex notify derives notification directory from untrusted input** (`flightpath-codex-notify.js` lines ~160-167). Unlike Copilot/Claude hooks where the notify directory is passed as a CLI argument by the extension, the Codex script computes `notifyDir` from `notification.cwd` which comes from the JSON argument supplied by the CLI tool. A crafted notification payload could direct file writes to an arbitrary directory. The extension should pass the notify directory as a separate argument (consistent with the other hooks) rather than deriving it from the payload.

- **[LOW]** **Double JSON parse in Codex notify** (`flightpath-codex-notify.js` lines ~91 and ~115). The same `process.argv[2]` JSON string is parsed twice: once at the top of `main()` to extract `cwd` for debug log initialization, and again inside the main try block. Store the parsed result from the first parse and reuse it.

- **[LOW]** **Redundant `existsSync` before `mkdirSync` with `recursive: true`** (all three hooks). The pattern `if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }` appears in all hooks. Since `mkdirSync` with `{ recursive: true }` is a no-op when the directory exists, the `existsSync` guard is unnecessary and introduces a theoretical TOCTOU window.

- **[INFO]** **`userPromptSubmitted` hook does no useful work** (`flightpath-copilot-hook.js` lines ~196-200). The Copilot hook registers a handler for `userPromptSubmitted` that reads all stdin, parses JSON, and debug-logs the result — but never writes a notification file (line ~197: only `sessionStart` and `sessionEnd` trigger writes). The hook still executes on every prompt submission, adding latency for debug logging only. Consider removing this hook registration if the data isn't needed.

### 7.2 Template Scripts

- **[MEDIUM]** **Workflow templates use non-existent schema property `newChatSession`** (`simple-feature.flightpath.json` lines 10, 15; `simple-feature.flightpath.yaml` lines 14, 19). The field `newChatSession: false` does not exist in `prompt-schema.json` or the `PromptItem` type — the correct property is `resumeSession: true` (inverse semantics). These templates silently ignore the invalid property, meaning prompts 2 and 3 will start new sessions instead of continuing the previous one, defeating the template's stated "same session" design.

- **[LOW]** **`check_condition.js` has unused imports and dead code** (`check_condition.js` lines 6-7, 29-34). `fs` is imported but only used in commented-out example code. The `runCommand()` helper function is defined but never called — it's example/reference code that should either be in a comment block or removed.

- **[LOW]** **`check_condition.py` has unused imports** (`check_condition.py` lines 5-6). `subprocess` and `os` are imported but only referenced in commented-out examples.

- **[LOW]** **`check_condition.bat` uses `exit 0` instead of `exit /B 0`** (`check_condition.bat` line 15). Without `/B`, `exit` terminates the entire `cmd.exe` host process rather than just the batch script. While this works correctly when invoked via `child_process.spawn` (which creates its own `cmd.exe`), it's not best practice and would close an interactive terminal if someone runs it manually.

- **[LOW]** **`full-feature` workflow uses Unix-only `test -f` command** (`full-feature.flightpath.json` line 5, `full-feature.flightpath.yaml` line 11). The `endCondition.script: "test -f {planDocument}"` works only on Unix/macOS. On Windows, this will fail unless Git Bash or WSL is the default shell. A cross-platform alternative or a note in the template would help.

### 7.3 DevCommands.ts

- **[LOW]** **Hardcoded model IDs in `testChatModelSelection()`** (lines ~170–210). Model test cases (`gpt-4o`, `gpt-4.1`, `gpt-5`, `claude-sonnet-4`, etc.) are hardcoded string literals rather than sourced from `ModelConstants` or `ModelRegistry`. These will silently become stale as models are added/removed, contradicting the project's single-source-of-truth principle for model lists.

- **[LOW]** **Hardcoded phantom agent names in `testChatAgentSelection()`** (lines ~270–280). Test cases reference `"test-agent-alpha"` and `"test-agent-beta"` which almost certainly don't exist as registered agents. These test cases will always fail silently (caught by the generic catch), providing no diagnostic value.

- **[LOW]** **Inconsistent output channel command** (lines ~107 vs ~235). `testFileAttachment` opens the output channel via `workbench.action.output.show` while `testChatModelSelection` and `testChatAgentSelection` use `workbench.action.output.toggleOutput`. The toggle variant may hide the panel if it's already visible — use `show` consistently.

- **[INFO]** **`testCopilotAutomation()` marked as "legacy POC"** (line ~734 in devMenu description). Still registered and functional, but described as a legacy proof-of-concept. Consider removing if superseded by `CopilotChatIntegration`, or add a note about why it's kept.

### 7.4 Agent & Workflow Templates

- **[LOW]** **Orchestrator agent hardcodes Claude-specific models** (`flightpath-orchestrator.agent.md` frontmatter and throughout body). The agent template specifies `model: Claude Sonnet 4.5` in frontmatter and references `claude-sonnet-4.5`, `claude-haiku-4.5`, and `gpt-5` in its generated workflow examples. When new models are added or removed, this template won't be updated by the `sync-models` workflow. Consider using generic descriptions (e.g., "powerful model", "fast model") or documenting that this template needs manual model updates.

- **[INFO]** **JSON and YAML workflow templates are maintained in parallel** (`workflows/` directory). Each workflow exists as both `.flightpath.json` and `.flightpath.yaml`. The content is manually synchronized — there's no build step to generate one from the other. Any edit to one format must be manually replicated to the other. Given three workflows this is manageable, but the `newChatSession` bug (7.2 above) demonstrates how drift can occur.

---

## 8. Cross-Cutting Concerns

### 8.1 Systemic `any` Usage

The codebase has a pervasive `any` problem that follows two distinct patterns:

**Pattern A: Interface-rooted `any` propagation.** The `ILogParser` interface declares `extractResponse(events: any[])`, `extractEvents(): any[]`, and `processEvent(event: any)`. This single design decision propagates untyped data through `BaseLogParser` → all three concrete log parsers → `CliIntegration.processNewEvents()` → dashboard event emission — approximately **3,000+ lines** of code that handle CLI events with zero compile-time type checking. Similarly, `ICliProvider.buildCliArgs(prompt: any, context: any)` leaves the two most critical parameters in the CLI layer untyped across all three providers.

**Pattern B: Boundary-crossing `any` casts.** These appear at architectural boundaries — extension↔webview (`handleWebviewMessage(message: any)`, `postMessage(message: any)`, `getCurrentState(): any`), extension↔MCP server (`server: typeof Server` → effectively `any`), and internal escape hatches (`(flightPathManager as any).promptQueue`, `(promptFile as any)[key]`, `prompt as any` in `restart()`). While some boundary `any` is unavoidable (VS Code API surfaces, serialization boundaries), many instances have typed alternatives available but unused.

**Quantified impact:** 40+ distinct `any` usage sites identified across 20+ files. The CLI layer alone has ~15 instances. `FlightPathWebviewProvider` has 20+ instances in a single file.

**Root fix:** Define `BaseCliEvent = { type: string; timestamp?: number; [key: string]: unknown }` and update `ILogParser` signatures. Type `ICliProvider.buildCliArgs` with `PromptItem` and `WorkflowContext`. Use the `IncomingMessage`/`OutgoingMessage` discriminated unions for webview messages instead of `any`.

### 8.2 Logging Inconsistency (console._ vs Log._)

The project has a centralized `Log` utility ([src/utils/Log.ts](src/utils/Log.ts)) that routes to a VS Code output channel, but **28+ call sites** across 7 files bypass it with direct `console.log`/`console.error`/`console.warn`:

| File                       | console.\* calls | Module        |
| -------------------------- | ---------------- | ------------- |
| WorkflowCommandHandler.ts  | 10               | Orchestration |
| WorkspaceSessionManager.ts | 8                | Orchestration |
| TemplateImporter.ts        | 4                | Orchestration |
| PromptQueue.ts             | 3                | Core          |
| TemplateManager.ts         | 2                | Core          |
| WorkflowInstance.ts        | 1                | Core          |
| OutputHistoryManager.ts    | 8 (debug-tagged) | Orchestration |

The orchestration module is the worst offender — every file except `PromptFileLoader.ts` and `PromptFileWatcher.ts` uses console directly. `OutputHistoryManager` has 8 `[APPEND-DEBUG]` log messages that are development artifacts left in production code.

**Impact:** User-facing diagnostic output is fragmented. Messages written to `console.*` appear only in the Extension Host log (Developer Tools), not in the FlightPath output channel that users are directed to check. Debug messages in production bloat the Extension Host log.

### 8.3 Hardcoded Strings Violating DashboardConstants

The project's core principle is that all shared string constants live in `DashboardConstants.ts`. Several violations exist:

| Location                            | Hardcoded String              | Should Use                           |
| ----------------------------------- | ----------------------------- | ------------------------------------ |
| extension.ts ~L103                  | `"completed"`                 | `EXECUTION_STATES.COMPLETED`         |
| OutputHistoryManager.ts ~L100       | `"running" as ExecutionState` | `EXECUTION_STATES.RUNNING`           |
| WorkflowCommandHandler.ts ~L281     | `=== "unavailable"`           | Named constant or enum               |
| FlightPathWebviewProvider.ts ~L2321 | `"claude-sonnet-4.5"`         | `DEFAULT_MODELS` or `ModelConstants` |
| DevCommands.ts ~L170-210            | `"gpt-4o"`, `"gpt-5"`, etc.   | `ModelConstants` values              |
| EndConditionEvaluator.ts ~L290      | `5` (env var count)           | Derive from actual count             |

Additionally, `ValidationUtils.ts` maintains a hardcoded model enum array (~30 model IDs) that is already stale — containing removed models and missing newer ones. This causes AJV validation to reject valid model names and accept invalid ones.

### 8.4 Dead Code Accumulation

Dead code falls into four categories:

**Entire dead classes (1 file, 249 lines):**

- `ChatLogMonitor.ts` — not imported or instantiated anywhere. Documented as a "legacy fallback" but never wired in.

**Dead methods/functions (across 12+ files, ~400+ lines):**

- `HarnessIntegration`: `getCapabilities()`, `getLastFullPrompt()` — defined + overridden but never called
- `PromptQueue`: `clear()`, `isCompleted()`, `getQueueExtensionStats()`, `getFailedCount()` — no production callers
- `StatusBarManager`: 7 public methods (`showSuccess`, `showError`, `showWarning`, `showProgress`, `setCustomStatus`, `updateCommand`, `getText`) — none called externally
- `FileSystemUtils`: 6 methods (~180 lines) — `findFiles`, `watchDirectory`, `stopWatching`, `getFileStats`, `createBackup`, `getDirectoryContents`
- `ModelRegistry`: `getModelIds()`, `getCliSupportedModels()`, `getModelIdsSync()` — no callers
- `ModelConstants`: `CLAUDE_CLI_MODEL_ALIASES`, `isKnownCopilotModel()` — no callers
- `AgentDiscovery`: `filterAgentsByHarness()` — no callers, effectively a no-op even if called
- `FileReferenceParser`: `convertToAtSyntax()` — no callers
- `CompletionHelpers`: `disposeCompletionHelpers()` — never called
- `CliIntegration`: `generateMcpConfigFile()` — placeholder returning `null`; `currentProcess` field — declared but never assigned
- `WorkflowInstance`: `isDashboardReady()` — always returns `true`, making its check unreachable
- `CodexLogParser`: `processEvent()` — defined but never called by any consumer
- `CopilotLogParser`: `eventBuffer` field — initialized but never populated or read

**Dead types/exports (across 5+ files):**

- `FlightPathTypes`: `ClaudeCliStatus` type, `WorkflowContext` interface (shadowed by WorkflowExecutor's version)
- `DashboardConstants`: `PROMPTS_APPENDED` message type — no handler exists
- `FlightPathWebviewProvider`: `CliOutputData` re-export — no consumer
- `QueueOperations`: `effectiveMaxSize` variable computed but unused (also in `HarnessIntegration`)
- `WebviewMessageTypes`: `IncomingMessage` union is incomplete — missing 9+ newer message types

**Dead imports:**

- `mcp-server.ts`: `hashPromptContent` imported but unused
- `FlightPathWebviewProvider.ts`: `DashboardOutput`, `isRegistryInitialized` — imported but unreferenced

**Estimated total dead code: ~900+ lines** across the codebase (excluding test-only methods that arguably belong in test helpers).

### 8.5 DRY Violations Across Component Boundaries

Beyond the CLI layer's ~976 duplicated lines (quantified in §3.7.1), several DRY violations cross architectural boundaries:

**Cross-boundary duplications:**

| Pattern                           | Where                                                              | Lines | Impact                                                 |
| --------------------------------- | ------------------------------------------------------------------ | ----- | ------------------------------------------------------ |
| Tool-to-semantic-event mapping    | 6+ sites across 5 files (3 providers + CliIntegration)             | ~500+ | **CRITICAL** — largest single DRY violation            |
| `extractJsonObjectsFromStream()`  | CliResponseParser (shared) + ClaudeResponseParser (copy)           | ~80   | **CRITICAL** — algorithmic code copied verbatim        |
| PromptQueue merge logic           | 3 methods in same file with near-identical hash-match loops        | ~200  | **HIGH** — same file, easy to extract                  |
| Hook script boilerplate           | 3 hook scripts share `getDebugLogPath`/`debugLog` verbatim         | ~80   | **MEDIUM** — constrained by self-contained requirement |
| `getWorkspaceDirs()` + MCP config | 3 CLI providers copy-paste identical blocks                        | ~100  | **HIGH** — violates composition architecture           |
| Webview type definitions          | `PromptItem`, `EndConditionConfig`, `CliEventData` each 2-3 copies | ~60   | **MEDIUM** — somewhat intentional for bundle boundary  |
| Global settings construction      | `sendInitialState()` vs `sendGlobalSettingsUpdate()`               | ~40   | **MEDIUM** — same object built twice                   |
| Chat session completion checks    | `ChatSessionMonitor` + `ChatSessionParser` duplicate 2 methods     | ~60   | **HIGH** — same module, no excuse                      |
| Path constants                    | `mcp-server.ts` duplicates `PATH_CONSTANTS`                        | ~10   | **LOW** — standalone binary constraint                 |
| Workflow property copying         | `PromptFileParser.normalizePromptFile()` duplicated internally     | ~20   | **LOW** — easy extract                                 |

**Estimated total DRY violation across entire codebase: ~1,200+ duplicated lines.**

### 8.6 Security Weaknesses

Six security concerns were identified, grouped by severity:

**Path traversal (3 instances):**

1. `EndConditionEvaluator.resolveScriptPath()` — `path.resolve()` with `../` can escape workspace (§2.7)
2. `PromptLinkProvider` — `@../../etc/passwd` resolves outside workspace (§6.5)
3. Hook scripts — unsanitized session IDs in `path.join(notifyDir, \`${sessionId}.json\`)` could write outside notify directory (§7.1)

**Configuration injection (1 instance):** 4. `FlightPathWebviewProvider.handleGetConfig/handleUpdateConfig` — accepts arbitrary config keys from webview with no allowlist; a compromised webview could read/write any VS Code setting (§6.1)

**CSP weakness (1 instance):** 5. `FlightPathWebviewProvider` — CSP allows `'unsafe-inline'` for `script-src`, weakening XSS protection (§6.1)

**Shell injection (1 instance):** 6. `CopilotCliProvider.buildInteractiveTuiCommand()` — basic quote escaping may not prevent `$(...)` or backtick interpretation (§3.4.1)

All are mitigated by VS Code's trusted workspace model and the extension running locally, but defense-in-depth is warranted — especially items 1, 3, and 4 which involve untrusted or semi-trusted input.

### 8.7 God Class Accumulation

Four files exceed 1,500 lines and exhibit multiple-responsibility violations:

| File                         | Lines | Responsibilities                                                                                                                                                 |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FlightPathWebviewProvider.ts | 2,381 | Webview lifecycle, HTML generation, 40+ message routing, workflow CRUD, template management, output history, settings sync, file I/O, save/export                |
| CliIntegration.ts            | 1,954 | Initialization, execution modes (interactive+headless), prompt sending, log monitoring, session management, MCP config, process lifecycle, cleanup, notification |
| CodexLogParser.ts            | 1,943 | Event parsing, tool mapping (3× internal), statistics, session discovery, response extraction                                                                    |
| PromptQueue.ts               | 1,689 | State machine, event emission, file persistence (working files), merge logic (3× duplication), model resolution                                                  |

Combined, these four files account for **~7,967 lines** — roughly 25% of the non-webview source. Each could be decomposed:

- `FlightPathWebviewProvider` → extract `WebviewMessageRouter`, `WorkflowSerializer`, `SettingsSync`
- `CliIntegration` → extract `CliLogMonitor` (~300 lines), move MCP config to `CliMcpConfigGenerator`
- `CodexLogParser` → extract shared `CliEventMapper`, deduplicate internal tool mapping
- `PromptQueue` → extract `WorkingFileManager` (~400 lines)

### 8.8 Synchronous File I/O in Async Context

Multiple modules use synchronous `fs` operations (`readFileSync`, `existsSync`, `readdirSync`, `statSync`, `writeFileSync`, `mkdirSync`) in contexts where async equivalents are available and preferable:

| File                         | Sync Operations                                        | Hot Path?                        |
| ---------------------------- | ------------------------------------------------------ | -------------------------------- |
| ChatSessionMonitor.ts        | `existsSync`, `statSync`, `readdirSync`                | **Yes** — every 500ms poll cycle |
| TemplateManager.ts           | All operations sync                                    | No — user-initiated              |
| FlightPathWebviewProvider.ts | `readFileSync` in `sendWorkflowPropertiesToSettings()` | Occasionally                     |
| SkillDiscovery.ts            | `existsSync` in loop                                   | No — once at startup             |
| PromptFileParser.ts          | `readFileSync` for schema loading                      | No — once at module load         |
| Log.ts                       | `appendFileSync` for file logging                      | Dev mode only                    |

The `ChatSessionMonitor` is the most critical — synchronous I/O in a 500ms polling loop directly blocks the extension host thread, potentially causing UI jank during workflow monitoring.

### 8.9 Inconsistent Module Patterns

**`FileSystemUtils` class vs. direct `fs` usage:** The codebase has a `FileSystemUtils` class with file watching, searching, and backup capabilities — but almost every module uses `fs.promises` directly. Only one consumer (`CliNotificationMonitor`) instantiates `FileSystemUtils`, and only for the `readJsonFileAndDelete` method. The class is dead infrastructure.

**`import fs` inconsistency:** Some files import `fs` (sync API), others import `fs/promises` (async API), and some import both. There's no project convention. This makes it unclear at a glance whether a file performs sync I/O.

**Barrel re-exports creating dual import paths:** `CliOutputTypes.ts` re-exports `CLI_EVENT_TYPES` from `DashboardConstants` "for backward compatibility." `FlightPathTypes.ts` re-exports `EXECUTION_STATES` and `STEP_STATUS`. This creates multiple valid import paths for the same constants, leading to inconsistent imports across the codebase.

### 8.10 Template and Schema Drift

Three template/schema synchronization risks were identified:

1. **`ValidationUtils.ts` model enum** — hardcoded model list is already stale (missing newer models, containing removed ones). Not synced by the `sync-models` script that updates `ModelConstants.ts`, `package.json`, and `prompt-schema.json`.

2. **Workflow templates use invalid property** — `simple-feature` templates (both JSON and YAML) use `newChatSession: false` which doesn't exist in the schema. The correct property is `resumeSession: true`.

3. **`PROMPT_PROPERTIES` / `END_CONDITION_PROPERTIES`** — defined in `DashboardConstants.ts` and independently copied in the React webview's `utils/prompt.ts` and `utils/endCondition.ts`. These are separate Vite bundles that can't share imports, but the copies can drift.

4. **JSON and YAML workflow templates** — maintained as parallel files with no build-time synchronization. The `newChatSession` bug demonstrates how drift occurs silently.

---

## 9. Prioritized Recommendations

### Priority 1: Quick Wins (< 1 hour each, high impact)

| #    | What to Fix                                                                                    | Ref                | Effort | Impact                                                                                                    | Action                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------ | ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1.1  | **Delete `ChatLogMonitor.ts`**                                                                 | §4.4               | 5 min  | Remove 249 lines of dead code; eliminate maintenance distraction                                          | Delete `src/flightpath/chat/ChatLogMonitor.ts`, remove any remaining imports                                        |
| 1.2  | **Fix hardcoded `"completed"` in extension.ts**                                                | §1.1               | 2 min  | Correctness — use `EXECUTION_STATES.COMPLETED`                                                            | Single string replacement                                                                                           |
| 1.3  | **Fix hardcoded `"running"` in OutputHistoryManager.ts**                                       | §4.7               | 2 min  | Correctness — use `EXECUTION_STATES.RUNNING`                                                              | Single string replacement                                                                                           |
| 1.4  | **Remove dead import `hashPromptContent` from mcp-server.ts**                                  | §1.2               | 1 min  | Clean imports                                                                                             | Delete the import line                                                                                              |
| 1.5  | **Remove dead `generateId()` method from mcp-server.ts**                                       | §1.2               | 2 min  | Remove dead code                                                                                          | Delete the method                                                                                                   |
| 1.6  | **Remove dead `ClaudeCliStatus` type from FlightPathTypes.ts**                                 | §1.3               | 1 min  | Remove dead export                                                                                        | Delete the type declaration                                                                                         |
| 1.7  | **Remove dead `WorkflowContext` from FlightPathTypes.ts**                                      | §1.3               | 2 min  | Remove shadowed dead type                                                                                 | Delete the interface (keep the WorkflowExecutor version)                                                            |
| 1.8  | **Remove `eventBuffer` field from CopilotLogParser.ts**                                        | §3.4.2             | 1 min  | Remove dead field                                                                                         | Delete field declaration                                                                                            |
| 1.9  | **Remove `processEvent()` from CodexLogParser.ts**                                             | §3.6.2             | 5 min  | Remove dead method                                                                                        | Delete the method and any related `eventBuffer` state                                                               |
| 1.10 | **Remove dead `StatusBarManager` methods**                                                     | §6.2               | 10 min | Remove ~60 lines of dead code                                                                             | Delete `showSuccess`, `showError`, `showWarning`, `showProgress`, `setCustomStatus`, `updateCommand`, `getText`     |
| 1.11 | **Remove dead `FileSystemUtils` methods**                                                      | §5.2               | 15 min | Remove ~180 lines of dead code; consider replacing entire class with standalone `readJsonFileAndDelete()` | Delete uncalled methods or inline the one used method                                                               |
| 1.12 | **Remove dead exports from ModelRegistry/ModelConstants**                                      | §5.8, §5.9         | 5 min  | Clean API surface                                                                                         | Delete `getModelIds`, `getCliSupportedModels`, `getModelIdsSync`, `CLAUDE_CLI_MODEL_ALIASES`, `isKnownCopilotModel` |
| 1.13 | **Remove dead `filterAgentsByHarness()`, `convertToAtSyntax()`, `disposeCompletionHelpers()`** | §5.14, §5.15, §6.3 | 5 min  | Remove dead exports                                                                                       | Delete the three functions                                                                                          |
| 1.14 | **Remove unused imports in FlightPathWebviewProvider.ts**                                      | §6.1               | 2 min  | Clean imports                                                                                             | Remove `DashboardOutput`, `isRegistryInitialized`, dead `CliOutputData` re-export                                   |
| 1.15 | **Fix `selectPromptFile` glob to include YAML**                                                | §1.1               | 2 min  | Bug fix — users can't select YAML workflows via the Select command                                        | Add `*.flightpath.yaml`, `*.flightpath.yml` to the glob                                                             |
| 1.16 | **Fix workflow templates using `newChatSession`**                                              | §7.2               | 5 min  | Bug fix — templates produce wrong session behavior                                                        | Replace `newChatSession: false` → `resumeSession: true` in both JSON and YAML templates                             |
| 1.17 | **Remove `[APPEND-DEBUG]` log messages from OutputHistoryManager.ts**                          | §4.7               | 5 min  | Clean production logging                                                                                  | Remove or gate behind `IS_DEV_MODE` the 8 debug-tagged log lines                                                    |
| 1.18 | **Fix `extractWorkflowId()` to handle `.flightpath.yml`**                                      | §4.7               | 2 min  | Bug fix — `.yml` extension not stripped from workflow ID                                                  | Add `.flightpath.yml` to the extension stripping logic                                                              |
| 1.19 | **Fix `RetryUtils` documentation mismatch**                                                    | §5.16              | 5 min  | Correctness — JSDoc says 15 attempts/10s, code defaults to 60/~87s                                        | Update JSDoc to match implementation                                                                                |

**Subtotal Priority 1: ~19 items, ~75 minutes. Removes ~550+ lines of dead code, fixes 3 bugs, corrects 2 hardcoded strings.**

---

### Priority 2: Medium Effort, High Value (1-4 hours each)

| #    | What to Fix                                                                          | Ref                                    | Effort | Impact                                                                                                                 | Action                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------ | -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1  | **Extract `CliEventMapper.mapToolToSemanticEvent()`**                                | §3.4.2, §3.5.2, §3.5.3, §3.6.2, §3.7.1 | 3 hrs  | Eliminates ~500+ lines of the largest DRY violation in the codebase; single source of truth for tool→event mapping     | Create `src/flightpath/cli/shared/CliEventMapper.ts` with a config-driven `mapToolToSemanticEvent(toolName, harnessId)`. Replace 6+ copies across CopilotLogParser, ClaudeLogParser, ClaudeResponseParser, CodexLogParser (×3) |
| 2.2  | **Remove `ClaudeResponseParser.extractJsonObjectsFromStream()` duplication**         | §3.3.3, §3.5.3                         | 30 min | Eliminates ~80 lines of duplicated algorithmic code                                                                    | Delete local copy in ClaudeResponseParser, import from shared `CliResponseParser`                                                                                                                                              |
| 2.3  | **Extract `CliProviderUtils` for shared provider logic**                             | §3.4.1, §3.5.1, §3.6.1, §3.7.3         | 2 hrs  | Eliminates ~100 lines of duplicated `getWorkspaceDirs()` + MCP config; fixes Codex missing `cliAdditionalDirs` support | Create shared utility, refactor all three providers                                                                                                                                                                            |
| 2.4  | **Move `readFirstEvents()` to `BaseLogParser`**                                      | §3.4.2, §3.5.2, §3.6.2                 | 30 min | Eliminates ~80 lines across 3 parsers                                                                                  | Add `readFirstNJsonlEvents()` to `BaseLogParser`, delete provider copies                                                                                                                                                       |
| 2.5  | **Type the `ILogParser` and `ICliProvider` interfaces**                              | §3.3.2, §3.3.1, §8.1                   | 2 hrs  | Adds compile-time safety to ~3,000 lines of CLI code                                                                   | Define `BaseCliEvent`, update `ILogParser` methods from `any[]` to `BaseCliEvent[]`, type `buildCliArgs` with `PromptItem` + `WorkflowContext`                                                                                 |
| 2.6  | **Add workspace-boundary validation to `EndConditionEvaluator.resolveScriptPath()`** | §2.7                                   | 30 min | Security — prevents `../../` path traversal out of workspace                                                           | After `path.resolve()`, verify result starts with workspace root                                                                                                                                                               |
| 2.7  | **Add config key allowlist to `handleGetConfig`/`handleUpdateConfig`**               | §6.1                                   | 30 min | Security — prevents webview from reading/writing arbitrary VS Code settings                                            | Validate that `key` starts with `"flightpath."` or is in an explicit allowlist                                                                                                                                                 |
| 2.8  | **Sanitize session IDs in hook script filenames**                                    | §7.1                                   | 30 min | Security — prevents path traversal via crafted session IDs                                                             | Add `path.basename()` or regex validation (`/^[a-zA-Z0-9_-]+$/`) before using IDs in filenames                                                                                                                                 |
| 2.9  | **Migrate `console.*` to `Log.*` across orchestration module**                       | §4.6, §4.9, §4.10, §8.2                | 1 hr   | Consistent logging — all output routes through FlightPath output channel                                               | Replace ~28 console calls across WorkflowCommandHandler, WorkspaceSessionManager, TemplateImporter, PromptQueue, TemplateManager, WorkflowInstance                                                                             |
| 2.10 | **Fix resource leak in `WorkflowInstance.stop()`**                                   | §2.4                                   | 15 min | Correctness — second `onResponseComplete` listener leaks                                                               | Capture disposable from second listener registration and dispose it                                                                                                                                                            |
| 2.11 | **Extract PromptQueue merge logic**                                                  | §2.2                                   | 1 hr   | Eliminates ~200 lines of near-identical code in 3 methods                                                              | Create `mergeDiskPrompts(memoryPrompts, diskPrompts)` helper, replace `mergePromptsFromDisk()` and `_updateWorkingFileInternal()` internals                                                                                    |
| 2.12 | **Fix `ClaudeToolPermissionMapper.hasFullPermissions()` always returning true**      | §3.5.5                                 | 30 min | Bug fix — permission denial patterns are silently ignored for Claude                                                   | Implement actual config checking, matching CopilotToolPermissionMapper behavior                                                                                                                                                |
| 2.13 | **Deduplicate ChatSessionMonitor↔ChatSessionParser methods**                         | §4.2, §4.3                             | 1 hr   | Eliminates ~60 lines; monitor delegates to parser for `getRequestCount()` and completion checks                        | ChatSessionMonitor calls ChatSessionParser methods instead of reimplementing                                                                                                                                                   |
| 2.14 | **Fix `ValidationUtils.ts` stale model list**                                        | §5.3                                   | 1 hr   | Correctness — AJV validation currently rejects valid models and accepts removed ones                                   | Either import from `ModelConstants` dynamically, or add `ValidationUtils` to the `sync-models` script's update targets                                                                                                         |
| 2.15 | **Make `ChatSessionMonitor` use async file ops**                                     | §4.2                                   | 2 hrs  | Performance — sync I/O in 500ms polling loop blocks extension host                                                     | Replace `existsSync`/`statSync`/`readdirSync` with `fs.promises` equivalents in `findAllSessionFiles()` and `waitForCompletion()`                                                                                              |
| 2.16 | **Fix `PropertyResolver.resolveAllowDynamicExtension()` OR-merge bug**               | §5.5                                   | 15 min | Correctness — workflow-level `false` cannot override global `true`, inconsistent with all other resolvers              | Change from OR-merge to proper precedence chain: prompt → workflow → settings                                                                                                                                                  |
| 2.17 | **Fix `CliProcessManager` timeout race conditions**                                  | §5.6                                   | 30 min | Correctness — timeout `setTimeout` never cleared on normal exit in both `spawn()` and `spawnSimple()`                  | Clear timeout on normal process exit; guard against double-settlement                                                                                                                                                          |
| 2.18 | **Extract headless retry callback in `CliIntegration`**                              | §3.1                                   | 30 min | Eliminates ~40 lines of duplicated response-building logic                                                             | Create `buildResponseOutput()` helper used by both primary and retry callbacks                                                                                                                                                 |
| 2.19 | **Deduplicate `NotificationConfig` and `ToolPermissionMode` types**                  | §3.2.4, §3.2.5, §3.3.4, §3.3.5         | 30 min | Single-source type definitions                                                                                         | Import from interface files instead of redefining in shared utilities                                                                                                                                                          |
| 2.20 | **Migrate `TemplateManager` to async I/O**                                           | §2.11                                  | 1 hr   | Prevents extension host blocking during template operations                                                            | Replace all `readFileSync`/`writeFileSync`/`readdirSync` with `fs.promises` equivalents                                                                                                                                        |

**Subtotal Priority 2: ~20 items, ~19 hours. Eliminates ~1,100+ duplicated lines, fixes 4 bugs, resolves 3 security issues, adds type safety to CLI layer.**

---

### Priority 3: Larger Refactors (1-3 days each)

| #   | What to Fix                                                                    | Ref        | Effort   | Impact                                                                                                                                                      | Action                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------ | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | **Decompose `FlightPathWebviewProvider`**                                      | §6.1, §8.7 | 2-3 days | Reduces 2,381-line god class to 4-5 focused classes; dramatically improves maintainability                                                                  | Extract `WebviewMessageRouter` (40+ message handlers → dispatch table), `WorkflowSerializer` (save/export/import), `SettingsSync` (config read/write/broadcast), keep provider as lifecycle + HTML shell     |
| 3.2 | **Decompose `CliIntegration`**                                                 | §3.1, §8.7 | 1-2 days | Reduces 1,954-line class to ~1,400; cleaner separation of concerns                                                                                          | Extract `CliLogMonitor` (~300 lines: `monitorLogFile`, `processNewEvents`, `getEntryTimestamp`), delegate MCP config fully to `CliMcpConfigGenerator`                                                        |
| 3.3 | **Extract `WorkingFileManager` from `PromptQueue`**                            | §2.2, §8.7 | 1-2 days | Reduces 1,689-line class; separates state machine from file persistence                                                                                     | Move `createWorkingFile`, `readWorkingFile`, `writeWorkingFileAtomic`, `updateWorkingFile`, `_updateWorkingFileInternal`, `updateWorkingFileProperties`, `generateWorkingFilePath` (~400 lines) to new class |
| 3.4 | **Strengthen CSP — replace `'unsafe-inline'` with nonce-based script loading** | §6.1       | 1 day    | Security — eliminates inline script execution, proper XSS protection                                                                                        | Generate per-session nonce, apply to `vscodeApiScript` injection, set CSP `'nonce-xxx'` instead of `'unsafe-inline'` for `script-src`                                                                        |
| 3.5 | **Unify webview type definitions**                                             | §1.5, §8.5 | 1 day    | Reduces 3 copies of `EndConditionConfig`, 2 copies of `PromptItem`, 2 copies of `CliEventData` to single sources with generated webview-compatible versions | Create a `src/types/shared/` module importable by both extension and webview build, or generate webview types from extension types at build time                                                             |
| 3.6 | **Complete `IncomingMessage` discriminated union**                             | §1.5       | 4 hrs    | Type safety — webview message handler currently has no compile-time safety for 9+ message types                                                             | Add missing message types (`WORKFLOWS_LIST`, `WORKFLOW_ADDED`, `GLOBAL_SETTINGS_UPDATED`, `RESET_WORKFLOW_STATE`, `RUN_HISTORY_UPDATED`, `OUTPUT_HISTORY_LOADED`, etc.) to the union                         |
| 3.7 | **Extract shared hook utility for scripts**                                    | §7.1       | 4 hrs    | Eliminates ~80 lines × 3 duplicated boilerplate in hook scripts                                                                                             | Create `src/scripts/flightpath-hook-utils.js` with shared `getDebugLogPath`, `getTempLogPath`, `debugLog`; import from all three hooks (all remain plain CJS with Node.js built-ins only)                    |

**Subtotal Priority 3: ~7 items, ~8-14 days. Addresses all 4 god classes, strengthens security, unifies types.**

---

### Priority 4: Nice to Have (low urgency, incremental improvement)

| #    | What to Fix                                                                                        | Ref    | Effort | Impact                                                   |
| ---- | -------------------------------------------------------------------------------------------------- | ------ | ------ | -------------------------------------------------------- |
| 4.1  | Lazy-init detector integrations in `WorkflowOrchestrator` (only create when harness is first used) | §2.5   | 2 hrs  | Minor resource savings at startup                        |
| 4.2  | Add timeout/cancellation to `WorkflowExecutor.waitForResponseComplete()`                           | §2.3   | 1 hr   | Prevents indefinite hang if integration crashes silently |
| 4.3  | Fix `logWorkflowCompletion()` to use actual completed count instead of total                       | §2.3   | 10 min | Correct logging for partial completions                  |
| 4.4  | Deduplicate `resolveDetectorIntegration()`/`getDefaultIntegration()` in WorkflowOrchestrator       | §2.5   | 30 min | Minor DRY cleanup                                        |
| 4.5  | Remove or properly gate `EndConditionHandler`'s "Retry Once More" button (currently does nothing)  | §2.8   | 30 min | UX — remove misleading dialog option                     |
| 4.6  | Replace `powershell` with `pwsh` (or detect) in `EndConditionEvaluator.getScriptCommand()`         | §2.7   | 30 min | Compatibility with PowerShell 7+ systems                 |
| 4.7  | Extract `formatStatistics()` to `BaseLogParser` with token-field config                            | §3.4.2 | 1 hr   | Eliminates ~100 lines across 3 parsers                   |
| 4.8  | Cache `AgentDiscovery`/`SkillDiscovery` results instead of re-scanning on every expansion          | §5.20  | 1 hr   | Performance for multi-prompt workflows                   |
| 4.9  | Fix `isInsidePromptString` closeQuoteIndex bug in PromptCompletionProvider                         | §6.4   | 30 min | Prevents completions triggering after string close       |
| 4.10 | Remove `require()` for `QueueOperations` in extension.ts, use static import                        | §1.1   | 5 min  | Enables tree-shaking and static analysis                 |
| 4.11 | Extract `PromptFileParser.normalizePromptFile()` property-copying duplication                      | §2.6   | 15 min | Minor DRY cleanup                                        |
| 4.12 | Use `pwsh` → `powershell` fallback in EndConditionEvaluator                                        | §2.7   | 30 min | Better cross-platform support                            |
| 4.13 | Add debouncing to `PromptFileWatcher.onDidChange`                                                  | §4.11  | 15 min | Prevents rapid-fire reloads during MCP multi-append      |
| 4.14 | Remove env key logging from Copilot/Claude hook scripts                                            | §7.1   | 5 min  | Avoid leaking env variable names to debug logs           |
| 4.15 | Fix `NativeAttachmentHandler.withFocusedDocument()` error recovery (use try/finally)               | §4.5   | 15 min | Prevents orphaned editor tabs on attachment failure      |

---

### Summary

| Priority             | Items | Estimated Effort | Lines Affected                                                     |
| -------------------- | ----- | ---------------- | ------------------------------------------------------------------ |
| P1: Quick Wins       | 19    | ~75 minutes      | ~550 dead lines removed, 3 bugs fixed                              |
| P2: Medium Effort    | 20    | ~19 hours        | ~1,100 duplicated lines eliminated, 4 bugs fixed, 3 security fixes |
| P3: Larger Refactors | 7     | ~8-14 days       | 4 god classes decomposed, CSP hardened, types unified              |
| P4: Nice to Have     | 15    | ~9 hours         | Incremental quality improvements                                   |

**Recommended sequence:** Priority 1 items should be done immediately — they're low-risk, high-confidence changes that clean up noise making larger refactors harder to reason about. Priority 2 items 2.1–2.5 (CLI DRY violations + type safety) should follow as a cohesive "CLI layer cleanup" sprint. Security items (2.6–2.8) should be addressed before any public release. Priority 3 items can be tackled individually as the codebase evolves — the god class decompositions (3.1–3.3) will provide the most long-term maintainability improvement.

For a pre-release project, **Priorities 1 and 2 are the sweet spot** — they eliminate ~1,650 lines of waste, fix 7 bugs, address security gaps, and add type safety to the most critical subsystem, all within approximately 20 hours of focused work.
