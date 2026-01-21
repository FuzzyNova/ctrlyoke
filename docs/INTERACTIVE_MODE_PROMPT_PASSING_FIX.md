# Session Resumption Log Discovery Fix

## Problem

When resuming a CLI session, FlightPath was unable to find the log file even though the session existed on disk. This happened because:

1. **CliIntegration** was passing the `resolvedSessionId` to `buildCliArgs()` (which adds `--resume <session-id>` to the CLI command) ✅
2. **CliIntegration** was passing the `resolvedSessionId` to `discoverSessionLog()` ✅
3. **BUT** the log parser implementations were **ignoring** the `sessionId` parameter ❌

## Root Cause

The log parser implementations had inconsistent method signatures:

- ❌ **CopilotLogParser**: Missing `sessionId` parameter entirely
- ✅ **ClaudeLogParser**: Had `sessionId` parameter and used it correctly
- ❌ **CodexLogParser**: Missing `sessionId` parameter entirely

When `CliIntegration.executeInTerminal()` called `discoverSessionLog(promptText, startTime, resolvedSessionId)`, the `resolvedSessionId` was being silently ignored by Copilot and Codex parsers.

## Solution

### 1. Updated CliIntegration.executeInTerminal()

Added session resumption fast path (lines 536-555):

```typescript
// If we already have a resolved session ID (from resumption), use it directly
if (resolvedSessionId) {
  Log.info(
    `🔄 Resuming session ${resolvedSessionId} - discovering log file directly...`
  );

  logPath = await this.provider.logParser.discoverSessionLog(
    promptText,
    startTime,
    resolvedSessionId
  );

  if (!logPath) {
    Log.error(
      `❌ Could not find log file for resumed session ${resolvedSessionId}\n` +
        `   The session may have been deleted or never existed.\n` +
        `   To fix: Remove the sessionId property to start a new session.`
    );
    this.lastFailureReason = "Log file not found for resumed session";
    return { success: false };
  }

  Log.info(`✅ Found log file for resumed session: ${logPath}`);
}
```

This creates a three-tier log discovery strategy:
1. **Resumed sessions** (highest priority): Use `resolvedSessionId` directly → Fast path
2. **SessionStart hook** (Claude new sessions): Wait for hook notification → Reliable for new sessions
3. **Prompt matching** (Copilot/Codex fallback): Match prompt text in logs → Slowest/least reliable

### 2. Updated CopilotLogParser.discoverSessionLog()

Added sessionId parameter and fast path logic:

```typescript
async discoverSessionLog(
  promptText: string,
  startTime: Date,
  sessionId?: string  // ← Added this parameter
): Promise<string | null> {
  // ...

  // If session ID provided, construct path directly (resumed sessions)
  if (sessionId) {
    // Try directory format: ~/.copilot/session-state/{sessionId}/events.jsonl
    const sessionDir = path.join(logDir, sessionId);
    const eventsPath = path.join(sessionDir, "events.jsonl");

    if (fs.existsSync(eventsPath)) {
      return eventsPath;
    }

    // Try flat file format: ~/.copilot/session-state/{sessionId}.jsonl
    const flatPath = path.join(logDir, `${sessionId}.jsonl`);
    if (fs.existsSync(flatPath)) {
      return flatPath;
    }

    return null;  // Session ID provided but not found
  }

  // Fallback to prompt text matching...
}
```

### 3. Updated CodexLogParser.discoverSessionLog()

Added sessionId parameter and file pattern matching:

```typescript
async discoverSessionLog(
  promptText: string,
  startTime: Date,
  sessionId?: string  // ← Added this parameter
): Promise<string | null> {
  // ...

  // If session ID provided, search for matching file directly
  if (sessionId) {
    // Codex file pattern: rollout-<timestamp>-<session-id>.jsonl
    const files = fs.readdirSync(datePath);
    const matchingFile = files.find((file) =>
      file.endsWith(`-${sessionId}.jsonl`)
    );

    if (matchingFile) {
      const logPath = path.join(datePath, matchingFile);
      return logPath;
    }

    return null;  // Session ID provided but not found
  }

  // Fallback to prompt text matching...
}
```

### 4. ClaudeLogParser (No Changes Needed)

ClaudeLogParser already correctly implemented the sessionId parameter.

## Provider-Specific Path Formats

Each provider stores log files differently:

| Provider | Directory Structure | Session Resumption Path |
|----------|---------------------|-------------------------|
| **Copilot** | `~/.copilot/session-state/` | `{sessionId}/events.jsonl` (directory format)<br>OR `{sessionId}.jsonl` (flat file format) |
| **Claude** | `{projectDir}/` | `{sessionId}.jsonl` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-*-{sessionId}.jsonl` |

## Testing

### Successful Session Resumption

When you now resume a session that exists:

1. FlightPath will log: `🔄 Resuming session {sessionId} - discovering log file directly...`
2. The log parser will construct the path directly based on the session ID
3. No prompt text matching needed (much faster and more reliable)
4. Success message: `✅ Found log file for resumed session: {path}`

### Failed Session Resumption

When you try to resume a session that doesn't exist:

1. FlightPath will log: `🔄 Resuming session {sessionId} - discovering log file directly...`
2. The log parser will try to find the file and fail
3. Clear error message with actionable fix:
   ```
   ❌ Could not find log file for resumed session {sessionId}
      The session may have been deleted or never existed.
      To fix: Remove the sessionId property to start a new session.
   ```
4. Workflow stops with error (prevents silent data loss)

## Benefits

- ✅ **Faster**: No retries waiting for log files that already exist
- ✅ **More reliable**: Direct path construction vs. fuzzy prompt matching
- ✅ **Better errors**: Clear, actionable messages with specific fix instructions
- ✅ **Consistent**: All three providers now work the same way
- ✅ **Fail fast**: Invalid sessions detected before CLI even launches
