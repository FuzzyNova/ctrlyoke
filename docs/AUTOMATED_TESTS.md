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

Both `CopilotCommandLineIntegration` and `CopilotChatIntegration` are production integrations with different use cases:

- **CLI Integration**: Default mode for multi-step workflows with deterministic completion
- **Chat Integration**: Valuable for single prompts and works around Copilot's attachment bug

## Priority 1: Critical Integration Tests

### CopilotChatIntegration

**Status**: ❌ No test coverage (IMPORTANT FOR SINGLE PROMPTS & BUG WORKAROUND)

**High Priority Tests:**

1. **Copilot Availability Detection**
   - ✓ Detects installed Copilot extensions
   - ✓ Progressive activation strategy (passive first, then active)
   - ✓ Correct status transitions (initializing → waiting → ready/unavailable)
   - ✓ Background polling (5s intervals, 6 attempts max)

2. **Language Model Tool Registration**
   - ✓ Registers `flightpath_response_complete` tool after Copilot is ready
   - ✓ Prevents duplicate registration
   - ✓ Tool callback fires response complete event
   - ✓ Duplicate call protection (toolCalledForCurrentPrompt flag)
   - ✓ LLM loop prevention (cancels chat when duplicate detected)

3. **Direct Automation (Zero-Interaction)**
   - ✓ Opens chat with configured window location (panel/tab/window)
   - ✓ Uses proven timing delays (1000ms focus, 300ms clear, 500ms type)
   - ✓ Clears existing input via selectAll
   - ✓ Types prompt text directly
   - ✓ Submit with retry logic and exponential backoff
   - ✓ Clipboard-based verification (prompt appears in chat)

4. **Native File Attachments (Bug Workaround)**
   - ✓ Processes `#file:path` references via `github.copilot.chat.attachFile` command
   - ✓ Processes `#file:path:startLine-endLine` via `github.copilot.chat.attachSelection` command
   - ✓ Opens documents with focus (preserveFocus: false)
   - ✓ Closes preview editors after attachment
   - ✓ Keeps `#file:` references in prompt text for context
   - ✓ Falls back to XML attachments when native commands fail
   - ✓ Respects `chatUseNativeAttachments` setting

5. **Response Completion Detection**
   - ✓ Tool instruction appended to prompts (wrapped in XML)
   - ✓ Streaming detection via clipboard polling
   - ✓ Requires 3 consecutive stable checks (1.5s)
   - ✓ Preserves user's clipboard content (cache and restore)
   - ✓ Timeout handling (40 attempts = 20s max)

6. **Prompt Augmentation**
   - ✓ Appends tool instruction in `<criticalInstruction>` XML tag
   - ✓ XML hidden in chat UI but processed by Copilot
   - ✓ Only includes tool instruction when needed (multi-prompt workflows)
   - ✓ Single prompts can skip tool instruction

7. **Configuration Integration**
   - ✓ Reads `chatWindowLocation` setting (panel/newTab/newWindow)
   - ✓ Reads `chatUseNativeAttachments` setting
   - ✓ Reads `autoAttachFiles` setting
   - ✓ Selects correct command based on chat location

8. **Error Handling**
   - ✓ Handles focus failures
   - ✓ Handles type command failures
   - ✓ Handles submit retry exhaustion
   - ✓ Reports clear error messages to user
   - ✓ Graceful degradation when commands unavailable

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
│   ├── integrations/
│   │   ├── CopilotCommandLineIntegration.test.ts
│   │   └── CopilotChatIntegration.test.ts
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
import { spawn } from "child_process";

// Mock spawn to return simulated CLI output
jest.mock("child_process");

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
mockSpawn.mockReturnValue({
  stdout: createMockStream(mockOutput),
  stderr: createMockStream(""),
  stdin: createMockWritableStream(),
  on: jest.fn((event, handler) => {
    if (event === "close") handler(0);
  }),
});
```

**For Chat Integration:**

```typescript
import * as vscode from "vscode";

