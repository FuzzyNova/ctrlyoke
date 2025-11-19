# FlightPath End Condition Handling

## Overview

End conditions in FlightPath are **optional validation checks** that determine whether a workflow step has completed successfully. They are defined in prompt files and executed by the `EndConditionEvaluator` class.

**Key Feature: Automatic Retry with Custom Prompts** 🔄

When a validation check fails (script runs successfully but indicates task incomplete), FlightPath can automatically retry with a configurable prompt that includes:

- Script output and error details
- Expected vs actual values
- Retry attempt progress
- Custom contextual guidance for Copilot

This enables **self-correcting workflows** where Copilot automatically fixes issues based on test failures, compilation errors, or validation results.

## Quick Example

```json
{
  "prompt": "Implement user authentication with tests",
  "endCondition": {
    "script": "npm test",
    "returns": "all_passed",
    "timeout": 60000,
    "maxRetries": 3,
    "retryPrompt": "Tests failing (attempt {retryCount}/{maxRetries}):\n\n{scriptOutput}\n\nPlease fix the issues."
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

## Current Implementation Status

⚠️ **IMPORTANT: End conditions are NOT currently implemented in the workflow execution flow.**

### What Exists

- ✅ **EndConditionEvaluator class** - Fully implemented with script execution capabilities
- ✅ **Schema validation** - End conditions are validated when loading prompt files
- ✅ **Template system** - Sample scripts can be generated via command palette
- ✅ **Type definitions** - `EndCondition` interface defined in `FlightPathTypes.ts`

### What Doesn't Exist Yet

- ❌ **Integration with workflow** - `evaluateCondition()` is never called during execution
- ❌ **Retry logic** - No mechanism to retry failed prompts
- ❌ **Failure handling** - No strategy for when conditions fail
- ❌ **Error recovery** - No handling for script execution errors

## End Condition Structure

### JSON Schema

```json
{
  "endCondition": {
    "script": "path/to/script.py",
    "returns": "true",
    "timeout": 30000,
    "maxRetries": 3,
    "retryPrompt": "The tests didn't pass. Here's the output:\n\n{scriptOutput}\n\nPlease fix the issues."
  }
}
```

### Properties

| Property      | Type   | Required | Description                                         |
| ------------- | ------ | -------- | --------------------------------------------------- |
| `script`      | string | Yes      | Path to executable script (relative or absolute)    |
| `returns`     | string | Yes      | Expected output value from script                   |
| `timeout`     | number | No       | Max execution time in milliseconds (default: 30000) |
| `maxRetries`  | number | No       | Maximum number of retry attempts (default: 0)       |
| `retryPrompt` | string | No       | Template for retry prompt with placeholder support  |

### Retry Prompt Template Placeholders

When `retryPrompt` is configured, you can use these placeholders for dynamic content:

| Placeholder       | Description                              | Example Value                                             |
| ----------------- | ---------------------------------------- | --------------------------------------------------------- |
| `{scriptOutput}`  | Standard output (stdout) from the script | `"3 tests failed: test_login, test_logout, test_session"` |
| `{errorOutput}`   | Error output (stderr) from the script    | `"SyntaxError: Unexpected token"`                         |
| `{expectedValue}` | The expected value from `returns` field  | `"true"`                                                  |
| `{actualValue}`   | The actual value returned by the script  | `"false"`                                                 |
| `{retryCount}`    | Current retry attempt number (1-indexed) | `"2"`                                                     |
| `{maxRetries}`    | Maximum retries configured               | `"3"`                                                     |

### Supported Script Types

The `EndConditionEvaluator` supports multiple script formats:

- **Python** (`.py`) - Executed with `python`
- **JavaScript** (`.js`) - Executed with `node`
- **TypeScript** (`.ts`) - Executed with `npx ts-node`
- **Bash** (`.sh`) - Executed with `sh` (or `bash` on Windows)
- **Windows Batch** (`.bat`, `.cmd`) - Executed with `cmd /c`
- **PowerShell** (`.ps1`) - Executed with `powershell -ExecutionPolicy Bypass`

## How End Conditions Should Work (Design)

### 1. Script Execution Flow with Retry Logic

```
┌─────────────────────────────────────────────────────────┐
│ 1. Copilot Response Complete                           │
│    - Tool callback signals completion                   │
│    - Streaming finishes                                 │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Check if End Condition Exists                       │
│    - If NO: Move to next prompt                        │
│    - If YES: Continue to evaluation                    │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Resolve Script Path                                 │
│    - Try absolute path                                  │
│    - Try relative to working directory                  │
│    - Try relative to workspace root                     │
│    - Try in .flightpath/ directory                      │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Execute Script                                       │
│    - Spawn child process with appropriate interpreter   │
│    - Collect stdout/stderr separately                   │
│    - Apply timeout protection                           │
│    - Wait for completion                                │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Compare Output to Expected Value                    │
│    - Exact string match                                 │
│    - Boolean interpretation (true/false/1/0/yes/no)     │
│    - Numeric comparison (>=)                            │
│    - String contains (substring match)                  │
└─────────────────────────────────────────────────────────┘
                        ↓
        ┌───────────────┴───────────────┐
        ↓                               ↓
