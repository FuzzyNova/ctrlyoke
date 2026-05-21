---
applyTo: "src/test/**"
---

<purpose>
Comprehensive Mocha test suite covering core business logic, state management, parsing, validation, workflow execution, harness integrations, and utility functions.
</purpose>

<testStructure>
**Root-Level Unit Tests** (`src/test/*.test.ts`):
- `promptFileParser.test.ts` (308 lines) - JSON/YAML parsing, schema validation, file path resolution
- `validationUtils.test.ts` (473 lines) - Security validation, script path validation, end condition validation
- `promptQueue.test.ts` (1171 lines) - State machine, lifecycle, pause/resume, dynamic queue extension
- `endConditionEvaluator.test.ts` (364 lines) - Script execution, timeout handling, retry logic with template substitution
- `promptIdentity.test.ts` (82 lines) - Content hashing, duplicate detection
- `flightpath.test.ts` (100 lines) - Component instantiation and integration
- `chatSessionParser.test.ts` (483 lines) - Chat session file parsing, UniversalCliOutput conversion
- `agentExpander.test.ts` (497 lines) - Agent file expansion and context injection logic
- `contextExpander.test.ts` (382 lines) - Context expansion with @-references, file/directory resolution
- `promptFileSplitter.test.ts` (430 lines) - Large prompt splitting logic (token/line limits)
- `retryUtils.test.ts` (321 lines) - Retry with backoff, permanent failures, custom delays
- `SessionValidator.test.ts` (164 lines) - Session ID validation (UUID for Copilot/Claude, thread_ for Codex)

**Unit Tests** (`src/test/unit/*.test.ts`):