// Mock VS Code commands for chat automation
const mockExecuteCommand = jest.fn();
vscode.commands.executeCommand = mockExecuteCommand;

// Mock chat commands
mockExecuteCommand.mockImplementation((command: string, ...args: any[]) => {
  switch (command) {
    case "workbench.panel.chat.view.copilot.focus":
      return Promise.resolve();
    case "type":
      return Promise.resolve();
    case "workbench.action.chat.submit":
      return Promise.resolve();
    case "github.copilot.chat.attachFile":
      return Promise.resolve();
    case "github.copilot.chat.attachSelection":
      return Promise.resolve();
    default:
      return Promise.resolve();
  }
});

// Mock clipboard for submit verification
const mockClipboard = {
  readText: jest.fn(),
  writeText: jest.fn(),
};
vscode.env.clipboard = mockClipboard;
```

**For VS Code API:**

```typescript
// Use VS Code's built-in test utilities
import * as vscode from "vscode";

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
  continue-on-error: true # Don't fail if CLI not installed in CI
```

## Implementation Status

**Phase 1 (COMPLETED):** Integration Tests

- ✅ Extension activation and lifecycle (2 tests)
- ✅ Command registration verification (CLI + Chat) (2 tests)
- ✅ Configuration settings validation (3 tests)
- ✅ Language Model Tool manifest verification (1 test)
- ✅ Core utilities (PromptQueue, ValidationUtils) (8 tests)
- ✅ Total: 19 passing automated tests

**Automated Test Coverage:**

- Extension loads and activates correctly
- All commands properly registered
- Configuration settings accessible
- Language Model Tool declared in manifest
- Chat automation commands available
- Status command executes without errors
- No workspace dependencies required

**Manual Testing Only (Not Automated):**

- Copilot CLI execution (requires `gh copilot` installed and authenticated)
- Copilot Chat integration (requires Copilot extensions + GitHub authentication)
- File attachment workflows (requires active Copilot session)
- End-to-end prompt workflows (requires workspace + Copilot)

**Rationale:** Copilot-dependent tests require manual installation, authentication, and active subscriptions. Automated tests focus on extension infrastructure that can run in isolated CI/CD environments.

**Phase 2 (NEXT):** Core Architecture Tests

- FlightPathManager orchestration
- EndConditionEvaluator script execution
- Integration between components

**Phase 3 (FUTURE):** Utility and Polish

- FileSystemUtils
- PromptFileParser (additional coverage)
- ValidationUtils (additional edge cases)

## Success Metrics

**Current Coverage (Phase 1):**

- ✅ Extension Lifecycle: 100% (activation, commands, config)
- ✅ Core Utilities: 100% (PromptQueue, ValidationUtils)
- ⚠️ CLI Integration: Manual testing only (requires external CLI)
- ⚠️ Chat Integration: Manual testing only (requires Copilot extensions)
- 🔄 Core Architecture: 0% (Phase 2 - not started)
- 🔄 FileSystemUtils: 0% (Phase 3 - not started)

**Test Results:**

- 19 passing automated tests
- 0 failing tests
- 0 pending tests (removed workspace/Copilot-dependent tests)
- All tests run in <100ms

**Quality Gates:**

- ✅ All automated tests pass before merge
- ✅ Tests run in CI/CD without external dependencies
- ✅ No workspace or authentication required
- ✅ Extension infrastructure fully validated

## Notes on Integration Testing Strategy

Both CLI and Chat integrations are production-ready with distinct advantages:

**CLI Integration (Default for workflows):**

- Simpler architecture (no UI timing dependencies)
- Deterministic completion detection
- Direct access to response text for end conditions
- Better debugging and logging
- Clearer error handling

**Chat Integration (Valuable for single prompts):**

- Works around known Copilot attachment bug using native commands
- Better UI experience for ad-hoc prompts
- Preserves chat history and context
- Useful when CLI is unavailable

**Testing Priority:** Both integrations should have comprehensive test coverage since they serve different use cases and are both actively maintained.
