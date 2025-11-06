# FlightPath Automated Testing Strategy

## Current Test Coverage

### Existing Tests

#### 1. `extension.test.ts` - Placeholder Only
- **Status**: ⚠️ Not testing actual functionality
- **Coverage**: Basic sample test (array indexOf)
- **Action Required**: Replace with real extension tests

#### 2. `flightpath.test.ts` - Core Utilities (8 tests)

**PromptQueue Tests (4 tests):**
- ✅ Instantiation
- ✅ Initial state (idle, empty prompts/results)
- ✅ Loading prompts correctly
- ✅ Progress tracking (current/total/percentage)

**ValidationUtils Tests (3 tests):**
- ✅ Valid prompt item validation
- ✅ Invalid prompt item detection (missing fields)
- ✅ Script path validation (path traversal prevention)

**PromptFileParser Tests (1 test):**
- ✅ Instantiation

### Coverage Gaps (Priority Order)

Given the strategic decision to deprecate `CopilotChatIntegration` and focus on `CopilotCommandLineIntegration`, the following gaps are prioritized:

## Priority 1: Critical CLI Integration Tests

### CopilotCommandLineIntegration
**Status**: ❌ No test coverage (PRIMARY INTEGRATION METHOD)

**High Priority Tests:**

1. **CLI Availability Detection**
   - ✓ Detects installed Copilot CLI (`copilot --version`)
   - ✓ Handles missing CLI gracefully
   - ✓ Correct status transitions (initializing → ready/unavailable)

2. **Prompt Execution**
   - ✓ Builds correct command arguments
   - ✓ Sends prompt via stdin (not command-line args)
   - ✓ Applies configured model (`--model` flag)
   - ✓ Applies workspace directories (`--add-dir` flags)
   - ✓ Applies tool permissions (`--allow-all-tools`)
   - ✓ Handles timeout scenarios (default 5min)

3. **Output Parsing**
   - ✓ Correctly separates response text from statistics
   - ✓ Handles empty responses
   - ✓ Handles multi-line responses with newlines
   - ✓ Correctly identifies statistics section ("Total usage est:")

4. **Response Completion**
   - ✓ Fires responseCompleteEmitter with actual response text
   - ✓ Deterministic completion (no polling needed)
   - ✓ Response text available for end condition evaluation

5. **Error Handling**
   - ✓ Non-zero exit codes
   - ✓ Stderr output
   - ✓ Process spawn failures
   - ✓ Timeout handling

6. **Configuration Integration**
   - ✓ Reads `copilotCliModel` setting correctly
   - ✓ Reads `copilotCliAllowedDirs` setting
   - ✓ Reads `copilotCliToolPermissions` setting
   - ✓ Reads `showCliOutput` setting

### Testing Approach for CLI Integration

**Mock Strategy:**
```typescript
// Mock child_process.spawn to simulate CLI responses
// Avoid actual CLI calls in unit tests
// Use fixtures for realistic CLI output

const mockCopilotOutput = `Here's my response to your prompt.

Total usage est: 1,234 tokens, $0.012`;
```

**Integration Test Strategy:**
```typescript
// Optional: Real CLI tests (if CLI is available)
// Mark as integration tests that can be skipped
// Only run when COPILOT_CLI_INTEGRATION_TESTS env var is set
```

## Priority 2: Core Architecture Tests

### FlightPathManager
**Status**: ❌ No test coverage (ORCHESTRATOR)

**High Priority Tests:**

1. **Lifecycle Management**
   - ✓ Initializes all components correctly
   - ✓ Registers commands properly
   - ✓ Disposes resources on deactivation

2. **Workflow Execution**
   - ✓ Loads prompt file correctly
   - ✓ Executes prompts sequentially
   - ✓ Waits for Copilot initialization before starting
   - ✓ Pauses/resumes/cancels workflows correctly

3. **Integration Coordination**
   - ✓ Factory creates correct integration (CLI vs Chat)
   - ✓ Listens to Copilot status changes
   - ✓ Listens to response completion events
   - ✓ Updates status bar appropriately

