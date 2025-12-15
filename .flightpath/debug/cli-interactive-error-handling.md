# CLI Interactive Mode Error Handling - Handoff Summary

**Date**: December 14, 2025  
**File**: `src/flightpath/cli/BaseCliIntegration.ts`  
**Issue**: React error #185 crashes Claude CLI during large prompt paste

## Current Problem

When pasting large prompts (>100KB) into Claude CLI's TUI via `terminal.sendText()`:

1. React error #185 occurs mid-paste (not after submission)
2. CLI crashes immediately
3. FlightPath continued pasting into crashed terminal
4. Error message not visible to user

## Implementation Status

### ✅ Completed

1. **Error Detection** (Lines ~315-355)
   - `detectCliError()` function checks raw buffer for error patterns
   - Captures full stack trace using regex: `/Error:[^\n]+(?:\n\s+at\s+[^\n]+)*/i`
   - Strips ANSI codes only for display

2. **Immediate Abort** (Lines ~441-455)
   - Triggers on ANY error detection (not gated by `promptSubmitted`)
   - Logs full raw data chunk that triggered detection
   - Calls `readAbortController.abort()` to stop read stream
   - Breaks out of loop immediately

3. **Error Handling Flow** (Lines ~599-621)
   - Emits error with full stack trace to dashboard
   - Focuses FlightPath panel via `flightpath.openPanel`
   - 100ms delay for message render
   - Disposes terminal to stop paste
   - Returns false

4. **Remainder Buffer Processing** (Lines ~576-589)
   - Processes final buffer content after stream ends
   - Ensures error messages get emitted even without status bar

### ⚠️ Temporary Testing Config

- **Chunk size**: 200KB (Line ~1047) - intentionally allows error
- **Purpose**: Reproduce React error for testing
- **TODO**: Revert to 50KB or less once testing complete

### 🔍 Current Detection Logic

```typescript
// NO promptSubmitted gate - detects errors during paste
if (!errorDetected && detectCliError(data)) {
  errorDetected = true;
  this.log(data); // Full raw chunk logged
  this.readAbortController?.abort();
  break;
}
```

## ✅ SOLVED: False Positive Prevention

**Problem**: Detection triggered on prompt echo if attached files contained error patterns

**Example**: Attaching `BaseCliIntegration.ts` (with error patterns in comments) triggered false detection

**Solution Implemented**: Chrome-based context detection

### The Pattern (Discovered by Nathan)

**False Positive** (error in pasted content):

```
... prompt content with error patterns ...
──────────────────────── (TUI chrome)
ctrl-g to edit prompt
... more content ...
──────────────────────── (TUI chrome AFTER error)
```

**Real Error** (actual CLI crash):

```
──────────────────────── (TUI chrome)
ctrl-g to edit prompt in Notepad  [?2026l

Error: Minified React error #185; ...
    at $1 (file:///...)
    at lA (file:///...)
... (NO chrome after error)
```

### Implementation (Lines ~315-395)

**Architecture:** CLI-specific chrome patterns via abstract method `getTuiChromePattern()`

```typescript
// BaseCliIntegration.ts
protected abstract getTuiChromePattern(): RegExp;

// CopilotCommandLineIntegration.ts
protected getTuiChromePattern(): RegExp {
  return /Ctrl\+c Exit/i; // Status bar: "Ctrl+c Exit · Ctrl+r Expand recent"
}

// ClaudeCommandLineIntegration.ts
protected getTuiChromePattern(): RegExp {
  return /(?:\? for shortcuts|ctrl-g to edit prompt)/i;
}

const detectCliError = (rawBuffer: string): boolean => {
  const tuiChromePattern = this.getTuiChromePattern();

  // For each error pattern match:
  // 1. Check if TUI chrome exists BEFORE the error
  // 2. Check if TUI chrome exists AFTER the error
  // 3. If chrome before + NO chrome after → Real error
  // 4. If chrome before + chrome after → False positive (prompt echo)
  // 5. If NO chrome before → Skip (not enough context)
}
```

### Test Results Expected

**With file attachment containing error patterns:**

- Should log: `⚠️ [FALSE POSITIVE] Error pattern surrounded by TUI chrome`
- Should continue execution without abort

**With real React error #185:**

- Should log: `❌ [REAL ERROR DETECTED] CLI crashed after TUI chrome`
- Should abort immediately and dispose terminal

## Next Steps

### Validation

1. Test with `BaseCliIntegration.ts` attached (known false positive trigger)
2. Test with large prompt causing React error #185 (real error)
3. Verify Output panel shows correct detection reasoning
4. Confirm no false aborts on file attachments

## Key Variables

```typescript
let errorDetected = false; // Flag for error state
let errorMessage = ""; // Captured error text
let promptTextSent = false; // After sendText() called
let promptSubmitted = false; // After \r sent (NOT USED for detection now)
let rawPasteBuffer = ""; // Raw buffer for error detection
```

## Test Command

Run FlightPath workflow with:

- Large prompt (>100KB when including attachments)
- File attachments (use `#file:` references)
- Watch Output panel for `❌ [ERROR TRIGGER]` log

## Files to Review

- `src/flightpath/cli/BaseCliIntegration.ts` - Core error detection
- `src/flightpath/cli/ClaudeCommandLineIntegration.ts` - Claude-specific patterns
- Output channel: "FlightPath" - Shows raw trigger data

## Context for New Agent

- User: Nathan
- Extension: FlightPath (VS Code)
- Mode: Interactive TUI (terminal automation)
- CLI: Claude Code CLI (also affects Copilot CLI)
- Method: `terminal.sendText()` → `execution.read()` streaming
- Goal: Detect real crashes without false positives from prompt echo
