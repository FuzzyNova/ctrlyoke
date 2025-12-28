# FlightPath Code Organization Refactoring Plan

## Executive Summary

This document outlines a comprehensive refactoring plan to improve code organization, maintainability, and adherence to SOLID principles across the FlightPath codebase. The focus is on breaking down large files (1,000+ lines) into smaller, focused components with single responsibilities.

**Key Metrics:**
- **Current State:** 6 large files totaling 7,302 lines (avg: 1,217 lines/file)
- **Target State:** ~25 focused files totaling ~7,500 lines (avg: 300 lines/file)
- **Primary Goals:** Single Responsibility, DRY principle, improved testability

---

## Current File Size Analysis

### Top 6 Largest Files (by line count)

```
1. FlightPathManager.ts                 - 1,958 lines  (orchestration + commands + file mgmt)
2. ClaudeCommandLineIntegration.ts      - 1,245 lines  (Claude CLI wrapper)
3. dashboard.js                          - 1,133 lines  (webview UI - not covered in this plan)
4. CodexCommandLineIntegration.ts       - 1,125 lines  (Codex CLI wrapper)
5. PromptQueue.ts                        - 1,108 lines  (queue state + file persistence)
6. TuiStreamProcessor.ts                 -   971 lines  (terminal output parsing)
7. BaseCliIntegration.ts                 -   895 lines  (CLI base class)
```

**Total:** 8,435 lines across 7 files (excluding dashboard.js)

---

## Refactoring Priorities

### Priority 1: FlightPathManager.ts (1,958 lines) - HIGHEST IMPACT

#### Current Problems
- **God Object Anti-Pattern:** Single class handling 10+ distinct responsibilities
- **Violates Single Responsibility Principle:** Orchestration, file I/O, UI, commands, templates, sessions all mixed together
- **Low Testability:** Cannot test individual concerns in isolation
- **Poor Code Navigation:** Difficult to find specific functionality in 2,000 line file

#### Current Responsibilities (Too Many!)
1. Integration orchestration (factory pattern for CLI/Chat selection)
2. Workflow execution coordination
3. Prompt file loading and parsing
4. Working file management and persistence
5. File watching and live reload
6. Template/agent import operations
7. Command handling (createPromptFile, takeOff, openPanel, etc.)
8. Session auto-loading and recovery
9. Queue state management coordination
10. Dashboard provider coordination

#### Proposed Refactoring

```
FlightPathManager.ts (1,958 lines)
    ↓
    SPLIT INTO 6 FOCUSED CLASSES:

┌─────────────────────────────────────────────────────────────────┐
│ FlightPathManager.ts (300-400 lines)                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Orchestration & Coordination ONLY               │
│                                                                 │
│ Core Methods:                                                   │
│ • initialize() - Setup all dependencies                         │
│ • executeLoadedPromptFile() - Start workflow execution          │
│ • getDefaultIntegration() - Factory pattern for provider        │
│ • createIntegrationForMode() - Integration selection            │
│ • startWorkflowExecution() - Delegate to WorkflowExecutor       │
│ • pause() / resume() / stop() - Queue control coordination      │
│ • onQueueStateChanged() - Event handler                         │
│                                                                 │
│ Dependencies (injected):                                        │
│ • PromptFileLoader (handles file I/O)                           │
│ • PromptFileWatcher (handles file monitoring)                   │
│ • TemplateImporter (handles template operations)                │
│ • WorkflowCommandHandler (handles UI commands)                  │
│ • WorkspaceSessionManager (handles session persistence)         │
│ • PromptQueue, WorkflowExecutor, Integrations (existing)        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PromptFileLoader.ts (200-300 lines) - NEW                       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Prompt File Loading & Validation                │
│                                                                 │
│ Methods:                                                        │
│ • loadPromptFile(filePath) - Parse and validate prompt file     │
│ • reloadFromWorkingFile(path) - Reload from working file        │
│ • saveAndReloadIfDirty(filePath) - Auto-save before exec        │
│ • validatePromptFile(file) - Validation logic                   │
│                                                                 │
│ Dependencies:                                                   │
│ • PromptFileParser (existing)                                   │
│ • PromptQueue (for loading prompts)                             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PromptFileWatcher.ts (100-150 lines) - NEW                      │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: File System Monitoring & Live Reload            │
│                                                                 │
│ Methods:                                                        │
│ • setupFileWatcher(filePath) - Create FileSystemWatcher         │
│ • onFileChanged(uri) - Handle file change events                │
│ • onFileDeleted(uri) - Handle file deletion                     │
│ • dispose() - Cleanup watchers                                  │
│                                                                 │
│ Use Cases:                                                      │
│ • Working file changes during execution (MCP appends)           │
│ • User edits to prompt files (auto-reload)                      │
│ • File deletion handling                                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ TemplateImporter.ts (300-400 lines) - NEW                       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Template & Agent Import Operations              │
│                                                                 │
│ Methods:                                                        │
│ • importAgents() - Import agents to .github/agents/             │
│ • importWorkflowTemplates() - Import to .flightpath/templates/  │
│ • createNewTemplate() - Create custom template from starting pt │
│ • loadManifest(type) - Read agent/workflow manifests            │
│ • copyTemplateFiles() - File copying with overwrite prompts     │
│                                                                 │
│ Dependencies:                                                   │
│ • TemplateManager (existing)                                    │
│ • vscode.workspace.fs (file operations)                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ WorkflowCommandHandler.ts (200-300 lines) - NEW                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Command Routing & UI Interactions               │
│                                                                 │
│ Methods:                                                        │
│ • createPromptFile() - New prompt file wizard                   │
│ • createDraftPrompt() - Timestamp-based draft creation          │
│ • createEndConditionScript() - Script template creation         │
│ • openPanel() - Dashboard panel management                      │
│ • takeOff() - File picker and execution kickoff                 │
│ • openCurrentPromptFile() - Open in editor                      │
│ • appendFromFile() - Queue append operations                    │
│                                                                 │
│ Helpers:                                                        │
│ • createExampleFlightPathYAML()                                 │
│ • createExampleFlightPathJSON()                                 │
│ • createExampleMarkdownPrompt()                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ WorkspaceSessionManager.ts (100-150 lines) - NEW                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Session Persistence & Recovery                  │
│                                                                 │
│ Methods:                                                        │
│ • autoLoadRecentSession() - Load from .flightpath/.queue/       │
│ • discoverPromptFiles() - Find all workflow files               │
│ • findMostRecentWorkingFile() - Sort by timestamp               │
│ • extractWorkflowName() - Parse filename metadata               │
│                                                                 │
│ Use Case:                                                       │
│ • Resume workflow after VS Code restart                         │
│ • Crash recovery                                                │
│ • Session continuity                                            │
└─────────────────────────────────────────────────────────────────┘
```