┌──────────────────┐          ┌──────────────────────────┐
│ 6a. SUCCESS      │          │ 6b. VALIDATION FAILURE   │
│ - Reset retries  │          │ (Happy Path - No Errors) │
│ - Move to next   │          │ - Script ran OK          │
└──────────────────┘          │ - Output didn't match    │
                              └──────────────────────────┘
                                        ↓
                              ┌──────────────────────────┐
                              │ 7. Check Retry Allowed   │
                              │ - retryCount < maxRetries│
                              │ - retryPrompt configured │
                              └──────────────────────────┘
                                        ↓
                      ┌─────────────────┴─────────────────┐
                      ↓                                   ↓
            ┌──────────────────┐              ┌──────────────────┐
            │ 8a. RETRY        │              │ 8b. MAX RETRIES  │
            │ - Build prompt   │              │ - Show error     │
            │ - Replace vars   │              │ - User choice:   │
            │ - Send to Copilot│              │   * Stop         │
            │ - Increment count│              │   * Continue     │
            │ - Wait response  │              │   * Manual fix   │
            │ - Back to step 1 │              └──────────────────┘
            └──────────────────┘
```

### 2. Retry Prompt Template Replacement

When a validation fails and `retryPrompt` is configured, FlightPath builds the retry message:

```typescript
function buildRetryPrompt(
  template: string,
  context: {
    scriptOutput: string; // stdout from script
    errorOutput: string; // stderr from script
    expectedValue: string; // from condition.returns
    actualValue: string; // from evaluation result
    retryCount: number; // current retry attempt (1-indexed)
    maxRetries: number; // from condition.maxRetries
  }
): string {
  return template
    .replace(/{scriptOutput}/g, context.scriptOutput.trim())
    .replace(/{errorOutput}/g, context.errorOutput.trim())
    .replace(/{expectedValue}/g, context.expectedValue)
    .replace(/{actualValue}/g, context.actualValue)
    .replace(/{retryCount}/g, String(context.retryCount))
    .replace(/{maxRetries}/g, String(context.maxRetries));
}
```

**Example transformation:**

```
Template: "Tests failed (attempt {retryCount}/{maxRetries}):\n{scriptOutput}\n\nFix the issues."

Context: {
  scriptOutput: "3 tests failed: login, logout, session",
  retryCount: 2,
  maxRetries: 3
}

Result: "Tests failed (attempt 2/3):
3 tests failed: login, logout, session

Fix the issues."
```

### 3. Result Comparison Logic

The `checkResult()` method supports flexible matching:

```typescript
// Exact match
"hello" matches "hello" ✅

// Boolean interpretation
"true" matches: "true", "1", "yes", "pass", "passed" ✅
"false" matches: "false", "0", "no", "fail", "failed" ✅

// Numeric comparison (>=)
"85.5" >= "80.0" ✅
"75" >= "80" ❌

// String contains
"Tests passed: 42/42" contains "passed" ✅
```

### 4. Retry Strategy (Happy Path Focus)

**Focus**: Script executes successfully but indicates validation failure

**Key Distinction**:

- ✅ **Happy Path**: Script runs, exits cleanly, but output doesn't match expected value
- ❌ **Error Path**: Script fails to execute, times out, or throws errors (different handling)

**Retry Decision Tree**:

```
Validation Failed?
  ├─ Yes → Check if error occurred during execution
  │         ├─ Yes (script error/timeout) → Error handling (not retry)
  │         └─ No (clean exit, wrong output) → Check retry conditions
  │                                             ├─ retryPrompt configured? No → Stop/Error
  │                                             ├─ retryCount < maxRetries? No → Stop/Error
  │                                             └─ Both Yes → Build & send retry prompt
  └─ No → Success, move to next prompt
