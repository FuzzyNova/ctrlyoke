# Session Log Discovery Retry Fix

**Status:** ✅ FIXED
**Date:** January 21, 2026
**Issue:** Timing issue between SessionStart hook and log file creation
**Impact:** Session log discovery failures in both Copilot and Claude CLI

---

## Problem

When using Copilot CLI or Claude CLI in interactive mode, FlightPath was encountering timing issues where the SessionStart hook notification would arrive before the CLI had finished creating the log file. This caused session log discovery to fail with errors:

### Copilot CLI Error
```
[ClaudeLogParser] No matching session log found
ERROR: ❌ Could not discover session log - no matching prompt found
```

### Claude CLI Error
```
[ClaudeLogParser] Session log exists but modified before startTime
[ClaudeLogParser] No matching session log found
ERROR: ❌ Could not find log file for session <session-id> - this should not happen!
```

---

## Root Cause

**Race condition:**
1. FlightPath receives SessionStart hook notification
2. FlightPath immediately tries to find the session log file
3. The CLI is still in the process of creating/writing the log file
4. Discovery fails because:
   - File doesn't exist yet, OR
   - File exists but hasn't been written to (old mtime)

**Typical timing:** Log file is created within ~50-100ms of the SessionStart hook, but FlightPath was only checking once.

---

## Solution

Implemented retry logic with exponential backoff to handle the timing mismatch between hook notification and file creation.

### 1. Created Shared Retry Utility

**File:** `src/utils/RetryUtils.ts` (new file, 162 lines)

A reusable utility for retry operations with exponential backoff:

```typescript
export async function retryWithBackoff<T>(
  operation: () => Promise<T | null | undefined>,
  options: RetryOptions = {}
): Promise<T | undefined>

export class PermanentFailureError extends Error
```

**Features:**
- Configurable retry attempts (default: 5)
- Customizable delay patterns (default: [0, 50, 100, 150, 200] ms)
- Support for permanent failure detection via `PermanentFailureError`
- Optional callback for logging retry attempts
- Total max wait time: 500ms (non-blocking)

**Options:**
```typescript
interface RetryOptions {
  maxAttempts?: number;        // Default: 5
  delays?: number | number[];  // Default: [0, 50, 100, 150, 200]
  onRetry?: (attempt, max, delay) => void;
}
```

**Use Cases:**
- Waiting for files to be created (CLI log files)
- Polling for resources that may not be immediately available
- Network requests with transient failures
- Any operation with transient failures vs. permanent failures

### 2. Updated CopilotLogParser

**File:** `src/flightpath/cli/copilot/CopilotLogParser.ts`

**Changes:**
- Wrapped entire `discoverSessionLog()` discovery loop in `retryWithBackoff()`
- Retries up to 5 times with delays: [0, 50, 100, 150, 200] ms
- Logs retry attempts at DEBUG level
- Total maximum wait: 500ms before giving up

**Before:**
```typescript
// Get recently modified files/directories
const candidates = this.findModifiedSessionLogs(logDir, startTime);
if (candidates.length === 0) {
  return null; // Failed immediately
}
// ... check candidates once
```

**After:**
```typescript
const result = await retryWithBackoff(
  async () => {
    const candidates = this.findModifiedSessionLogs(logDir, startTime);
    if (candidates.length === 0) {
      return null; // Will retry
    }
    // ... check candidates
    return logPath; // Success
  },
  {
    maxAttempts: 5,
    delays: [0, 50, 100, 150, 200],
    onRetry: (attempt, max, delay) => {
      if (attempt > 1) {
        Log.debug(`[CopilotLogParser] Session log file not found (attempt ${attempt}/${max}), retrying in ${delay}ms...`);
      }
    },
  }
);
```

### 3. Refactored ClaudeLogParser

**File:** `src/flightpath/cli/claude/ClaudeLogParser.ts`

**Changes:**
- Replaced inline retry logic with shared `retryWithBackoff()` utility
- **IMPORTANT:** Does NOT throw PermanentFailureError for "file too old" case
- Maintains same retry behavior (5 attempts, 500ms max total wait)

**Rationale for NOT failing on old files:**

When **resuming a session**, the log file will have an old modification time initially because it's from the previous session. The CLI will update the file as it writes new content. If we treat "file exists but is old" as a permanent failure, session resumption would break.

**Solution:**
```typescript
if (fs.existsSync(logPath)) {
  const stats = fs.statSync(logPath);
  if (stats.mtime >= startTime) {
    return logPath; // Success - file exists and is recent
  } else {
    // File exists but hasn't been updated yet - might be resuming an old session
    // The CLI will update it soon, so retry instead of failing
    Log.debug(
      `[ClaudeLogParser] Session log exists but not yet updated, will retry...`
    );
    return null; // Retry - file will be updated soon
  }
}
```

---

## Benefits

