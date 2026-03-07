# FlightPath Source Code Audit — Fix Tracking

**Started:** February 27, 2026  
**Scope:** Fixing all HIGH and MEDIUM priority issues from `SOURCE_CODE_AUDIT.md`

---

## Progress Tracking

| Section                     | Status    | HIGH Fixed              | MEDIUM Fixed | Notes                                                                                                                         |
| --------------------------- | --------- | ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. Entry Points & Types     | Completed | 4/4                     | 10/10        | All HIGH and MEDIUM issues fixed                                                                                              |
| 2. Core Flightpath Modules  | Completed | 3/3                     | 22/22        | All HIGH and MEDIUM issues fixed                                                                                              |
| 3. CLI Integration          | Completed | 2/2 CRITICAL + 13/15    | 21/33        | All CRITICAL fixed, 2 HIGH deferred (architecture recommendations), 12 MEDIUM deferred (type-safety arch, security hardening) |
| 4. Chat & Orchestration     | Completed | 1/1 CRITICAL + 3/3 HIGH | 20/20        | All issues fixed. ChatLogMonitor deleted (249 lines dead code).                                                               |
| 5. Utilities                | Completed | 1/1                     | 12/12        | All HIGH and MEDIUM issues fixed                                                                                              |
| 6. UI & Completions         | Completed | 2/2                     | 10/10        | All HIGH and MEDIUM issues fixed                                                                                              |
| 7. Templates, Scripts & Dev | Completed | 0/0                     | 3/3          | All MEDIUM issues fixed. Shared hook utils created (~80 lines deduped).                                                       |
| 8. Cross-Cutting Concerns   | Completed | 0/0                     | 4/4          | Hardcoded strings, dead code, backward-compat re-export. Logging already fixed in prior sections.                             |

**All sections complete.**

---

## Detailed Fix Log

_Fixes will be logged below as they are completed._

### Section 1: Entry Points & Types

#### 1.1 extension.ts

1. **[HIGH] Hardcoded `"completed"` string** — Replaced `queueState.status === "completed"` with `queueState.status === EXECUTION_STATES.COMPLETED` (line ~103). Added `EXECUTION_STATES` to imports from `DashboardConstants`.

2. **[HIGH] Unsafe `(flightPathManager as any).promptQueue` casts** — Added `getActivePromptQueue(): PromptQueue | null` method to `WorkflowOrchestrator` (delegates to `viewedInstance?.promptQueue`). Replaced both `(flightPathManager as any).promptQueue` casts in `registerLanguageModelTools()` with `flightPathManager.getActivePromptQueue()`. Added `PromptQueue` import to `WorkflowOrchestrator.ts`.

3. **[MEDIUM] `require()` for QueueOperations** — Replaced `const { getQueueStatus, appendToQueue } = require("./flightpath/QueueOperations")` with static `import { getQueueStatus, appendToQueue } from "./flightpath/QueueOperations"` at module top.

4. **[MEDIUM] `selectPromptFile` glob misses YAML** — Updated glob pattern from `"**/*.{prompt.json,flightpath.json,prompt.md}"` to `"**/*.{prompt.json,flightpath.json,flightpath.yaml,flightpath.yml,prompt.md}"` in the `selectPromptFile` command.

5. **[MEDIUM] `parameters: any` on LM Tool invoke** — Changed `parameters: any` to `parameters: unknown` and added runtime validation: checks `typeof params === "object"`, validates `params.prompts` is an array, `params.position` is a string, etc. Uses `QueuePosition` type cast for the position field.

#### 1.2 mcp-server.ts

1. **[HIGH] Unused `hashPromptContent` import** — Removed the `import { hashPromptContent } from "./utils/PromptIdentity"` line. Function was imported but never called in this file.

2. **[MEDIUM] Dead `generateId()` method** — Removed the unused `private generateId(): string` method from `FlightPathMCPServer` class.

3. **[MEDIUM] Magic number `100` for `maxQueueSize`** — Extracted to module-level `const MAX_QUEUE_SIZE = 100`. Updated all 3 usages (metadata response, validation check) to use the named constant.

4. **[MEDIUM] `private server` field typing** — Changed `private server: typeof Server` to `private server: InstanceType<typeof Server>` for more accurate typing (the field holds a Server instance, not the class itself).

#### 1.3 FlightPathTypes.ts

1. **[HIGH] Dead `ClaudeCliStatus` type** — Removed the `export type ClaudeCliStatus = "Initializing" | "Ready" | "Unavailable"` declaration. Confirmed it has zero imports/usages across the codebase.

2. **[MEDIUM] `WorkflowContext.promptQueue?: any`** — Replaced `any` with `{ getState(): QueueState }` minimal interface type. This avoids circular dependency with PromptQueue while providing type safety. Note: the `WorkflowContext` in FlightPathTypes.ts is itself dead code (never imported — the `WorkflowContext` in `WorkflowExecutor.ts` is the one used), but fixed anyway for correctness.

3. **[MEDIUM] `completedIds` renamed to `completedIndices`** — Renamed `QueueState.completedIds` to `QueueState.completedIndices` across all source files:
   - `src/types/FlightPathTypes.ts` (1 occurrence)
   - `src/flightpath/PromptQueue.ts` (17 occurrences)
   - `src/test/promptQueue.test.ts` (12 occurrences)
   - Documentation files were NOT updated (they reference old code for context)

#### 1.4 DashboardConstants.ts

1. **[MEDIUM] `PROMPTS_APPENDED` usage check** — Confirmed `PROMPTS_APPENDED` is defined but has no handler in the webview or extension. Added comment `// Reserved: defined for future use (no handler exists yet)` to the constant definition.

#### 1.5 WebviewMessageTypes.ts

1. **[MEDIUM] `CliEventData` duplication** — Removed the local duplicate `CliEventData` union type definition. Added `CliEventData` to the `export type { ... } from "./CliOutputTypes"` re-export block, making `CliOutputTypes.ts` the single source of truth.

