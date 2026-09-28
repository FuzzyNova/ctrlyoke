# CLI streamed script output drops a line split across chunks

- **Found:** 2026-09-28 by the maxSteps orchestrator review pass (`npm test`)
- **Area:** `CliTerminalFormatter.renderScriptOutput` (`src/cli/`)
- **Severity:** low

## Symptom

`CLI dry-run output` › `counts a line split across chunks once` fails: after 199 full lines
arrive, a line streamed as `"split "` + `"line\n"` never appears in the output
(`assert.ok(output.includes("split line"))`). It fails the same way at `8874eec8`, before the
maxSteps work, so it predates this change. The last commit to touch this area is `729b9b10`
(`fix(cli): count streamed script output by lines, not chunks`).

## Steps to Reproduce

1. `MOCHA_GREP="counts a line split across chunks once" npm run test:extension`

## Root Cause

Not yet investigated. The partial line is probably counted against the display cap, or
dropped, when the chunk that completes it arrives.

## Suggested Fix

Buffer a trailing partial line until its newline arrives, and count and render it once.
