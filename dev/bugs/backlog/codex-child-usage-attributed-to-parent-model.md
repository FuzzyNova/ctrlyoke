# Codex subagent token usage is attributed to the parent's model

- **Found:** 2026-10-23 by subagent-attribution review (codex-cli followed child source)
- **Area:** `src/core/harness/codex/CodexLogParser.ts` (`registerCodexSubagent`)
- **Severity:** medium

## Symptom

When a Codex child runs a different model than its parent (for example a
cheaper model chosen for the spawned agent), the child's tokens are merged into
`TokenUsage.modelUsage` under the parent's model, so per-model usage and cost
estimates for the step are wrong. When the models match the bug is invisible.

## Steps to Reproduce

1. Run a codex-cli step whose parent spawns a child (`spawn_agent`) whose
   rollout `session_meta.payload.model` differs from the parent's.
2. Let the follower read the child rollout (headless or interactive).
3. Inspect the step's `modelUsage`: the child's input/output/cache/reasoning
   tokens are added under the parent model key; the child model never appears.

## Root Cause

The child's model is meant to be captured in the source's `usage` callback from
the child's `session_meta` record (`childModel = record.payload.model`, around
line 1534), with `childModel ?? this.sessionMeta?.model` as the fallback for
`token_count` records (around line 1547).

But the source's `read()` replay filter (around lines 1509-1520) drops every
record until the first `task_started` carrying
`turn_attribution.initiating_agent_path`. The child's `session_meta` is the
first line of the rollout, so it is always skipped before reaching `usage`. The
`SESSION_META` branch is therefore dead code, `childModel` stays `undefined`,
and the fallback always resolves to the parent's `this.sessionMeta?.model`
(`token_count.info.model` is not normally present). The `turn_context` record,
which also carries the model, is never consulted for the child either.

## Suggested Fix

Capture the child's model while reading, before the replay filter discards it:
set `childModel` from the child `session_meta` (already parsed during file
discovery, so the model can be read there) and/or from the child's
`turn_context` after `task_started`. Keep skipping replayed records for event
mapping only. Add a `LogParsers.test.ts` case with a child rollout whose
`session_meta.model` differs from the parent's and assert `modelUsage` is keyed
by the child model.
