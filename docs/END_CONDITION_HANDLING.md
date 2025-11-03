# FlightPath End Condition Handling

## Overview

End conditions in FlightPath are **optional validation checks** that determine whether a workflow step has completed successfully. They are defined in prompt files and executed by the `EndConditionEvaluator` class.

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
    "timeout": 30000
  }
}
```

### Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `script` | string | Yes | Path to executable script (relative or absolute) |
| `returns` | string | Yes | Expected output value from script |
| `timeout` | number | No | Max execution time in milliseconds (default: 30000) |

### Supported Script Types

The `EndConditionEvaluator` supports multiple script formats:

- **Python** (`.py`) - Executed with `python`
- **JavaScript** (`.js`) - Executed with `node`
- **TypeScript** (`.ts`) - Executed with `npx ts-node`
- **Bash** (`.sh`) - Executed with `sh` (or `bash` on Windows)
- **Windows Batch** (`.bat`, `.cmd`) - Executed with `cmd /c`
- **PowerShell** (`.ps1`) - Executed with `powershell -ExecutionPolicy Bypass`

## How End Conditions Should Work (Design)

### 1. Script Execution Flow

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
│    - Collect stdout/stderr                              │
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
┌──────────────────┐          ┌──────────────────┐
│ 6a. SUCCESS      │          │ 6b. FAILURE      │
│ - Mark completed │          │ - Mark failed    │
│ - Move to next   │          │ - Handle error   │
└──────────────────┘          └──────────────────┘
```

### 2. Result Comparison Logic

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

## Failure Scenarios & Handling (Not Implemented)

### Scenario 1: End Condition Script Fails

**What Should Happen:**
```
Script returns: "false"
Expected: "true"
→ Condition FAILS
```

**Proposed Handling Options:**

1. **Auto-Retry (Recommended)**
   - Send a follow-up prompt to Copilot
   - Example: "The previous task did not complete successfully. {reason}. Please continue working on it."
   - Max retries: 3 (configurable)

2. **Stop with Error**
   - Mark workflow as failed
   - Show error notification to user
   - Allow manual intervention

3. **Skip and Continue**
   - Mark as completed with warning
   - Continue to next prompt
   - Log failure for review

### Scenario 2: Script Execution Error

**What Should Happen:**
```
Script fails to execute (file not found, syntax error, etc.)
→ Execution ERROR
```

**Current Behavior (if implemented):**
```typescript
{
    success: false,
    result: '',
    error: 'Script not found: check_condition.py',
    duration: 250
}
```

**Proposed Handling:**
- Show error notification to user
- Offer to open script file for editing
- Option to skip condition and continue
- Option to abort workflow

### Scenario 3: Script Timeout

**What Should Happen:**
```
Script runs longer than timeout duration
→ Process killed
→ Timeout ERROR
```

**Current Behavior (if implemented):**
```typescript
{
    success: false,
    result: 'partial output...',
    error: 'Script execution timed out',
    timeout: true,
    duration: 30000
}
```

**Proposed Handling:**
- Show timeout warning
- Allow user to increase timeout and retry
- Option to skip and continue
- Option to abort workflow

### Scenario 4: Script Returns Unexpected Output

**What Should Happen:**
```
Script returns: "partial-success"
Expected: "true"
→ Condition FAILS (doesn't match any comparison logic)
```

**Proposed Handling:**
- Log actual vs expected output
- Show diff to user
- Allow manual override ("Treat as success"/"Treat as failure")

## Implementation Plan

### Phase 1: Basic Integration

1. **Connect EndConditionEvaluator to FlightPathManager**
   - Add method call in `waitForResponseComplete()`
   - Pass working directory and timeout

2. **Handle Success Case**
   - If condition passes, move to next prompt
   - Log success message

3. **Handle Failure Case**
   - Stop workflow execution
   - Show error dialog to user
   - Allow manual "Continue Anyway" option

### Phase 2: Auto-Retry Logic

1. **Implement Retry Configuration**
   ```json
   {
     "endCondition": {
       "script": "check_tests.py",
       "returns": "true",
       "maxRetries": 3,
       "retryPrompt": "Tests are still failing. Please fix the issues and try again."
     }
   }
   ```

