---
applyTo: "src/test/**"
---

<purpose>
Comprehensive Mocha test suite with unit and integration tests. Covers core business logic, state management, parsing, validation, and CLI integration.
</purpose>

<testStructure>
**Unit Tests** (src/test/*.test.ts):
- `promptFileParser.test.ts` (303 lines) - JSON/YAML parsing, schema validation, file path resolution
- `validationUtils.test.ts` (474 lines) - Security validation, script path validation, end condition validation
- `promptQueue.test.ts` (763 lines) - State machine, lifecycle, pause/resume, dynamic queue extension
- `endConditionEvaluator.test.ts` (374 lines) - Script execution, timeout handling, retry logic with template substitution
- `promptIdentity.test.ts` (276 lines) - Content hashing, duplicate detection, instruction injection logic
- `flightpath.test.ts` (78 lines) - Basic component instantiation and integration
- `extension.test.ts` (12 lines) - Placeholder sample test

**Integration Tests** (src/test/integration/\*.test.ts):

- `cli.integration.test.ts` (99 lines) - Extension activation, command registration, CLI mode validation
- `chat.integration.test.ts` (62 lines) - Chat commands, file attachment, configuration
- `token-parsing.test.ts` (90 lines) - Token count parsing for Copilot/Claude CLI output
- `workflow.integration.test.ts` (27 lines) - End-to-end workflow execution (minimal)

**Test Infrastructure:**

- `runTest.ts` - @vscode/test-electron runner configuration
- `suite/index.ts` - Mocha test suite setup (TDD style, glob pattern: `**/**.test.js`)
- `fixtures/` - Test prompt files (JSON/YAML/Markdown), invalid files for error testing

**Test organization:**

- One test file per source module
- Nested `suite()` blocks for logical grouping
- Descriptive test names: "should [expected behavior] when [condition]"
- TDD style (Mocha UI: 'tdd')
  </testStructure>

<testCoverage>
**Core logic fully tested:** PromptFileParser, ValidationUtils, PromptQueue, EndConditionEvaluator, PromptIdentity
**Partial integration tests:** CLI/Chat setup, token parsing
**Manual testing only:** Full workflows, AI responses, UI components
</testCoverage>

<testingChallenges>
**AI integration:** Cannot mock CLI/Chat; test setup only, manual for responses
**Async:** Use async/await, set timeouts (30000ms for activation), cleanup resources
**VS Code API:** Tests via @vscode/test-electron, access real APIs, check extension.isActive
**Fixtures:** `src/test/fixtures/`, navigate from `out/test`: `path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'prompts')`
</testingChallenges>

<keyPatterns>
**State machines:** Test all transitions, edge cases, dynamic extension, enforcement limits
**Security:** Directory traversal, shell injection, command injection (test reject + accept)
**Parsers:** Format normalization, schema validation errors, file resolution
**Retry logic:** Template substitution, maxRetries, timeout, exit codes
**Identity:** Hash consistency, normalization, deduplication, injection logic
</keyPatterns>

<runningTests>
`npm test` → @vscode/test-electron → loads extension → Mocha discovers `**/**.test.js` → runs in TDD mode
**Debugging:** F5 (Extension Development Host), set breakpoints in TypeScript
**Watch mode:** `npm run watch` for rapid feedback
</runningTests>

<testingPhilosophy>
**Pre-release status:** Comprehensive unit tests for core logic. Integration tests for setup only. Manual testing for AI/UI.
**Adding tests:** Create `<module>.test.ts`, use `suite()`/`test()`, mock dependencies, cleanup resources, run `npm test` before committing.
</testingPhilosophy>

<relatedFiles>
- `../../package.json` - Test scripts and Mocha configuration
- `../extension.ts` - Extension entry point (activate/deactivate functions tested)
- All source files in `src/` - Tested by corresponding test files
</relatedFiles>
