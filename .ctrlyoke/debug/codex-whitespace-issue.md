# Codex CLI Excessive Whitespace Issue

**Date:** December 19, 2025  
**Status:** 🔴 UNRESOLVED  
**Issue:** Codex CLI TUI output contains excessive blank lines (10+ consecutive) in dashboard export despite multiple collapse attempts

---

## Problem Summary

When using Codex CLI in interactive TUI mode, the exported dashboard output contains 10+ consecutive blank lines between content sections, despite having:

1. A regex to collapse 3+ blank lines to 2
2. A line-by-line counter that limits consecutive blanks to 2
3. TUI chrome filtering to remove status bars
4. Trailing whitespace removal from each line

**Expected:** Max 2 consecutive blank lines  
**Actual:** 10+ consecutive blank lines in output

---

## Architecture Context

### Processing Pipeline (Time-Based Mode for Codex)

```
Raw TUI data
  ↓
stripAnsiCodes() - Remove terminal escape sequences
  ↓
trimEnd() each line - Remove trailing spaces (TUI padding)
  ↓
filterTuiChromeFromChunk() - Remove TUI UI elements
  ↓
deduplicateContent() - Collapse blanks + dedupe lines
  ↓
streamingEmitter.fire() - Send to dashboard
```

### Key Code Location

`src/utils/TuiStreamProcessor.ts`:

- `processTimeBasedChunk()` - Main processing function for Codex
- `deduplicateContent()` - Where blank line collapsing should happen

---

## What We've Tried

### Attempt 1: Add persistent blank line counter

**Change:** Made `consecutiveBlankLines` an instance variable instead of local  
**Reason:** Counter was resetting between chunks, allowing blanks to accumulate  
**Result:** ❌ Still excessive blanks

### Attempt 2: Regex to collapse whitespace-filled lines

**Change:** `/(\r?\n[ \t]*){3,}/g` → match lines with only spaces/tabs  
**Result:** ❌ Too specific, didn't catch all cases

### Attempt 3: Simplified regex for consecutive newlines

**Change:** `/(?:\r?\n[ \t]*){3,}/g` → simpler pattern  
**Result:** ❌ Still not matching properly

### Attempt 4: Even simpler regex

**Change:** `/\n\n\n+/g` → just match 3+ newlines directly  
**Result:** ❌ Not working (possibly line ending issues)

### Attempt 5: Remove redundant whitespace handling

**Change:** Removed `/\n{4,}/g` replacement from `stripAnsiCodes()` since `deduplicateContent()` handles it  
**Result:** ❌ No improvement

### Attempt 6: Add trailing whitespace removal

**Change:** Added `trimEnd()` on each line after ANSI strip  
**Reason:** TUI adds 200+ spaces to pad terminal width  
**Result:** ❌ Still excessive blanks

### Attempt 7: Normalize line endings before regex

**Change:** Convert `\r\n` to `\n` before running collapse regex  
**Reason:** Mixed line endings might prevent regex matching  
**Result:** ❌ Still failing (current state)

### Attempt 8: Enhanced TUI chrome patterns

**Change:** Added patterns for Codex-specific UI elements:

- `/^›\s+[^›]*$/i` - Prompt indicator lines
- `/^─\s+Worked for \d+s\s+─+$/i` - Separator lines
- `/\d+%\s+context\s+left/i` - Context status
  **Result:** ⚠️ Filtering more chrome, but blanks remain

---

## Debug Log Evidence

### Latest Test Run (2025-12-19T17:33:34)

**Input to `deduplicateContent()`:**

```
Input length: 3034 chars
Input has 460 newlines
```

**After regex collapse:**

```
After collapse: 246 newlines (removed 214)
```

**After line-by-line processing:**

```
Final output: 116 newlines, 117 lines
Consecutive blank counter at: 2
```

**Observation:** The regex IS removing newlines (214 removed), and the line counter IS working (counter at 2), but the OUTPUT STILL HAS 10+ blank lines in a row.

### Input Preview (first 500 chars):

```
"
•Working
7
Working

•
Working

•
orking

•
rking


•king
ing

•
ng

g











8
```

