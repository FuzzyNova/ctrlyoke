---
applyTo: "src/test/**"
---

<purpose>
Comprehensive Mocha test suite covering core business logic, state management, parsing, validation, workflow execution, harness integrations, and utility functions.
</purpose>

<testStructure>
**Root-Level Unit Tests** (`src/test/*.test.ts`):
- `promptFileParser.test.ts` (302 lines) - JSON/YAML parsing, schema validation, file path resolution
- `validationUtils.test.ts` (473 lines) - Security validation, script path validation, end condition validation
- `promptQueue.test.ts` (1005 lines) - State machine, lifecycle, pause/resume, dynamic queue extension
- `endConditionEvaluator.test.ts` (365 lines) - Script execution, timeout handling, retry logic with template substitution
- `promptIdentity.test.ts` (144 lines) - Content hashing, duplicate detection
- `flightpath.test.ts` (101 lines) - Component instantiation and integration
- `chatSessionParser.test.ts` (483 lines) - Chat session file parsing, UniversalCliOutput conversion
- `agentExpander.test.ts` (497 lines) - Agent file expansion and context injection logic
- `promptFileSplitter.test.ts` (430 lines) - Large prompt splitting logic (token/line limits)
- `retryUtils.test.ts` (321 lines) - Retry with backoff, permanent failures, custom delays
- `SessionValidator.test.ts` (164 lines) - Session ID validation (UUID for Copilot/Claude, thread_ for Codex)

**Unit Tests** (`src/test/unit/*.test.ts`):

- `PropertyResolver.test.ts` (405 lines) - Three-tier property resolution (prompt → workflow → settings)
- `SessionResolver.test.ts` (626 lines) - Session ID resolution, cross-harness validation, auto-resume logic
- `CliOutputFormatter.test.ts` (624 lines) - Universal CLI output formatting for dashboard display
- `CliEventMapper.test.ts` (249 lines) - Maps tool calls to CLI_EVENT_TYPES (BASH_COMMAND, FILE_WRITE, etc.), ToolClassification
- `CliMcpConfigGenerator.test.ts` (259 lines) - MCP JSON config generation for CLI harnesses
- `CliResponseParser.test.ts` (226 lines) - JSON object extraction from CLI stdout streams, CliUsage parsing
- `CliToolPermissionMapper.test.ts` (301 lines) - Copilot→Claude tool permission pattern mapping, COPILOT_TO_CLAUDE_MAP
- `ToolPermissionMappers.test.ts` (350 lines) - Copilot/Claude/Codex/OpenCode tool permission flag generation
- `FileReferenceParser.test.ts` (281 lines) - Parses `@file`, `@dir/`, `#file:`, `#sym:` references from prompt text
- `DiscoveryUtils.test.ts` (95 lines) - `formatDisplayName` (kebab→Title Case), `isAccessibleDirectory`
- `FileLockUtils.test.ts` (119 lines) - `withFileLock` concurrency safety for JSON file operations
- `TempFileManager.test.ts` (189 lines) - Temp file creation/cleanup inside workspace root (`.flightpath/tmp/`)
- `TypedEmitter.test.ts` (133 lines) - TypedEmitter fire/event pub-sub, subscription disposal
- `QueueOperations.test.ts` (109 lines) - `getQueueStatus` workflow name extraction, `appendToQueue`
- `OutputHistoryManager.test.ts` (118 lines) - Execution target persistence to `.flightpath/output-history.json`
- `PriorContext.test.ts` (380 lines) - HarnessIntegration prior-context building (buildPriorContextSection and helpers)
- `OpenCodeResponseParser.test.ts` (140 lines) - OpenCode JSON stream parsing (text, tool events, session ID, token usage)
- `OpenCodeNotificationMonitor.test.ts` (50 lines) - OpenCode hook config (returns none; OpenCode uses plugin file)
- `WorkflowExecutor.test.ts` (434 lines) - WorkflowExecutor execution context, prompt cycling, state transitions
- `WorkflowInstance.test.ts` (423 lines) - WorkflowInstance lifecycle and state management
- `WorkingFileManager.test.ts` (233 lines) - WorkingFile state (startWork, completeWork, reset)

**Integration Tests** (`src/test/integration/*.test.ts`):