- `PropertyResolver.test.ts` (734 lines) - Three-tier property resolution (prompt → workflow → settings), hooks property resolution
- `SessionResolver.test.ts` (634 lines) - Session ID resolution, cross-harness validation, auto-resume logic
- `CliOutputFormatter.test.ts` (601 lines) - Universal CLI output formatting for dashboard display
- `CliEventMapper.test.ts` (249 lines) - Maps tool calls to CLI_EVENT_TYPES (BASH_COMMAND, FILE_WRITE, etc.), ToolClassification
- `CliMcpConfigGenerator.test.ts` (258 lines) - MCP JSON config generation for CLI harnesses
- `CliResponseParser.test.ts` (225 lines) - JSON object extraction from CLI stdout streams, CliUsage parsing
- `CliToolPermissionMapper.test.ts` (297 lines) - Copilot→Claude tool permission pattern mapping, COPILOT_TO_CLAUDE_MAP
- `ToolPermissionMappers.test.ts` (563 lines) - Per-mapper flag generation for Copilot/Claude/Codex/OpenCode/Qwen/Gemini + passthrough handling
- `HarnessToolPermissionMappers.test.ts` (928 lines) - All harness tool permission mappers with cross-mapper consistency checks
- `FileReferenceParser.test.ts` (339 lines) - Parses `@file`, `@dir/`, `#file:`, `#sym:` references from prompt text
- `FlightPathConfigService.test.ts` (258 lines) - FlightPathConfigService config reads/defaults, FileConfigBackend, settings seeding and FLIGHTPATH_SETTINGS_DEFAULTS
- `DiscoveryUtils.test.ts` (95 lines) - `formatDisplayName` (kebab→Title Case), `isAccessibleDirectory`
- `FileLockUtils.test.ts` (119 lines) - `withFileLock` concurrency safety for JSON file operations
- `TempFileManager.test.ts` (189 lines) - Temp file creation/cleanup inside the workspace root
- `TypedEmitter.test.ts` (133 lines) - TypedEmitter fire/event pub-sub, subscription disposal
- `QueueOperations.test.ts` (140 lines) - `getQueueStatus` workflow name extraction, `appendToQueue`
- `OutputHistoryManager.test.ts` (698 lines) - Timeline-backed workflow output history (manifest + events.jsonl), projection into WorkflowOutputHistory shape
- `PriorContext.test.ts` (806 lines) - HarnessIntegration prior-context building (buildPriorContextSection and helpers)
- `PromptFileLoader.test.ts` (318 lines) - PromptFileLoader.populateSettingsDefaults, settings seeding from VS Code config
- `SettingsJsonHooksTracker.test.ts` (232 lines) - Hook baseline capture, FlightPath hook injection/restoration tracking
- `SettingsJsonMcpTracker.test.ts` (51 lines) - `SettingsJsonMcpTracker` register/unregister MCP servers in harness config files, file cleanup on deactivation
- `OpenCodeResponseParser.test.ts` (140 lines) - OpenCode JSON stream parsing (text, tool events, session ID, token usage)
- `OpenCodeNotificationMonitor.test.ts` (37 lines) - OpenCode hook config (returns none; OpenCode uses plugin file)
- `CodexResponseParser.test.ts` (85 lines) - Codex JSONL response parsing (deduplication of agent text across item.started/completed events)
- `CodexCliProvider.test.ts` (103 lines) - Codex resume-subcommand suffix building and argument ordering relative to hook/permission flags
- `CompletionNotificationFactory.test.ts` (163 lines) - Workflow success/failure notification building, notification suppression modes
- `ContextReferenceBuilder.test.ts` (77 lines) - Context reference formatting, path quoting for spaces, `@file`/`#sym:` reference construction
- `FlightPathHostedServer.test.ts` (27 lines) - `HostedServerMessageFactory` webview message shape construction
- `HostedServiceWorkerScript.test.ts` (46 lines) - Service worker template rendering, badge message type injection
- `HostedWorkspaceViewerService.test.ts` (320 lines) - File/directory listing for hosted server, path traversal rejection, directory-first ordering
- `NotificationSettings.test.ts` (30 lines) - Notification settings defaults (phase 1 group defaults)
- `PtyProcessManager.test.ts` (34 lines) - PTY shell executable classification
- `RangeNotationParser.test.ts` (29 lines) - Range notation parsing (comma-separated numbers, hyphen ranges, deduplication)
- `WorkspaceSessionManager.test.ts` (61 lines) - Session discovery ordering by `lastModifiedAt`
- `WorkspaceSnapshotService.test.ts` (104 lines) - Workspace snapshot tracking for dirty/committed file state transitions
- `WorkflowExecutor.test.ts` (649 lines) - WorkflowExecutor execution context, prompt cycling, state transitions, finalStep phase handling
- `WorkflowInstance.test.ts` (1026 lines) - WorkflowInstance lifecycle, finalStep replay, runtime transitions, eager working file creation, append-and-continue
- `WorkflowOrchestrator.test.ts` (184 lines) - Startup auto-load gating (dashboard-ready + init coordination)
- `WorkflowStateMachine.test.ts` (276 lines) - State machine transitions with ordered event emission (previous/current snapshots)
- `WorkingFileManager.test.ts` (236 lines) - WorkingFile state (startWork, completeWork, reset)
- `WorkspaceInitializer.test.ts` (68 lines) - `WorkspaceInitializer.initializeIfNeeded`, directory creation and `.gitignore` generation
- `WorkflowStepSanitizer.test.ts` (150 lines) - Clipboard-safe step serialization/sanitization that strips transient runtime fields while preserving persistable prompt/script properties
- `CliArgParser.test.ts` (86 lines) - `parseArgString` CLI arg string tokenization (quoted args, edge cases)
- `CliExecutionRunner.test.ts` (289 lines) - CliExecutionRunner orchestrates headless/interactive execution lifecycle
- `CliExecutionSession.test.ts` (92 lines) - CliExecutionSession result/state container
- `CliFailureTracker.test.ts` (69 lines) - PTY exit classification, startup-stage failures, interactive abort state
- `CliIntegration.test.ts` (458 lines) - CliIntegration full integration with mock ICliProvider and PlatformAdapter
- `CliInteractiveStartupCoordinator.test.ts` (162 lines) - Session resume log seeking, startup coordination with log parsers
- `CliPromptPreparer.test.ts` (479 lines) - Fast-path/full-path prompt preparation, agent/skills content, slash commands
- `CliPromptRuntimeCoordinator.test.ts` (201 lines) - Runtime metadata (timing, harness) tracking during prompt execution
- `CliResponseCollector.test.ts` (271 lines) - CLI result building, session ID preference (parsed output over log discovery)
- `CliSessionResolverAdapter.test.ts` (123 lines) - Workflow properties and auto-resumed session ID resolution
- `CliTransportCoordinator.test.ts` (718 lines) - Headless/interactive prompt dispatch, PTY coordination, temp file cleanup
- `CliWatchSession.test.ts` (61 lines) - Run timestamp extraction and ordering helpers (`getHistoryRunTimestamp`, `isNewerHistoryRunPath`)
- `CopilotChatIntegration.test.ts` (106 lines) - Prior context building for the Chat harness
- `EndConditionHandler.test.ts` (345 lines) - EndConditionHandler integrating EndConditionEvaluator, PromptQueue, WorkflowStateMachine
- `ErrorUtils.test.ts` (64 lines) - `getErrorMessage` extraction from Error instances, strings, numbers, and unknown types
- `ModelConstants.test.ts` (200 lines) - Model display names, validation, context window sizes for Copilot/Claude/Qwen/Gemini
- `OutputCaptureBuffer.test.ts` (788 lines) - Event routing to dashboard sink, prompt start/complete lifecycle, status messages
- `RuntimeMode.test.ts` (58 lines) - `setRuntimeMode`/`isCli` switching between CLI and VS Code modes
- `TimelineRecorder.test.ts` (126 lines) - Timeline event recording and manifest file writing
- `TtlCache.test.ts` (246 lines) - TTL-based caching, expiry, refresh, and concurrent request deduplication
- `VarSubstitutor.test.ts` (235 lines) - `{{placeholder}}` substitution in prompt strings and end condition scripts
- `WebviewSettingsSync.test.ts` (386 lines) - `WebviewSettingsSync` settings sync from working file to webview via `WebviewMessageRouter`
- `promptPathUtils.test.ts` (90 lines) - `looksLikeFilePath`, `PROMPT_FILE_EXTENSIONS` constant validation