**Clear issue:** 10+ blank lines between "g" and "8" in input

### Output Preview (first 500 chars):

```
"
7



rking




8












• Running Get-Content .flightpath\temp\1766165591-current-1.prompt.md
```

**Still 11+ blank lines after "8"!** The regex is supposed to collapse this.

---

## Why Isn't The Regex Working?

### Current Regex

```typescript
const normalized = text.replace(/\r\n/g, "\n");
const collapsedText = normalized.replace(/\n\n\n+/g, "\n\n");
```

**Pattern:** `/\n\n\n+/g` should match 3+ consecutive `\n` characters

### Hypothesis 1: Regex isn't matching

- The pattern looks correct for matching `\n\n\n` or more
- We normalize line endings first
- But somehow it's not catching those 10+ newlines in the input

### Hypothesis 2: Something after deduplicateContent() is adding blanks

- The function returns 116 newlines
- But final dashboard has more?
- Need to trace what happens after `streamingEmitter.fire()`

### Hypothesis 3: Multiple chunks accumulate blanks

- Each chunk independently allows 2 blanks
- If chunks are split at blank lines, could accumulate across chunks
- But the persistent counter should prevent this

---

## Next Steps

### 1. Add regex match metadata

```typescript
// Before replace
const matches = normalized.match(/\n\n\n+/g);
Log.debug(
  `[deduplicateContent] Found ${matches?.length || 0} runs of 3+ newlines`
);
if (matches) {
  matches.forEach((match, idx) => {
    Log.debug(`  Match ${idx}: ${match.length} newlines`);
  });
}

// Then replace
const collapsedText = normalized.replace(/\n\n\n+/g, "\n\n");
```

This will show:

- How many runs of 3+ newlines exist
- How long each run is
- Whether regex is finding them at all

### 2. Try alternative collapse approach

Instead of regex, manually count and rebuild:

```typescript
const lines = normalized.split("\n");
const result: string[] = [];
let blankCount = 0;

for (const line of lines) {
  if (line.trim() === "") {
    blankCount++;
    if (blankCount <= 2) {
      result.push(line);
    }
  } else {
    blankCount = 0;
    result.push(line);
  }
}

const collapsedText = result.join("\n");
```

This is more explicit and easier to debug.

### 3. Check what happens after emit

Add logging in the dashboard/FlightPathManager to see what text is received:

```typescript
this.streamingEmitter.fire(newContent);
Log.debug(
  `[Emitted] ${newContent.length} chars, ${(newContent.match(/\n/g) || []).length} newlines`
);
```

### 4. Test regex in isolation

Create a simple test case:

```typescript
const test = "a\n\n\n\n\n\n\n\n\n\n\nb"; // 10 newlines
const result = test.replace(/\n\n\n+/g, "\n\n");
// Should be: "a\n\nb"
console.log(
  `Input: ${test.length} chars, ${(test.match(/\n/g) || []).length} newlines`
);
console.log(
  `Output: ${result.length} chars, ${(result.match(/\n/g) || []).length} newlines`
);
```

---

## Key Questions

1. **Is the regex actually matching?** Need to see match metadata
2. **Is something after `deduplicateContent()` adding blanks back?** Need to trace the emit path
3. **Are blank lines being added in dashboard rendering?** Check FlightPathDashboardProvider
4. **Is the issue in how we're joining lines?** The `join('\n')` should be safe but worth verifying

---

## Raw Data Samples

### Clean Chunk Data (has trailing spaces)

From earlier debug: Lines with 200+ spaces were present. These get trimmed by `trimEnd()`.

### After TUI Chrome Filtering

Should have removed status bars like:

- `› Explain this codebase`
- `100% context left · ? for shortcuts`
- `─ Worked for 15s ───`

But blank lines where those were remain.

---

## Conclusion

The regex `/\n\n\n+/g` should work but empirical evidence shows it's not collapsing the blank lines. Next step is to add detailed match logging to see if:

1. The regex is finding the patterns at all
2. The replacement is happening but being undone later
3. We need a completely different approach (manual line-by-line)