- `cli.integration.test.ts` (93 lines) - Extension activation, command registration, CLI mode validation
- `chat.integration.test.ts` (75 lines) - Chat commands, file attachment, configuration
- `token-parsing.test.ts` (127 lines) - Token count parsing for Copilot/Claude CLI output

**Harness Log Parser Tests** (`src/test/suite/harness/*.test.ts`):

- `LogParsers.test.ts` (1747 lines) - All harness log parsers:
  - ClaudeLogParser (JSONL from `~/.claude/projects/`)
  - CopilotLogParser (flat file + subdirectory formats)
  - CodexLogParser (nested payload, date-based directories)
  - Coverage: response extraction, completion detection, session ID extraction, session discovery, error handling

**Test Infrastructure:**

- `runTest.ts` - @vscode/test-electron runner configuration
- `suite/index.ts` - Mocha suite setup (TDD style, glob: `**/**.test.js`)
- `fixtures/` - Test prompt files (JSON/YAML/Markdown), CLI output samples, invalid files for error testing

**Test Organization:**

- One test file per source module
- Nested `suite()` blocks for logical grouping
- Descriptive test names: "should [expected behavior] when [condition]"
- TDD style (Mocha UI: `'tdd'`)
- Total: ~12,100 lines across 36 test files
</testStructure>

<testCoverage>
**Fully Tested:**
- Core parsing: PromptFileParser, PromptFileSplitter, FileReferenceParser
- Validation: ValidationUtils, SessionValidator
- State management: PromptQueue, PromptIdentity, WorkflowInstance, WorkingFileManager
- Execution: EndConditionEvaluator, RetryUtils, WorkflowExecutor
- CLI harness shared: CliEventMapper, CliMcpConfigGenerator, CliResponseParser, CliToolPermissionMapper
- Tool permissions: Copilot/Claude/Codex/OpenCode mappers
- OpenCode: OpenCodeResponseParser, OpenCodeNotificationMonitor
- Log parsers: ClaudeLogParser, CopilotLogParser, CodexLogParser
- Utilities: PropertyResolver, SessionResolver, CliOutputFormatter, DiscoveryUtils, FileLockUtils, TempFileManager, TypedEmitter
- Queue helpers: QueueOperations, OutputHistoryManager
- HarnessIntegration: prior-context building
- Chat integration: ChatSessionParser, AgentExpander

**Partial Coverage:**

- CLI/Chat command registration and extension activation
- Token parsing for CLI output

**Manual Testing Only:**

- Full workflows with real AI responses
- UI components (dashboard, settings webview)
- Real CLI/Chat harness interactions
</testCoverage>

<testingChallenges>
**AI Integration:** Cannot mock real CLI/Chat responses; test setup/parsing only, manual for full workflows
**Async Operations:** Use async/await, set timeouts (30000ms for activation), cleanup resources in teardown
**VS Code API:** Tests run via @vscode/test-electron with real API access, check `extension.isActive`
**Fixtures:** Located in `src/test/fixtures/`, navigate from `out/test` using relative paths
**Temp Files:** LogParsers and other tests create temp dirs; always clean up in `teardown`/`afterEach`
**Private Methods:** Use test subclasses (e.g., `class TestHarness extends HarnessIntegration`) to expose protected/private helpers
</testingChallenges>

<keyPatterns>
**Harness Terminology:** Use `Harness` enum (CopilotCli, CopilotChat, ClaudeCli, CodexCli, OpenCodeCli), not "provider"
**Property Resolution:** Test three-tier precedence (prompt → workflow → VS Code settings)
**Session Management:** Validate cross-harness references, UUID vs `thread_` formats, auto-resume logic
**State Machines:** Test all transitions, edge cases, dynamic extension, limit enforcement
**Security:** Directory traversal, shell injection, command injection (test both reject and accept cases)
**Parsers:** Format normalization, schema validation errors, file path resolution
**Retry Logic:** Template substitution, maxRetries, timeout handling, exit codes
**CLI Harness Shared:** CliEventMapper classifies tool names → event types; CliResponseParser extracts JSON from raw stdout
**Tool Permissions:** Each harness mapper converts ToolPermissionConfig into CLI flags; test allow/deny/all/none modes
**OpenCode:** Uses plugin file for hooks (not hook config JSON); separate JSON stream format from Claude/Codex
</keyPatterns>

<runningTests>
`npm test` → @vscode/test-electron → loads extension → Mocha discovers `**/**.test.js` → runs in TDD mode
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
