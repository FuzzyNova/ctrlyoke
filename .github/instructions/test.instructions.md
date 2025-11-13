---
applyTo: "src/test/**"
---

<purpose>
Mocha test suite. Minimal coverage (pre-release, features prioritized over tests).
</purpose>

<testFiles>
- `extension.test.ts` - Basic sample test (placeholder)
- `flightpath.test.ts` - Future FlightPath core logic tests
- `runTest.ts` - Test runner configuration
- `suite/index.ts` - Mocha test suite setup
</testFiles>

<testPatterns>
**Unit tests (when implemented):**
- Mock VS Code API using test doubles
- Test pure functions and business logic in isolation
- Fast execution (no I/O, no timers)
- Examples: PromptFileParser validation, ValidationUtils

**Integration tests (when implemented):**

- Use VS Code Extension Development Host
- Test actual extension API interactions
- Test command registration and execution
- Examples: FlightPathManager command handling, CopilotIntegration initialization

**Test organization:**

- One test file per source file (e.g., `PromptFileParser.test.ts`)
- Group related tests in `suite()` blocks
- Use descriptive test names: "should [expected behavior] when [condition]"
  </testPatterns>

<testingChallenges>
**Copilot integration testing:**
- Cannot easily mock Copilot CLI (external process)
- Cannot reliably test chat window automation (UI interactions)
- Focus on testing integration _setup_ and _configuration_, not actual Copilot responses
- Use test doubles for CopilotIntegration in higher-level tests

**Async operation testing:**

- Many operations are async (file I/O, process spawning, polling)
- Use async/await in test functions
- Set reasonable timeouts (Mocha default: 2000ms, may need longer)
- Clean up resources (kill processes, close files) in afterEach()

**VS Code API mocking:**

- vscode module cannot be imported outside Extension Development Host
- Use dependency injection to enable testing
- Alternative: Test in Extension Development Host (slower but more realistic)
  </testingChallenges>

<coverageGoals>
**High priority:**
- PromptFileParser: Schema validation, format normalization
- ValidationUtils: Type validation, error formatting
- PromptQueue: State transitions, progress tracking
- EndConditionEvaluator: Script execution, timeout handling

**Medium priority:**

- FileSystemUtils: File operations, watching
- StatusBarManager: State visualization
- PromptCompletionProvider: Completion item generation

**Low priority (integration heavy):**

- FlightPathManager: Full workflow execution
- CopilotIntegration: Actual Copilot interaction
- CLI/Chat integrations: Real automation (covered by manual testing)
  </coverageGoals>

<runningTests>
```bash
npm test                    # Run all tests
npm run watch              # Watch mode during development
```

**Test runner:**

- Uses @vscode/test-electron
- Launches Extension Development Host
- Runs tests in VS Code environment
- Closes automatically after completion
  </runningTests>

<testingPhilosophy>
**Pre-release status** means testing is lower priority than feature completeness. As extension stabilizes, add tests incrementally:

1. Start with pure functions (validation, parsing)
2. Add unit tests for stateful components (queue, evaluator)
3. Add integration tests for workflows
4. Add E2E tests for user scenarios

**Don't block feature development for test coverage** - Build tests when patterns stabilize and breaking changes become costly.
</testingPhilosophy>

<relatedFiles>
- `../../package.json` - Test scripts and Mocha configuration
- `../extension.ts` - Extension entry point (activate/deactivate functions tested)
- All source files in `src/` - Tested by corresponding test files
</relatedFiles>