```

## Current Behavior (What Actually Happens)

### During Workflow Execution

1. **Prompt sent to Copilot Chat** ✅
2. **Wait for response completion** ✅
   - Tool callback detected
   - Streaming finishes
3. **End condition timeout used** ⚠️
   - Timeout from `prompt.endCondition?.timeout` is extracted
   - Used as maximum wait time for response completion
   - Default: 30 minutes (1,800,000ms)
4. **Script execution** ❌ **NEVER HAPPENS**
5. **Move to next prompt** ✅

### What's Missing

The `PromptQueue.waitForEndCondition()` method has placeholder code:

```typescript
private async waitForEndCondition(prompt: PromptItem): Promise<void> {
    if (!prompt.endCondition) {
        await this.completeCurrentAndMoveNext();
        return;
    }

    // This would integrate with EndConditionEvaluator
    // For now, simulate waiting with a timeout
    const timeout = prompt.endCondition.timeout || 30000;

    this.executionTimer = setTimeout(async () => {
        console.log(`FlightPath: End condition timeout reached...`);
        // In a real implementation, we would check the actual condition here
        await this.completeCurrentAndMoveNext();
    }, timeout);
}
```

**Problem**: This is never actually called because `FlightPathManager` doesn't invoke it after response completion.

## Failure Scenarios & Handling

### Scenario 1: Validation Failure (Happy Path) ⭐

**What Happens:**

```
Script executes successfully
Script returns: "false"
Expected: "true"
→ Validation FAILS (but script ran correctly)
```

**Retry Logic (NEW):**

When `retryPrompt` is configured and retries are available:

1. **Build retry prompt** from template with placeholders
2. **Send to Copilot** as a continuation of the current task
3. **Increment retry counter**
4. **Wait for response completion**
5. **Re-evaluate end condition**
6. **Repeat** until success or max retries reached

**When Max Retries Exhausted:**

```typescript
// User notification with options
vscode.window.showErrorMessage(
  `End condition failed after ${maxRetries} retries. Script output: ${actualValue}`,
  "Stop Workflow",
  "Continue Anyway",
  "Retry Once More"
);
```

**Example Configuration:**

```json
{
  "prompt": "Implement user authentication with tests",
  "endCondition": {
    "script": "npm test",
    "returns": "all_passed",
    "timeout": 60000,
    "maxRetries": 3,
    "retryPrompt": "The tests are still failing (attempt {retryCount}/{maxRetries}).\n\nTest output:\n{scriptOutput}\n\nPlease fix the failing tests and ensure all tests pass."
  }
}
```

**Execution Flow:**

1. Copilot implements authentication
2. Script runs: `npm test` → outputs "5 tests failed"
3. Doesn't match "all_passed" → **Retry 1**
4. Send retry prompt with test output
5. Copilot fixes issues
6. Script runs: `npm test` → outputs "2 tests failed"
7. Still doesn't match → **Retry 2**
8. Continue until success or max retries (3) reached

### Scenario 2: Script Execution Error (Error Path)

**What Happens:**

```
Script fails to execute (file not found, syntax error, etc.)
→ Execution ERROR (not validation failure)
```

**Current Design:**

```typescript
{
    success: false,
    result: '',
    error: 'Script not found: check_condition.py',
    duration: 250
}
```

**Handling Strategy:**

This is **NOT** the retry path. Execution errors are handled differently:

- Show error notification to user immediately
- **Do not retry** - retries are only for validation failures
- Options:
  - Stop workflow
  - Open script file for editing
  - Skip condition and continue to next prompt
  - Abort entire workflow

**Key Difference:**

- **Validation failure** (happy path) → Use retry mechanism
- **Execution error** (error path) → Stop and notify user

### Scenario 3: Script Timeout (Error Path)

**What Happens:**

```
Script runs longer than timeout duration
→ Process killed
→ Timeout ERROR (not validation failure)
```

**Current Design:**

```typescript
{
    success: false,
    result: 'partial output...',
    error: 'Script execution timed out',
    timeout: true,
    duration: 30000
}
```

**Handling Strategy:**

This is **NOT** the retry path. Timeout errors handled separately:

- Show timeout warning immediately
- **Do not retry** - fix the script or increase timeout
- Options:
  - Increase timeout and retry once
  - Skip condition and continue
  - Abort workflow

**Not Suitable for Retry Logic:**
If a script times out, retrying won't help unless the underlying issue is fixed.

### Scenario 4: Unexpected Output (Happy Path Variant)

**What Happens:**

```
Script executes successfully
Script returns: "partial-success"
Expected: "true"
→ Validation FAILS (clean execution, wrong output)
```

**Handling Strategy:**

This **IS** the retry path if configured:

- If `retryPrompt` exists and retries available → Use retry mechanism
- If no retries configured or exhausted:
  - Log actual vs expected output
  - Show notification to user
  - Options:
    - Manual override ("Treat as success")
    - Stop workflow
    - Continue to next prompt anyway

**Example with Retry:**

```json
{
  "endCondition": {
    "script": "validate_output.py",
    "returns": "success",
    "maxRetries": 2,
    "retryPrompt": "Validation returned '{actualValue}' but expected '{expectedValue}'.\n\nDetails:\n{scriptOutput}\n\nPlease address the issues."
  }
}
```

## Implementation Plan

### Phase 1: Basic Integration with Retry Logic (Primary Focus)

**Goal**: Implement happy path retry mechanism for validation failures

#### 1.1 Update Type Definitions

**File**: `src/types/FlightPathTypes.ts`

```typescript
export interface EndCondition {
  script: string;
  returns: string;
  timeout?: number;
  maxRetries?: number; // NEW: default 0 (no retries)
  retryPrompt?: string; // NEW: template with placeholders
}