2. **[MEDIUM] Missing `IncomingMessage` union members** — Added 9 missing message interfaces and added them to the `IncomingMessage` union type:
   - `WorkflowsListMessage` (`WORKFLOWS_LIST`) — multi-workflow coordination
   - `WorkflowAddedMessage` (`WORKFLOW_ADDED`) — multi-workflow coordination
   - `WorkflowDismissedMessage` (`WORKFLOW_DISMISSED`) — multi-workflow coordination
   - `WorkflowSummaryUpdatedMessage` (`WORKFLOW_SUMMARY_UPDATED`) — multi-workflow coordination
   - `ActiveWorkflowChangedMessage` (`ACTIVE_WORKFLOW_CHANGED`) — multi-workflow coordination
   - `GlobalSettingsUpdatedMessage` (`GLOBAL_SETTINGS_UPDATED`) — settings sync
   - `ResetWorkflowStateMessage` (`RESET_WORKFLOW_STATE`) — bidirectional reset
   - `RunHistoryUpdatedMessage` (`RUN_HISTORY_UPDATED`) — history updates
   - `OutputHistoryLoadedMessage` (`OUTPUT_HISTORY_LOADED`) — history loading (uses `unknown` for `history` field to avoid circular dep with `OutputHistoryTypes`)
   - Also added `import type { WorkflowSummary } from "./FlightPathTypes"` and re-exported it.

### Section 2: Core Flightpath Modules

#### 2.1 HarnessIntegration.ts

1. **[HIGH] Dead `getCapabilities()` method** — Removed the abstract `getCapabilities()` method from `HarnessIntegration` (~15 lines) and its override in `CopilotChatIntegration` (~12 lines at line 803). Confirmed zero callers across the codebase.

2. **[HIGH] Dead `getLastFullPrompt()` method** — Removed the method from `HarnessIntegration` (~6 lines) and its override in `CliIntegration` (~6 lines at line 1405). Confirmed zero callers across the codebase.

#### 2.2 PromptQueue.ts

1. **[HIGH] DRY merge logic duplication** — Extracted shared `mergeDiskPrompts(diskPrompts: PromptItem[]): PromptItem[]` private method. Refactored both `mergePromptsFromDisk()` and `_updateWorkingFileInternal()` to call it. The helper builds a memoryPromptMap by hash, finds new prompts from disk, uses disk ordering as source of truth, and rebuilds results preserving existing runtime metadata.

2. **[HIGH] `parser: any` typing** — Changed `parser: any` to `parser: { parsePromptFile(filePath: string): Promise<PromptFile | null> }` minimal interface. Avoids circular dependency with `PromptFileParser` while providing type safety.

3. **[MEDIUM] `clear()` test-only method** — Added comment `// NOTE: Only called from tests (production code uses clearQueue() instead).` Confirmed 3 test callers in `promptQueue.test.ts`, zero production callers.

4. **[MEDIUM] `console.error` → `Log.error`** — Replaced 3 `console.error` occurrences (lines 635, 638, 1466) with `Log.error`. Added `Log` import.

5. **[MEDIUM] Dead `isCompleted()` method** — Removed entirely. Confirmed zero callers via grep.

6. **[MEDIUM] `as any` in `restart()`** — Changed `const { _runtime: _, ...rest } = prompt as any; return rest as PromptItem;` to `const { _runtime, ...rest } = prompt; return rest;`. Proper destructuring works because `_runtime` is optional on `PromptItem`.

7. **[MEDIUM] `operationQueue` error resilience** — Added `.catch()` handlers to all 3 `operationQueue` chain locations (`appendPrompts`, `updateWorkingFile`, `updateWorkingFileProperties`) to prevent a rejected promise from permanently breaking the queue chain.

#### 2.3 WorkflowExecutor.ts

1. **[MEDIUM] `waitForResponseComplete` unbounded wait** — Added 30-minute safety timeout using `setTimeout` with cleanup on normal completion. Rejects with descriptive error message if timeout fires.

2. **[MEDIUM] `logWorkflowCompletion` wrong count** — Changed `${totalPrompts}/${totalPrompts}` to `${completedCount}/${totalPrompts}` using `this.promptQueue.getCompletedCount()`.

#### 2.4 WorkflowInstance.ts

1. **[HIGH] Resource leak in `stop()` — dual listeners** — Merged two separate `onResponseComplete` listeners into a single listener that handles both `confirmedStopped` and timeout cancellation. The timeout is set up first, then a single listener calls `confirmedStopped()`, `clearTimeout()`, and `dispose()`.

2. **[MEDIUM] `isDashboardReady()` always returns true** — Added TODO comment documenting it as a Phase 2 placeholder. Updated JSDoc to match.

3. **[MEDIUM] `console.log` in `deletePromptFromQueue`** — Changed to `Log.info`.

#### 2.5 WorkflowOrchestrator.ts

1. **[MEDIUM] DRY `resolveDetectorIntegration`/`getDefaultIntegration`** — Made `getDefaultIntegration()` delegate to `resolveDetectorIntegration(undefined)`. Refactored `resolveDetectorIntegration` to use `const harness = harnessOverride ?? ConfigurationUtils.getIntegrationMode()` with a single switch statement.

2. **[MEDIUM] `createDraftPrompt` bracket notation** — Replaced `instance["currentPromptFile"] = {...}` and `instance["setupPromptFileWatcher"](...)` with new public methods `instance.setCurrentPromptFile(...)` and `instance.initializeFileWatcher(...)` added to `WorkflowInstance`.

3. **[MEDIUM] `saveState` no-op** — Updated JSDoc to clearly explain why clearing stale state from previous architecture is needed.

#### 2.6 PromptFileParser.ts

1. **[MEDIUM] DRY property copying** — Extracted `copyWorkflowLevelProperties(parsed, promptFile)` private method. Both single-prompt and multi-prompt normalization paths now call it instead of duplicating 6 property-copy lines.

#### 2.7 EndConditionEvaluator.ts

1. **[MEDIUM] No workspace-root path validation** — Added workspace root validation after `resolveScriptPath`. For absolute paths and working-directory-relative paths, checks `!fullPath.startsWith(workspaceRoot)` and returns null with `Log.error` if outside workspace boundary.