4. **End Condition Handling**
   - ✓ Receives response text from CLI integration
   - ✓ Passes response text to EndConditionEvaluator
   - ✓ Handles end condition success/failure
   - ✓ Continues to next prompt on success
   - ✓ Stops workflow on failure (if configured)

5. **Error Recovery**
   - ✓ Handles prompt send failures
   - ✓ Handles end condition evaluation errors
   - ✓ Reports errors to user via notifications

### EndConditionEvaluator
**Status**: ❌ No test coverage (CRITICAL VALIDATION)

**High Priority Tests:**

1. **Script Path Resolution**
   - ✓ Resolves absolute paths
   - ✓ Resolves relative paths from workspace
   - ✓ Resolves paths from `.flightpath/` directory
   - ✓ Rejects paths with `..` traversal
   - ✓ Handles missing scripts gracefully

2. **Script Execution**
   - ✓ Executes Python scripts (`.py`)
   - ✓ Executes JavaScript scripts (`.js`, `.ts`)
   - ✓ Executes shell scripts (`.sh`, `.bat`, `.ps1`)
   - ✓ Passes response text via stdin or environment variable
   - ✓ Captures stdout/stderr correctly
   - ✓ Enforces timeout (default 30s)
   - ✓ Kills long-running processes

3. **Result Evaluation**
   - ✓ Compares script output to expected value
   - ✓ Handles exact string matches
   - ✓ Handles boolean returns (`true`/`false`)
   - ✓ Handles numeric comparisons
   - ✓ Reports evaluation duration

4. **Security**
   - ✓ Scripts cannot access parent directories
   - ✓ Scripts run in isolated processes
   - ✓ Scripts have limited execution time
   - ✓ Scripts cannot modify FlightPath state directly

5. **Template Generation**
   - ✓ `createSampleScript()` copies from templates correctly
   - ✓ Templates exist for all supported languages
   - ✓ Generated scripts are valid and executable

## Priority 3: Utility Tests

### FileSystemUtils
**Status**: ❌ No test coverage

**Tests Needed:**

1. **Directory Operations**
   - ✓ `ensureDirectory()` creates missing directories
   - ✓ `ensureDirectory()` handles existing directories
   - ✓ Recursive directory creation

2. **File Operations**
   - ✓ `readFile()` reads existing files
   - ✓ `readFile()` returns null for missing files
   - ✓ `writeFile()` creates files with content
   - ✓ `writeFile()` creates parent directories
   - ✓ `fileExists()` detects existing files

3. **File Discovery**
   - ✓ `findFiles()` finds matching files recursively
   - ✓ Respects `maxDepth` parameter
   - ✓ Handles inaccessible directories

4. **File Watching**
   - ✓ Registers watchers correctly
   - ✓ Fires change events on file modifications
   - ✓ Disposes watchers correctly

### PromptFileParser
**Status**: ⚠️ Minimal coverage (1 test)

**Additional Tests Needed:**

1. **Schema Validation**
   - ✓ Loads schema from bundled location
   - ✓ Validates single prompt format correctly
   - ✓ Validates multiple prompts format correctly
   - ✓ Rejects invalid JSON
   - ✓ Rejects missing required fields
   - ✓ Provides clear error messages

2. **File Format Normalization**
   - ✓ Normalizes single prompt to array format
   - ✓ Preserves multiple prompts format
   - ✓ Handles optional endCondition field

3. **File Discovery**
   - ✓ Discovers `.prompt.json` files
   - ✓ Discovers `.flightpath.json` files
   - ✓ Searches recursively in configured directory
   - ✓ Handles missing prompts directory

## Priority 4: UI/UX Tests (Lower Priority)

### StatusBarManager
**Status**: ❌ No test coverage

**Tests Needed:**
- Status bar item creation
- Status text updates based on state
- Click command registration
- Visibility toggling

## Testing Infrastructure Recommendations

### 1. Test Structure

