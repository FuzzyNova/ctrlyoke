# CLI streamed script output counts every chunk as a line, truncating early

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/cli/CliTerminalFormatter.ts` (`countOutputLines`, `writeBoundedScriptChunk`, script output finalisation)
- **Resolution:** fixed in this commit

## Symptom

When the CLI streams a script step / pre- or end-condition's output, the
`MAX_SCRIPT_OUTPUT_LINES` (200) cap is applied to _chunks_, not lines. Output that
arrives without a newline in each chunk (progress dots, spinners, a long line split
across several stdout `data` events) is cut off after 200 chunks, even though it is a
single line well under the 20,000-char cap, and the truncation notice then reports the
wrong number of omitted lines.

Reproduced by calling `writeBoundedScriptChunk(".", state)` 300 times against the
source with `tsx`: only 200 characters were written, and the state ended at
`shownLines: 200, totalLines: 300` for what is one line of 300 characters. The final
notice would read "… script output truncated: 100 more lines, 100 more characters".

## Steps to Reproduce

1. Run a workflow via the CLI with a script step such as
   `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('.');if(++i>=300){clearInterval(t)}},5)"`.
2. Only 200 dots are shown, followed by a truncation notice claiming 100 more lines.

## Root Cause

`countOutputLines(text)` returns `split("\n").length` minus one for a trailing newline,
so any non-empty chunk without a newline counts as one line. `writeBoundedScriptChunk`
applies it per streamed delta (`state.totalLines += countOutputLines(chunk)` and
`state.shownLines += countOutputLines(visible)`), so a line spread over N chunks is
counted N times. The finalisation path then takes
`Math.max(state.totalLines, countOutputLines(totalText))`, keeping the inflated value.
`state.endsWithNewline` already tracks whether the previous chunk left a line open,
but it isn't used when counting.

## Suggested Fix

Count lines incrementally: a chunk adds one line per `\n` it contains, plus one more
only if the previous chunk ended with a newline (i.e. a new line was started) and the
chunk does not end exactly at a newline boundary — equivalently, use
`state.endsWithNewline` to decide whether the chunk's first segment starts a new line.
Apply the same rule to `shownLines` and use `countOutputLines(totalText)` (not the
running max) for the final total. Add unit tests in the CLI formatter tests for:
300 single-char chunks (all shown, no notice), a line split across two chunks
(counted once), and >200 real lines (still capped at 200 with an accurate count).