2. **[MEDIUM] PowerShell `pwsh` preference** — Added `resolvePowerShellExecutable()` private method that tries `execSync("pwsh -Version")` and falls back to `"powershell"`. Updated `.ps1` case in `getScriptCommand` to use it.

#### 2.8 EndConditionHandler.ts

1. **[MEDIUM] Recursive retry → iterative** — Replaced recursive `handleValidationFailure` with iterative `handleValidationFailureIterative` using a `while (true)` loop. The loop checks stopped state, canRetry, sends retry prompt, re-evaluates, and continues or breaks. Eliminates stack depth concern for workflows with many retries.

#### 2.10 QueueOperations.ts

1. **[MEDIUM] Deprecated `AppendPosition` type alias** — Removed the deprecated `AppendPosition` type alias and its export. Confirmed zero external consumers (only the definition itself existed).

2. **[MEDIUM] `endCondition: any` typing** — Changed `endCondition?: any` in `AppendPromptsRequest.prompts` array items to `endCondition?: EndCondition`. Added `EndCondition` to the `FlightPathTypes` import.

#### 2.11 TemplateManager.ts

1. **[MEDIUM] Synchronous fs operations** — Replaced all sync fs calls with async equivalents: `readFileSync` → `fs.promises.readFile`, `existsSync` → `pathExists()` helper using `fs.promises.access`, `mkdirSync` → `fs.promises.mkdir`, `writeFileSync` → `fs.promises.writeFile`, `readdirSync` → `fs.promises.readdir`. Added private `pathExists()` async helper method.

2. **[MEDIUM] `console.warn` → `Log.warn`** — Replaced 2 `console.warn` occurrences in `discoverCustomTemplates` with `Log.warn`. Added `Log` import.

### Section 3: CLI Integration

> **New shared utilities created:** `CliEventMapper.ts`, `CliProviderUtils.ts`
> **Files modified:** ~20 files across `src/flightpath/cli/`
> **Lines of duplicated code eliminated:** ~800+
> **Bug fixes:** 2 (ClaudeToolPermissionMapper hasFullPermissions, CodexCliProvider missing cliAdditionalDirs)

#### 3.1 CliIntegration.ts

1. **[HIGH] Headless retry callback duplication** — Extracted `buildHeadlessResponseCallback()` private helper method (~50 lines) that encapsulates the shared parse→store→log→fire logic. Both the primary `onResponseComplete` callback and the retry `onRetryResponse` callback now delegate to this helper, eliminating ~70 lines of duplicated code. Also fixed the retry callback to use `ConfigurationUtils.shouldLogRawCliOutput()` consistently instead of inline `vscode.workspace.getConfiguration()`.

2. **[MEDIUM] Dead code — `generateMcpConfigFile()`** — Removed the placeholder method (~35 lines) that always returned `null`. Also removed the related `getMcpConfigArgs()` wrapper method (~15 lines), the unused `cachedMcpConfigPath` field, and the unused `ChildProcess` import.

3. **[MEDIUM] Duplicated timestamp extraction** — Replaced the inline `getEntryTimestamp()` helper function inside `monitorLogFile()` with delegation to `BaseLogParser.extractTimestamp()` via the parser instance. Both performed the same `entry.timestamp || entry.time || entry.ts` cascading lookup.

4. **[MEDIUM] Redundant `isSimplePrompt()` checks** — Removed 5 redundant individual character checks (`"`, `'`, `\`, `` ` ``, `$`) that were already excluded by the `SAFE_CHARS_PATTERN` regex character class.

5. **[MEDIUM] `currentProcess` field never assigned** — Removed the unused `currentProcess` field and its check in `cancelImplementation()`. Cancellation works via `CliProcessManager.kill()` directly.

#### 3.2 Shared Utilities — New Files

1. **[CRITICAL/HIGH] Created `CliEventMapper.ts`** — Single source of truth for tool-name-to-semantic-event-type classification. Uses Set-based O(1) lookup for known tool categories (BASH*TOOLS, FILE_READ_TOOLS, FILE_WRITE_TOOLS, FILE_EDIT_TOOLS, FILE_DELETE_TOOLS, WEB_SEARCH_TOOLS). Returns `ToolClassification` union type with event type and optional MCP server/tool extraction. Handles all three MCP naming conventions: `server(tool)` (Copilot), `server__tool` (Codex), `server.tool`/`mcp*\*` (Claude). Eliminates ~600 lines of duplicated mapping logic across 6+ locations.

2. **[HIGH] Created `CliProviderUtils.ts`** — Shared utility for `getWorkspaceDirs(workspaceRoot)` and `buildMcpConfigBlock(...)`. `getWorkspaceDirs` includes VS Code workspace folders AND `ConfigurationUtils.getCliAllowedDirs()` (fixing a bug in CodexCliProvider that was missing additional dirs). `buildMcpConfigBlock` extracts the shared PromptIdentity check and MCP config generation logic.

#### 3.3 Shared Utilities — Modified Files

1. **[MEDIUM] `BaseLogParser.ts` — Added `readFirstNJsonlEvents()`** — Protected method that reads first N events from a JSONL log file. Replaces identical private implementations in all 3 log parsers (~40 lines × 3 = ~120 lines eliminated).

2. **[MEDIUM] `CliToolPermissionMapper.ts` — Single-sourced types** — Removed duplicate `ToolPermissionMode` type definition (now imports from `IToolPermissionMapper`). Removed duplicate `ToolPermissionConfig` interface (now imports from `IToolPermissionMapper`). Exported `COPILOT_TO_CLAUDE_MAP` constant for reuse by `ClaudeToolPermissionMapper`. Re-exports types for backward compatibility.

3. **[MEDIUM] `CliNotificationMonitor.ts` — Single-sourced types** — Removed duplicate `NotificationConfig` and `NotificationResult` interface definitions (now imports from `INotificationMonitor`). Re-exports for backward compatibility.

#### 3.4 Copilot Provider

1. **[HIGH] `CopilotCliProvider.ts` — getWorkspaceDirs dedup** — Replaced private `getWorkspaceDirs()` method with `CliProviderUtils.getWorkspaceDirs()`. Replaced MCP config block with `CliProviderUtils.buildMcpConfigBlock()` call (kept provider-specific `--allow-tool flightpath` flag after).

