# The ctrlyoke MCP tools skill says `append_step` returns `changed`, but it never does

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/templates/skills/ctrlyoke-mcp-tools/SKILL.md`, `src/mcp-server.ts`
- **Resolution:** fixed in 1834a326

## Symptom

The skill's "Reading the result" section (around line 28) says: "For the queue-mutating tools
(`append_step`, `edit_step`, `remove_step`, `reorder_steps`) that object carries `changed`."
Only `edit_step`, `remove_step` and `reorder_steps` return `changed`. An agent following the skill
looks for `changed` after an append and never finds it. `docs/reference/mcp-tools.md` lists the
`append_step` result fields correctly.

## Steps to Reproduce

Call `append_step` through the MCP server (or `ctrlyoke-mcp` one-shot) and inspect the JSON result.
It has no `changed` field.

## Root Cause

The edit/remove/reorder response builder emits `changed` (`src/mcp-server.ts`, around line 1388).
Both `append_step` response paths (around lines 1161-1180 and 1195-1215) don't.

## Suggested Fix

Either remove `append_step` from that sentence in the skill, or add `changed: true` to both
`append_step` responses (an append that succeeds always changes the queue) and document it in
`docs/reference/mcp-tools.md`. Adding the field keeps all four queue-mutating tools consistent; if
you do that, add an MCP server test asserting it.
