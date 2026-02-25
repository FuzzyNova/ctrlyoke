# Runtime Metadata Audit - January 21, 2026

## Overview

Comprehensive audit of all places where `_runtime` metadata should be updated but might not be. This ensures working files always reflect the actual execution state.

---

## ✅ Already Fixed

### 1. Provider/Model Updates on Resume (FIXED)

**Issue:** When restarting from working files, `_runtime.provider` and `_runtime.model` were not updated to reflect what actually ran.

**Location:** `src/flightpath/cli/CliIntegration.ts` lines 1543-1574

**Fix Applied:**

```typescript
// IMPORTANT: Always create/update provider and model fields, even when resuming
const actualProvider = resolvedProperties?.provider ?? this.getIntegrationMode();
const actualModel = resolvedProperties?.model ?? "";

if (!prompt._runtime) {
  // First execution - create new _runtime
  prompt._runtime = { provider: actualProvider, model: actualModel, ... };
} else {
  // Resuming from working file - update to match what actually ran
  prompt._runtime.provider = actualProvider;
  prompt._runtime.model = actualModel;
  // Keep existing startedAt
}
```

**Status:** ✅ FIXED (January 21, 2026)

---

## ⚠️ Issues Found

### 2. Retry Count Not Persisted to \_runtime

**Issue:** `retryCount` is tracked in `PromptResult` (transient in-memory state) but never copied to `prompt._runtime.retryCount` (persistent working file).

**Impact:**

- After VS Code restart, retry count information is lost
- Users can't see how many times a prompt was retried by inspecting working files
- Session resumption logic can't use retry count for decision making

**Evidence:**

- `PromptRuntimeMetadata` defines `retryCount?: number` (line 118 in FlightPathTypes.ts)
- `PromptQueue` tracks retries in `state.results[i].retryCount` (line 660)
- **BUT** `CliIntegration` never sets `prompt._runtime.retryCount`

**Where to Fix:**
`src/flightpath/cli/CliIntegration.ts` lines 1543-1583

**Proposed Fix:**

```typescript
// Store runtime metadata in prompt's _runtime (always on success, session ID optional)
if (success) {
  // ... existing provider/model/agent updates ...

  // Add retry count if applicable
  if (workflowContext?.promptQueue) {
    const currentRetryCount =
      workflowContext.promptQueue.getCurrentRetryCount();
    if (currentRetryCount > 0) {
      prompt._runtime.retryCount = currentRetryCount;
    }
  }

  // Add session ID if available
  if (extractedSessionId) {
    prompt._runtime.sessionId = extractedSessionId;
  }

  prompt._runtime.completedAt = Date.now();

  // Persist runtime metadata to working file
  if (workflowContext?.promptQueue) {
    await workflowContext.promptQueue.updateWorkingFile();
  }
}
```

**Status:** ⚠️ **NEEDS FIX**

---

### 3. Failure Cases Don't Update \_runtime

**Issue:** When prompt execution fails (errors, validation failures, user cancellation), `_runtime` is not updated at all.

**Impact:**

- Working file shows stale `_runtime` from previous successful attempt
- Users can't see when/why prompts failed by inspecting working files
- No failure timestamp or error message in persistent metadata

**Evidence:**

- Line 1544: `if (success) { ... }` - Only updates `_runtime` on success
- Failure paths (lines 1586+) return early without updating `_runtime`

**Proposed Fix:**
Add failure metadata tracking:

```typescript
// Store runtime metadata in prompt's _runtime (always, not just on success)
const actualProvider =
  resolvedProperties?.provider ?? this.getIntegrationMode();
const actualModel = resolvedProperties?.model ?? "";

if (!prompt._runtime) {
  prompt._runtime = {
    provider: actualProvider,
    model: actualModel,
    agent: actualAgent,
    startedAt: Date.now(),
  };
} else {
  // Update provider/model even on failure
  prompt._runtime.provider = actualProvider;
  prompt._runtime.model = actualModel;
  prompt._runtime.agent = actualAgent;
}

if (success) {
  // Success-specific updates
  if (extractedSessionId) {
    prompt._runtime.sessionId = extractedSessionId;
  }
  prompt._runtime.completedAt = Date.now();
  delete prompt._runtime.failedAt; // Clear any previous failure
  delete prompt._runtime.failureReason;
} else {
  // Failure-specific updates
  prompt._runtime.failedAt = Date.now();
  prompt._runtime.failureReason = this.lastFailureReason;
}

// Always persist to working file
if (workflowContext?.promptQueue) {
  await workflowContext.promptQueue.updateWorkingFile();
}
```

