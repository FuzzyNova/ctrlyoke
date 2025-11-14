# FlightPath Manual Testing Workspace

This directory serves as a dedicated workspace for manually testing the FlightPath extension. When you press **F5** to debug FlightPath, this workspace automatically opens in the Extension Development Host window.

## Quick Start

1. Press **F5** in VS Code to start debugging FlightPath
2. The Extension Development Host window opens with this `manual-test` workspace
3. FlightPath extension is active and ready to test
4. Test prompts are already available in `.flightpath/` directory

## Test Scenarios

### 1. Simple Markdown Prompt (CLI Mode)
**File:** `.flightpath/simple.prompt.md`

**Test:**
- Right-click the file → "Send to CLI"
- Verifies: Basic CLI execution without file attachments

**Expected:** Copilot responds with explanation of FlightPath in the Output panel.

---

### 2. Prompt with File Attachment (CLI Mode)
**File:** `.flightpath/with-file.prompt.json`

**Test:**
- Right-click the file → "Send to CLI"
- Verifies: `#file:` reference processing and attachment
- Uses: `sample-code/example.ts`

**Expected:** Copilot analyzes the TypeScript code and explains its functionality.

---

### 3. Multi-Step Workflow (CLI Mode)
**File:** `.flightpath/multi-step.flightpath.json`

**Test:**
- Right-click the file → "Send to CLI"
- Verifies: Sequential prompt execution
- Tests: Different models (haiku vs sonnet)

**Expected:** Three sequential responses:
1. File listing (haiku)
2. Code analysis (sonnet) 
3. Improvement suggestions (default model)

---

### 4. End Condition Validation (Phase 2 Testing)
**File:** `.flightpath/with-end-condition.prompt.json`

**Test:**
- Right-click the file → "Send to CLI"
- Verifies: End condition script execution
- Uses: `scripts/check_has_add_function.py`

**Expected:** 
- Copilot generates TypeScript `add` function
- End condition script validates response contains "add" and "function"
- Workflow completes if validation passes

---

### 5. End Condition Retry Mechanism (NEW - Phase 1 Implementation)
**File:** `test-retry.flightpath.json`

**Test:**
- Tests automatic retry with custom prompts when validation fails
- Verifies: `maxRetries`, `retryPrompt`, placeholder replacement
- Uses: `check_documentation.js` script

**Expected:**
1. Copilot creates `add` function with tests
2. End condition validates tests pass (may fail initially)
3. If validation fails AND retries available → sends retry prompt with script output
4. Retry prompt includes: attempt number, test output, expected vs actual values
5. Copilot fixes issues based on feedback
6. Re-validates until success or max retries (3) reached

**Retry Flow:**
```
Copilot Response → Validate → Failed? 
  ↓ (has retries)
Build retry prompt with {scriptOutput}, {retryCount}, etc.
  ↓
Send to Copilot → Wait → Validate → Loop until success/max retries
```

**Test Variations:**
- **Happy Path:** Script succeeds but output doesn't match (triggers retry)
- **Error Path:** Script fails to execute (shows error, no retry)
- **Max Retries:** Exhaust all retries (user prompted to continue/stop)

---

### 6. Chat Mode Testing
**Any prompt file**

**Test:**
- Right-click the file → "Send to Chat"
- Verifies: Chat window automation
- Tests: File attachment via native commands

**Expected:**
- Chat window opens
- Prompt appears in input field
- Files attached (if applicable)
- Response appears in chat history

---

## End Condition Scripts

Located in `.flightpath/scripts/`:

| Script | Purpose | Returns |
|--------|---------|---------|
| `always_true.py` | Always succeeds | `true` |
| `always_false.py` | Always fails | `false` |
| `always_fails.py` | Always fails (for retry exhaustion tests) | `false` |
| `timeout_test.py` | Tests timeout handling | Sleeps 60s |
| `timeout_script.py` | Tests timeout in retry mechanism | Sleeps 20s |
| `check_has_add_function.py` | Validates "add" function in response | `true`/`false` |
| `check_typescript.js` | Detects TypeScript syntax | `true`/`false` |
| `check_documentation.js` | Validates JSDoc comments | `complete`/`incomplete` |
| `check_counter.py` | Validates counter.txt value (retry tests) | `true`/`false` |
| `check_counter_value.py` | Validates counter with command-line target | `true`/`false` |

### Testing End Conditions