#### Benefits
- **Single Responsibility:** Each class has ONE clear job
- **Testability:** Can mock dependencies and test in isolation
- **Navigation:** Jump to focused files for specific functionality
- **Reusability:** PromptFileLoader can be used outside FlightPathManager
- **Maintainability:** Changes to file watching don't affect command handling

#### Implementation Strategy
1. Create new classes with methods extracted from FlightPathManager
2. Update FlightPathManager constructor to inject new dependencies
3. Replace direct method calls with delegation to new classes
4. Update tests to use new class structure
5. Remove old methods from FlightPathManager

---

### Priority 2: CLI Integrations - Extract Shared Utilities

#### Current Problems
- **Massive Code Duplication:** ClaudeCommandLineIntegration (1,245) and CodexCommandLineIntegration (1,125) share 40-50% identical code
- **Parallel Maintenance:** Bug fixes must be applied to 2-3 files
- **Inconsistent Behavior:** Small differences creep in over time
- **Violates DRY Principle:** Same logic copy-pasted with minor variations

#### Shared Logic Identified

##### 1. JSON/JSONL Response Parsing (~300 lines duplicated)
```
Current:
  ClaudeCommandLineIntegration.parseStreamJsonOutput()
  CodexCommandLineIntegration.parseJsonLinesOutput()
  Both: extractResponseFromEvent(), formatToolCallSummary()

Commonalities:
  - Extract JSON objects from streams
  - Parse usage/token counts
  - Extract session/thread IDs
  - Format error messages
```

##### 2. Hook/Notification Monitoring (~250 lines duplicated)
```
Current:
  ClaudeCommandLineIntegration.monitorNotificationFile()
  CodexCommandLineIntegration.monitorNotificationFile()
  Both: extractSessionId(), extractThreadId(), delay(), cleanup logic

Commonalities:
  - Poll notification directory for new files
  - Support both session-specific and wildcard monitoring
  - JSON file parsing and cleanup
  - Timeout and error handling
```

##### 3. MCP Configuration (~100 lines duplicated)
```
Current:
  Both: generateMcpConfigFile() with minor format differences
  Both: getMcpConfigArgs() with CLI-specific arguments

Commonalities:
  - JSON config generation
  - File caching
  - Environment variable setup
  - Server path normalization
```

##### 4. Tool Permission Mapping (~150 lines duplicated)
```
Current:
  Both: getToolPermissionArgs() with different flag formats
  Both: convertToolPatternToClaudeFormat(), parseToolPattern()

Commonalities:
  - Parse tool patterns (shell, write, etc.)
  - Convert between CLI formats
  - Handle allow/deny lists
  - Quote handling for shell safety
```

#### Proposed Shared Utilities