2. **[HIGH] `CopilotLogParser.ts` — mapToolToSemanticEvent dedup** — Replaced inline `mapToolToSemanticEvent()` method with CliEventMapper-based switch on `classification.type`. Removed unused `eventBuffer` field. Replaced `readFirstEvents()` with inherited `readFirstNJsonlEvents()` and deleted the private method.

3. **[MEDIUM] `CopilotToolPermissionMapper.ts` — parsePattern dedup** — Changed class to extend `ToolPermissionMapperBase` (was directly implementing `IToolPermissionMapper`). Removed duplicate `parsePattern()` private method — now inherits from base class.

#### 3.5 Claude Provider

1. **[HIGH] `ClaudeCliProvider.ts` — getWorkspaceDirs + MCP config dedup** — Same pattern as Copilot: replaced both methods with CliProviderUtils calls. Kept provider-specific `--allowed-tools mcp__flightpath` flag. Removed private `getWorkspaceDirs()` method.

2. **[CRITICAL] `ClaudeResponseParser.ts` — extractJsonObjectsFromStream dedup** — Removed the ~90-line private `extractJsonObjectsFromStream()` method (was a full reimplementation of `CliResponseParser.extractJsonObjectsFromStream()`). Updated 3 call sites to use `CliResponseParser.extractJsonObjectsFromStream()`. Also replaced `mapToolToSemanticEvent()` with CliEventMapper-based version.

3. **[HIGH] `ClaudeLogParser.ts` — mapToolToSemanticEvent dedup** — Replaced inline tool mapping with CliEventMapper-based switch. Replaced `readFirstNEvents()` with inherited `readFirstNJsonlEvents()` and deleted the private method.

4. **[HIGH] `ClaudeToolPermissionMapper.ts` — hasFullPermissions bug fix + dedup** — **BUG FIX:** `hasFullPermissions()` always returned `true`, ignoring `deniedTools`. Now returns `true` only for `dangerouslyAllowAll` mode or when `deniedTools.length === 0`. Also removed duplicate `COPILOT_TO_CLAUDE_MAP` — now imports from `CliToolPermissionMapper`.

#### 3.6 Codex Provider

1. **[HIGH] `CodexCliProvider.ts` — getWorkspaceDirs + MCP config dedup + bug fix** — Same pattern as other providers. **BUG FIX:** Codex's `getWorkspaceDirs()` was missing `ConfigurationUtils.getCliAllowedDirs()` support — users couldn't add extra directories via settings for Codex while Copilot/Claude users could. Now uses `CliProviderUtils.getWorkspaceDirs()` which includes additional dirs.

2. **[CRITICAL] `CodexLogParser.ts` — triple internal tool mapping dedup** — Replaced 3 internal copies of tool-to-semantic-event mapping (`tool_use`, `function_call`, `custom_tool_call` sections — ~300 lines total) with CliEventMapper-based switch blocks (~200 lines). Removed dead `processEvent()` method (~30 lines) and unused `eventBuffer` field. Added `toolCallMap.clear()` at start of `extractResponse()` to prevent cross-run state leaks. Replaced `readFirstEvents()` with inherited `readFirstNJsonlEvents()`.

3. **[MEDIUM] `CodexToolPermissionMapper.ts` — buildArgs dedup** — Made `buildArgs()` delegate to `buildCodexSpecificArgs(config, undefined, undefined)`, eliminating the duplicated switch statement over `config.mode`.

4. **[MEDIUM] `CodexResponseParser.ts` — parseJsonLines dedup** — Replaced private `parseJsonLines()` (~20 lines) with `CliResponseParser.parseJsonLines()`. Updated 2 call sites with `as CodexCliJsonEvent[]` cast.

#### 3.7 Test Updates

1. **`LogParsers.test.ts`** — Updated "should handle multiple content blocks" test for ClaudeLogParser. The test previously expected `write_file` as a generic `TOOL_CALL` event; updated to check for `FILE_WRITE` semantic event type (matching the new CliEventMapper behavior). Added `FileWriteData` import.

#### 3.8 Deferred Items

**HIGH (2 deferred):**

- **3.1 God class characteristics** — Architecture recommendation to split `CliIntegration.ts` into smaller classes. Deferred: requires significant restructuring beyond targeted fixes.
- **3.7.2 `any` type pipeline from ILogParser** — Architecture recommendation to define `BaseCliEvent` type. Deferred: cross-cutting type change affecting ~3,000 lines.

**MEDIUM (12 deferred):**

- **3.2.1 Abstract methods use `any` types** — Architecture: would require generic type parameters across all parsers.
- **3.2.1 `readJsonlEvents()` returns `any[]`** — Same `any` type architecture issue.
- **3.2.4 Static `extractSessionId()`/`extractThreadId()` unused** — Needs investigation on whether providers should delegate to these.
- **3.2.5 `validatePatterns()` incomplete** — Design decision: either make void or return structured errors.
- **3.3.1 `buildCliArgs()` uses `any` for prompt/context** — Type safety improvement requiring `PromptItem`/`WorkflowContext` types in interface.
- **3.3.2 All ILogParser method signatures use `any[]`** — Root cause of `any` pipeline, same architecture issue.
- **3.4.1 Shell injection risk in `buildInteractiveTuiCommand()`** — Security hardening: needs temp file approach for all prompts.
- **3.4.1 `createHookFile()` path validation** — Security: workspace root path traversal check.
- **3.5.2 `extractResponse()` tool-result handling duplicated with ClaudeResponseParser** — Complex internal dedup within Claude provider.
- **3.5.3 `processUserContent()` duplicated with ClaudeLogParser** — Same as above, needs shared extraction.
- **3.5.4 `isFileNewerThan()` method verification** — Needs runtime verification of base class inheritance.
- **3.6.3 `parseItemToEvents()` partially duplicated** — Minor internal dedup within Codex provider.

### Section 4: Chat & Orchestration

