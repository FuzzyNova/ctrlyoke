# Copilot CLI Completion Detection Fix

**Date:** January 22, 2026
**Status:** Fixed
**Issue:** Premature completion detection in Copilot CLI interactive mode

## Problem Summary

FlightPath was detecting completion **before Copilot CLI finished responding** when using interactive mode. This caused responses to be cut off mid-execution.

### Root Cause

The bug occurred because FlightPath used **two parallel completion detection mechanisms**:

1. **sessionEnd hook** - Fires when Copilot truly completes (✅ CORRECT)
2. **Log file monitoring** - Checked for `assistant.turn_end` events (❌ WRONG)

The log file monitoring triggered completion on the **first** `assistant.turn_end` event, but Copilot emits this event **after each tool call**, not just at final completion!

### Example: Multi-Tool Response

When Copilot executes multiple tools in one response:

```
Prompt: "Create a file, edit it, then delete it"

Copilot Response Timeline:
1. Creates file → assistant.turn_end (turn 0) ← FlightPath detects completion HERE!
2. Edits file → assistant.turn_end (turn 1)    ← Still going...
3. Deletes file → assistant.turn_end (turn 2)  ← Still going...
4. Final message → assistant.turn_end (turn 3)
5. sessionEnd hook fires ← TRUE completion
```

FlightPath detected completion at step 1, cutting off 75% of the response!

## Evidence

From actual Copilot log file (`~/.copilot/session-state/{session-id}/events.jsonl`):

```
2026-01-22T04:10:46.943Z - assistant.turn_end (turn 0) ← File created
2026-01-22T04:10:48.638Z - assistant.turn_end (turn 1) ← Intent logged
2026-01-22T04:10:55.830Z - assistant.turn_end (turn 2) ← File edited
2026-01-22T04:10:57.655Z - assistant.turn_end (turn 3) ← Intent logged
2026-01-22T04:11:01.761Z - assistant.turn_end (turn 4) ← File deleted
2026-01-22T04:11:03.455Z - assistant.turn_end (turn 5) ← Final message
```

FlightPath log showed:

```
[04:10:47.135Z] INFO: ✅ Completion detected via log file  ← 16 seconds too early!
[04:10:47.135Z] INFO: 🛑 User cancelled - stopping notification monitoring
[04:10:49] [RESPONSE] (still streaming...)  ← Output continued after "completion"
```

## Solution

**Disable log-based completion detection for Copilot CLI.**

### Code Changes

**File:** `src/flightpath/cli/copilot/CopilotLogParser.ts`

```typescript
isComplete(event: any): boolean {
  // NEVER detect completion from log files for Copilot - use hooks instead!
  // Reason: assistant.turn_end fires after EACH tool call, not at final completion
  return false;  // ← Changed from: event.type === "assistant.turn_end"
}
```

This ensures Copilot **only** completes when the `sessionEnd` hook fires, which is reliable.

### Why This Works

- **Interactive mode:** sessionEnd hook fires when session truly ends (configured in `CopilotCliProvider.buildSessionEndHookArgs()`)
- **Headless mode:** Process exit signals completion (log monitoring not used)

### Other Providers

**Claude CLI** and **Codex CLI** have reliable log completion signals:

- **Claude:** `stop_reason` field indicates true completion
- **Codex:** `turn.completed` event signals end of response

These providers can safely use **both** log monitoring and hooks for redundancy.

## Related Files Changed

1. `src/flightpath/cli/copilot/CopilotLogParser.ts` - Fixed `isComplete()` method
2. `docs/COPILOT_CLI_EVENT_STRUCTURE.md` - Updated completion detection docs

## Testing

To verify the fix:

1. Run a multi-step workflow with Copilot CLI in interactive mode
2. Check FlightPath output panel for completion timing
3. Verify sessionEnd hook fires before "Completion detected" message
4. Confirm full response is captured (not cut off mid-execution)

Example test prompt:

```
Create a file named test.txt, write "hello" to it, then delete it.
Use three separate operations.
```

Expected behavior:

- All three operations complete
- sessionEnd hook fires after final operation
- FlightPath shows "Completion detected via Stop hook"

## Prevention

This bug class (premature log-based completion) is prevented for future providers by:

1. **Testing multi-tool responses** during provider development
2. **Documenting log event semantics** (what events mean vs. what they signal)
3. **Preferring hooks over log parsing** for completion detection when available

## References

- Original bug report: [User message, 2026-01-22]
- Log file evidence: `~/.copilot/session-state/169c4cfe-604f-4a44-98b3-002c5c29c3e1/events.jsonl`
- sessionEnd hook implementation: `CopilotNotificationMonitor.ts`
- Hook configuration: `.github/hooks/flightpath.json` (auto-generated)