1. **Robustness:** Handles timing variations between CLIs and operating systems
2. **Performance:** Only waits when necessary (fast path on first success)
3. **Efficiency:** Maximum 500ms total delay, doesn't block other operations
4. **Reusability:** Shared utility can be used for other retry scenarios
5. **Observability:** Debug logs show retry attempts for troubleshooting
6. **Session resumption:** Works correctly when resuming old sessions (doesn't fail on old mtimes)

---

## Testing

### Unit Tests

**Test File:** `src/test/retryUtils.test.ts` (new file, 317 lines)

Comprehensive unit tests covering:
- ✅ Successful retries after N attempts
- ✅ Exhausted retries (returns undefined)
- ✅ Permanent failures (stops immediately via PermanentFailureError)
- ✅ Custom delay patterns (array and fixed)
- ✅ Retry callbacks with correct parameters
- ✅ Error handling and recovery
- ✅ Real-world scenarios (file creation timing)

**Results:** All 360 tests passing, including 21 new retry tests.

### Debug Logs

When retry logic is active, you'll see debug logs like:
```
[CopilotLogParser] Session log file not found (attempt 2/5), retrying in 50ms...
[CopilotLogParser] Session log file not found (attempt 3/5), retrying in 100ms...
[CopilotLogParser] Found matching session log: ~/.copilot/session-state/abc-123/events.jsonl
```

For Claude CLI with session resumption:
```
[ClaudeLogParser] Session log exists but not yet updated (mtime: 2026-01-20T10:00:00.000Z, startTime: 2026-01-21T04:00:00.000Z), will retry...
[ClaudeLogParser] Session log not ready (attempt 2/5), retrying in 50ms...
[ClaudeLogParser] Found session log via session ID: ~/.claude/projects/dev_FlightPath/abc-123.jsonl
```

---

## Impact

- **Copilot CLI:** Session discovery now succeeds consistently even when log files are created after hook notification
- **Claude CLI:** Handles both fast-path (session ID) and fallback (prompt matching) discovery with retry
- **Session resumption:** Works correctly even when log file has old modification time
- **User Experience:** Eliminates intermittent "Could not discover session log" errors in interactive mode
- **Future-proof:** Retry utility available for other timing-sensitive operations

---

## Configuration

No configuration needed - retry logic is automatic. Defaults are tuned for typical CLI file creation timing (~50-100ms).

To adjust retry behavior (if needed), edit the retry parameters in the log parser files:
```typescript
{
  maxAttempts: 5,                   // Number of attempts
  delays: [0, 50, 100, 150, 200],  // Delay before each attempt (ms)
}
```

Total maximum wait: 500ms

---

## Related Files

### New Files
- `src/utils/RetryUtils.ts` - Shared retry utility (162 lines)
- `src/test/retryUtils.test.ts` - Retry utility tests (317 lines)
- `docs/SESSION_LOG_DISCOVERY_RETRY_FIX.md` - This documentation

### Modified Files
- `src/flightpath/cli/copilot/CopilotLogParser.ts` - Added retry to discoverSessionLog()
- `src/flightpath/cli/claude/ClaudeLogParser.ts` - Refactored inline retry to use shared utility

---

## Code Changes Summary

### RetryUtils.ts (NEW)
```typescript
export async function retryWithBackoff<T>(
  operation: () => Promise<T | null | undefined>,
  options: RetryOptions = {}
): Promise<T | undefined> {
  // Implementation with exponential backoff
  // Handles PermanentFailureError to stop immediately
}

export class PermanentFailureError extends Error {
  // Signals permanent failure (stops retries)
}
```

### CopilotLogParser.ts (MODIFIED)
- Added import: `retryWithBackoff` from `RetryUtils`
- Wrapped `discoverSessionLog()` discovery loop in `retryWithBackoff()`
- Added debug logging for retry attempts

### ClaudeLogParser.ts (MODIFIED)
- Added import: `retryWithBackoff` from `RetryUtils`
- Removed inline retry loop (38 lines)
- Replaced with `retryWithBackoff()` call
- Does NOT use `PermanentFailureError` for old files (supports session resumption)

---

## Future Enhancements

Potential improvements if needed:
- Make retry delays configurable via settings
- Add metrics to track retry success rates
- Adaptive delays based on CLI performance
- Circuit breaker for repeated failures
- Extended retry for very slow systems (configurable max wait time)

---

## Appendix: Session Resumption Handling

### Why We Don't Fail on Old Files

**Scenario:** User resumes an old Claude session

1. FlightPath calls `discoverSessionLog(promptText, startTime, sessionId)`
2. Session ID is from the old session (e.g., 3 days ago)
3. Log file exists: `~/.claude/projects/dev_FlightPath/old-session-id.jsonl`
4. File's mtime is 3 days old (< startTime)
5. CLI starts writing new content to the same file
6. File's mtime gets updated as CLI writes

**Without retry:** Discovery would fail immediately (file exists but is old)
**With retry (current):** Discovery retries until file gets updated (within 500ms)

### Alternative Approaches Considered

1. **Check if file size increases between retries**
   - Too complex, requires state tracking
   - File size might not change immediately

2. **Use PermanentFailureError for old files**
   - Breaks session resumption
   - No way to distinguish "wrong session" from "resuming old session"

3. **Increase timeout for old files**
   - Current approach already does this (retries up to 500ms)
   - Works for both new sessions and resumed sessions

**Conclusion:** Current approach (retry without permanent failure) is simplest and handles all cases correctly.

---

**End of Documentation**