> **Files modified:** 9 files across `src/flightpath/chat/` and `src/flightpath/orchestration/`
> **Files deleted:** 1 (`ChatLogMonitor.ts` — 249 lines dead code)
> **Test files updated:** 1 (`chatSessionParser.test.ts`)
> **Console→Log migrations:** 20 calls across 3 files

#### 4.1 CopilotChatIntegration.ts

1. **[MEDIUM] DRY commandMap violation** — Extracted shared `getChatCommand(purpose: 'focus' | 'new')` private helper method with a nested `commandMap` keyed by purpose. `getChatWindowCommand()` and `startNewChatSession()` now both delegate to it, eliminating duplicated copilot/copilot-edits command mapping.

2. **[MEDIUM] `getCapabilities()` dead code** — Already removed by Section 2 agent (confirmed via grep: zero matches in `src/flightpath/chat/`). No action needed.

3. **[MEDIUM] `resolvedProperties?: any` typing** — Replaced `resolvedProperties?: any` with `resolvedProperties?: ResolvedProperties` in both `sendPrompt()` and `buildCopilotChatPrompt()` method signatures. Added `import { ResolvedProperties } from "../../utils/PropertyResolver"`.

#### 4.2 ChatSessionMonitor.ts

1. **[HIGH] `getRequestCount()` duplication** — Removed the ~20-line instance method that duplicated `ChatSessionParser.getRequestCount()`. Now delegates to `ChatSessionParser.getRequestCount(filePath)` (static method).

2. **[HIGH] `isLastRequestComplete()` duplication** — Core completion logic now delegates to `ChatSessionParser.isSessionComplete(filePath)` (static). The monitor method adds cancellation detection (checks for `isCanceled: true` on the last request) and debug logging on top of the delegated result.

3. **[MEDIUM] Sync fs in hot path** — Converted `findAllSessionFiles()` from synchronous to async using `fs.promises.stat()` and `fs.promises.readdir()`. Added `findAllSessionFilesSync()` as fallback for `findSessionFileByPromptText()` (which is called synchronously from completion detection).

4. **[MEDIUM] No directory caching** — Added `DirectoryCache` interface with `entries`, `parentMtimes`, and `timestamp` fields. Implemented mtime-based directory invalidation with `DIR_CACHE_TTL_MS = 2000`. Both sync and async `findAllSessionFiles` methods use the cache when fresh, doing a full re-scan only when directory mtime changes or cache expires.

#### 4.3 ChatSessionParser.ts

1. **[MEDIUM] Instance methods should be static** — Changed `isSessionComplete()` and `getRequestCount()` from instance methods to `static` methods. Both only depend on their parameters (file path), not on instance state. Updated all callers in `ChatSessionMonitor.ts` and `chatSessionParser.test.ts`.

2. **[MEDIUM] `replayJsonl()` defensive check** — Added `if (!Array.isArray(state.requests))` guard after replay completes. If `requests` is not an array (unexpected malformed data), logs a warning and resets to empty array to prevent downstream crashes.

3. **[MEDIUM] `extractThinkingText()` fragile heuristic** — Added detailed JSDoc comment documenting the encrypted content detection heuristic: VS Code encrypts thinking blocks from some models (like Claude), producing base64-like strings with 100+ consecutive non-whitespace characters. The 100-char threshold is calibrated to flag encrypted blocks while allowing legitimate long identifiers/URLs.

#### 4.4 ChatLogMonitor.ts

1. **[CRITICAL] Dead code — entire file** — Confirmed via grep: zero imports or references to `ChatLogMonitor` anywhere in `src/` (only match was its own class definition). Deleted the entire 249-line file. No barrel export existed.

#### 4.5 NativeAttachmentHandler.ts

1. **[MEDIUM] `withFocusedDocument()` no finally** — Wrapped the `action()` call in `try/finally` so that `closeActiveEditor()` cleanup always executes even if the action throws.

2. **[MEDIUM] Fixed 200ms delays** — Extracted to named static constants: `DOCUMENT_FOCUS_DELAY_MS = 200` and `INTER_ATTACHMENT_DELAY_MS = 200`. Both `delay()` call sites now use the named constants.

#### 4.6 WorkflowCommandHandler.ts

1. **[MEDIUM] `console.*` → `Log.*`** — Replaced all 8 `console.error`/`console.log` calls with `Log.error`/`Log.info`. Added `import { Log } from "../../utils/Log"`.

2. **[MEDIUM] Hardcoded prompts path** — Changed `createDraftPrompt()` from hardcoded `".flightpath", "prompts"` strings to `PATH_CONSTANTS.FLIGHTPATH_DIR, PATH_CONSTANTS.PROMPTS_DIR`. Added `PATH_CONSTANTS` to `ConfigurationUtils` import.

3. **[MEDIUM] `TemplateManager` inline instantiation** — Changed from creating `new TemplateManager(this.context)` inline in `createNewTemplate()` to a cached `templateManager` field initialized once in the constructor.

#### 4.7 OutputHistoryManager.ts

1. **[MEDIUM] `[APPEND-DEBUG]` logs** — Removed all 8 `Log.info("[APPEND-DEBUG] ...")` statements from `saveStepOutput()` and `getLatestHistoryFilePath()`. These were temporary debugging logs left over from development.

2. **[MEDIUM] `extractWorkflowId()` missing `.yml`** — Added `.flightpath.yml` to the list of extensions stripped by `extractWorkflowId()` (already had `.flightpath.yaml`, `.flightpath.json`, `.prompt.md`, `.prompt.json`).

#### 4.8 PromptFileLoader.ts

1. **[MEDIUM] `(promptFile as any)[key]` unsafe cast** — Replaced dynamic bracket-notation access with type-safe explicit field access. Created `extractWorkflowProperties()` private helper method that reads each property by name from the parsed prompt file object using typed field access.

2. **[MEDIUM] `loadPromptFile()` too many responsibilities** — Extracted two helper methods: `extractWorkflowProperties(promptFile)` for collecting workflow-level properties, and `populateSettingsDefaults(properties, harness)` for applying VS Code settings-based defaults. Also replaced `as any` harness cast with `Parameters<typeof ConfigurationUtils.getModelForHarness>[0]` for type-safe model lookup.