export interface PromptResult {
  prompt: string;
  status: "pending" | "sent" | "completed" | "failed";
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
  retryCount?: number; // NEW: track retry attempts
  scriptOutput?: string; // NEW: capture last output for debugging
}
```

#### 1.2 Update EndConditionEvaluator

**File**: `src/flightpath/EndConditionEvaluator.ts`

```typescript
export interface EvaluationResult {
  success: boolean;
  stdout: string;           // CHANGED: separate stdout
  stderr: string;           // CHANGED: separate stderr
  result: string;           // Keep for backward compatibility (same as stdout)
  error?: string;
  timeout?: boolean;
  duration: number;
  exitCode?: number;        // NEW: capture exit code
}

// NEW method
private buildRetryPrompt(
  template: string,
  evaluationResult: EvaluationResult,
  expectedValue: string,
  retryCount: number,
  maxRetries: number
): string {
  return template
    .replace(/{scriptOutput}/g, evaluationResult.stdout.trim())
    .replace(/{errorOutput}/g, evaluationResult.stderr.trim())
    .replace(/{expectedValue}/g, expectedValue)
    .replace(/{actualValue}/g, evaluationResult.result.trim())
    .replace(/{retryCount}/g, String(retryCount))
    .replace(/{maxRetries}/g, String(maxRetries));
}
```

#### 1.3 Update PromptQueue State Tracking

**File**: `src/flightpath/PromptQueue.ts`

```typescript
// Add retry tracking to queue state
private currentRetryCount: number = 0;

// NEW method
private canRetry(prompt: PromptItem): boolean {
  if (!prompt.endCondition?.retryPrompt) {
    return false;
  }
  const maxRetries = prompt.endCondition.maxRetries || 0;
  return this.currentRetryCount < maxRetries;
}

// NEW method
private resetRetryCount(): void {
  this.currentRetryCount = 0;
}

// MODIFY: Reset retries when moving to next prompt
private async completeCurrentAndMoveNext(): Promise<void> {
  // ... existing code ...
  this.resetRetryCount();
  // ... existing code ...
}
```

#### 1.4 Integrate Retry Logic in FlightPathManager

**File**: `src/flightpath/FlightPathManager.ts`

```typescript
// After response completion, evaluate end condition
private async handleResponseComplete(): Promise<void> {
  const currentPrompt = this.promptQueue.getCurrentPrompt();
  if (!currentPrompt?.endCondition) {
    await this.promptQueue.completeCurrentAndMoveNext();
    return;
  }

  // Evaluate end condition
  const evaluator = new EndConditionEvaluator(this.context);
  const result = await evaluator.evaluateCondition(
    currentPrompt.endCondition,
    this.workspaceRoot
  );

  // Check result
  if (result.success) {
    // SUCCESS: Move to next prompt
    console.log('FlightPath: End condition passed');
    await this.promptQueue.completeCurrentAndMoveNext();
    return;
  }

  // Check if this is an execution error (error path)
  if (result.error || result.timeout) {
    // ERROR PATH: Script failed to execute properly
    this.handleExecutionError(result);
    return;
  }

  // VALIDATION FAILURE (happy path): Check retry
  if (this.promptQueue.canRetry(currentPrompt)) {
    await this.handleValidationRetry(currentPrompt, result);
  } else {
    await this.handleMaxRetriesExhausted(currentPrompt, result);
  }
}