```
src/test/
├── unit/                          # Fast, isolated tests
│   ├── cli/
│   │   └── CopilotCommandLineIntegration.test.ts
│   ├── core/
│   │   ├── FlightPathManager.test.ts
│   │   ├── EndConditionEvaluator.test.ts
│   │   ├── PromptQueue.test.ts
│   │   └── PromptFileParser.test.ts
│   └── utils/
│       ├── FileSystemUtils.test.ts
│       └── ValidationUtils.test.ts
├── integration/                   # Real VS Code API tests
│   └── workflow.integration.test.ts
├── fixtures/                      # Test data
│   ├── prompts/
│   │   ├── single.prompt.json
│   │   └── multi.flightpath.json
│   ├── scripts/
│   │   ├── success.py
│   │   ├── failure.js
│   │   └── timeout.sh
│   └── cli-outputs/
│       ├── success.txt
│       └── error.txt
└── helpers/                       # Test utilities
    └── mockCopilotCli.ts
```

### 2. Mocking Strategy

**For CLI Integration:**
```typescript
import { spawn } from 'child_process';

// Mock spawn to return simulated CLI output
jest.mock('child_process');

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
mockSpawn.mockReturnValue({
  stdout: createMockStream(mockOutput),
  stderr: createMockStream(''),
  stdin: createMockWritableStream(),
  on: jest.fn((event, handler) => {
    if (event === 'close') handler(0);
  })
});
```

**For VS Code API:**
```typescript
// Use VS Code's built-in test utilities
import * as vscode from 'vscode';

// Real API calls in integration tests
// Mock only external dependencies
```

### 3. Test Data Management

**Fixtures for Prompt Files:**
```json
// fixtures/prompts/single.prompt.json
{
  "prompt": "Explain this code @workspace",
  "endCondition": {
    "script": "check_explanation.py",
    "returns": "true",
    "timeout": 30000
  }
}
```

**Fixtures for CLI Output:**
```
// fixtures/cli-outputs/success.txt
This is a detailed response from Copilot CLI.
It can span multiple lines and include code blocks.

Total usage est: 1,234 tokens, $0.012
```

### 4. Test Commands

Add to `package.json`:
```json
{
  "scripts": {
    "test": "node ./out/test/runTest.js",
    "test:unit": "mocha out/test/unit/**/*.test.js",
    "test:integration": "COPILOT_CLI_INTEGRATION_TESTS=1 npm test",
    "test:watch": "mocha out/test/**/*.test.js --watch",
    "test:coverage": "nyc npm test"
  }
}
```

### 5. CI/CD Integration

**GitHub Actions Workflow:**
```yaml
- name: Run Unit Tests
  run: npm run test:unit

- name: Run Integration Tests (if CLI available)
  run: npm run test:integration
  continue-on-error: true  # Don't fail if CLI not installed in CI
```

## Implementation Priority

**Phase 1 (Week 1):** CLI Integration Tests
- CopilotCommandLineIntegration core functionality
- Output parsing and error handling
- Mock infrastructure setup

**Phase 2 (Week 2):** Core Architecture Tests
- FlightPathManager orchestration
- EndConditionEvaluator script execution
- Integration between components

**Phase 3 (Week 3):** Utility and Polish
- FileSystemUtils
- PromptFileParser (additional coverage)
- ValidationUtils (additional edge cases)

**Phase 4 (Optional):** Integration Tests
- Full workflow end-to-end tests
- Real CLI execution (optional, behind env var)
- Performance benchmarks

## Success Metrics

**Target Coverage:**
- CLI Integration: 80%+ coverage
- Core Architecture: 75%+ coverage
- Utilities: 90%+ coverage
- Overall: 70%+ coverage

**Quality Gates:**
- All tests pass before merge
- No new code without tests
- Integration tests optional but encouraged
- Documentation updated with test examples

## Notes on Chat Integration Deprecation

Given the decision to deprecate `CopilotChatIntegration`, the following can be **deprioritized or skipped**:

- ❌ Chat automation timing tests
- ❌ Language Model Tool callback tests
- ❌ Clipboard-based streaming detection tests
- ❌ Chat window location configuration tests
- ❌ XML prompt wrapping tests for chat

**Rationale:** Focus testing effort on the CLI integration which provides:
- Simpler architecture (no UI timing dependencies)
- Deterministic completion detection
- Direct access to response text
- Better debugging and logging
- Clearer error handling

If chat integration is fully removed in the future, these tests would become obsolete anyway.