#### 4.9 TemplateImporter.ts

1. **[MEDIUM] `console.error` → `Log.error`** — Replaced all 4 `console.error` calls with `Log.error`. Added `import { Log } from "../../utils/Log"`.

2. **[MEDIUM] Misleading variable names** — Renamed `importedAgents`/`failedAgents` return properties from `copyTemplateFiles()` to `importedItems`/`failedItems`. These are used for both agent and workflow template imports, so the `-Agents` suffix was misleading. Updated both callers (`importAgents()` and `importWorkflowTemplates()`).

#### 4.10 WorkspaceSessionManager.ts

1. **[MEDIUM] `console.*` → `Log.*`** — Replaced all 8 `console.error`/`console.log`/`console.warn` calls with `Log.error`/`Log.info`/`Log.warn`. Added `import { Log } from "../../utils/Log"`.

2. **[MEDIUM] `_runtime` any cast** — Added `import { PromptItem, WorkingFile } from "../../types/FlightPathTypes"`. Added `as WorkingFile` type assertion for parsed JSON in `findMostRecentWorkingFile()` and `discoverSessions()`. Changed `(p: any)` filter to `(p: PromptItem)` for session ID filter. Replaced legacy `runtime?.completedPrompts?.length` with `prompts.filter(p => p._runtime?.completedAt).length` for type-safe completed prompt counting.

#### 4.12 Cross-cutting: Console→Log Migration

All `console.*` calls in Section 4 files migrated to `Log.*` (total: 20 calls across WorkflowCommandHandler, TemplateImporter, WorkspaceSessionManager).

### Section 5: Utilities

#### 5.2 FileSystemUtils.ts

1. **[MEDIUM] Dead code removal (~350 lines)** — Verified via grep that the following methods had zero callers outside `FileSystemUtils.ts` itself: `findFiles()`, `findFilesRecursive()`, `shouldIgnoreDirectory()`, `watchDirectory()`, `stopWatching()`, `stopAllWatchers()`, `getFileStats()`, `createBackup()`, `getWorkspaceRelativePath()`, `getDirectoryContents()`, `ensureDirectory()`, `readFile()`, `writeFile()`, `fileExists()`, `deleteFile()`, `dispose()`. Also removed unused `chokidar` and `path` imports, watchers map, event emitter, and `onDidChangeFile` event.

2. **[MEDIUM] Class → standalone functions** — Converted the entire `FileSystemUtils` class to two standalone exported functions: `readJsonFileAndDelete()` (used by `CliNotificationMonitor`) and `saveIfDirty()` (used by `extension.ts`). Updated all 3 consumers:
   - `extension.ts`: Changed `FileSystemUtils.saveIfDirty()` → `saveIfDirty()` (4 call sites)
   - `CliNotificationMonitor.ts`: Changed `new FileSystemUtils().readJsonFileAndDelete()` → `readJsonFileAndDelete()` (1 call site)
   - `CliIntegration.ts`: Removed dead `FileSystemUtils` import (never used)

#### 5.3 ValidationUtils.ts

1. **[HIGH] DRY model enum — dynamic from ModelConstants** — Removed the 22-entry hardcoded model enum array. Added imports of `COPILOT_CLI_MODEL_IDS`, `CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS` from `ModelConstants.ts`. Built `ALL_MODEL_IDS` array dynamically using `[...new Set([...COPILOT_CLI_MODEL_IDS, ...CLAUDE_CLI_MODELS, ...CODEX_CLI_MODELS])]`. Used in the AJV schema's `enum` property with `as unknown as readonly string[]` cast to satisfy AJV's strict typing.

2. **[MEDIUM] `sanitizePromptText()` test-only marker** — Added JSDoc `@internal` tag with note "Only called from tests — not used in production code paths." Confirmed via grep: only called from `validationUtils.test.ts` (10 references), never from production code.

#### 5.5 PropertyResolver.ts

1. **[MEDIUM] `resolveAllowDynamicExtension()` OR-merge → three-tier precedence** — Replaced `Boolean(prompt.allowDynamicExtension || workflow.allowDynamicExtension || globalEnabled)` with proper three-tier chain: check `prompt.allowDynamicExtension !== undefined` first, then `workflow.allowDynamicExtension !== undefined`, then fall back to `ConfigurationUtils.getDynamicQueueConfig().enabled`. Now a prompt-level `false` correctly overrides a workflow-level `true`, matching the pattern used by all other resolvers. Updated JSDoc to match.

#### 5.6 CliProcessManager.ts

1. **[MEDIUM] `spawn()` race condition — timeout vs close double-settlement** — Added `settled` boolean flag. Both `close` handler and `error` handler check `settled` before resolving/rejecting. Timeout handler sets `settled = true` before rejecting. Close handler clears the timeout via stored `timeoutId`. Prevents the promise from being both resolved and rejected.

2. **[MEDIUM] `spawnSimple()` timeout never cleared** — Added `settled` boolean flag and stored timeout as `timeoutId`. Close handler calls `clearTimeout(timeoutId)` before resolving. Error handler also calls `clearTimeout(timeoutId)`. Timeout handler checks `settled` before killing and rejecting. Prevents double-settlement and leaked timers.

#### 5.8 ModelRegistry.ts

1. **[MEDIUM] Dead code removal** — Verified via grep that `getModelIds()`, `getModelIdsSync()`, and `getCliSupportedModels()` have zero callers outside their own definitions. Removed all three functions (~25 lines).

#### 5.14 AgentDiscovery.ts

1. **[MEDIUM] Dead `filterAgentsByHarness()` removal** — Verified via grep: zero callers outside the definition itself. Removed the method (~15 lines). Note: The `supportsCopilotCli`/`supportsClaudeCli` flags on `AgentInfo` are always `true` (set in `discoverAgentsInDirectory`), making this filter a no-op even if it had been called.

#### 5.15 FileReferenceParser.ts

1. **[MEDIUM] Dead `convertToAtSyntax()` removal** — Verified via grep: zero callers outside the definition. Removed the exported function (~15 lines).