**Note:** This requires extending `PromptRuntimeMetadata` interface:

```typescript
export interface PromptRuntimeMetadata extends ExecutionProperties {
  startedAt: number;
  completedAt?: number;
  failedAt?: number; // NEW: Timestamp when prompt failed
  failureReason?: string; // NEW: Why it failed
  retryCount?: number;
}
```

**Status:** ⚠️ **NEEDS FIX**

---

### 4. Chat Integration May Not Update \_runtime

**Issue:** Haven't audited `CopilotChatIntegration` to verify it updates `_runtime` consistently with CLI integrations.

**Location:** `src/flightpath/chat/CopilotChatIntegration.ts`

**Action Needed:** Review chat integration's sendPrompt implementation to ensure:

- Provider/model/agent are saved to `_runtime`
- Session IDs are tracked (if applicable to chat)
- Retry counts are persisted
- Failure cases update `_runtime`

**Status:** ⚠️ **NEEDS INVESTIGATION**

---

## ✅ Working Correctly

### 5. Working File Updates Are Comprehensive

**Good:** `PromptQueue.updateWorkingFile()` is called in all the right places:

- ✅ After state changes (running, paused, completed, error, stopped)
- ✅ After prompt completion
- ✅ After queue extensions/merges
- ✅ After workflow property updates
- ✅ During MCP-driven appends

**Evidence:** Lines 283, 302, 353, 403, 439, 522, 542, 687, 698, 857 in PromptQueue.ts

**Status:** ✅ WORKING CORRECTLY

---

### 6. Working File Serialization Is Correct

**Good:** Working file includes all `_runtime` fields when saving:

- Provider, model, agent
- Session ID
- Start/completion timestamps
- (Will include retry count and failure info once those are fixed)

**Evidence:** Lines 1340-1359 in PromptQueue.ts

**Status:** ✅ WORKING CORRECTLY

---

## Recommendations

### High Priority Fixes

1. **Add retryCount to \_runtime** (Issue #2)
   - Low complexity, high value for debugging
   - Enables retry count to survive VS Code restarts

2. **Track failure metadata** (Issue #3)
   - Requires interface extension
   - Critical for understanding workflow failures in retrospect

### Medium Priority

3. **Audit CopilotChatIntegration** (Issue #4)
   - Ensure consistency with CLI integrations
   - May uncover similar stale data issues

### Low Priority (Nice to Have)

4. **Add execution duration tracking**
   - `_runtime.executionDuration = completedAt - startedAt`
   - Helpful for performance analysis

5. **Add response preview to \_runtime**
   - `_runtime.responsePreview = response.substring(0, 200)`
   - Helpful for workflow debugging without opening full logs

---

## Testing Checklist

After implementing fixes, verify:

- [ ] Retry count persists across VS Code restarts
- [ ] Failed prompts have `failedAt` and `failureReason` in working file
- [ ] Provider/model updates work when resuming errored workflows
- [ ] Chat integration updates `_runtime` consistently
- [ ] Working file `_runtime` matches actual execution in all scenarios:
  - [ ] First run (no prior `_runtime`)
  - [ ] Resume after restart (existing `_runtime`)
  - [ ] Resume after error (stale `_runtime`)
  - [ ] Resume after workflow property change
  - [ ] Retries (multiple attempts)
  - [ ] Mixed providers (Claude → Copilot → Claude)

---

## Related Documentation

- **Provider fix:** `docs/CROSS_PROVIDER_AUTO_RESUME_FIX.md`
- **Session management:** `docs/SESSION_MANAGEMENT.md`
- **Working file format:** `docs/WORKFLOW_PROPERTIES.md`

---

**Last Updated:** January 21, 2026