// NEW method: Handle validation failure retry
private async handleValidationRetry(
  prompt: PromptItem,
  evaluationResult: EvaluationResult
): Promise<void> {
  this.promptQueue.incrementRetryCount();

  const retryPrompt = this.evaluator.buildRetryPrompt(
    prompt.endCondition!.retryPrompt!,
    evaluationResult,
    prompt.endCondition!.returns,
    this.promptQueue.getCurrentRetryCount(),
    prompt.endCondition!.maxRetries || 0
  );

  console.log(`FlightPath: Retry ${this.promptQueue.getCurrentRetryCount()} - Sending retry prompt`);

  // Send retry prompt to Copilot (same mode as original)
  await this.copilotIntegration.sendPrompt(retryPrompt);

  // Wait for response completion (will re-evaluate condition)
  // Response completion handler will call handleResponseComplete() again
}

// NEW method: Handle max retries exhausted
private async handleMaxRetriesExhausted(
  prompt: PromptItem,
  evaluationResult: EvaluationResult
): Promise<void> {
  const maxRetries = prompt.endCondition?.maxRetries || 0;
  const action = await vscode.window.showErrorMessage(
    `End condition failed after ${maxRetries} retries.\n\nExpected: ${prompt.endCondition?.returns}\nActual: ${evaluationResult.result}`,
    'Stop Workflow',
    'Continue Anyway',
    'View Output'
  );

  if (action === 'Continue Anyway') {
    await this.promptQueue.completeCurrentAndMoveNext();
  } else if (action === 'View Output') {
    // Show output in a new document or output channel
    this.showScriptOutput(evaluationResult);
  } else {
    // Stop workflow
    this.promptQueue.stop();
  }
}

// NEW method: Handle execution errors (not retryable)
private handleExecutionError(result: EvaluationResult): void {
  const message = result.timeout
    ? 'Script execution timed out'
    : `Script execution failed: ${result.error}`;

  vscode.window.showErrorMessage(
    message,
    'Stop Workflow',
    'Skip Condition',
    'Edit Script'
  ).then(action => {
    if (action === 'Skip Condition') {
      this.promptQueue.completeCurrentAndMoveNext();
    } else if (action === 'Edit Script') {
      // Open script file for editing
    } else {
      this.promptQueue.stop();
    }
  });
}
```

#### 1.5 Update JSON Schema

**File**: `schemas/prompt-schema.json`

```json
{
  "definitions": {
    "endCondition": {
      "type": "object",
      "properties": {
        "script": {
          "type": "string",
          "description": "Path to script file to execute"
        },
        "returns": {
          "type": "string",
          "description": "Expected return value from script"
        },
        "timeout": {
          "type": "number",
          "description": "Timeout in milliseconds (default: 30000)"
        },
        "maxRetries": {
          "type": "number",
          "description": "Maximum retry attempts for validation failures (default: 0)",
          "minimum": 0
        },
        "retryPrompt": {
          "type": "string",
          "description": "Template for retry prompt. Supports placeholders: {scriptOutput}, {errorOutput}, {expectedValue}, {actualValue}, {retryCount}, {maxRetries}"
        }
      },
      "required": ["script", "returns"]
    }
  }
}
```

### Phase 2: Enhanced Retry Features (Future)

#### 2.1 Conditional Retry Strategies

```json
{
  "endCondition": {
    "script": "check_tests.py",
    "returns": "passed",
    "maxRetries": 3,
    "retryStrategy": {
      "exponentialBackoff": true, // Wait 1s, 2s, 4s between retries
      "includeHistory": true, // Include previous retry attempts in prompt
      "adaptivePrompt": true // Let AI adjust based on retry count
    }
  }
}
```

#### 2.2 Multiple End Conditions with Retry

```json
{
  "endConditions": {
    "all": [
      {
        "script": "check_tests.py",
        "returns": "true",
        "maxRetries": 3,
        "retryPrompt": "Tests failing:\n{scriptOutput}"
      },
      {
        "script": "check_coverage.py",
        "returns": "80",
        "maxRetries": 2,
        "retryPrompt": "Coverage at {actualValue}%, need {expectedValue}%"
      }
    ],
    "retryStrategy": "sequential" // or "parallel"
  }
}
```

### Phase 3: Advanced Features (Future)

- AI-powered retry prompt generation (use LLM to analyze failure and generate contextual prompt)
- Retry history tracking and analytics
- Visual retry progress indicators
- Configurable retry delay/backoff
- Script output parsing and structured error extraction

## Example Workflows

### Example 1: Test-Driven Development with Retries

```json
{
  "prompts": [
    {
      "prompt": "Implement the calculateTotal() function with proper error handling and unit tests",
      "endCondition": {
        "script": ".flightpath/check_tests.sh",
        "returns": "all_passed",
        "timeout": 60000,
        "maxRetries": 3,
        "retryPrompt": "The tests are not passing yet (attempt {retryCount}/{maxRetries}).\n\nTest output:\n{scriptOutput}\n\nPlease fix the failing tests."
      }
    }
  ]
}
```

**Script (`check_tests.sh`):**

```bash
#!/bin/bash
npm test 2>&1
if [ $? -eq 0 ]; then
    echo "all_passed"
    exit 0
