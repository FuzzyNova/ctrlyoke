# Copilot Chat Log Format Change (December 2025)

## Issue Summary

**Date Discovered**: December 16, 2025  
**Impact**: FlightPath's chat mode completion detection is **broken** - fires completion too early  
**Root Cause**: Copilot changed their log format to emit `finish reason: [stop]` after every sub-request instead of only at final completion

## The Problem

### Previous Behavior (Working)

In older Copilot versions, the log file would show:

- Multiple tool calls and sub-requests without `finish reason` markers
- A single `finish reason: [stop]` at the END of the entire response
- FlightPath could reliably detect this marker for completion

### Current Behavior (Broken)

As of December 2025, the log file now shows:

- `finish reason: [stop]` after **every sub-request**
- `finish reason: [stop]` after **every tool call**
- `finish reason: [stop]` after **internal completions** (XtabProvider, copilotLanguageModelWrapper, etc.)
- Multiple `finish reason: [stop]` markers for the **same request ID**

## Example Log Output

Here's a single chat request (`e6fd71e8-1ae8-47d5-98ac-6a4ffa0535fd`) showing multiple finish markers:

```
2025-12-16 12:04:02.619 [info] ccreq:6c6cc3df.copilotmd | success | gpt-4o-mini -> gpt-4o-mini-2024-07-18 | 358ms | [copilotLanguageModelWrapper]
2025-12-16 12:04:03.696 [info] ccreq:e5f1225c.copilotmd | success | claude-haiku-4.5 | 4614ms | [panel/editAgent]
2025-12-16 12:04:08.180 [info] ccreq:0b9108f1.copilotmd | success | claude-haiku-4.5 | 4199ms | [panel/editAgent]
2025-12-16 12:04:08.234 [info] ccreq:0ff8b3cd.copilotmd | success | gpt-4o-mini -> gpt-4o-mini-2024-07-18 | 1124ms | [copilotLanguageModelWrapper]
2025-12-16 12:04:11.145 [info] ccreq:b270c44e.copilotmd | success | gpt-4o-mini -> gpt-4o-mini-2024-07-18 | 316ms | [copilotLanguageModelWrapper]
2025-12-16 12:04:12.830 [info] ccreq:ead876b6.copilotmd | success | claude-haiku-4.5 | 4451ms | [panel/editAgent]
... (more sub-requests)
2025-12-16 12:04:36.244 [info] ccreq:baabbb0f.copilotmd | success | claude-haiku-4.5 | 13112ms | [panel/editAgent]
```

**Each of these sub-requests had its own `finish reason: [stop]` marker**, causing FlightPath to detect completion after the first one (~3 seconds) instead of waiting for the actual completion (~34 seconds later).

### Log Patterns Now Observed

1. **Multiple providers emit finish markers**:
   - `[XtabProvider]` - Tab completion provider (inline suggestions)
   - `[copilotLanguageModelWrapper]` - Internal LLM wrapper for small tasks
   - `[panel/editAgent]` - Main chat agent responses
   - `[title]` - Chat title generation

2. **Same request ID reused across sub-requests**:
   - Request `e6fd71e8-1ae8-47d5-98ac-6a4ffa0535fd` appears in 7+ separate `success` log lines
   - Each tool call is a separate `ccreq:XXXXXXXX` but same parent request ID

3. **Finish reasons now include**:
   - `finish reason: [stop]` - Normal completion (now appears multiple times)
   - `finish reason: [tool_calls]` - Tool invocation (new in this format)
   - `finish reason: [null]` - Unknown/intermediate state (new)

## Impact on FlightPath

### Current Detection Logic