**Integration Tests** (`src/test/integration/*.test.ts`):

- `cli.integration.test.ts` (91 lines) - Extension activation, command registration, CLI mode validation
- `chat.integration.test.ts` (73 lines) - Chat commands, file attachment, configuration
- `token-parsing.test.ts` (127 lines) - Token count parsing for Copilot/Claude CLI output

**Harness Log Parser Tests** (`src/test/suite/harness/*.test.ts`):

- `LogParsers.test.ts` (2006 lines) - All harness log parsers:
  - ClaudeLogParser (JSONL from `~/.claude/projects/`)
  - CopilotLogParser (flat file + subdirectory formats)
  - CodexLogParser (nested payload, date-based directories)
  - OpenCodeLogParser (completion detection, session ID extraction)
  - Cross-Parser Compatibility (shared behavior across parsers)
  - Coverage: response extraction, completion detection, session ID extraction, session discovery, error handling

**Harness Hook Integration Tests** (`src/test/harness/*.test.ts`):

- `hooks.harness.test.ts` (381 lines) - Real CLI harness integration tests for hook event delivery:
  - Verifies stop, sessionStart, preToolUse, postToolUse, userPromptSubmit hooks fire correctly
  - Runs with `npm run test:harness` (not part of `npm test`)
  - Exit code 3 from CLI = harness not installed → test skipped
  - Requires compiled CLI (`npm run compile`) and authenticated harness