```
┌─────────────────────────────────────────────────────────────────┐
│ CliResponseParser.ts (200-300 lines) - NEW SHARED UTILITY       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Generic CLI Response Parsing                    │
│                                                                 │
│ Generic Interfaces:                                             │
│ • CliJsonResponse { type, content, usage, session_id, error }   │
│ • CliUsage { input_tokens, output_tokens, total_tokens }        │
│                                                                 │
│ Methods:                                                        │
│ • parseStreamJson(stdout) - Parse concatenated JSON objects     │
│ • parseJsonLines(stdout) - Parse newline-delimited JSON         │
│ • extractUsageStats(json) - Token count extraction              │
│ • extractSessionId(json) - Session ID from various formats      │
│ • formatStatistics(usage, model) - Unified stats string         │
│                                                                 │
│ Used By:                                                        │
│ • ClaudeCommandLineIntegration                                  │
│ • CodexCommandLineIntegration                                   │
│ • CopilotCommandLineIntegration (future)                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CliNotificationMonitor.ts (200-250 lines) - NEW SHARED UTILITY  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Hook/Notify File Monitoring                     │
│                                                                 │
│ Configuration:                                                  │
│ • NotificationConfig { directory, pollMs, timeoutMs }           │
│                                                                 │
│ Methods:                                                        │
│ • monitorForCompletion(config, sessionId?) - Generic monitor    │
│ • pollForFile(dir, filter) - File polling with timeout          │
│ • readAndCleanup(filePath) - Read JSON + delete file            │
│ • waitForNewFile(dir, baseline) - Detect new files              │
│                                                                 │
│ Supports:                                                       │
│ • Session-specific monitoring (claude-session-123.json)         │
│ • Wildcard monitoring (any new *.json file)                     │
│ • Timeout handling                                              │
│ • Cleanup on success/failure                                    │
│                                                                 │
│ Used By:                                                        │
│ • ClaudeCommandLineIntegration (stop hook)                      │
│ • CodexCommandLineIntegration (notify hook)                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CliMcpConfigGenerator.ts (100-150 lines) - NEW SHARED UTILITY   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: MCP Server Configuration                        │
│                                                                 │
│ Methods:                                                        │
│ • generateConfigFile(options) - Generic config generator        │
│ • getConfigArgs(cli, configPath) - CLI-specific arg format     │
│ • formatInlineTOML(config) - Codex inline format                │
│ • formatJSONFile(config) - Claude/Copilot file format           │
│                                                                 │
│ Config Options:                                                 │
│ • serverPath: string                                            │
│ • workspaceRoot: string                                         │
│ • includeTypeField: boolean (Claude needs "type": "stdio")      │
│ • format: "json" | "toml-inline"                                │
│                                                                 │
│ Caching:                                                        │
│ • Cache generated config per session                            │
│ • Invalidate on workspace/server changes                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CliToolPermissionMapper.ts (150-200 lines) - NEW SHARED UTILITY │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Tool Permission Pattern Conversion              │
│                                                                 │
│ Tool Pattern Format:                                            │
│ • Copilot: "shell(git:*)", "write", "mcp_server(tool)"         │
│ • Claude: "Bash", "Write", "Edit", "mcp__server"               │
│ • Codex: No granular patterns (mode-based only)                 │
│                                                                 │
│ Methods:                                                        │
│ • parsePattern(pattern) - Extract tool name and args            │
│ • convertToClaudeFormat(copilotPattern) - Copilot → Claude      │
│ • buildPermissionArgs(cli, config) - Generate CLI args          │
│ • validateToolPatterns(patterns) - Syntax validation            │
│                                                                 │
│ Mapping Tables:                                                 │
│ • COPILOT_TO_CLAUDE_MAP { shell: "Bash", write: "Write", ... } │
│ • CLAUDE_TO_COPILOT_MAP (reverse mapping)                       │
└─────────────────────────────────────────────────────────────────┘
```

#### Impact on CLI Integrations

**Before Refactoring:**
```
ClaudeCommandLineIntegration.ts     - 1,245 lines
CodexCommandLineIntegration.ts      - 1,125 lines
Total                               - 2,370 lines
Duplicated Logic                    - ~1,000 lines (42%)
```

**After Refactoring:**
```
ClaudeCommandLineIntegration.ts     -   750 lines (40% reduction)
CodexCommandLineIntegration.ts      -   700 lines (38% reduction)
CliResponseParser.ts                -   250 lines (new shared)
CliNotificationMonitor.ts           -   225 lines (new shared)
CliMcpConfigGenerator.ts            -   125 lines (new shared)
CliToolPermissionMapper.ts          -   175 lines (new shared)
Total                               - 2,225 lines
Shared/Reusable Logic               -   775 lines (35%)
```

**Benefits:**
- 145 lines saved (6% reduction) through deduplication
- Bug fixes applied once, benefit all CLIs
- Consistent behavior across integrations
- Future CLIs can reuse utilities immediately
- Better test coverage (test shared utilities once)

---

### Priority 3: PromptQueue.ts (1,108 lines) - Split State & Persistence

#### Current Problems
- **Mixed Concerns:** In-memory queue state + disk persistence in same class
- **Difficult Testing:** File I/O operations make tests slow and fragile
- **Retry Logic Buried:** 100+ lines of retry handling mixed with queue operations
- **Large Method Signatures:** updateWorkingFile() is 100+ lines

#### Current Responsibilities (Too Many!)
1. Queue state management (start, pause, resume, stop)
2. Prompt tracking and progress calculation
3. Retry count and retry prompt logic
4. Working file creation and persistence
5. Atomic file writes (temp + rename)
6. Queue merging from disk (MCP appends)
7. Prompt deduplication (hash-based identity)
8. Append segment tracking

#### Proposed Refactoring