else
    echo "tests_failed"
    exit 0  # Exit cleanly for retry mechanism
fi
```

**Execution Flow:**

1. Copilot implements `calculateTotal()` with tests
2. Run tests → "tests_failed" (validation fails)
3. **Retry 1**: Send retry prompt with test output
4. Copilot fixes implementation
5. Run tests → "tests_failed" (still not passing)
6. **Retry 2**: Send retry prompt again
7. Copilot fixes edge cases
8. Run tests → "all_passed" (success!)
9. Move to next prompt

### Example 2: Compilation Check with Detailed Errors

```json
{
  "prompts": [
    {
      "prompt": "Refactor the UserService class to use dependency injection",
      "endCondition": {
        "script": "npm run build",
        "returns": "success",
        "timeout": 120000,
        "maxRetries": 2,
        "retryPrompt": "The code doesn't compile. Here's the compiler output:\n\n{scriptOutput}\n\nPlease fix these compilation errors."
      }
    }
  ]
}
```

**Script (`package.json`):**

```json
{
  "scripts": {
    "build": "tsc --noEmit && echo 'success' || echo 'failed'"
  }
}
```

**Why This Works:**

- TypeScript compilation errors go to stdout
- Script outputs "success" or "failed" for easy matching
- Retry prompt includes full compiler output with line numbers and error messages

### Example 3: Code Quality Gates

```json
{
  "prompts": [
    {
      "prompt": "Add comprehensive JSDoc comments to all public methods in the API module",
      "endCondition": {
        "script": "check_coverage.py",
        "returns": "pass",
        "timeout": 30000,
        "maxRetries": 2,
        "retryPrompt": "Documentation coverage is at {actualValue}% but we need {expectedValue}%.\n\nMissing documentation:\n{scriptOutput}\n\nPlease add JSDoc comments to the remaining methods."
      }
    }
  ]
}
```

**Script (`check_coverage.py`):**

```python
#!/usr/bin/env python3
import subprocess
import json

# Run documentation coverage tool
result = subprocess.run(['npx', 'documentation-coverage'],
                       capture_output=True, text=True)

# Parse output
coverage = extract_coverage_percentage(result.stdout)

if coverage >= 90:
    print("pass")
    print(f"Coverage: {coverage}%", file=sys.stderr)
else:
    print("fail")
    # Print detailed missing docs for retry prompt
    print(result.stdout)  # Full report goes to scriptOutput

exit(0)  # Always exit cleanly for retry
```

### Example 4: Simple File Existence Check (No Retry Needed)

```json
{
  "prompts": [
    {
      "prompt": "Create a comprehensive README.md file with installation and usage instructions",
      "endCondition": {
        "script": "check_readme.js",
        "returns": "exists",
        "timeout": 10000
        // No retry needed - either file exists or it doesn't
      }
    }
  ]
}
```

**Script (`check_readme.js`):**

```javascript
#!/usr/bin/env node
const fs = require("fs");

if (fs.existsSync("README.md")) {
  const content = fs.readFileSync("README.md", "utf8");
  if (content.length > 500) {
    // At least 500 characters
    console.log("exists");
    process.exit(0);
  }
}

console.log("missing");
process.exit(0);
```

### Example 5: Advanced - Multiple Validation Points

```json
{
  "prompts": [
    {
      "prompt": "Implement secure password hashing with bcrypt and add comprehensive tests",
      "endCondition": {
        "script": "validate_security.sh",
        "returns": "secure",
        "timeout": 90000,
        "maxRetries": 3,
        "retryPrompt": "Security validation failed on attempt {retryCount}/{maxRetries}:\n\n{scriptOutput}\n\n{errorOutput}\n\nPlease address these security concerns."
      }
    }
  ]
}
```

**Script (`validate_security.sh`):**

```bash
#!/bin/bash

# Run security audit
npm audit --audit-level=high > audit.txt 2>&1
AUDIT=$?

# Run tests
npm test > tests.txt 2>&1
TESTS=$?

# Check for proper bcrypt usage
grep -r "bcrypt.hash" src/ > /dev/null 2>&1
BCRYPT=$?

# Combine results
if [ $AUDIT -eq 0 ] && [ $TESTS -eq 0 ] && [ $BCRYPT -eq 0 ]; then
    echo "secure"
    exit 0