- `mcp.harness.test.ts` (120 lines) - MCP dynamic queue extension: verifies `flightpath_append_queue` tool appends steps that execute with verifiable side effects
- `workflow.harness.test.ts` (273 lines) - Multi-step sequential execution, end conditions, and retry loops using real CLI harnesses

**Test Infrastructure:**

- `runTest.ts` - @vscode/test-electron runner configuration
- `suite/index.ts` - Mocha suite setup (TDD style, glob: `**/**.test.js`)
- `fixtures/` - Test prompt files (JSON/YAML/Markdown), CLI output samples, invalid files for error testing

**Test Organization:**

- One test file per source module
- Nested `suite()` blocks for logical grouping
- Descriptive test names: "should [expected behavior] when [condition]"
- TDD style (Mocha UI: `'tdd'`)
- Total: 23,608 lines across 84 `*.test.ts` files
  </testStructure>

<testCoverage>
**Fully Tested:**
- Core parsing: PromptFileParser, PromptFileSplitter, FileReferenceParser, CliArgParser, promptPathUtils
- Validation: ValidationUtils, SessionValidator
- State management: PromptQueue, PromptIdentity, WorkflowInstance, WorkingFileManager, WorkflowStateMachine, WorkflowStepSanitizer clipboard serialization helpers
- Execution: EndConditionEvaluator, EndConditionHandler, RetryUtils, WorkflowExecutor
- Orchestration: WorkflowOrchestrator (startup auto-load gating), PromptFileLoader (settings defaults), TimelineRecorder, CliWatchSession helpers, WorkspaceInitializer
- CLI harness shared: CliEventMapper, CliMcpConfigGenerator, CliResponseParser, CliToolPermissionMapper, CliExecutionRunner, CliExecutionSession, CliFailureTracker, CliInteractiveStartupCoordinator, CliPromptPreparer, CliPromptRuntimeCoordinator, CliResponseCollector, CliSessionResolverAdapter, CliTransportCoordinator, CliIntegration (full integration), CodexCliProvider resume-subcommand ordering
- Tool permissions: Copilot/Claude/Codex/OpenCode/Qwen/Gemini mappers (ToolPermissionMappers + HarnessToolPermissionMappers)
- Hooks: SettingsJsonHooksTracker (baseline capture, injection tracking), SettingsJsonMcpTracker (MCP config register/unregister), PropertyResolver hooks resolution
- OpenCode: OpenCodeResponseParser, OpenCodeNotificationMonitor
- Codex: CodexResponseParser (agent text deduplication across item.started/completed events)
- Log parsers: ClaudeLogParser, CopilotLogParser, CodexLogParser, OpenCodeLogParser (+ cross-parser compatibility)
- Utilities: PropertyResolver, SessionResolver, CliOutputFormatter, DiscoveryUtils, FileLockUtils, TempFileManager, TypedEmitter, ErrorUtils, RuntimeMode, TtlCache, VarSubstitutor, ModelConstants, FlightPathConfigService, WebviewSettingsSync, RangeNotationParser
- Context: ContextExpander (@-reference resolution, file/directory expansion), ContextReferenceBuilder (reference formatting, path quoting)
- Queue helpers: QueueOperations, OutputHistoryManager
- HarnessIntegration: prior-context building, OutputCaptureBuffer event routing
- Chat integration: ChatSessionParser, AgentExpander, CopilotChatIntegration
- Hosted server: FlightPathHostedServer (message factory), HostedWorkspaceViewerService (file listing, path traversal rejection), HostedServiceWorkerScript (template rendering)
- Notifications: CompletionNotificationFactory (success/failure notification building), NotificationSettings (defaults)
- Session management: WorkspaceSessionManager (discovery ordering), WorkspaceSnapshotService (dirty/committed state tracking)
- PTY: PtyProcessManager (shell executable classification)

**Partial Coverage:**

- CLI/Chat command registration and extension activation
- Token parsing for CLI output
- Real harness hook delivery (requires installed CLI; `test:harness` suite)

**Manual Testing Only:**