1. **Success Case:** Use `always_true.py` - workflow should continue
2. **Failure Case:** Use `always_false.py` - workflow should stop
3. **Timeout Case:** Use `timeout_test.py` with 10s timeout - should fail with timeout error
4. **Real Validation:** Use `check_has_add_function.py` - validates actual response content

### Testing Retry Mechanism (NEW)

The retry mechanism automatically re-prompts Copilot when validation fails:

**Key Concepts:**
- **Happy Path (Retry):** Script runs successfully (exit 0) but output doesn't match expected value
- **Error Path (No Retry):** Script fails to execute, times out, or exits with non-zero code

---

#### Test 1: Basic Counter Retry
**File:** `retry-counter-test.flightpath.json`

**Setup:**
- Uses `counter.txt` (reset to 0 before testing)
- Script checks if counter equals 3
- Max retries: 5

**Test:**
1. Reset counter: `echo 0 > counter.txt`
2. Right-click `retry-counter-test.flightpath.json` → "Send to CLI"
3. Copilot increments counter by 1 (now = 1)
4. Script validates: expects 3, gets 1 → FAIL
5. Retry prompt sent with script output
6. Copilot increments again (now = 2)
7. Still fails validation
8. Copilot increments again (now = 3)
9. Validation succeeds ✓

**Expected:**
- 3 total Copilot interactions (initial + 2 retries)
- Counter.txt ends with value `3`
- Workflow completes successfully

**Validates:**
- Basic retry mechanism works
- Placeholder replacement (`{scriptOutput}`, `{retryCount}`, `{maxRetries}`)
- Script output captured and included in retry prompt
- Retry loop stops on success

---

#### Test 2: Max Retries Exhaustion
**File:** `retry-max-exhaustion-test.flightpath.json`

**Setup:**
- Uses `always_fails.py` script (always returns false)
- Max retries: 2

**Test:**
1. Right-click `retry-max-exhaustion-test.flightpath.json` → "Send to CLI"
2. Initial response from Copilot
3. Validation fails → Retry 1
4. Validation fails → Retry 2
5. Max retries reached → Show error dialog

**Expected:**
- 3 total Copilot interactions (initial + 2 retries)
- Error message: "End condition validation failed after 2 retries"
- Workflow stops (does not continue)

**Validates:**
- Max retries enforcement
- Proper stopping behavior
- User notification when retries exhausted

---

#### Test 3: Timeout Error Path (No Retry)
**File:** `retry-timeout-error-test.flightpath.json`

**Setup:**
- Uses `timeout_script.py` (sleeps 20 seconds)
- Timeout: 5000ms (5 seconds)
- Max retries: 3

**Test:**
1. Right-click `retry-timeout-error-test.flightpath.json` → "Send to CLI"
2. Copilot responds
3. Script starts executing
4. Timeout after 5 seconds
5. Script killed

**Expected:**
- Error message: "Script execution timed out"
- **NO retry attempts** (timeouts are execution errors, not validation failures)
- Workflow stops immediately
- Retry prompt never used

**Validates:**
- Error path vs happy path distinction
- Timeouts don't trigger retries
- Proper error handling

---

#### Test 4: Multi-Step Workflow with Retries
**File:** `retry-multi-step-test.flightpath.json`

**Setup:**
- Uses `multi-step-counter.txt` (reset to 0 before testing)
- 3 steps with different validation scripts
- Each step has retries enabled

**Test:**
1. Reset counter: `echo 0 > multi-step-counter.txt`
2. Right-click `retry-multi-step-test.flightpath.json` → "Send to CLI"
3. Step 1: Set counter to 5 (retries until successful)
4. Step 2: Multiply by 2 (expects 10, retries until successful)
5. Step 3: Add 5 (expects 15, retries until successful)

**Expected:**
- Each step may require multiple attempts
- Counter progression: 0 → 5 → 10 → 15
- All steps complete successfully
- Final value in `multi-step-counter.txt` is `15`

**Validates:**
- Retries work in multi-step workflows
- Each step has independent retry counters
- Sequential execution with validation

---

#### Retry Prompt Placeholders

Available placeholders in `retryPrompt`:
- `{scriptOutput}` - stdout from the script
- `{errorOutput}` - stderr from the script  
- `{expectedValue}` - what we're looking for
- `{actualValue}` - what we got
- `{retryCount}` - current attempt (1, 2, 3...)
- `{maxRetries}` - maximum attempts configured

**Example:**
```json
{
  "retryPrompt": "Validation failed. Expected: {expectedValue}, Got: {actualValue}\n\n{scriptOutput}\n\nRetry {retryCount}/{maxRetries}"
}
```