#### 5.16 RetryUtils.ts

1. **[MEDIUM] JSDoc `maxAttempts` default mismatch** — Changed `@default 15` to `@default 60` in the `maxAttempts` property JSDoc to match the actual implementation default of `maxAttempts = 60` in `retryWithBackoff()`.

#### 5.20 Cross-Cutting

1. **[MEDIUM] AgentExpander re-discovery caching** — Added 5-second TTL cache (`AGENT_CACHE_TTL_MS = 5000`) for `AgentDiscovery.discoverAgents()` results. `expandAgent()` now reuses cached agent list if less than 5 seconds old, avoiding redundant filesystem scans during multi-prompt workflows. File reads are NOT cached (prevents stale content during development).

2. **[MEDIUM] SkillExpander re-discovery caching** — Same pattern: added 5-second TTL cache (`SKILL_CACHE_TTL_MS = 5000`) for `SkillDiscovery.discoverSkills()` results. `expandSkills()` reuses cached skills list within the TTL window.

3. **[MEDIUM] FileSystemUtils class cleanup** — Addressed as part of 5.2 above. After removing dead code, converted the remaining `readJsonFileAndDelete()` and static `saveIfDirty()` to standalone exported functions and updated the single consumer (`CliNotificationMonitor`).

### Section 6: UI & Completions

> **Files modified:** 5 (`FlightPathWebviewProvider.ts`, `StatusBarManager.ts`, `CompletionHelpers.ts`, `PromptCompletionProvider.ts`, `PromptLinkProvider.ts`)
> **Dead code removed:** ~120 lines (StatusBarManager: 7 methods; CompletionHelpers: 1 dead export)
> **Security fixes:** 2 (CSP nonce, config key allowlist)

#### 6.1 FlightPathWebviewProvider.ts

1. **[HIGH] CSP `'unsafe-inline'` for `script-src`** — Replaced `'unsafe-inline'` with nonce-based CSP. Added `getNonce()` private method generating 32-character random nonces. The nonce is applied to the injected `vscodeApi` capture script, the React module script tag, and any other script tags via regex replacement. CSP directive now uses `'nonce-${nonce}'` instead of `'unsafe-inline'`. `'unsafe-inline'` kept for `style-src` (required by Tailwind).

2. **[HIGH] `handleGetConfig`/`handleUpdateConfig` arbitrary config access** — Added allowlist validation to both methods. Each now checks `key.startsWith("flightpath.")` before proceeding, with `Log.warn()` for rejected attempts. Prevents webview from reading/writing arbitrary VS Code settings.

3. **[MEDIUM] DRY violation: `sendInitialState()` / `sendGlobalSettingsUpdate()`** — Extracted `buildGlobalSettings()` private method that constructs the global settings object from `ConfigurationUtils`. Both `sendInitialState()` and `sendGlobalSettingsUpdate()` now call it, eliminating ~30 lines of duplicated configuration reads.

4. **[MEDIUM] `sendWorkflowPropertiesToSettings()` synchronous `readFileSync`** — Converted to async: `fsSync.readFileSync()` → `fs.readFile()`, method signature changed to `async ... Promise<void>`. Updated all 4 call sites to `await`. Also made `updateSessionRestored()` async since it now awaits the method.

5. **[MEDIUM] `handleCreateWorkflow` dead handler** — Marked with clear TODO JSDoc documenting it as a stub pending `WorkflowCommandHandler.createWorkflowFromTemplate()` implementation. Removed unused destructuring of `templateId`, `fileName`, `variables` from message.

6. **[MEDIUM] `handleRemoveWorkflowHistory` fragile stem matching** — Added detailed documentation explaining why stem matching is necessary (original file has different extension than working copy). Improved matching to use `f === \`${stem}.flightpath.json\`` or `f.startsWith(\`${stem}.\`)` to prevent false matches (e.g., "foo" matching "foobar.flightpath.json").

7. **[MEDIUM] Excessive `any` usage** — Fixed the most impactful instances:
   - `pendingWorkflowProperties.endCondition: any` → `EndCondition | null` (imported from FlightPathTypes)
   - `updateStepStatus(status: any, details?: any)` → `status: { state: StepStatus; duration?: number; message?: string; endConditionResult?: unknown }`, `details?: Record<string, unknown>`
   - `handleUpdateConfig(key: string, value: any)` → `value: unknown`
   - `(this.pendingWorkflowProperties as any)[property]` → `as Record<string, unknown>`
   - Remaining `any` in `postMessage`, `handleWebviewMessage`, `getCurrentState` annotated with eslint-disable comments explaining the blocker (no Webview→Extension message union type exists yet)

#### 6.2 StatusBarManager.ts

1. **[MEDIUM] Dead code removal** — Verified via grep that `showSuccess()`, `showError()`, `showWarning()`, `showProgress()`, `setCustomStatus()`, `updateCommand()`, and `getText()` have zero external callers (only defined within StatusBarManager itself, never called from outside). Removed all 7 methods (~90 lines). DRY violation (item 2) is moot since the methods were removed.

#### 6.3 CompletionHelpers.ts

1. **[MEDIUM] `disposeCompletionHelpers()` dead export** — Removed `export` keyword. The `configWatcher` is pushed to `context.subscriptions` for automatic VS Code disposal; the explicit dispose function was never called. Kept as private function for potential future use.

2. **[MEDIUM] `getWorkspaceFiles()` unnecessary export** — Removed `export` keyword. Function is only used internally within `CompletionHelpers.ts` (by `getFileCompletions()`). No external callers.

#### 6.4 PromptCompletionProvider.ts

1. **[MEDIUM] `isInsidePromptString` missing closing quote check** — Fixed the return condition from `return charIndex > openQuoteIndex` to `return charIndex > openQuoteIndex && (closeQuoteIndex === -1 || charIndex <= closeQuoteIndex)`. Now correctly verifies the cursor is between the opening and closing quotes, or that no closing quote exists yet on the line.

### Section 7: Templates, Scripts & Dev