else
    echo "insecure"
    # Output what failed for retry prompt
    [ $AUDIT -ne 0 ] && echo "- npm audit found vulnerabilities" && cat audit.txt
    [ $TESTS -ne 0 ] && echo "- tests failing" && cat tests.txt
    [ $BCRYPT -ne 0 ] && echo "- bcrypt.hash not found in code"
    exit 0  # Exit cleanly for retry
fi
```

## Best Practices

### 1. Script Design for Retry Support

✅ **DO:**

- **Exit cleanly (code 0)** even on validation failure - reserve non-zero for errors
- Output simple, parseable values to stdout (e.g., "true", "false", "85")
- Output detailed error messages to stdout for `{scriptOutput}` placeholder
- Use stderr for debug/internal messages only
- Keep scripts fast (< 5 seconds) since they may run multiple times
- Make scripts idempotent (safe to run multiple times)
- Include actionable information in output

**Example (Good):**

```python
#!/usr/bin/env python3
import sys

# Run validation
tests_passed, details = run_tests()

if tests_passed:
    print("true")
    sys.exit(0)  # Clean exit
else:
    print("false")
    # Detailed output for retry prompt
    print(f"\nFailed tests:\n{details}")
    sys.exit(0)  # Still clean exit - this is validation failure, not error
```

❌ **DON'T:**

- Use non-zero exit codes for validation failures (reserve for errors)
- Output verbose logs to stdout (use stderr instead)
- Assume specific directory structure without validation
- Rely on global state between executions
- Perform destructive operations without confirmation
- Mix validation output with progress messages

**Example (Bad):**

```python
#!/usr/bin/env python3
import sys

if not run_tests():
    print("Running tests...")
    print("Test 1... FAILED")
    print("Test 2... PASSED")
    print("Overall: FAILED")
    sys.exit(1)  # BAD: Non-zero exit treated as error, not retry
