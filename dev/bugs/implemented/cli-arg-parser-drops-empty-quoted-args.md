# `parseArgString` drops explicitly empty quoted arguments, shifting the next flag into the value slot

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/CliArgParser.ts` (`parseArgString`)
- **Resolution:** fixed in this commit

## Symptom

`parseArgString('--system-prompt "" --model x')` returns `["--system-prompt", "--model", "x"]`.
Expected `["--system-prompt", "", "--model", "x"]`. The same happens with `''`. This string is
what harness `additionalArgs` text is split with, so the harness receives `--model` as the value of
`--system-prompt`.

## Steps to Reproduce

Call `parseArgString` with the input above (scratch script against compiled `out/`).

## Root Cause

A token is only pushed when `current.length > 0` (`CliArgParser.ts:~51` and `~62`), so a quoted
empty string never becomes a token.

## Suggested Fix

Track whether the current token has started (set by any quote, or any non-space character) and
push on whitespace/end when it has, even if `current` is empty. Tests: `""` and `''` produce an
empty token; plain repeated whitespace still produces none.