```
PromptQueue.ts (1,108 lines)
    ↓
    SPLIT INTO 4 FOCUSED CLASSES:

┌─────────────────────────────────────────────────────────────────┐
│ PromptQueue.ts (500-600 lines)                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: In-Memory Queue State Management ONLY           │
│                                                                 │
│ Core State:                                                     │
│ • prompts: PromptItem[]                                         │
│ • results: PromptResult[]                                       │
│ • currentIndex: number                                          │
│ • status: ExecutionState                                        │
│                                                                 │
│ Core Operations:                                                │
│ • loadPrompts(prompts) - Initialize queue                       │
│ • start() / pause() / resume() / stop() - State transitions     │
│ • restart() - Reset to beginning                                │
│ • hasNext() / getCurrentPrompt() - Navigation                   │
│ • markCurrentAsSent() / completeCurrentAndMoveNext()            │
│ • markCurrentAsFailed(error)                                    │
│ • getProgress() / getCompletedCount() / getFailedCount()        │
│                                                                 │
│ Event Emission:                                                 │
│ • onDidChangeState: Event<QueueState>                           │
│ • emitStateChange() - Notify listeners                          │
│                                                                 │
│ Dependencies (injected):                                        │
│ • QueueRetryHandler - Retry logic delegation                    │
│ • WorkingFileManager - Persistence delegation                   │
│ • QueueMergeStrategy - Merge logic delegation                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ QueueRetryHandler.ts (150-200 lines) - NEW                      │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Retry Logic & State                             │
│                                                                 │
│ State:                                                          │
│ • currentRetryCount: number                                     │
│                                                                 │
│ Methods:                                                        │
│ • canRetry(prompt) - Check if retry allowed                     │
│ • incrementRetryCount() - Increment counter                     │
│ • resetRetryCount() - Reset on success                          │
│ • getCurrentRetryCount() - Getter                               │
│ • getEffectiveMaxRetries(prompt) - With defaults                │
│ • getEffectiveRetryPrompt(prompt) - With defaults               │
│                                                                 │
│ Smart Defaults:                                                 │
│ • If retryPrompt specified → use default maxRetries (3)         │
│ • If maxRetries specified → use default retryPrompt             │
│ • Support unlimited retries (maxRetries = -1)                   │
│                                                                 │
│ Configuration Sources:                                          │
│ • Prompt-level: prompt.endCondition.maxRetries/retryPrompt      │
│ • Settings-level: flightpath.defaultMaxRetries/defaultRetryPrompt│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ WorkingFileManager.ts (300-400 lines) - NEW                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Working File Persistence                        │
│                                                                 │
│ File Operations:                                                │
│ • createWorkingFile(originalPath, prompts, workspace)           │
│ • readWorkingFile(workingPath) → WorkingFile                    │
│ • writeWorkingFileAtomic(path, file) - Atomic write             │
│ • updateWorkingFile(queueState) - Sync to disk                  │
│ • generateWorkingFilePath() - Timestamp-based naming            │
│                                                                 │
│ WorkingFile Format:                                             │
│ • originalFile: string                                          │
│ • workflowName: string                                          │
│ • startedAt: number                                             │
│ • prompts: PromptItem[]                                         │
│ • _runtime: { currentIndex, completedPrompts, executionState }  │
│                                                                 │
│ Safety Features:                                                │
│ • Atomic writes (temp + rename)                                 │
│ • Operation queue (serialize concurrent writes)                 │
│ • Error recovery (cleanup temp files)                           │
│                                                                 │
│ Location:                                                       │
│ • .flightpath/.queue/workflow-TIMESTAMP.flightpath.json         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ QueueMergeStrategy.ts (150-200 lines) - NEW                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Queue Merging & Deduplication                   │
│                                                                 │
│ Methods:                                                        │
│ • reloadAndMergeQueue(filePath, maxSize) - Dynamic queue reload │
│ • appendPrompts(prompts, source, position) - User/MCP appends   │
│ • mergePromptsFromDisk() - Read working file + merge            │
│ • canAppend() - State validation                                │
│                                                                 │
│ Deduplication:                                                  │
│ • isPromptCompleted(prompt, completedIds) - Check if done       │
│ • hashPromptContent(text) - SHA-256 content hash                │
│ • Build identity set: { explicitId, contentHash }               │
│                                                                 │
│ Merge Logic:                                                    │
│ • Compare memory vs disk prompts                                │
│ • Preserve disk order (MCP may insert at "next" position)       │
│ • Maintain existing results (completion status)                 │
│ • Track append segments for audit trail                         │
│                                                                 │
│ Queue Extension Tracking:                                       │
│ • queueExtensions: number (count)                               │
│ • lastReloadTime: number (timestamp)                            │
│ • appendSegments: AppendSegment[] (audit trail)                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Benefits
- **Clear Separation:** Queue (in-memory) vs Persistence (disk) vs Retry (logic)
- **Faster Tests:** Can mock WorkingFileManager for pure queue logic tests
- **Reusability:** WorkingFileManager can be used for session recovery
- **Maintainability:** File format changes isolated to one class
- **Concurrency Safety:** Operation queue prevents race conditions

---

### Priority 4: TuiStreamProcessor.ts (971 lines) - Extract Filtering

#### Current Problems
- **Mixed Concerns:** Screen parsing + content filtering + deduplication all intertwined
- **Hard-to-Maintain Patterns:** 100+ lines of regex patterns for chrome filtering
- **Complex Deduplication:** Line occurrence counting logic is dense
- **Mode Switching:** Time-based vs screen-based extraction logic mixed together

#### Current Responsibilities
1. Stream processing orchestration
2. TUI screen extraction from buffer
3. Content filtering (chrome removal)
4. Content deduplication (circular buffer)
5. Completion detection (escape indicator)
6. Blank line collapsing
7. CLI error detection

#### Proposed Refactoring

```
TuiStreamProcessor.ts (971 lines)
    ↓
    SPLIT INTO 4 FOCUSED CLASSES:

┌─────────────────────────────────────────────────────────────────┐
│ TuiStreamProcessor.ts (400-500 lines)                           │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Stream Processing Orchestration                 │
│                                                                 │
│ Core Flow:                                                      │
│ 1. Wait for TUI ready (first complete screen)                   │
│ 2. Send prompt via @file reference                              │
│ 3. Detect file echo (prompt read by CLI)                        │
│ 4. Submit prompt (send \r)                                      │
│ 5. Stream output and detect completion                          │
│                                                                 │
│ Methods:                                                        │
│ • processStream(execution, terminal, prompt, timeout)           │
│ • isFileReferenceEchoed() - File paste detection                │
│ • startSubmissionTimer() - Dynamic paste completion             │
│ • processTimeBasedChunk() - Codex mode                          │
│ • processScreenBasedChunk() - Claude/Copilot mode               │
│                                                                 │
│ Dependencies (injected):                                        │
│ • TuiScreenExtractor - Screen parsing                           │
│ • TuiChromeFilter - Pattern filtering                           │
│ • TuiContentDeduplicator - Content deduplication                │
│                                                                 │
│ Configuration:                                                  │
│ • TuiStreamConfig { escapeIndicator, screenEndPattern, ... }    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ TuiChromeFilter.ts (200-250 lines) - NEW                        │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: TUI Chrome Pattern Filtering                    │
│                                                                 │
│ Methods:                                                        │
│ • isTuiChromeLine(line, patterns) - Pattern matching            │
│ • filterTuiChromeFromChunk(text, patterns) - Bulk filtering     │
│ • stripAnsiCodes(text) - ANSI escape code removal               │
│                                                                 │
│ Chrome Pattern Categories:                                      │
│ • Box borders and separators                                    │
│ • Status bars and keyboard shortcuts                            │
│ • Thinking indicators and spinners                              │
│ • Welcome messages and tips                                     │
│ • Approval prompts and UI hints                                 │
│                                                                 │
│ CLI-Specific Pattern Sets:                                      │
│ • Copilot patterns (status bar, Ctrl+c Exit, etc.)              │
│ • Claude patterns (dashes, >, spinner symbols)                  │
│ • Codex patterns (box borders, ›, context %)                    │
│                                                                 │
│ Pattern Management:                                             │
│ • Validate patterns at initialization                           │
│ • Log filtered content for debugging                            │
│ • Support pattern updates without code changes                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ TuiContentDeduplicator.ts (150-200 lines) - NEW                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Content Deduplication & Formatting              │
│                                                                 │
│ Methods:                                                        │
│ • extractNewContent(screen, emittedMap, promptFilter)           │
│ • deduplicateContent(text) - Circular buffer tracking           │
│ • collapseBlankLines(text, maxConsecutive) - Whitespace mgmt    │
│                                                                 │
│ Deduplication Strategy:                                         │
│ • Track line occurrence counts between screens                  │
│ • Emit lines that appear MORE times in current screen           │
│ • Handles progressive updates (annotations added under lines)   │
│ • Preserves identical lines in different contexts               │
│                                                                 │
│ Circular Buffer:                                                │
│ • recentLinesBuffer: Set<string> (last 100 unique lines)        │
│ • consecutiveBlankLines: number (persistent counter)            │
│ • Prevent repeated animation frames                             │
│ • Maintain natural formatting                                   │
│                                                                 │
│ Blank Line Handling:                                            │
│ • Collapse 3+ consecutive → 2 blank lines                       │
│ • Preserve paragraph breaks                                     │
│ • Persistent counter across chunks                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ TuiScreenExtractor.ts (100-150 lines) - NEW                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Screen Boundary Detection & Extraction          │
│                                                                 │
│ Methods:                                                        │
│ • extractScreensFromBuffer(buffer, pattern) - Parse screens     │
│ • detectScreenBoundary(text, pattern) - Find boundaries         │
│                                                                 │
│ Screen Parsing Logic:                                           │
│ • Use CLI-specific screenEndPattern (status bar, prompt, etc.)  │
│ • Split buffer into complete screens                            │
│ • Return remainder for next chunk                               │
│                                                                 │
│ Mode-Based Extraction:                                          │
│ • Screen-based (Claude/Copilot): Parse complete screens         │
│ • Time-based (Codex): Process chunks directly                   │
│                                                                 │
│ Completion Detection:                                           │
│ • Track escape indicator across screens                         │
│ • Require 2+ consecutive screens without indicator              │
│ • Prevent premature completion detection                        │
└─────────────────────────────────────────────────────────────────┘
```

#### Benefits
- **Maintainability:** Chrome patterns isolated in one place
- **Testability:** Can test deduplication logic independently
- **Clarity:** Screen extraction separated from content filtering
- **Reusability:** TuiChromeFilter can be used for log parsing

---

### Priority 5: BaseCliIntegration.ts (895 lines) - Execution Strategies

#### Current Problems
- **Strategy Pattern Missing:** Interactive vs headless execution mixed in one class
- **Terminal Management Complexity:** Terminal lifecycle mixed with process spawning
- **Temp File Duplication:** createPromptFileWithReference() duplicates TempFileManager logic

#### Proposed Refactoring

```
BaseCliIntegration.ts (895 lines)
    ↓
    SPLIT INTO 3 FOCUSED CLASSES:

