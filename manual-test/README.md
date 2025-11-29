# FlightPath Manual Testing Workspace

This directory serves as a dedicated workspace for manually testing the FlightPath extension. When you press **F5** to debug FlightPath, this workspace automatically opens in the Extension Development Host window.

## Quick Start

1. Press **F5** in VS Code to start debugging FlightPath
2. The Extension Development Host window opens with this `manual-test` workspace
3. FlightPath extension is active and ready to test
4. Test prompts are available in `.flightpath/` directory

## Test Philosophy

**Test FlightPath, not LLMs.** All prompts are designed to be simple enough that any model can complete them. If a test fails, it should indicate a FlightPath bug, not an LLM limitation.

**Model defaults.** Most tests omit the `model` field to use your default selection. Only tests that specifically verify model-switching functionality specify models.

---

## Test Files Overview

### Core Feature Tests (`.flightpath/` directory)

| File                             | Purpose         | Tests                            |
| -------------------------------- | --------------- | -------------------------------- |
| `simple.prompt.md`               | Markdown format | Basic prompt execution           |
| `with-file.prompt.json`          | File attachment | `#file:` reference processing    |
| `with-end-condition.prompt.json` | End condition   | Script validation                |
| `multi-step.flightpath.json`     | Model switching | Multi-step with different models |

### Retry Mechanism Tests

| File                                        | Purpose          | Tests                             |
| ------------------------------------------- | ---------------- | --------------------------------- |
| `retry-counter-test.flightpath.json`        | Basic retry      | Counter increment with validation |
| `retry-max-exhaustion-test.flightpath.json` | Exhaustion       | Max retries reached behavior      |
| `retry-timeout-error-test.flightpath.json`  | Error path       | Timeout doesn't trigger retry     |
| `retry-multi-step-test.flightpath.json`     | Multi-step retry | Retries in sequential workflow    |

### Special Feature Tests

| File                                          | Purpose         | Tests                             |
| --------------------------------------------- | --------------- | --------------------------------- |
| `agent-test.flightpath.json`                  | Agent switching | Custom agent selection (CLI only) |
| `new-chat-session-test.flightpath.json`       | Session control | `newChatSession` flag behavior    |
| `multi-step-file-reference.flightpath.json`   | File references | External prompt file paths        |
| `dynamic-queue-basic-example.flightpath.json` | Dynamic queue   | Queue extension during execution  |
| `dynamic-queue-multi-stage.flightpath.json`   | Complex queue   | Multi-stage dynamic workflows     |

---

## Test Scenarios

### 1. Simple Markdown Prompt

**File:** `.flightpath/simple.prompt.md`

**Test:** Right-click → "Send to CLI" or "Send to Chat"

**Expected:** Copilot responds with explanation of FlightPath.

---

### 2. Prompt with File Attachment

**File:** `.flightpath/with-file.prompt.json`

**Test:** Right-click → "Send to CLI"

**Expected:** Copilot analyzes `sample-code/example.ts` and explains its functionality.

---

### 3. End Condition Validation

**File:** `.flightpath/with-end-condition.prompt.json`

**Test:** Right-click → "Send to CLI"

**Expected:**

- Copilot generates TypeScript `add` function
- End condition script validates response contains "add" function
- Workflow completes if validation passes

---

### 4. Multi-Step with Model Switching

**File:** `.flightpath/multi-step.flightpath.json`

**Test:** Right-click → "Send to CLI" or "Send to Chat"

**Expected:** Two sequential responses using different models (gpt-5-mini, claude-haiku-4.5).

---

### 5. Basic Counter Retry

**File:** `retry-counter-test.flightpath.json`

**Setup:**

```powershell
echo 0 > counter.txt
```

**Test:** Right-click → "Send to CLI"

**Expected:**

- Copilot increments counter, script validates value equals 3
- Retries until validation passes
- Counter.txt ends with value `3`

---

### 6. Max Retries Exhaustion

**File:** `retry-max-exhaustion-test.flightpath.json`

**Test:** Right-click → "Send to CLI"

**Expected:**

- Uses `always_fails.py` script (always returns false)
- 3 total attempts (initial + 2 retries)
- Error message when max retries reached
- Workflow stops

---

### 7. Timeout Error Path

**File:** `retry-timeout-error-test.flightpath.json`

**Test:** Right-click → "Send to CLI"

**Expected:**

- Script times out after 5 seconds
- **NO retry attempts** (timeouts are execution errors, not validation failures)
- Error message shown
- Workflow stops immediately

---

### 8. Multi-Step Retry Workflow

**File:** `retry-multi-step-test.flightpath.json`

**Setup:**

```powershell
echo 0 > multi-step-counter.txt
```

**Test:** Right-click → "Send to CLI"

**Expected:**