- Full workflows with real AI responses
- UI components (dashboard, settings webview)
  </testCoverage>

<testingChallenges>
**AI Integration:** Cannot mock real CLI/Chat responses; test setup/parsing only, manual for full workflows
**Async Operations:** Use async/await, set timeouts (30000ms for activation), cleanup resources in teardown
**VS Code API:** Tests run via @vscode/test-electron with real API access, check `extension.isActive`
**Fixtures:** Located in `src/test/fixtures/`, navigate from `out/test` using relative paths
**Temp Files:** LogParsers and other tests create temp dirs; always clean up in `teardown`/`afterEach`
**Private Methods:** Use test subclasses (e.g., `class TestHarness extends HarnessIntegration`) to expose protected/private helpers
**Harness Hook Tests:** `src/test/harness/` tests invoke real CLIs; exit code 3 = not installed (skip); run separately with `npm run test:harness`
</testingChallenges>

<keyPatterns>
**Harness Terminology:** Use `Harness` enum (CopilotCli, CopilotChat, ClaudeCli, CodexCli, OpenCodeCli), not "provider"
**Property Resolution:** Test three-tier precedence (prompt → workflow → VS Code settings)
**Session Management:** Validate cross-harness references, UUID vs `thread_` formats, auto-resume logic
**State Machines:** Test all transitions, edge cases, dynamic extension, limit enforcement (WorkflowStateMachine emits previous+current snapshots on each transition)
**Security:** Directory traversal, shell injection, command injection (test both reject and accept cases)
**Parsers:** Format normalization, schema validation errors, file path resolution
**Retry Logic:** Template substitution, maxRetries, timeout handling, exit codes
**CLI Harness Shared:** CliEventMapper classifies tool names → event types; CliResponseParser extracts JSON from raw stdout; CliExecutionRunner delegates to headless/interactive path; CliTransportCoordinator manages PTY/spawn dispatch and temp file cleanup
**Tool Permissions:** Each harness mapper (Copilot/Claude/Codex/OpenCode/Qwen/Gemini) converts ToolPermissionConfig into CLI flags; test allow/deny/all/none modes; HarnessToolPermissionMappers covers cross-mapper consistency
**OpenCode:** Uses plugin file for hooks (not hook config JSON); separate JSON stream format from Claude/Codex
**OutputCaptureBuffer:** Routes prompt lifecycle events and CLI events to IDashboardSink; test start/complete/status-message callbacks separately
**RuntimeMode:** `setRuntimeMode`/`isCli` must be reset in `teardown` to avoid cross-test pollution
</keyPatterns>

<runningTests>
`npm test` → @vscode/test-electron → loads extension → Mocha discovers `**/**.test.js` → runs in TDD mode
`npm run test:harness` → runs real CLI harness hook integration tests (requires installed + authenticated harness)
**Debugging:** F5 (Extension Development Host), set breakpoints in TypeScript
**Watch Mode:** `npm run watch` for rapid compilation feedback
</runningTests>

<testingPhilosophy>
**Pre-Release Status:** Comprehensive unit tests for core logic. Integration tests for setup/registration. Manual testing for AI/UI interactions.
**Adding Tests:** Create `<module>.test.ts` in the appropriate directory, use `suite()`/`test()`, mock or stub dependencies, clean up resources in `teardown`/`afterEach`, run `npm test` before committing.
**Test Subclasses:** Extend abstract/protected classes (e.g., HarnessIntegration) to expose internals rather than changing visibility in production code.
</testingPhilosophy>

<relatedFiles>
- `../../package.json` - Test scripts and Mocha configuration
- `../extension.ts` - Extension entry point (activate/deactivate)
- `../types/FlightPathTypes.ts` - Core types including Harness enum
- `../types/DashboardConstants.ts` - CLI_EVENT_TYPES, EXECUTION_STATES, STEP_STATUS constants
- All source files in `src/` - Tested by corresponding test files
</relatedFiles>