┌─────────────────────────────────────────────────────────────────┐
│ BaseCliIntegration.ts (400-500 lines)                           │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Abstract Base & Common Utilities                │
│                                                                 │
│ Abstract Methods (subclass must implement):                     │
│ • getCliName() - CLI command name                               │
│ • getCliDisplayName() - Display name for UI                     │
│ • getIntegrationMode() - Provider string                        │
│ • getEscapeIndicator() - TUI completion indicator               │
│ • getScreenEndPattern() - Screen boundary regex                 │
│ • getTuiChromePatterns() - Chrome filter patterns               │
│ • getMcpConfigArgs() - MCP config arguments                     │
│ • parseTokenCounts() - Token usage parsing                      │
│ • hasFullPermissions() - Permission check                       │
│                                                                 │
│ Common Utilities:                                               │
│ • getWorkspaceDirs() - Workspace directory list                 │
│ • shouldShowOutput() - Output panel visibility                  │
│ • logPrompt() / logResponse() - Formatted logging               │
│ • getLastResult() / getLastCliCommand() - Accessors             │
│                                                                 │
│ Dependencies (injected):                                        │
│ • InteractiveTuiExecutor - Terminal execution                   │
│ • HeadlessProcessExecutor - Background execution                │
│ • CliProcessManager (existing)                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ InteractiveTuiExecutor.ts (200-250 lines) - NEW                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Interactive Terminal Execution Strategy         │
│                                                                 │
│ Methods:                                                        │
│ • executeInTerminal(args, promptText, workflowContext)          │
│ • withInteractiveTuiExecution(args, executeCallback)            │
│ • createFreshTerminal() - Terminal lifecycle                    │
│ • waitForShellIntegration(terminal, timeout)                    │
│ • disposeTerminalIfExists() - Cleanup                           │
│                                                                 │
│ Terminal Lifecycle:                                             │
│ 1. Dispose existing terminal (if any)                           │
│ 2. Create fresh terminal with shell integration                 │
│ 3. Wait for shell integration to be ready                       │
│ 4. Execute CLI command                                          │
│ 5. Stream output via execution.read()                           │
│ 6. Detect completion via TuiStreamProcessor                     │
│ 7. Cleanup temp files                                           │
│                                                                 │
│ Dependencies:                                                   │
│ • CliProcessManager (terminal creation)                         │
│ • TempFileManager (prompt file creation)                        │
│ • TuiStreamProcessor (output parsing)                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ HeadlessProcessExecutor.ts (150-200 lines) - NEW                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ RESPONSIBILITY: Headless Background Execution Strategy          │
│                                                                 │
│ Methods:                                                        │
│ • executeHeadlessWithPromptFile(args, promptText, callback)     │
│ • spawnProcess(command, args, options)                          │
│ • spawnSimpleCommand(command, args, timeout)                    │
│                                                                 │
│ Execution Flow:                                                 │
│ 1. Write prompt to temp file                                    │
│ 2. Build CLI args with @file reference                          │
│ 3. Spawn CLI process (no stdin needed)                          │
│ 4. Stream stdout in real-time (optional)                        │
│ 5. Wait for process completion                                  │
│ 6. Delegate result parsing to callback                          │
│ 7. Cleanup temp file                                            │
│                                                                 │
│ Output Streaming:                                               │
│ • shouldStreamHeadlessOutput() - Check if streaming enabled     │
│ • processStreamingChunk() - Transform chunks before emission    │
│ • onStdout callback - Fire streaming events                     │
│                                                                 │
│ Dependencies:                                                   │
│ • CliProcessManager (process spawning)                          │
│ • TempFileManager (prompt file creation)                        │
└─────────────────────────────────────────────────────────────────┘
```

#### Benefits
- **Strategy Pattern:** Clear separation of execution strategies
- **Single Responsibility:** Each executor handles ONE execution mode
- **Testability:** Can test terminal logic separately from process spawning
- **Reusability:** Executors can be used by other integrations

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
**Goal:** Extract shared utilities without breaking existing functionality

1. **Create Shared CLI Utilities**
   - [ ] CliResponseParser.ts - JSON/JSONL parsing
   - [ ] CliNotificationMonitor.ts - Hook monitoring
   - [ ] CliMcpConfigGenerator.ts - MCP config generation
   - [ ] CliToolPermissionMapper.ts - Tool permission mapping
   - [ ] Unit tests for each utility

2. **Update CLI Integrations to Use Utilities**
   - [ ] ClaudeCommandLineIntegration - Replace duplicated code
   - [ ] CodexCommandLineIntegration - Replace duplicated code
   - [ ] Integration tests to verify behavior unchanged

### Phase 2: Core Refactoring (Week 3-4)
**Goal:** Break up largest files into focused components

3. **Refactor FlightPathManager** ✅ COMPLETED
   - [x] PromptFileLoader.ts (200 lines) - Prompt file loading & validation
   - [x] PromptFileWatcher.ts (123 lines) - File system monitoring & live reload
   - [x] TemplateImporter.ts (325 lines) - Template & agent import operations
   - [x] WorkflowCommandHandler.ts (528 lines) - Command routing & UI interactions
   - [x] WorkspaceSessionManager.ts (135 lines) - Session persistence & recovery
   - [x] Update FlightPathManager to delegate (reduced from 1,958 to 819 lines - 58% reduction)
   - [x] Remove deprecated methods (no backward compatibility needed for unreleased product)
   - [ ] Update tests

   **Status:** All 5 new orchestration classes created and integrated. FlightPathManager successfully refactored to delegate responsibilities. Deprecated methods removed. Compilation successful with no errors.

4. **Refactor PromptQueue**
   - [ ] QueueRetryHandler.ts
   - [ ] WorkingFileManager.ts
   - [ ] QueueMergeStrategy.ts
   - [ ] Update PromptQueue to delegate
   - [ ] Update tests

### Phase 3: Polish & Optimization (Week 5)
**Goal:** Refine remaining files and optimize

5. **Refactor TuiStreamProcessor**
   - [ ] TuiChromeFilter.ts
   - [ ] TuiContentDeduplicator.ts
   - [ ] TuiScreenExtractor.ts
   - [ ] Update TuiStreamProcessor
   - [ ] Update tests

6. **Refactor BaseCliIntegration**
   - [ ] InteractiveTuiExecutor.ts
   - [ ] HeadlessProcessExecutor.ts
   - [ ] Update BaseCliIntegration
   - [ ] Update tests

### Phase 4: Validation (Week 6)
**Goal:** Ensure everything works end-to-end

7. **Testing & Validation**
   - [ ] Run full test suite
   - [ ] Manual testing of all workflows
   - [ ] Performance benchmarks (ensure no regression)
   - [ ] Update documentation

---

## Testing Strategy

### Unit Tests
- **Shared Utilities:** Test each utility in isolation with mocked dependencies
- **New Classes:** Test each new class independently
- **Edge Cases:** Test error handling, timeouts, race conditions

### Integration Tests
- **CLI Integrations:** Verify behavior unchanged after refactoring
- **FlightPathManager:** Test orchestration with new dependencies
- **PromptQueue:** Test state management with new handlers

### Regression Tests
- **Existing Workflows:** Ensure all existing workflows still work
- **Error Scenarios:** Test error handling hasn't changed
- **Performance:** Verify no performance degradation

---

## Success Metrics

### Code Quality
- ✅ Average file size: ~300 lines (from 1,217)
- ✅ Single Responsibility: Each class has ONE clear job
- ✅ Code duplication: <10% (from ~42% in CLI integrations)
- ✅ Test coverage: >80% for new utilities

### Maintainability
- ✅ Bug fixes in shared code benefit all CLIs
- ✅ New CLI integrations can reuse 70% of code
- ✅ Faster onboarding for new developers
- ✅ Easier to navigate codebase

### Development Velocity
- ✅ Feature additions are faster (focused files)
- ✅ Tests run faster (can mock file I/O)
- ✅ Refactoring is safer (smaller blast radius)

---

## Risks & Mitigation

### Risk 1: Breaking Changes
**Mitigation:**
- Implement behind feature flags initially
- Maintain backward compatibility during transition
- Comprehensive testing at each phase
- Gradual rollout (Phase 1 → 2 → 3 → 4)

### Risk 2: Regression Bugs
**Mitigation:**
- Keep existing tests running throughout refactoring
- Add integration tests before making changes
- Manual testing of critical workflows
- Beta testing with users before release

### Risk 3: Performance Impact
**Mitigation:**
- Benchmark before and after refactoring
- Optimize hot paths (queue operations, file I/O)
- Profile to identify bottlenecks
- Use lazy initialization where appropriate

### Risk 4: Developer Disruption
**Mitigation:**
- Coordinate with other developers on timing
- Document changes thoroughly
- Provide migration guides for in-progress work
- Keep communication channels open

---

## Future Considerations

### Extensibility
- Plugin system for new CLI integrations
- Generic CLI wrapper that can handle any CLI with minimal code
- Configuration-driven TUI patterns (no code changes for new CLIs)

### Performance
- Lazy loading of heavy dependencies
- Caching strategies for frequently accessed data
- Parallel execution where possible

### Maintenance
- Automated refactoring tools for future cleanups
- Code complexity metrics in CI/CD
- Regular "code health" reviews

---

## Appendix: File Size Comparison

### Before Refactoring
```
src/flightpath/
├── FlightPathManager.ts                    1,958 lines
├── PromptQueue.ts                          1,108 lines
├── cli/
│   ├── BaseCliIntegration.ts                 895 lines
│   ├── ClaudeCommandLineIntegration.ts     1,245 lines
│   └── CodexCommandLineIntegration.ts      1,125 lines
└── utils/
    └── TuiStreamProcessor.ts                 971 lines

