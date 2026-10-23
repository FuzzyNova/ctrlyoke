# Claude nested subagent spawn-card updates are unattributed and never merge into the card

- **Found:** 2026-10-23 by subagent output attribution review (inline stamping area)
- **Area:** `src/core/harness/claude/ClaudeLogParser.ts`, `src/utils/CliEventNormalizer.ts`
- **Severity:** medium

## Symptom

When a Claude subagent itself spawns a subagent (depth 2+), the grandchild's spawn card stays
"running" forever and a second, duplicate `Agent` tool-call row appears in the parent group
carrying only the status/terminal state.

## Steps to Reproduce

1. Feed `normalizeCliEvents` an `Agent` tool_call with `subagent: { parentToolCallId: "toolu_A" }`,
   `id: "toolu_B"`, `subagentSpawn.state: "running"` (what `extractResponse` produces for a child's
   `Agent` tool_use, stamped from `parent_tool_use_id`).
2. Follow it with the event `buildSubagentSpawnUpdate` produces for the matching `system`
   `task_notification` (`id: "toolu_B"`, `subagentSpawn.state: "completed"`, no `subagent`).
3. Output is two events: `[{parentToolCallId:"toolu_A"}, running]` and `[undefined, completed]`.
   They were not merged (verified with a scratch esbuild bundle of `normalizeCliEvents`).

## Root Cause

`system` `task_started`/`task_progress`/`task_notification` lines carry `tool_use_id` but no
`parent_tool_use_id` (see the plan's claude-cli sample). `buildSubagentSpawnUpdate`
(`ClaudeLogParser.ts` ~1688) emits its tool-call update with no `subagent`, and the stamping at
~571 only runs when `event.parent_tool_use_id` is set. For a top-level spawn that is correct (the
card lives in the parent group), but a grandchild's spawn tool_call is stamped with its parent
spawn id. `CliEventNormalizer` merges spawn updates only when `sameSubagentGroup` matches
(~863-873, 484), so the unstamped update never finds the stamped card. Plan section 1 says nested
groups "form a tree" with the spawn call carrying attribution; the update path does not honor that.

## Suggested Fix

Remember each spawn tool_use id's attribution when stamping the assistant `Agent` block (e.g. a
per-parse map `toolUseId -> subagent`, cleared with the other per-parse state) and have
`buildSubagentSpawnUpdate` stamp its event from that map (same for the interactive path at ~1547).
Add a LogParsers/CliEventNormalizer test with a depth-2 spawn plus `task_notification`.
