# Claude token usage is counted once per content block, inflating tokens and cost 2–3x

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/harness/claude/ClaudeLogParser.ts`
- **Resolution:** fixed in this commit

## Symptom

Claude Code writes one API response to its session JSONL as several `assistant` lines, one per
content block (thinking, text, tool_use). Every line carries the same `message.id`/`requestId` and an
identical `message.usage`. ctrlyoke adds `usage` on every line, so the step's input, output,
cache-read and cache-creation token totals, and the estimated cost derived from them, are
multiplied by the number of blocks in each response.

A real session log had 142 assistant lines but only 71 unique `message.id`s.

Headless runs are mostly masked because the stdout `result` event later overwrites the sums. The
inflation shows in interactive (log-sourced) runs and in any headless run that ends without a
`result` event (killed or failed).

## Steps to Reproduce

Feed `ClaudeLogParser` two assistant lines with `message.id: "msg_1"`, `requestId: "req_1"`,
one with a thinking block and one with a tool_use block, both with usage
`{input_tokens: 2, output_tokens: 224, cache_read_input_tokens: 31621, cache_creation_input_tokens: 500}`.

- Observed: `inputTokens 4, outputTokens 448, cachedInputTokens 63242, cacheCreatedTokens 1000`.
- Expected: `2 / 224 / 31621 / 500`.

The context-window figure is correct because it uses only the last usage.

## Root Cause

The "Extract usage stats" block in `extractResponse` (around lines 365-374) sums
`event.message.usage` on every assistant line without de-duplicating by `message.id`. The
existing fixtures are synthetic and have no `message.id`, so tests don't catch it. The Copilot
parser already guards against the equivalent double count.

## Suggested Fix

Track the `message.id` values (falling back to `requestId`) whose usage has already been added,
and sum usage only the first time an id is seen. Keep updating `lastAssistantUsage` on every
line. Add a fixture with multi-block responses that share a `message.id`.