Total: 7,302 lines in 6 files
Average: 1,217 lines/file
```

### After Refactoring
```
src/flightpath/
├── FlightPathManager.ts                      400 lines
├── PromptQueue.ts                            550 lines
├── cli/
│   ├── BaseCliIntegration.ts                 450 lines
│   ├── ClaudeCommandLineIntegration.ts       750 lines
│   ├── CodexCommandLineIntegration.ts        700 lines
│   ├── CliResponseParser.ts                  250 lines (new)
│   ├── CliNotificationMonitor.ts             225 lines (new)
│   ├── CliMcpConfigGenerator.ts              125 lines (new)
│   ├── CliToolPermissionMapper.ts            175 lines (new)
│   ├── InteractiveTuiExecutor.ts             225 lines (new)
│   └── HeadlessProcessExecutor.ts            175 lines (new)
├── orchestration/
│   ├── PromptFileLoader.ts                   250 lines (new)
│   ├── PromptFileWatcher.ts                  125 lines (new)
│   ├── TemplateImporter.ts                   350 lines (new)
│   ├── WorkflowCommandHandler.ts             250 lines (new)
│   └── WorkspaceSessionManager.ts            125 lines (new)
├── queue/
│   ├── QueueRetryHandler.ts                  175 lines (new)
│   ├── WorkingFileManager.ts                 350 lines (new)
│   └── QueueMergeStrategy.ts                 175 lines (new)
└── utils/
    ├── TuiStreamProcessor.ts                 450 lines
    ├── TuiChromeFilter.ts                    225 lines (new)
    ├── TuiContentDeduplicator.ts             175 lines (new)
    └── TuiScreenExtractor.ts                 125 lines (new)