- Step 1: Set counter to 5
- Step 2: Multiply by 2 (expects 10)
- Step 3: Add 5 (expects 15)
- Final value: `15`

---

### 9. New Chat Session Control

**File:** `new-chat-session-test.flightpath.json`

**Test:** Right-click → "Send to CLI" or "Send to Chat"

**Expected:**

- Prompts with `newChatSession: true` start fresh sessions
- Prompts with `newChatSession: false` continue in same session
- Context preserved within sessions, reset between sessions

---

### 10. Agent Support (CLI Only)

**File:** `agent-test.flightpath.json`

**Test:** Right-click → "Send to CLI"

**Expected:**

- Uses custom agents from `.github/agents/`
- Each prompt can specify different agent
- CLI output shows agent being used

**Note:** Agents must be in workspace root `.github/agents/`, not subdirectories.

---

### 11. File Path References

**File:** `multi-step-file-reference.flightpath.json`

**Test:** Right-click → "Send to CLI"

**Expected:**

- `prompt` field can reference external `.prompt.md` files
- Content loaded from referenced file
- Supports relative paths

---

### 12. Dynamic Queue

**Files:** `dynamic-queue-basic-example.flightpath.json`, `dynamic-queue-multi-stage.flightpath.json`

**Test:** Right-click → "Send to CLI" (with `enableDynamicQueue` setting enabled)

**Expected:**

- Copilot can extend the workflow by modifying the `.flightpath.json` file
- New prompts are picked up and executed
- Queue size limits enforced

---

## End Condition Scripts

Located in `.flightpath/scripts/`:

| Script                      | Purpose                 | Returns        |
| --------------------------- | ----------------------- | -------------- |
| `always_true.py`            | Always succeeds         | `true`         |
| `always_false.py`           | Always fails            | `false`        |
| `always_fails.py`           | Exhaustion tests        | `false`        |
| `timeout_test.py`           | Timeout handling        | Sleeps 60s     |
| `timeout_script.py`         | Retry timeout           | Sleeps 20s     |
| `check_counter.py`          | Counter validation      | `true`/`false` |
| `check_counter_value.py`    | Counter with target     | `true`/`false` |
| `check_has_add_function.py` | Validate "add" function | `true`/`false` |
| `check_typescript.js`       | TypeScript detection    | `true`/`false` |

---

## Retry Configuration Examples

### Only retryPrompt (uses default maxRetries: 3)

```json
{
  "endCondition": {
    "script": "validate.js",
    "returns": "success",
    "retryPrompt": "Custom retry: {scriptOutput}"
  }
}
```

### Only maxRetries (uses default retryPrompt)

```json
{
  "endCondition": {
    "script": "validate.js",
    "returns": "success",
    "maxRetries": 5
  }
}
```

### Both specified

```json
{
  "endCondition": {
    "script": "validate.js",
    "returns": "success",
    "maxRetries": 2,
    "retryPrompt": "Attempt {retryCount}/{maxRetries}: {scriptOutput}"
  }
}
```

### Unlimited retries

```json
{
  "endCondition": {
    "script": "validate.js",
    "returns": "success",
    "maxRetries": -1,
    "retryPrompt": "Keep trying: {scriptOutput}"
  }
}
```

---

## Retry Prompt Placeholders

Available placeholders in `retryPrompt`:

- `{scriptOutput}` - stdout from the script
- `{errorOutput}` - stderr from the script
- `{expectedValue}` - what we're looking for
- `{actualValue}` - what we got
- `{retryCount}` - current attempt (1, 2, 3...)
- `{maxRetries}` - maximum attempts configured

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
    print('Failed tests: login, logout')  # Details for retry
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

Use in prompts: `#file:sample-code/example.ts`

Line ranges: `#file:sample-code/example.ts:6-11`

---

## Resetting Test Files

Before running counter tests:

```powershell
echo 0 > counter.txt
echo 0 > multi-step-counter.txt
```

---

## Configuration Testing

### CLI Model Selection

1. Settings → "flightpath.copilotCliModel"
2. Options: `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-5`

### Chat Window Location

1. Settings → "flightpath.chatWindowLocation"
2. Options: `chatPanel`, `newTab`, `newWindow`

### Show CLI Output

1. Settings → "flightpath.showCliOutput"
2. Toggle to control Output panel visibility

---

## Troubleshooting

### CLI not working

1. Check: `gh copilot --version`
2. Authenticate: `gh auth login`
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

## Adding New Tests

### New Prompt

Create in `.flightpath/`:

- `.prompt.md` - Markdown format
- `.prompt.json` - JSON with optional endCondition
- `.flightpath.json` - Multi-step workflows

### New Script

Create in `.flightpath/scripts/`:

```python
import sys
response = sys.stdin.read()
print('true' if valid(response) else 'false')
sys.exit(0)
```

Test: `echo "test" | python script.py`

---

Happy testing! 🚀
