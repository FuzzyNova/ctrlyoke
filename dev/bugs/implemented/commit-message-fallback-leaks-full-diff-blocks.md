# Fallback commit message keeps full-diff bodies from the response text

- **Found:** 2026-10-13 by Claude (prior-context investigation)
- **Area:** `src/git/CommitMessageGenerator.ts`
- **Resolution:** fixed in `6fbe937a0` (the generator reads the step's `TEXT` events only)

## Symptom

When the commit-message model writes or edits a file before answering (it should not, but nothing
prevents it), the fallback commit message can include the full unified diff of that change.

## Steps to Reproduce

1. Keep `general.includeFullDiffsInPriorContext` at its default, `true`.
2. Generate a commit message where the model doesn't call the MCP commit tool and does create or
   edit a file before replying.
3. The resulting message contains a fenced ` ```diff ` block.

## Root Cause

With the setting on, `extractTextFromEvents`
(`src/core/harness/shared/CliResponseTextExtractor.ts:58-60`, `:91-107`) renders a file operation
as an `[Edited: path]` line followed by a fenced diff. The cleanup at
`CommitMessageGenerator.ts:750-753` strips only the one-line form
(`/\n\[(Created|Edited|Deleted):[^\]]*\]/g`). It removes the label line and leaves the diff block
in the message.

A related problem is on the same path. A headless failure with no text fires
`onResponseComplete(failure.message)` (`src/core/harness/shared/CliResponseCollector.ts:147`,
`:181`), and the generator then treats that failure message as the model's answer.

## Suggested Fix

The full-diff leak path is gone after Phase 1; captured response text now uses one-line file operation annotations.

[`PRIOR_CONTEXT_DETAIL_PLAN.md`](../../implemented/PRIOR_CONTEXT_DETAIL_PLAN.md) D5 removes the
setting, and `extractTextFromEvents` then always emits the one-line form, which this regex
matches. Phase 2 of that plan (D8c) fixes both problems properly: the generator reads only the
step's `TEXT` events and checks success, and the regexes are deleted.
