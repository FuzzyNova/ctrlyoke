# Codex step token usage includes every earlier turn of a resumed session

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/harness/codex/CodexLogParser.ts`
- **Resolution:** fixed in this commit

## Symptom

Codex's `token_count` event reports `info.total_token_usage` as a running total for the whole
session. ctrlyoke takes the last value as the step's usage. When a step resumes an earlier
session (`resumeSession`), its reported tokens and estimated cost include every previous turn,
and workflow totals count those earlier steps again.

Real `codex exec` rollout: turn 1 ends at `total_tokens 6,319,078`; turn 2 begins by replaying
`6,319,078` and ends at `9,417,002`. ctrlyoke reports turn 2 as 9,417,002 tokens instead of about
3,097,924.

## Steps to Reproduce

Feed `CodexLogParser` only the events from turn 2 of a resumed session (timestamps at or after the
step start, as `CliLogMonitor` does). The first `token_count` replays the previous total
(`total_tokens 6,319,078`) and the last has `total_tokens 9,417,002`.

- Observed: `totalTokens 9,417,002`, `inputTokens 9,391,006`, `cachedInputTokens 9,207,296`.
- Expected: the difference between the last and first totals, about 3,097,924 total tokens, with
  input and cached input reduced the same way.

## Root Cause

The `token_count` handling (around lines 260-273) overwrites the counters with
`total_token_usage` each time, and the `metadata.usage` built around lines 573-591 reports them
as this step's usage. Nothing subtracts the total from before the step. Other parsers (OpenCode per
`step_finish`, Qwen per message) report per-step values.

## Suggested Fix

Use the first `total_token_usage` seen in the step's event window (the replayed prior total) as a
baseline, and report the last value minus the baseline for each field. If the window has no replay
line (a fresh session), the baseline is zero. Alternatively, sum `last_token_usage` across the
step's `token_count` events. Add fixtures for a fresh session and a resumed session.
