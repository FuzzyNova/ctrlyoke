# `ctrlyoke history list` NAME column has no width cap, so every row wraps

- **Found:** 2026-10-03 by Claude (claude-cli) while manually testing the CLI history commands
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`renderHistoryList`)
- **Severity:** low

## Symptom

`history list` pads the NAME column to its longest value. Lineages named after a pasted prompt
can be more than 100 characters long, for example
`We've implemented dev/implemented/VIRTUALIZED_OUTPUT_IMPROVEMENTS.md and dev/implemented/OUTPUT_VIRTUALIZATION_PLAN.md`.
One such name widens every row: in a real workspace with 1358 lineages, rows reached 226
characters and wrapped in any normal terminal, even with the default limit.

## Steps to Reproduce

1. Have at least one lineage whose name is about 100+ characters (creating a workflow from a
   long prompt does this).
2. `node ./out/cli.js history list`.
3. Every row is padded to that width, and RUNS/LATEST/STATE wrap onto the next line.

## Root Cause

`renderHistoryList` computes each column width as `Math.max(header.length, ...values)` with no cap
(`src/cli/HistoryInspectionCommands.ts:1950`). `history steps` already avoids this for its
prompt column by shortening it with `…` (`formatStepPrompt`) and leaving the last column
unpadded.

## Suggested Fix

Cap NAME at a fixed width (around 48 characters) and end truncated names with `…`. `formatStepPrompt`
truncates inline (`slice(0, 117)` + `…`), so move that into a small shared helper and use it in
both places rather than copying it. Do not
truncate `--json` output. Alternatively, move NAME to the last column and leave it unpadded, as
`history steps` does with PROMPT; either way the fixed-width columns stay aligned.

## Decision

Decided 2026-10-03 (obvious, no input needed): cap NAME at 48 characters and end truncated names with `…`. Keep NAME where it is, because moving it to the end would push the identifying text past KEY and the state columns. Extract `formatStepPrompt`'s inline truncation into one shared helper (e.g. `truncateCell(text, max)`) and use it for both the PROMPT and NAME columns. `--json` keeps full names.