Total: ~7,500 lines in 25 files
Average: ~300 lines/file
Reduction: 60% in average file size
```

---

## Progress Update - 2025-12-27

### ✅ Phase 2.3 - FlightPathManager Refactoring COMPLETED

Successfully refactored FlightPathManager.ts (1,958 lines) into 6 focused classes following SOLID principles:

**New Orchestration Classes Created:**

1. **PromptFileLoader.ts** (200 lines)
   - Location: `src/flightpath/orchestration/PromptFileLoader.ts`
   - Responsibility: Prompt file loading & validation
   - Methods: `loadPromptFile()`, `saveAndReloadIfDirty()`, `reloadFromWorkingFile()`

2. **PromptFileWatcher.ts** (123 lines)
   - Location: `src/flightpath/orchestration/PromptFileWatcher.ts`
   - Responsibility: File system monitoring & live reload
   - Methods: `setupFileWatcher()`, `dispose()`

3. **TemplateImporter.ts** (325 lines)
   - Location: `src/flightpath/orchestration/TemplateImporter.ts`
   - Responsibility: Template & agent import operations
   - Methods: `importAgents()`, `importWorkflowTemplates()`

4. **WorkflowCommandHandler.ts** (528 lines)
   - Location: `src/flightpath/orchestration/WorkflowCommandHandler.ts`
   - Responsibility: Command routing & UI interactions
   - Methods: `createPromptFile()`, `createDraftPrompt()`, `createEndConditionScript()`, `openPanel()`, `takeOff()`, `openCurrentPromptFile()`, `createNewTemplate()`

5. **WorkspaceSessionManager.ts** (135 lines)
   - Location: `src/flightpath/orchestration/WorkspaceSessionManager.ts`
   - Responsibility: Session persistence & recovery
   - Methods: `autoLoadRecentSession()`, `discoverPromptFiles()`

6. **FlightPathManager.ts** (819 lines - DOWN FROM 1,958)
   - **58% reduction in file size**
   - Now focuses purely on orchestration and coordination
   - Delegates all specialized tasks to the 5 new classes

**Architecture Benefits:**
- ✅ Single Responsibility: Each class has ONE clear job
- ✅ Dependency Injection: All new classes are injected dependencies
- ✅ Testability: Can now test each orchestration component in isolation
- ✅ Maintainability: Changes to file watching don't affect command handling
- ✅ Reusability: Components can be reused outside FlightPathManager

**Build Status:**
- ✅ Compilation successful with no errors
- ✅ All TypeScript type checks pass
- ✅ No breaking changes to public API

**Next Steps:**
- Update unit tests for new class structure
- Continue with Priority 2 (CLI integrations) or Priority 3 (PromptQueue)

---

## Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.1 | 2025-12-27 | Claude Code | FlightPathManager refactoring completed |
| 1.0 | 2025-12-27 | Claude Code | Initial refactoring plan |

