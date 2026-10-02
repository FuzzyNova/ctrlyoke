# Claude step context window drops to 0 when the step ends with a `<synthetic>` assistant message

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading plus real Claude transcripts
- **Area:** `src/core/harness/claude/ClaudeLogParser.ts`
- **Severity:** medium

## Symptom

Claude Code writes client-generated assistant messages to the session
transcript. Examples are "API Error: Server error mid-response…" and
"No response requested.". Each has `"model":"<synthetic>"`, an all-zero `usage`
block, and `stop_reason:"stop_sequence"`. Real samples are in
`~/.claude/projects/*/*.jsonl`.

When one of these ends a step, the step's final `contextWindowUsed` is 0. The
dashboard's context bar falls from the live value (e.g. 65%) to 0% as soon as
the step completes. The completed value outranks live data, so 0 is what sticks.
Copy Metadata and the CLI `Context:` line show 0 too.

A related case: when a synthetic message is the first assistant event of the
step, `model` becomes `"<synthetic>"`. Pricing then fails as an unknown model,
and the context window size falls back to the default.

## Steps to Reproduce

Feed `ClaudeLogParser` (via `extractResponse` / the parse entry point used by
the existing tests) two assistant events, in this order:

1. Model `claude-opus-4-6`, usage `{input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 200}`.
2. Model `<synthetic>`, all-zero usage, text `API Error: Server error mid-response. The response above may be incomplete.`

Expected: `contextWindowUsedTokens` is 151000 and the model is `claude-opus-4-6`.
Actual: `contextWindowUsedTokens` is 0.

## Root Cause

The assistant-usage block (~366-387) sets `lastAssistantUsage = usage` for
every assistant event, including synthetic ones. The model block (~390-392)
takes the first `message.model`. Then
`contextUsage = lastAssistantUsage ?? resultUsage` (~461-469) computes context
occupancy from the zeroed synthetic usage.

## Suggested Fix

Skip assistant events whose `message.model === "<synthetic>"` when updating
`lastAssistantUsage` and `model`. Their usage is all zeros, so the billing
totals are unaffected. Keep their text/content events so the "API Error"
message still appears in the output. Put the `<synthetic>` sentinel in a
constant next to the other Claude constants rather than inline.
