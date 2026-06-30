# ctrlyoke Manual Testing Workspace

This directory contains test files for manually testing the ctrlyoke extension. When you press **F5** to debug ctrlyoke, the `ctrlyoke-test.code-workspace` opens in the Extension Development Host window with the project root directory (giving you access to these tests and the ability to use ctrlyoke on ctrlyoke itself).

## Quick Start

1. Press **F5** in VS Code to start debugging ctrlyoke
2. The Extension Development Host window opens with the `ctrlyoke-test.code-workspace` (root directory)
3. ctrlyoke extension is active and ready to test
4. Run tests by right-clicking test files → "Run with ctrlyoke"

## Test Philosophy

**Test ctrlyoke, not LLMs.** All prompts are designed to be simple enough that any model can complete them. If a test fails, it should indicate a ctrlyoke bug, not an LLM limitation.

**Model defaults.** Most tests omit the `model` field to use your default selection. Only tests that specifically verify model-switching functionality specify models.

---

## What Makes a Good Manual Test?

Good manual tests share these characteristics:

### 1. Simple and Fast ⚡

- **Simple prompts**: "Remember the number 42" instead of "Analyze the architectural patterns"
- **Quick execution**: Tests should complete in seconds, not minutes
- **Clear instructions**: Tell the LLM "we are testing" to encourage brief responses
- **Free models work**: Haiku/gpt-5-mini should be able to complete the test

### 2. Clear Pass/Fail Indicators ✅

- Use end condition scripts for automated validation
- Simple verification: "Did the file get updated?" not "Is the architecture improved?"
- Explicit success criteria in the prompt

### 3. Tests ctrlyoke, Not AI Capabilities 🎯

- **Good**: "Set counter.txt to 5" (tests file operations and end conditions)
- **Bad**: "Refactor this codebase" (tests AI, not ctrlyoke)
- Focus on mechanical operations: read file, write number, respond with text

### Examples of Good Tests

✅ `new-chat-session-test.ctrlyoke.json` - Simple question/answer to verify session isolation
✅ `retry-counter-test.ctrlyoke.json` - Mechanical file update with clear validation
✅ `dynamic-queue-basic-example.ctrlyoke.json` - Simple tool calls with explicit instructions
✅ `workflow-properties-test.ctrlyoke.yaml` - Tests edge cases with simple prompts
✅ `yaml-format-test.ctrlyoke.yaml` - Just verifies YAML parsing works

### Examples of Bad Tests

❌ "Analyze ctrlyoke architecture and suggest improvements" - Too complex, slow, no clear pass/fail
❌ "Review the code and provide detailed feedback" - Subjective, tests AI quality
❌ Using real implementation tasks in tests - Unpredictable, slow, hard to validate
❌ Multi-stage workflows that modify code - Takes too long, unclear success criteria

---

## Test vs Example

This directory contains both **tests** and **examples**:

- **Tests** (root directory): Fast, focused validation of specific features
- **Examples** (`examples/` subdirectory): Educational workflows demonstrating advanced patterns

When creating new files:

- If it tests a specific ctrlyoke feature with clear pass/fail → Root directory
- If it demonstrates best practices or complex workflows → `examples/` subdirectory

---

## Core Feature Tests

### Basic Format Tests

| File                                     | Tests                                   | Duration |
| ---------------------------------------- | --------------------------------------- | -------- |
| `simple-prompt-test.prompt.md`           | Markdown format, basic execution        | 5 sec    |
| `yaml-format-test.ctrlyoke.yaml`       | YAML parsing, multi-line strings        | 5 sec    |
| `yaml-multi-step-test.ctrlyoke.yaml`   | YAML multi-step with session continuity | 10 sec   |
| `.ctrlyoke/simple.prompt.md`           | Simple prompt in .ctrlyoke directory  | 5 sec    |
| `.ctrlyoke/multi-step.ctrlyoke.json` | Multi-step with model switching         | 15 sec   |

### Session Management Tests

| File                                    | Tests                                        | Duration |
| --------------------------------------- | -------------------------------------------- | -------- |
| `new-chat-session-test.ctrlyoke.json` | Session isolation with `newChatSession` flag | 10 sec   |
| `session-resume-test.ctrlyoke.yaml`   | Context preservation across prompts          | 10 sec   |

### Retry Mechanism Tests

| File                                        | Tests                            | Duration |
| ------------------------------------------- | -------------------------------- | -------- |
| `retry-counter-test.ctrlyoke.json`        | Basic retry with file validation | 15 sec   |
| `retry-multi-step-test.ctrlyoke.json`     | Multi-step workflow with retries | 30 sec   |
| `retry-max-exhaustion-test.ctrlyoke.json` | Max retries exhaustion behavior  | 15 sec   |
| `retry-timeout-error-test.ctrlyoke.json`  | Timeout doesn't trigger retry    | 10 sec   |
| `script-error-test.ctrlyoke.json`         | Script crash error handling      | 10 sec   |

### Advanced Features

