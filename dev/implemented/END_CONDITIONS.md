# FlightPath End Conditions

## Overview

End conditions are **optional validation checks** that determine whether a workflow step has completed successfully. When a validation check fails but the script runs successfully, FlightPath can automatically retry with a custom prompt.

**Status:** ✅ Fully Implemented

---

## Quick Start

```json
{
  "prompt": "Implement user authentication with tests",
  "endCondition": {
    "script": "npm test",
    "returns": "all_passed",
    "timeout": 60000,
    "maxRetries": 3,
    "retryPrompt": "Tests failing:\n\n{stdout}\n\nPlease fix the issues."
  }
}
```

**How it works:**

1. Copilot implements authentication → Tests run → "5 tests failed"
2. ❌ Doesn't match "all_passed" → **Retry with test output**
3. Copilot fixes issues → Tests run → "2 tests failed"
4. ❌ Still doesn't match → **Retry again with updated output**
5. Copilot fixes remaining issues → Tests run → "all_passed"
6. ✅ **Success!** Move to next prompt

---

## Configuration

### JSON Schema

```json
{
  "endCondition": {
    "script": "path/to/script.py",
    "returns": "true",
    "timeout": 30000,
    "maxRetries": 3,
    "retryPrompt": "Template with placeholders..."
  }
}
```

### Properties

| Property      | Type   | Required | Default | Description                                      |
| ------------- | ------ | -------- | ------- | ------------------------------------------------ |
| `script`      | string | Yes      | -       | Path to executable script (relative or absolute) |
| `returns`     | string | Yes      | -       | Expected output value from script                |
| `timeout`     | number | No       | 30000   | Max execution time in milliseconds               |
| `maxRetries`  | number | No       | 0       | Maximum retry attempts                           |
| `retryPrompt` | string | No       | -       | Template for retry prompt                        |

### Retry Prompt Placeholders

| Placeholder       | Description                                               | Example              |
| ----------------- | --------------------------------------------------------- | -------------------- |
| `{stdout}`        | stdout from the validation script                         | `"3 tests failed"`   |
| `{stderr}`        | stderr from the validation script                         | `"SyntaxError: ..."` |
| `{expected}`      | The configured expected value                             | `"true"`             |
| `{actual}`        | The actual comparison value (resolved from compareSource) | `"false"`            |
| `{exitCode}`      | Numeric exit code from the validation script              | `"1"`                |
| `{compareSource}` | Comparison source: `stdout`, `stderr`, `exitCode`, `auto` | `"stdout"`           |

---

## Supported Script Types

| Extension      | Interpreter                                |
| -------------- | ------------------------------------------ |
| `.py`          | `python`                                   |
| `.js`          | `node`                                     |
| `.ts`          | `npx ts-node`                              |
| `.sh`          | `bash` (Windows) / `sh` (macOS/Linux)      |
| `.bat`, `.cmd` | `cmd /c` (Windows only)                    |
| `.ps1`         | `powershell -ExecutionPolicy Bypass -File` |

---

## Script Design Guidelines

**Key Requirement:** Scripts must exit with code 0 for validation failures.

Non-zero exit codes are reserved for execution errors (which don't trigger retries).

```python
#!/usr/bin/env python3
import sys

if tests_passed():
    print("true")
    sys.exit(0)  # Success
else:
    print("false")
    print("Failed tests: login, logout")  # Details for retry
    sys.exit(0)  # Still exit 0 - validation failure, not error
```

```javascript
// check_tests.js
if (allTestsPassed()) {
  console.log("all_passed");
  process.exit(0);
} else {
  console.log("failed");
  console.log("Details: 3 tests failed");
  process.exit(0); // Exit 0 for validation failures
}
```

---

## Retry Flow

```
Response Complete
       ↓
Evaluate End Condition
       ↓
   Success? ──Yes──► Move to next prompt ✅
       ↓ No
   Error? ──Yes──► Show error dialog ❌ (don't retry)
       ↓ No
Validation Failure (script ran OK, output didn't match)
       ↓
   Retries available? ──No──► User prompt (Stop/Continue/Retry)
       ↓ Yes
Build retry prompt (replace placeholders)
       ↓
Send to Copilot
       ↓
Increment retry counter
       ↓
Wait for response
       ↓
   (loop back to Evaluate)
```

---

## Happy Path vs Error Path

### Happy Path (Retry-eligible)

- ✅ Script executes successfully (exit code 0)
- ❌ Output doesn't match expected value
- → **Triggers automatic retry**

### Error Path (Not retry-eligible)

- ❌ Script fails to execute (file not found, syntax error)
- ❌ Script times out
- ❌ Non-zero exit code
- → **Shows error dialog, no automatic retry**

---

## Example Use Cases

### Test-Driven Development

```json
{
  "prompt": "Implement the login function with tests",
  "endCondition": {
    "script": "npm test",
    "returns": "all_passed",
    "maxRetries": 3,
    "retryPrompt": "Tests failing:\n{stdout}\n\nFix these issues."
  }
}
```

### Compilation Validation

```json
{
  "prompt": "Add TypeScript types to the module",
  "endCondition": {
    "script": "npm run build",
    "returns": "success",
    "maxRetries": 2,
    "retryPrompt": "Compilation errors:\n\n{stdout}\n\nFix the errors above."
  }
}
```

### Code Coverage Gate

```json
{
  "prompt": "Increase test coverage to 80%",
  "endCondition": {
    "script": "check_coverage.py",
    "returns": "pass",
    "maxRetries": 2,
    "retryPrompt": "Coverage at {actual}%, need {expected}%.\n\n{stdout}\n\nCompare source: {compareSource}"
  }
}
```

---

## Creating End Condition Scripts

Use the command palette to generate script templates:

```
Ctrl+Shift+P → FlightPath: Create End Condition Script
```

This creates a template in your workspace that you can customize.

---

## Implementation Details

### Files Involved

- `src/types/FlightPathTypes.ts` - `EndCondition` interface
- `src/flightpath/EndConditionEvaluator.ts` - Script execution and template replacement
- `src/flightpath/EndConditionHandler.ts` - Retry orchestration logic
- `src/flightpath/PromptQueue.ts` - Retry counter tracking
- `schemas/prompt-schema.json` - JSON schema validation

### Key Methods

- `EndConditionEvaluator.evaluateCondition()` - Executes script and returns result
- `EndConditionEvaluator.buildRetryPrompt()` - Replaces template placeholders
- `PromptQueue.canRetry()` - Checks if retry is available
- `EndConditionHandler.handleEndConditionResult()` - Routes to success/retry/error

---

## Troubleshooting

| Issue                | Cause                    | Solution                              |
| -------------------- | ------------------------ | ------------------------------------- |
| Script not found     | Path is incorrect        | Use relative path from workspace root |
| Timeout              | Script takes too long    | Increase `timeout` value              |
| No retries happening | `maxRetries` is 0        | Set `maxRetries` to desired value     |
| Wrong interpreter    | Extension not recognized | Check supported script types          |
| Retry not triggering | Non-zero exit code       | Ensure script exits with code 0       |