> **New file created:** `src/scripts/flightpath-hook-utils.js` (shared hook utilities)
> **Files modified:** 5 (`flightpath-copilot-hook.js`, `flightpath-claude-hook.js`, `flightpath-codex-notify.js`, `simple-feature.flightpath.json`, `simple-feature.flightpath.yaml`)
> **Duplicated code eliminated:** ~80 lines (3 × `getDebugLogPath` + `getTempLogPath` + `debugLog` boilerplate)
> **Security fixes:** 3 (path traversal via unsanitized IDs in all 3 hook scripts)

#### 7.1 Hook Scripts

1. **[MEDIUM] Path traversal via unsanitized IDs in notification filenames** — All three hook scripts used externally-supplied identifiers (`sessionId`, `threadId`) directly in `path.join(notifyDir, \`${id}.json\`)`without sanitization, allowing directory traversal attacks. Fixed by applying`path.basename()` to strip directory components before using the ID in the filename:
   - `flightpath-copilot-hook.js`: Added `const safeSessionId = sessionId ? path.basename(sessionId) : null;` before building the notification filename.
   - `flightpath-claude-hook.js`: Added `const safeSessionId = path.basename(sessionId);` before building the `-start.json`/`-stop.json` notification filenames.
   - `flightpath-codex-notify.js`: Added `const safeThreadId = path.basename(threadId);` before building the notification filename.

2. **[MEDIUM] DRY violation — ~80 lines of duplicated boilerplate across 3 hooks** — Created `src/scripts/flightpath-hook-utils.js` exporting shared utility functions:
   - `getDebugLogPath(logsDir, scriptName)`: Ensures logs directory exists, returns log file path.
   - `getTempLogPath(scriptName)`: Returns fallback log path in `os.tmpdir()`.
   - `createLogger(logPath)`: Returns a `debugLog(message, data?)` function bound to a log file path. Returns a no-op logger when `logPath` is null.
   - `getLogsDirFromNotifyDir(notifyDir)`: Derives `.flightpath/logs/` from a notification directory by navigating up 2 levels (shared by Copilot and Claude hooks).

   Refactored all three hooks to `require("./flightpath-hook-utils")` and use the shared functions. Replaced module-level `DEBUG_LOG_FILE` variable + standalone `debugLog()` function pattern with `let debugLog = createLogger(null)` + re-assignment after argument parsing. The shared file follows all hook script conventions: plain CJS, Node.js built-ins only, no external dependencies.

#### 7.2 Template Scripts

1. **[MEDIUM] Workflow templates use non-existent `newChatSession` property** — Both `simple-feature` workflow templates referenced `newChatSession: false` (a property that doesn't exist in the schema) instead of `resumeSession: true` (the correct property with inverse semantics). Fixed in:
   - `src/templates/workflows/simple-feature.flightpath.json`: Replaced `"newChatSession": false` with `"resumeSession": true` on both the `implement` and `commit` prompts.
   - `src/templates/workflows/simple-feature.flightpath.yaml`: Same fix — replaced `newChatSession: false` with `resumeSession: true` on both prompts.

### Section 8: Cross-Cutting Concerns

Verified and fixed remaining items from §8 that were not covered by Sections 1–7.

#### §8.2 Logging — console._ → Log._

All previously identified `console.*` calls have been verified as already fixed:

- **PromptQueue.ts** — `console.error` already replaced with `Log.error` (Section 2 fix)
- **TemplateManager.ts** — `console.warn` already replaced (Section 2 fix)
- **WorkflowInstance.ts** — `console.log` already replaced with `Log.info` (Section 2 fix)

#### §8.3 Hardcoded Strings

1. **[MEDIUM] OutputHistoryManager.ts `"running" as ExecutionState`** — Replaced with `EXECUTION_STATES.RUNNING`. Updated import from `ExecutionState` type-only to include both `EXECUTION_STATES` constant and `type ExecutionState`.

2. **[MEDIUM] FlightPathWebviewProvider.ts `"claude-sonnet-4.5"` hardcoded fallback** — Replaced with `DEFAULT_MODELS[HARNESS_IDS.COPILOT_CLI]`. Also fixed the `(DEFAULT_MODELS as any)[harness]` cast to `(DEFAULT_MODELS as Record<string, string>)[harness]` to eliminate unnecessary `any`.

3. **[MEDIUM] WorkflowCommandHandler.ts `=== "unavailable"` string comparison** — Replaced with `HARNESS_STATUS_STRINGS.UNAVAILABLE`. Added `HARNESS_STATUS_STRINGS` import from `DashboardConstants`.

#### §8.4 Dead Code

1. **FlightPathTypes.ts `WorkflowContext` interface** — Verified this is NOT dead code (contrary to what the audit stated). `CliIntegration.ts` imports and uses it extensively for temp file naming and session resolution. Left in place.

2. **FlightPathWebviewProvider.ts unused `DashboardOutput` import** — Removed. Confirmed zero usages in the file.

3. **FlightPathWebviewProvider.ts unused `isRegistryInitialized` import** — Removed from the `ModelRegistry` import block. Confirmed zero usages in the file.

4. **FlightPathWebviewProvider.ts dead `currentWorkflowName` field** — Removed the field declaration and its single assignment site (in `getCurrentState()`). The field was written but never read anywhere.

#### §8.9 Module Patterns — Backward-Compat Re-export

1. **[MEDIUM] `CliOutputTypes.ts` re-export of `CLI_EVENT_TYPES`** — Removed the `export { CLI_EVENT_TYPES }` re-export and its corresponding import. Migrated all 13 files that imported `CLI_EVENT_TYPES` from `CliOutputTypes` to import directly from `DashboardConstants`:
   - `ChatSessionParser.ts`
   - `CliIntegration.ts`
   - `CliEventMapper.ts` (already fixed)
   - `CliOutputFormatter.ts`
   - `ClaudeLogParser.ts`
   - `ClaudeResponseParser.ts`
   - `CodexLogParser.ts`
   - `CodexResponseParser.ts`
   - `CopilotLogParser.ts`
   - `CopilotResponseParser.ts`
   - `chatSessionParser.test.ts` (already fixed)
   - `LogParsers.test.ts`
   - `CliOutputFormatter.test.ts`