---

#### Script Design for Retries

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

#### Resetting Test Files

Before running tests, reset counter files:

```powershell
# PowerShell
echo 0 > manual-test\counter.txt
echo 0 > manual-test\multi-step-counter.txt
```

```bash
# Bash
echo 0 > manual-test/counter.txt
echo 0 > manual-test/multi-step-counter.txt
```

---

## Sample Code Files

Located in `sample-code/`:

- **`example.ts`** - TypeScript class with interfaces, generics, Map
- **`example.py`** - Python dataclasses with type hints

Use these in prompts with `#file:sample-code/example.ts` syntax.

### Line Range References

Test specific selections:
- `#file:sample-code/example.ts:6-11` - User interface only
- `#file:sample-code/example.ts:23-26` - getUser method
- `#file:sample-code/example.py:8-20` - Product dataclass

---

## Configuration Testing

Test different FlightPath settings:

### CLI Model Selection
1. Open Settings → search "flightpath.copilotCliModel"
2. Try different models: `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-5`
3. Run any prompt and verify model is used

### Chat Window Location
1. Open Settings → search "flightpath.chatWindowLocation"  
2. Try: `chatPanel`, `newTab`, `newWindow`
3. Use "Send to Chat" and verify correct window opens

### Show CLI Output
1. Open Settings → search "flightpath.showCliOutput"
2. Toggle true/false
3. Run CLI prompt and check if output appears in Output panel

---

## Status Bar Testing

FlightPath status appears in bottom-left of VS Code:

- **⚙️ FlightPath: Initializing** - Extension starting up
- **✓ FlightPath: Ready (CLI)** - CLI mode available
- **✓ FlightPath: Ready (Chat)** - Chat mode available  
- **▶ FlightPath: Running** - Workflow executing
- **⏸ FlightPath: Paused** - Workflow paused
- **❌ FlightPath: Setup Required** - Configuration issue

Click status bar item to see Copilot status details.

---

## Command Palette Testing

Open Command Palette (`Ctrl+Shift+P`) and test:

- **FlightPath: Take Off** - Start workflow (select prompt file)
- **FlightPath: Open Panel** - Open FlightPath panel (future feature)
- **FlightPath: Create Prompt File** - Create new prompt file
- **FlightPath: Create End Condition Script** - Create script from template
- **FlightPath: Pause Execution** - Pause running workflow
- **FlightPath: Resume Execution** - Resume paused workflow
- **FlightPath: Stop Execution** - Cancel running workflow
- **FlightPath: Show Copilot Status** - Display integration status
- **FlightPath: Debug State** - Show internal state (debug info)

---

## Troubleshooting

### CLI not working
1. Check if GitHub Copilot CLI is installed: `gh copilot --version`
2. Authenticate: `gh auth login`
3. Restart VS Code Extension Development Host

### Chat not working
1. Ensure GitHub Copilot extension is installed in Extension Development Host
2. Check GitHub Copilot status in bottom-right
3. Sign in to GitHub Copilot if needed

### File attachments not working
1. Verify `flightpath.autoAttachFiles` setting is `true`
2. Check file paths are correct (relative to this workspace)
3. Try absolute paths if relative paths fail

### End conditions not executing
1. Check script has execute permissions (Linux/Mac: `chmod +x script.py`)
2. Verify Python/Node.js is in PATH
3. Check script timeout is reasonable (default: 30s)

---

## Adding Your Own Tests

### New Prompt File
1. Create `.prompt.md` or `.prompt.json` in `.flightpath/`
2. Use existing prompts as templates
3. Reference files with `#file:sample-code/yourfile.ext`

### New End Condition Script
1. Create script in `.flightpath/scripts/`
2. Read response from stdin: `response = sys.stdin.read()`
3. Print result: `print('true')` or `print('false')`
4. Test standalone: `echo "test response" | python script.py`

### New Sample Code
1. Add file to `sample-code/`
2. Reference in prompts: `#file:sample-code/newfile.ext`
3. Test with both CLI and Chat modes

---

## Known Issues

- **Copilot attachment bug:** Chat mode uses native attachment commands as workaround
- **Multi-root workspaces:** Not fully tested yet, may have issues
- **Windows path separators:** Use forward slashes in `#file:` references

---

## Next Steps

As you test, consider adding:
- More complex multi-step workflows
- Edge case prompts (empty files, binary files, large files)
- Performance tests (many files, large responses)
- Error handling tests (invalid paths, missing files)

Happy testing! 🚀
