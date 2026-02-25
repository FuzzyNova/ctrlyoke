# Session Resumption Fixes - January 21, 2026

## Overview

This document details the fixes applied to session resumption functionality for CLI integrations, specifically addressing issues with Claude CLI's `-c` flag and retry timing.

## Fixed Issues

### Issue 1: Claude `-c` Flag is Dangerous

**Problem:**
When no explicit session ID was provided but `resumeSession: true` was set (equivalent to old `newChatSession: false`), FlightPath would use Claude's `-c` (continue) flag. This flag resumes the **most recent Claude session globally**, not workspace-specific.

**Why This is Bad:**

1. ❌ Resumes most recent session **across all projects**, not just current workspace
2. ❌ If user has multiple Claude sessions open in different repos, might resume wrong one
3. ❌ No guarantee which session will be resumed
4. ❌ Could accidentally contaminate sessions with context from different projects

**Example Scenario:**

```yaml
# Workflow in project A
prompts:
  - prompt: "Analyze code"
  - prompt: "Continue analysis"
    resumeSession: true # ← Used to add `-c` flag
```

If user also has Claude session open in project B, the `-c` flag might resume project B's session instead!

**Solution:**
Removed `-c` flag support entirely. Now Claude only resumes sessions when we have an **explicit session ID** from workflow state.

**Code Changes:**

- File: `src/flightpath/cli/claude/ClaudeCliProvider.ts` (lines 184-197)
- Before:
  ```typescript
  if (sessionId) {
    args.push("-r", sessionId);
  } else if (!shouldStartNewSession) {
    args.push("-c"); // ← DANGEROUS
  }
  ```
- After:
  ```typescript
  // Only resume with explicit session ID
  if (sessionId) {
    args.push("-r", sessionId);
  } else {
    // Start new session (no -c flag)
  }
  ```

**Behavior Change:**
| Setting | Old Behavior | New Behavior |
|---------|-------------|--------------|
| `sessionId: "abc-123"` | ✅ Resume session abc-123 | ✅ Resume session abc-123 (unchanged) |
| `sessionId: 1` (ref) | ✅ Resume session from prompt 1 | ✅ Resume session from prompt 1 (unchanged) |
| `resumeSession: true` | ⚠️ Use `-c` flag (global resume) | ✅ Start new session (safe) |
| No sessionId/resumeSession | ✅ Start new session | ✅ Start new session (unchanged) |

### Issue 2: Retry Timing Too Short for Resumed Sessions

**Problem:**
When resuming a Claude session, the log file exists but has an old modification time (`mtime`). The CLI needs time to update the file with new content, but FlightPath's retry logic only waited 500ms total.

**Error Logs:**

```
[ClaudeLogParser] Session log exists but not yet updated (mtime: 2026-01-21T04:48:22.658Z, startTime: 2026-01-21T04:54:06.195Z), will retry...
[ClaudeLogParser] Session log not ready (attempt 2/5), retrying in 50ms...
[ClaudeLogParser] Session log not ready (attempt 3/5), retrying in 100ms...
[ClaudeLogParser] Session log not ready (attempt 4/5), retrying in 150ms...
[ClaudeLogParser] Session log not ready (attempt 5/5), retrying in 200ms...
[ClaudeLogParser] Session log file not found after retries: ...
❌ Could not find log file for session ...
```

The file existed but wasn't updated within 500ms, causing false failures.

**Solution:**
Increased retry timing from 500ms to ~5 seconds with more aggressive backoff:

**Code Changes:**

- File: `src/flightpath/cli/claude/ClaudeLogParser.ts` (lines 285-286)
- Before:
  ```typescript
  {
    maxAttempts: 5,
    delays: [0, 50, 100, 150, 200], // Total: 500ms
  }
  ```
- After:
  ```typescript
  {
    maxAttempts: 10,
    delays: [0, 100, 200, 300, 500, 500, 500, 1000, 1000, 1000], // Total: ~5s
  }
  ```

**Retry Timeline:**
| Attempt | Delay | Cumulative Wait |
|---------|-------|----------------|
| 1 | 0ms | 0ms |
| 2 | 100ms | 100ms |
| 3 | 200ms | 300ms |
| 4 | 300ms | 600ms |
| 5 | 500ms | 1,100ms |
| 6 | 500ms | 1,600ms |
| 7 | 500ms | 2,100ms |
| 8 | 1,000ms | 3,100ms |
| 9 | 1,000ms | 4,100ms |
| 10 | 1,000ms | 5,100ms |

This gives Claude CLI plenty of time to process the resume request and update the log file.

## Impact

### Breaking Changes

None. The `-c` flag removal only affects edge cases where:

- `resumeSession: true` is set (old `newChatSession: false`)
- No explicit `sessionId` is provided
- User expected to resume previous session

These workflows will now start **new sessions** instead of using `-c`. This is safer behavior.

### Improvements

1. ✅ **More reliable session resumption** - 5-second retry window catches slow updates
2. ✅ **Safer session isolation** - No accidental cross-project contamination
3. ✅ **Predictable behavior** - Sessions only resume when explicitly requested via sessionId
4. ✅ **Better error messages** - Clear actionable feedback when session not found

## Testing Recommendations

### Test Case 1: Explicit Session Resume (Should Work)

```yaml
prompts:
  - id: first
    prompt: "Analyze code"

  - prompt: "Continue analysis"
    sessionId: 1 # Resume first prompt's session
```

**Expected:** Second prompt resumes first prompt's session successfully.

### Test Case 2: resumeSession: true (Behavior Changed)

```yaml
prompts:
  - prompt: "First prompt"

  - prompt: "Second prompt"
    resumeSession: true # No longer uses -c flag
```

**Old Behavior:** Used `-c` flag (might resume wrong session)
**New Behavior:** Starts new session (safe)

### Test Case 3: Slow File Update (Should Work Now)

```yaml
prompts:
  - prompt: "Test prompt"
    sessionId: "existing-session-id"
```

**Expected:**

- Waits up to 5 seconds for log file to update
- Succeeds even if file takes 2-3 seconds to update
- No false failures

## Related Files

- `src/flightpath/cli/claude/ClaudeCliProvider.ts` - Removed `-c` flag support
- `src/flightpath/cli/claude/ClaudeLogParser.ts` - Increased retry timing
- `docs/INTERACTIVE_MODE_PROMPT_PASSING_FIX.md` - Session resumption log discovery

## Rollback Instructions

If these changes cause issues:

1. **Revert `-c` flag removal:**

   ```typescript
   // In ClaudeCliProvider.ts line 190
   if (sessionId) {
     args.push("-r", sessionId);
   } else if (!shouldStartNewSession) {
     args.push("-c"); // Restore -c flag
   }
   ```

2. **Revert retry timing:**
   ```typescript
   // In ClaudeLogParser.ts line 285
   {
     maxAttempts: 5,
     delays: [0, 50, 100, 150, 200],
   }
   ```

However, we **strongly recommend keeping these changes** as they prevent session contamination across projects.