```

### 2. Retry Prompt Design

✅ **DO:**

- **Include context**: Tell Copilot what failed and why
- **Use placeholders**: Leverage `{scriptOutput}` for dynamic details
- **Be specific**: "Fix the login test failure" > "Fix the tests"
- **Include progress**: Use `{retryCount}/{maxRetries}` to show urgency
- **Format clearly**: Use newlines and structure for readability
- **Guide the fix**: Suggest what to focus on

**Example (Good):**

```json
{
  "retryPrompt": "The tests are still failing (attempt {retryCount}/{maxRetries}).\n\n**Test Results:**\n{scriptOutput}\n\n**Expected:** {expectedValue}\n**Actual:** {actualValue}\n\nPlease fix the failing tests and ensure all edge cases are covered."
}
```

❌ **DON'T:**

- Be vague: "It didn't work, try again"
- Omit useful information: Not including `{scriptOutput}`
- Be too brief: "Failed" (no context)
- Repeat the original prompt: Copilot needs new information
- Blame: "You made a mistake" (be constructive)

**Example (Bad):**

```json
{
  "retryPrompt": "Failed. Try again."
}
```

### 3. Retry Configuration

✅ **DO:**

- **Start with 2-3 retries**: Good balance for most tasks
- **Use retries for fixable issues**: Compilation errors, test failures, style issues
- **Increase timeout for slow operations**: Especially when retrying
- **Provide progressive guidance**: Later retries can be more specific
- **Consider task complexity**: Complex tasks may need more retries

**Recommended Retry Counts:**

- **Simple fixes** (formatting, simple bugs): 1-2 retries
- **Test failures** (unit tests, integration): 2-3 retries
- **Complex refactoring**: 3-5 retries
- **Code generation with validation**: 2-4 retries

❌ **DON'T:**

- Set excessive retries (>5) - indicates wrong approach
- Use retries for non-deterministic issues (timeouts, network errors)
- Retry without providing new information in retryPrompt
- Set retries without timeout consideration

### 4. Timeout Configuration for Retry Scenarios

Since scripts may run multiple times, configure timeouts appropriately:

- **Quick checks** (lint, format): 5,000-10,000ms
- **Test execution** (with potential retries): 30,000-90,000ms
- **Build/compile** (may retry 2-3 times): 60,000-180,000ms
- **Complex validation**: 120,000-300,000ms
- **Maximum**: Never exceed 30 minutes (1,800,000ms)

**Formula**: `timeout >= (script_duration * (maxRetries + 1) * 1.5)`

### 5. Placeholder Usage

Available placeholders and when to use them:

| Placeholder       | Best Used For                                          | Example                                   |
| ----------------- | ------------------------------------------------------ | ----------------------------------------- |
| `{scriptOutput}`  | Detailed error messages, test results, compiler output | "Compiler errors:\n{scriptOutput}"        |
| `{errorOutput}`   | Debug info, warnings (rarely needed in retry prompts)  | "Warnings:\n{errorOutput}"                |
| `{expectedValue}` | Remind Copilot of the goal                             | "Need: {expectedValue}"                   |
| `{actualValue}`   | Show what was achieved                                 | "Got: {actualValue}"                      |
| `{retryCount}`    | Indicate progress/urgency                              | "Attempt {retryCount}/{maxRetries}"       |
| `{maxRetries}`    | Set expectations                                       | "Last chance ({retryCount}/{maxRetries})" |

### 6. Security & Safety

✅ **DO:**

- Review script content before using in workflows
- Use workspace-relative paths
- Validate script output before using in prompts
- Limit script permissions where possible
- Keep scripts in version control

❌ **DON'T:**

- Run scripts from untrusted sources
- Use scripts that modify system settings
- Include secrets in script output
- Allow scripts to access network without validation

## Security Considerations

### Current Protections

1. **Path Validation**
   - Scripts validated before execution
   - Path traversal prevented
   - Must exist in workspace or .flightpath/

2. **Process Isolation**
   - Each script runs in separate child process
   - Processes tracked and killed on disposal
   - No shared state between executions

3. **Timeout Protection**
   - All scripts have maximum execution time
   - Processes force-killed (SIGKILL) on timeout
   - Prevents infinite loops

### Limitations

⚠️ **Scripts have full access to:**

- Workspace file system
- Environment variables
- System commands
- Network (if available)

💡 **Recommendation**: Only use end condition scripts from trusted sources. Review script content before executing workflows.

## Future Enhancements

### 1. Visual End Condition Builder

- GUI for creating end conditions
- Template library
- Script generator

### 2. End Condition Testing

- Command to test scripts independently
- See output without running workflow
- Debug failed conditions

### 3. Condition Monitoring

- Real-time script output streaming
- Progress indicators for long-running scripts
- Script execution history

### 4. Marketplace Integration

- Share end condition scripts
- Community templates
- Rated and reviewed scripts

## Related Documentation

- [Copilot Response Handling](./COPILOT_RESPONSE_HANDLING.md) - How responses are detected
- [Architecture](./ARCHITECTURE.md) - Overall system design
- [Schema Documentation](../schemas/) - JSON schema definitions

## Troubleshooting

### Problem: "Script not found"

**Solution:** Check script path is relative to workspace root or .flightpath/ directory

### Problem: "Unsupported script type"

**Solution:** Use supported extensions: .py, .js, .ts, .sh, .bat, .cmd, .ps1

### Problem: "Script execution timed out"

**Solution:**

- Increase timeout value in endCondition
- Optimize script performance
- Consider if retries are causing cumulative timeout issues

### Problem: "End condition always passes/fails"

**Solution:**

- Verify script outputs expected value to stdout
- Use exit code 0 (don't exit with 1 for validation failures)
- Check comparison logic matches your output format

### Problem: "Retries not triggering"

**Solution:**

- Verify `maxRetries > 0` is set
- Verify `retryPrompt` is configured
- Check that script exits with code 0 (validation failure, not execution error)
- Review logs to see if error path is being triggered instead

### Problem: "Retry prompt doesn't include script output"

**Solution:**

- Verify placeholder syntax: `{scriptOutput}` (case-sensitive, curly braces)
- Check that script outputs to stdout (not stderr)
- Ensure script output is captured before exit

### Problem: "Permission denied"

**Solution:**

- Make script executable: `chmod +x script.sh` (Unix/Linux/Mac)
- Windows: Ensure script extension is associated with an interpreter

### Problem: "Infinite retry loop"

**Solution:**

- Check `maxRetries` is set to a reasonable value (not infinite)
- Verify script can actually distinguish success from failure
- Review retry prompt - is it giving Copilot actionable information?

### Problem: "Script runs but output not captured"

**Solution:**

- Use `print()` in Python, `console.log()` in JavaScript, `echo` in bash
- Flush output buffers if needed
- Don't redirect stdout within the script

### Problem: "Placeholders not replaced in retry prompt"

**Solution:**

- Check placeholder spelling: `{scriptOutput}` not `{script_output}` or `{output}`
- Verify template string is properly formatted in JSON (escape newlines with `\n`)
- Review available placeholders list

---

**Status**: 🚧 **Ready for Implementation** - Comprehensive plan complete for Phase 1 retry mechanism focusing on happy path validation failures.

**Last Updated**: November 13, 2024