[ChatLogMonitor.ts#L120](../src/flightpath/chat/ChatLogMonitor.ts#L120):

```typescript
if (newContent.includes("finish reason: [stop]")) {
  return { completed: true, userCancelled: false };
}
```

**This triggers on the FIRST sub-request completion**, not the actual end of the chat response.

### Result

- Workflows complete prematurely (3 seconds instead of 34 seconds in example above)
- End condition scripts run before Copilot is finished
- Multi-step workflows fail because next prompt fires while previous is still running

## Investigation Results

### VS Code API Check (December 16, 2025)

**No new APIs available** for chat completion detection:

- ❌ No `onDidCompleteChatRequest` event
- ❌ No `ChatSession` state observable
- ❌ No way to await chat command completion
- ❌ No notification API hooks
- ❌ `vscode.chat` namespace is only for custom participants, not automating Copilot

**Confirmed**: VS Code does NOT expose any way to detect when Copilot Chat completes a response.

### Why This Wasn't Caught Earlier

1. **New chat sessions work differently**: When using `newChatSession: true`, the old format is still used (single finish marker). Most testing used new sessions.

2. **Continued sessions are affected**: When using `newChatSession: false`, the new format appears. This is the common use case for multi-prompt workflows.

3. **Ask/Plan modes hide the issue**: Text-only responses complete quickly, so premature detection isn't obvious.

## Potential Workarounds

### Option 1: Track Request IDs (Complex)

- Parse `ccreq:XXXXXXXX` patterns
- Build a map of active sub-requests
- Only trigger completion when ALL sub-requests for a session are done
- **Problem**: No session ID in logs, can't correlate ccreq to parent request

### Option 2: Debounce After Activity (Unreliable)

- After seeing `finish reason: [stop]`, wait N seconds for more activity
- If no new log entries, assume completion
- **Problem**: How long to wait? Too short = premature, too long = slow UX

### Option 3: Look for Session Closure Markers (Unproven)

- Search for `Closing session` log lines
- **Problem**: These appear at extension shutdown, not response completion

### Option 4: Track `request done: requestId:` Patterns (Promising?)

```
2025-12-16 12:04:36.243 [info] message 0 returned. finish reason: [stop]
2025-12-16 12:04:36.243 [info] request done: requestId: [e6fd71e8-1ae8-47d5-98ac-6a4ffa0535fd] model deployment ID: []
```

The `request done` line appears AFTER the final sub-request. Could use this + debounce.

### Option 5: Accept Inactivity Timeout as Primary (Current Fallback)

- Set `treatChatTimeoutAsSuccess: true` (already default)
- Increase `chatInactivityTimeout` from 300s to something reasonable
- Accept that chat mode is best-effort only

## Recommendations

### Short-Term (Immediate)

1. **Update documentation** warning users about Chat mode limitations
2. **Recommend CLI mode as primary** for workflows requiring reliable completion detection
3. **Keep `treatChatTimeoutAsSuccess: true`** as default (it already is)
4. **Document that Chat mode is "experimental"** for multi-step workflows

### Medium-Term (Next Release)

1. **Implement `request done:` marker detection** with debounce:
   - Track `request done: requestId:` lines
   - Wait 5 seconds after seeing one
   - If no new activity, trigger completion
   - Fallback to inactivity timeout if no marker found

2. **Add setting**: `flightpath.chatCompletionStrategy`
   - `"finish-reason"` - Current broken method (for backward compatibility)
   - `"request-done"` - New method using `request done:` marker
   - `"debounce"` - Wait N seconds after any activity
   - `"inactivity-timeout"` - Current fallback (most reliable, slowest)

3. **Add telemetry/logging**: Track completion detection accuracy

### Long-Term (Future)

1. **Open VS Code GitHub issue** requesting completion event API (see [CHAT_COMPLETION_DETECTION.md](CHAT_COMPLETION_DETECTION.md) for proposed API)
2. **Switch CLI mode to default** in settings
3. **Deprecate Chat mode** for workflows if no API improvements

## Related Documentation

- [CHAT_COMPLETION_DETECTION.md](CHAT_COMPLETION_DETECTION.md) - Full completion detection strategy and proposed VS Code APIs
- [CHAT_MODE_LIMITATIONS.md](CHAT_MODE_LIMITATIONS.md) - All Chat mode limitations including agent selection, ask/plan modes
- [ChatLogMonitor.ts](../src/flightpath/chat/ChatLogMonitor.ts) - Current implementation

## Status

**Current State**: Chat mode completion detection is unreliable for continued sessions  
**Workaround**: Use CLI mode (`flightpath.provider: "copilot-cli"`) for reliable workflows  
**Fix Status**: Investigating `request done:` marker approach

---

**Last Updated**: December 16, 2025  
**Copilot Chat Extension Version**: 0.35.0  
**VS Code Version**: 1.107.0
