---
applyTo: "src/test/**"
---

<purpose>
Comprehensive Mocha test suite covering core business logic, state management, parsing, validation, CLI/Chat integration, and utility functions.
</purpose>

<testStructure>
**Root-Level Unit Tests** (src/test/*.test.ts):
- `promptFileParser.test.ts` (335 lines) - JSON/YAML parsing, schema validation, file path resolution
- `validationUtils.test.ts` (473 lines) - Security validation, script path validation, end condition validation
- `promptQueue.test.ts` (769 lines) - State machine, lifecycle, pause/resume, dynamic queue extension
- `endConditionEvaluator.test.ts` (373 lines) - Script execution, timeout handling, retry logic with template substitution
- `promptIdentity.test.ts` (275 lines) - Content hashing, duplicate detection, instruction injection logic
- `flightpath.test.ts` (101 lines) - Component instantiation and integration
- `chatSessionParser.test.ts` (474 lines) - Chat session file parsing, UniversalCliOutput conversion
- `agentExpander.test.ts` - Agent file expansion and context injection logic
- `promptFileSplitter.test.ts` (420 lines) - Large prompt splitting logic (token/line limits)
- `retryUtils.test.ts` (321 lines) - Retry with backoff, permanent failures, custom delays
- `SessionValidator.test.ts` (125 lines) - Session ID validation (UUID for Copilot/Claude, thread_ for Codex)
- `extension.test.ts` (15 lines) - Placeholder sample test

**Unit Tests** (src/test/unit/\*.test.ts):

- `PropertyResolver.test.ts` (405 lines) - Three-tier property resolution (prompt → workflow → settings)
- `SessionResolver.test.ts` (495 lines) - Session ID resolution, cross-harness validation, auto-resume logic
- `CliOutputFormatter.test.ts` (618 lines) - Universal CLI output formatting for dashboard display

**Integration Tests** (src/test/integration/\*.test.ts):

- `cli.integration.test.ts` (98 lines) - Extension activation, command registration, CLI mode validation
- `chat.integration.test.ts` (75 lines) - Chat commands, file attachment, configuration
- `token-parsing.test.ts` (90 lines) - Token count parsing for Copilot/Claude CLI output
- `workflow.integration.test.ts` (27 lines) - End-to-end workflow execution (minimal)

**CLI Parser Tests** (src/test/suite/cli/\*.test.ts):

- `LogParsers.test.ts` (1474 lines) - Comprehensive tests for all three harness log parsers:
  - ClaudeLogParser (JSONL format from ~/.claude/projects/)
  - CopilotLogParser (flat file + subdirectory formats)
  - CodexLogParser (nested payload structure in date-based directories)
  - Coverage: response extraction, completion detection, session ID extraction, session discovery, error handling

**Test Infrastructure:**

- `runTest.ts` - @vscode/test-electron runner configuration
- `suite/index.ts` - Mocha test suite setup (TDD style, glob pattern: `**/**.test.js`)
- `fixtures/` - Test prompt files (JSON/YAML/Markdown), invalid files for error testing

**Test Organization:**

- One test file per source module
- Nested `suite()` blocks for logical grouping
- Descriptive test names: "should [expected behavior] when [condition]"
- TDD style (Mocha UI: 'tdd')
- Total: ~7,700 lines across 19 test files
  </testStructure>

<testCoverage>
**Fully Tested:**
- Core parsing: PromptFileParser, PromptFileSplitter
- Validation: ValidationUtils, SessionValidator
- State management: PromptQueue, PromptIdentity
- Execution: EndConditionEvaluator, RetryUtils
- CLI parsers: ClaudeLogParser, CopilotLogParser, CodexLogParser
- Utilities: PropertyResolver, SessionResolver, CliOutputFormatter
- Chat integration: ChatSessionParser

**Partial Coverage:**

- CLI/Chat setup and command registration
- Token parsing for CLI output

**Manual Testing Only:**

- Full workflows with AI responses
- UI components (dashboard, settings webview)
- Real CLI/Chat interactions
  </testCoverage>

<testingChallenges>
**AI Integration:** Cannot mock real CLI/Chat responses; test setup/parsing only, manual for full workflows
**Async Operations:** Use async/await, set timeouts (30000ms for activation), cleanup resources in teardown
**VS Code API:** Tests run via @vscode/test-electron with real API access, check extension.isActive
**Fixtures:** Located in `src/test/fixtures/`, navigate from `out/test` using relative paths
**Temp Files:** CleanLogParsers and other tests create temp files; ensure cleanup in teardown
</testingChallenges>

<keyPatterns>
**Harness Terminology:** Use `Harness` enum (CopilotCli, CopilotChat, ClaudeCli, CodexCli), not "provider"
**Property Resolution:** Test three-tier precedence (prompt → workflow → VS Code settings)
**Session Management:** Validate cross-harness references, UUID vs thread_ formats, auto-resume logic
**State Machines:** Test all transitions, edge cases, dynamic extension, limit enforcement
**Security:** Directory traversal, shell injection, command injection (test both reject and accept cases)
**Parsers:** Format normalization, schema validation errors, file path resolution
**Retry Logic:** Template substitution, maxRetries, timeout handling, exit codes
**Identity:** Hash consistency, normalization, deduplication, instruction injection logic
**CLI Parsers:** Multi-format support, session discovery, completion detection, error recovery
</keyPatterns>

<runningTests>
`npm test` → @vscode/test-electron → loads extension → Mocha discovers `**/**.test.js` → runs in TDD mode
**Debugging:** F5 (Extension Development Host), set breakpoints in TypeScript
**Watch Mode:** `npm run watch` for rapid compilation feedback
**Coverage:** Comprehensive unit tests for business logic, integration tests for setup/glue code
</runningTests>

<testingPhilosophy>
**Pre-Release Status:** Comprehensive unit tests for core logic. Integration tests for setup/registration. Manual testing for AI/UI interactions.
**Adding Tests:** Create `<module>.test.ts`, use `suite()`/`test()`, mock dependencies when possible, cleanup resources in teardown, run `npm test` before committing.
**TDD Approach:** Write tests first when adding new logic modules, validate all edge cases and error conditions.
</testingPhilosophy>

<relatedFiles>
- `../../package.json` - Test scripts and Mocha configuration
- `../extension.ts` - Extension entry point (activate/deactivate)
- `../types/FlightPathTypes.ts` - Core types including Harness enum
- `../types/CliOutputTypes.ts` - Universal CLI output types
- All source files in `src/` - Tested by corresponding test files
</relatedFiles>
