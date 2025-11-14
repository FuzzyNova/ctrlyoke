# End Condition Retry Mechanism - Design Summary

## Overview

This document summarizes the design for FlightPath's end condition retry mechanism, focusing on the **happy path** where validation scripts execute successfully but indicate the task is incomplete (e.g., tests didn't pass, code doesn't compile).

## Core Concept

When Copilot completes a task, an end condition script can validate the result. If validation fails BUT the script ran successfully, FlightPath automatically retries with a custom prompt that includes details about what went wrong.

## Key Design Decisions

### 1. Happy Path vs Error Path

**Happy Path (Retry-eligible):**
- ✅ Script executes successfully (exit code 0)
- ❌ Output doesn't match expected value
- → **Trigger retry mechanism**

**Error Path (Not retry-eligible):**
- ❌ Script fails to execute (file not found, syntax error)
- ❌ Script times out
- → **Show error, don't retry**

### 2. Template String Placeholders

Simple curly-brace syntax for dynamic content:

```typescript
{
  retryPrompt: "Compilation failed:\n\n{scriptOutput}\n\nExpected: {expectedValue}"
}
```

**Available Placeholders:**
- `{scriptOutput}` - stdout from the script
- `{errorOutput}` - stderr from the script
- `{expectedValue}` - what we're looking for
- `{actualValue}` - what we got
- `{retryCount}` - current attempt number
- `{maxRetries}` - maximum attempts configured

**Why This Approach:**
- Simple and predictable (no `eval()`)
- Clear what's available
- Easy to document and use
- Secure by design

### 3. Schema Extensions

**New EndCondition Properties:**

```typescript
interface EndCondition {
  script: string;
  returns: string;
  timeout?: number;
  maxRetries?: number;      // NEW: Default 0 (no retries)
  retryPrompt?: string;     // NEW: Template with placeholders
}
```

**Updated EvaluationResult:**

```typescript
interface EvaluationResult {
  success: boolean;
  stdout: string;           // CHANGED: Separate stdout
  stderr: string;           // CHANGED: Separate stderr
  result: string;           // Keep for compatibility
  error?: string;
  timeout?: boolean;
  duration: number;
  exitCode?: number;        // NEW: Capture exit code
}
```

**Enhanced PromptResult (for tracking):**

```typescript
interface PromptResult {
  prompt: string;
  status: "pending" | "sent" | "completed" | "failed";
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
  retryCount?: number;      // NEW: Track attempts
  scriptOutput?: string;    // NEW: Debugging info
}
```

### 4. Retry Flow

```
Response Complete
  ↓
Evaluate End Condition
  ↓
Success? → Move to next prompt ✅
  ↓ No
Execution Error? → Show error dialog ❌ (don't retry)
  ↓ No
Validation Failure (Happy Path)
  ↓
retryPrompt configured AND retries available?
  ↓ Yes
Build retry prompt (replace placeholders)
  ↓
Send to Copilot
  ↓
Increment retry counter
  ↓
Wait for response
  ↓
Evaluate End Condition (repeat)
```

### 5. Script Design Guidelines

**Key Requirement**: Scripts must exit with code 0 for validation failures

**Why?** Non-zero exit codes reserved for execution errors (which don't retry)

**Example:**

```python
#!/usr/bin/env python3
import sys

if tests_passed():
    print("true")
    sys.exit(0)  # Success
else:
    print("false")
    print("Failed tests: login, logout")  # Details for retry
    sys.exit(0)  # Still exit 0 - this is validation failure, not error
```

## Implementation Checklist

### Phase 1: Basic Retry Mechanism

- [ ] Update `EndCondition` type with `maxRetries` and `retryPrompt`
- [ ] Update `EvaluationResult` to separate stdout/stderr
- [ ] Update `PromptResult` to track retry count
- [ ] Add `buildRetryPrompt()` method to EndConditionEvaluator
- [ ] Update PromptQueue to track retry count per prompt
- [ ] Implement retry logic in FlightPathManager:
  - [ ] Distinguish happy path (retry) from error path
  - [ ] Build and send retry prompts
  - [ ] Handle max retries exhausted
  - [ ] Handle execution errors separately
- [ ] Update JSON schema with new fields
- [ ] Add IntelliSense for placeholders in retryPrompt

### Phase 2: Enhanced Features (Future)

- [ ] Exponential backoff between retries
- [ ] Include retry history in prompts
- [ ] Multiple end conditions with retry
- [ ] AI-powered retry prompt generation
- [ ] Retry analytics and visualization

## Example Use Cases

### 1. Test-Driven Development
```json
{
  "endCondition": {
    "script": "npm test",
    "returns": "all_passed",
    "maxRetries": 3,
    "retryPrompt": "Tests failing:\n{scriptOutput}\n\nFix these issues."
  }
}
```

### 2. Compilation Validation
```json
{
  "endCondition": {
    "script": "npm run build",
    "returns": "success",
    "maxRetries": 2,
    "retryPrompt": "Compilation errors:\n\n{scriptOutput}\n\nFix the errors above."
  }
}
```

### 3. Code Quality Gates
```json
{
  "endCondition": {
    "script": "check_coverage.py",
    "returns": "pass",
    "maxRetries": 2,
    "retryPrompt": "Coverage at {actualValue}%, need {expectedValue}%.\n\n{scriptOutput}"
  }
}
```

## Benefits

1. **Self-Correcting Workflows**: Copilot automatically fixes issues based on feedback
2. **Reduced Manual Intervention**: Validation failures handled automatically
3. **Contextual Feedback**: Script output included in retry prompts
4. **Flexible Configuration**: Users control retry count and messaging
5. **Progressive Refinement**: Each retry includes updated feedback

## Security Considerations

- Scripts exit cleanly (code 0) even on validation failure
- Non-zero exits reserved for actual errors
- Script output sanitized before including in prompts
- Retry count limits prevent infinite loops
- Scripts run in isolated processes with timeout protection

## Files to Modify

1. `src/types/FlightPathTypes.ts` - Type definitions
2. `src/flightpath/EndConditionEvaluator.ts` - Evaluation logic and template replacement
3. `src/flightpath/PromptQueue.ts` - Retry counter tracking
4. `src/flightpath/FlightPathManager.ts` - Main retry orchestration
5. `schemas/prompt-schema.json` - Schema updates
6. `docs/END_CONDITION_HANDLING.md` - Documentation (✅ COMPLETED)

## Testing Strategy

### Unit Tests
- Template placeholder replacement
- Retry count tracking
- Happy path vs error path distinction

### Integration Tests
- Full retry flow with mock Copilot
- Max retries exhausted behavior
- Script output capture and inclusion

### Manual Tests
- Real test failure scenarios
- Compilation error scenarios
- Timeout vs validation failure distinction

---

**Status**: Design Complete - Ready for Implementation
**Created**: November 13, 2024
**Author**: Nathan (with Copilot Prompt Planner)