| File                                          | Tests                                    | Duration |
| --------------------------------------------- | ---------------------------------------- | -------- |
| `workflow-properties-test.ctrlyoke.yaml`    | Property inheritance and precedence      | 15 sec   |
| `test-property-sync.ctrlyoke.yaml`          | Property sync to dashboard UI            | 10 sec   |
| `dynamic-queue-basic-example.ctrlyoke.json` | Dynamic queue extension via MCP tools    | 20 sec   |
| `attachment-test.prompt.md`                   | All attachment types (@, #file, #sym)    | 10 sec   |
| `prompt-links-test.ctrlyoke.json`           | Clickable links (Ctrl+Click navigation)  | UI Test  |
| `precondition-test.ctrlyoke.yaml`           | preCondition pass/skip/always-run gating | 15 sec   |
| `script-step-test.ctrlyoke.yaml`            | scriptStep executes without AI           | 10 sec   |
| `end-condition-continue-test.ctrlyoke.yaml` | endCondition onFail: "continue" advances | 10 sec   |

---

## Test Scenarios

### 1. Basic Prompt Execution

**File:** `simple-prompt-test.prompt.md`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:** LLM responds with "4" (tests basic execution)

---

### 2. Session Continuity

**File:** `session-resume-test.ctrlyoke.yaml`

**Setup:** None required

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- First prompt tells LLM "My favorite color is orange"
- Second prompt asks "What is my favorite color?"
- LLM should respond "orange" (proves session continuity)

---

### 3. Counter Retry Test

**File:** `retry-counter-test.ctrlyoke.json`

**Setup:**

```powershell
echo 0 > counter.txt
```

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- LLM increments counter in counter.txt
- Script validates value equals 3
- Retries until validation passes
- Final counter.txt value: `3`

---

### 4. Multi-Step Retry Workflow

**File:** `retry-multi-step-test.ctrlyoke.json`

**Setup:**

```powershell
echo 0 > multi-step-counter.txt
```

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Step 1: Set counter to 5
- Step 2: Multiply by 2 (expects 10)
- Step 3: Add 5 (expects 15)
- Final value: `15`

---

### 5. Max Retries Exhaustion

**File:** `retry-max-exhaustion-test.ctrlyoke.json`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Uses `always_fails.py` script (always returns false)
- 3 total attempts (initial + 2 retries)
- Error message when max retries reached
- Workflow stops gracefully

---

### 6. Workflow Properties Test

**File:** `workflow-properties-test.ctrlyoke.yaml`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Tests three-tier precedence (prompt > workflow > settings)
- First prompt inherits all workflow defaults
- Second prompt overrides model only
- Third prompt overrides all properties

---

### 7. Dynamic Queue Extension

**File:** `dynamic-queue-basic-example.ctrlyoke.json`

**Test:**

1. Enable setting: `ctrlyoke.enableDynamicQueue`
2. Right-click → "Run with ctrlyoke"

**Expected:**

- First prompt calls `ctrlyoke_append_queue` tool to add 2 new prompts
- Second prompt calls `ctrlyoke_queue_status` to verify queue state
- Dynamically added prompts execute automatically

---

### 8. Attachment Types Test

**File:** `attachment-test.prompt.md`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- LLM receives 4 attachments:
  1. Full file (@manual-test/simple-prompt-test.prompt.md)
  2. Directory structure (@manual-test/sample-code/)
  3. Line range (#file:src/extension.ts:1-20)
  4. Symbol (#sym:src/extension.ts:activate:14)
- LLM responds "All attachments received" if successful

### 9. preCondition Gating

**File:** `precondition-test.ctrlyoke.yaml`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Step 1 has `preCondition` using `always_true.py` → runs normally
- Step 2 has `preCondition` using `always_false.py` → **skipped** (no AI call)
- Step 3 has no `preCondition` → always runs as confirmation step

---

### 10. Script Step Execution

**File:** `script-step-test.ctrlyoke.yaml`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Step 1 is a `scriptStep` (no AI call) — runs `always_true.py`, script returns "true"
- Step 2 is a regular prompt step — confirms the workflow continued after the script step

---

### 11. End Condition `onFail: "continue"`

**File:** `end-condition-continue-test.ctrlyoke.yaml`

**Test:** Right-click → "Run with ctrlyoke"

**Expected:**

- Step 1 runs; end condition script (`always_false.py`) returns "false" → fails
- Because `onFail: "continue"`, the workflow **does NOT stop** — it advances
- Step 2 runs, confirming the workflow continued past the failed end condition

---

## End Condition Scripts

Located in `.ctrlyoke/scripts/`:

| Script                   | Purpose                       | Returns        |
| ------------------------ | ----------------------------- | -------------- |
| `always_true.py`         | Always succeeds (pass test)   | `true`         |
| `always_false.py`        | Always fails (retry test)     | `false`        |
| `always_fails.py`        | Exhaustion tests              | `false`        |
| `throws_error.py`        | Script crash/error            | Exit code 1    |
| `timeout_script.py`      | Timeout handling (sleeps 20s) | Timeout        |
| `check_counter.py`       | Validates counter equals 3    | `true`/`false` |
| `check_counter_value.py` | Validates counter equals N    | `true`/`false` |

---

## Retry Configuration Examples

### Basic Retry

```json
{
  "endCondition": {
    "script": "manual-test/.ctrlyoke/scripts/check_counter.py",
    "returns": "true",
    "maxRetries": 3,
    "onFail": "retry",
    "retryPrompt": "Validation failed. Please increment @counter.txt."
  }
}
```

### Retry with Placeholders

```json
{
  "endCondition": {
    "script": "validate.py",
    "returns": "success",
    "maxRetries": 5,
    "retryPrompt": "Validation failed (exit {exitCode}): {stdout}"
  }
}
```

### Retry Prompt Placeholders

- `{stdout}` - stdout from the script
- `{stderr}` - stderr from the script
- `{expected}` - what we're looking for
- `{actual}` - what we got
- `{exitCode}` - numeric exit code from the script
- `{compareSource}` - comparison source: stdout, stderr, exitCode, or auto

---

## Script Design for Retries

✅ **DO:** Exit with code 0 even on validation failure

```python
import sys

if tests_passed:
    print('true')
    sys.exit(0)
else:
    print('false')
    sys.exit(0)  # Still exit 0 - validation failure, not error
```

❌ **DON'T:** Exit with non-zero code for validation failures

```python
if not tests_passed:
    sys.exit(1)  # This triggers error path, not retry!
```

---

## Sample Code Files

Located in `sample-code/`:

- **`example.ts`** - TypeScript class with interfaces, generics, Map
- **`example.py`** - Python dataclasses with type hints
- **`README.md`** - Description of sample code

Use in prompts: `@sample-code/example.ts`

Line ranges: `@sample-code/example.ts:6-11`

---

## Resetting Test Files

Before running counter tests:

```powershell
echo 0 > counter.txt
echo 0 > multi-step-counter.txt
```

---

## Link Harness Testing

### Test: Clickable Context References

**File:** `prompt-links-test.ctrlyoke.json`

**Test Steps:**

1. Open test file in the editor
2. **File links** (`@path/to/file.ts`):
   - Ctrl+Hover to see blue underline
   - Ctrl+Click to open the file
3. **Directory links** (`@path/to/dir/`):
   - Ctrl+Hover for tooltip
   - Ctrl+Click to reveal in Explorer
4. **Line range links** (`#file:path:10-20`):
   - Ctrl+Click to open file with lines selected
5. **Symbol links** (`#sym:path:symbol:42`):
   - Ctrl+Click to navigate to symbol definition

**Expected Behavior:**

- All references show as clickable links when Ctrl is held
- Clicking navigates to correct location
- Invalid paths show error message (graceful degradation)

---

## Examples Directory

The `examples/` subdirectory contains **educational examples** demonstrating advanced ctrlyoke patterns. These are NOT tests - they are detailed workflows showing best practices.

- **workflow-properties/** - Property inheritance patterns
- **sessions/** - Session management strategies (multi-session, cross-harness, session reuse)

See `examples/README.md` for details.

---

## Adding New Tests

### Guidelines

1. **Keep it simple**: Can the test run in under 30 seconds?
2. **Clear validation**: Is there an obvious pass/fail indicator?
3. **Model-agnostic**: Can free models complete this test?
4. **Test ctrlyoke**: Does this test a ctrlyoke feature, not AI quality?

### Creating a New Test

**Markdown format** (simplest):

```markdown
What is 2 + 2?
```

**YAML format** (multi-step):

```yaml
steps:
  - prompt: Step 1 instructions
    model: claude-haiku-4.5
  - prompt: Step 2 instructions
```

**JSON format** (with end condition):

```json
{
  "prompt": "Instructions here",
  "endCondition": {
    "script": "manual-test/.ctrlyoke/scripts/validate.py",
    "returns": "true",
    "onFail": "retry",
    "maxRetries": 3,
    "retryPrompt": "Validation failed: {stdout}\n\nPlease fix and try again."
  }
}
```

### Adding End Condition Scripts

Create in `.ctrlyoke/scripts/`:

```python
import sys
response = sys.stdin.read()
# Validation logic here
print('true' if valid else 'false')
sys.exit(0)
```

Test: `echo "test" | python manual-test/.ctrlyoke/scripts/validate.py`

---

## Troubleshooting

### CLI not working

1. Check: `gh copilot --version` or `claude --version`
2. Authenticate: `gh auth login` or `claude auth login`
3. Restart Extension Development Host

### Chat not working

1. Ensure GitHub Copilot extension installed
2. Check Copilot status (bottom-right)
3. Sign in to GitHub Copilot

### End conditions not executing

1. Check script permissions (Linux/Mac: `chmod +x`)
2. Verify Python/Node.js in PATH
3. Check timeout setting

---

Happy testing! 🚀