2. **Add Retry Counter**
   - Track attempts per prompt
   - Reset on success
   - Abort after max retries

3. **Smart Retry Prompts**
   - Include script output/error in retry prompt
   - Give Copilot context about what failed

### Phase 3: Advanced Features

1. **Multiple End Conditions**
   ```json
   {
     "endConditions": {
       "all": [
         { "script": "check_tests.py", "returns": "true" },
         { "script": "check_coverage.py", "returns": "80" }
       ]
     }
   }
   ```

2. **Conditional End Conditions**
   ```json
   {
     "endCondition": {
       "script": "check_environment.sh",
       "returns": "production",
       "onMatch": {
         "script": "run_integration_tests.py"
       },
       "onMismatch": {
         "skip": true
       }
     }
   }
   ```

3. **AI-Powered End Conditions** (Future)
   - Use VS Code Language Model API
   - Let AI analyze Copilot's response
   - Determine completion without scripts

## Example Workflows

### Example 1: Test-Driven Development

```json
{
  "prompts": [
    {
      "prompt": "Implement the calculateTotal() function with proper error handling",
      "endCondition": {
        "script": ".flightpath/check_tests.sh",
        "returns": "all_passed",
        "timeout": 60000
      }
    }
  ]
}
```

**Script (`check_tests.sh`):**
```bash
#!/bin/bash
npm test > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "all_passed"
    exit 0
else
    echo "tests_failed"
    exit 1
fi
```

### Example 2: Code Coverage Check

```json
{
  "prompts": [
    {
      "prompt": "Add unit tests for the UserAuth module",
      "endCondition": {
        "script": "check_coverage.py",
        "returns": "85",
        "timeout": 120000
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

result = subprocess.run(['npm', 'run', 'coverage:json'], 
                       capture_output=True, text=True)
data = json.loads(result.stdout)
coverage = data['total']['lines']['pct']

print(str(int(coverage)))  # Output: "85"
exit(0 if coverage >= 85 else 1)
```

### Example 3: File Existence Check

```json
{
  "prompts": [
    {
      "prompt": "Create a README.md file with project documentation",
      "endCondition": {
        "script": "check_readme.js",
        "returns": "exists",
        "timeout": 10000
      }
    }
  ]
}
```

**Script (`check_readme.js`):**
```javascript
#!/usr/bin/env node
const fs = require('fs');

if (fs.existsSync('README.md')) {
    const content = fs.readFileSync('README.md', 'utf8');
    if (content.length > 100) {
        console.log('exists');
        process.exit(0);
    }
}

console.log('missing');
process.exit(1);
```

## Best Practices

### 1. Script Design

✅ **DO:**
- Output a single, simple value (e.g., "true", "false", "85")
- Use exit code 0 for success, non-zero for failure
- Keep scripts fast (< 5 seconds)
- Include error messages in stderr
- Make scripts idempotent

❌ **DON'T:**
- Output verbose logs to stdout
- Assume specific directory structure
- Rely on global state
- Perform destructive operations
- Use scripts for side effects

### 2. Timeout Configuration

- **Quick checks** (file exists): 5,000-10,000ms
- **Test execution**: 30,000-120,000ms
- **Build/compile**: 120,000-300,000ms
- **Never** exceed 30 minutes (workflow safety timeout)

### 3. Error Messages

Make error messages actionable:

```python
# Good
if not tests_passed:
    print("false")
    print("3 tests failed: test_login, test_logout, test_session", file=sys.stderr)
    exit(1)

# Bad
if not tests_passed:
    print("no")
    exit(1)
```

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
**Solution:** Increase timeout value or optimize script performance

### Problem: "End condition always passes/fails"
**Solution:** Verify script outputs expected value to stdout and uses correct exit code

### Problem: "Permission denied"
**Solution:** Make script executable: `chmod +x script.sh` (Unix/Linux/Mac)

---

**Status**: 🚧 Under Construction - End conditions are designed but not integrated into workflow execution yet.

**Last Updated**: November 3, 2025
