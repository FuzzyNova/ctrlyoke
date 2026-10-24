# MCP edit_step can set a pending step's additionalArgs, including permission flags

- **Found:** 2026-10-23 by the workflow-orchestrator step (claude-cli) while
  planning MCP step-control additions
- **Area:** `src/utils/McpToolDefinitions.ts`, `src/mcp-server.ts`, every
  `src/core/harness/*/*CliProvider.ts`
- **Resolution:** fixed in this commit

## Symptom

`edit_step` accepts `additionalArgs` for a pending step (`MCP_STEP_UPDATE_SCHEMA`,
`src/utils/McpToolDefinitions.ts:294`). `toWorkflowStepUpdates`
(`src/mcp-server.ts:387`) only formats the array into an argument string; it
doesn't filter it. Each CLI provider then splices the tokens straight into the
harness command line, for example `ClaudeCliProvider.ts:397` and
`CodexCliProvider.ts:491`.

The ctrlyoke MCP tools are auto-approved for the agents that get them; claude-cli
gets `--allowed-tools mcp__ctrlyoke`, for example. So an agent can, with no
approval prompt, give a later step harness flags its author never chose. That
includes flags that widen what the step may do without asking, such as
codex-cli's `--dangerously-bypass-approvals-and-sandbox` or claude-cli's
`--dangerously-skip-permissions`. ctrlyoke's own permission flags come after the
extra args. Whether they win depends on the harness and the flag: a later
`--permission-mode` may override an earlier one, but a bypass flag has no
counterpart flag to cancel it, and could at worst make the harness reject the
combination.

That cuts against the boundary `dev/implemented/MCP_PARALLEL_APPEND_PLAN.md`
(Decision 2) draws for `append_step`: the MCP step surface deliberately leaves
out "permissions, or every execution property". `append_step` respects that
boundary; `edit_step` reopens it.

The likeliest trigger isn't a malicious orchestrator but prompt injection: a
repository file or tool output that steers the agent into "fixing" a later step
this way.

Not verified end to end against a live harness; the code path above is direct.

## Resolution notes

`edit_step` keeps `additionalArgs` in its input schema for compatibility, marks it
deprecated, and rejects both setting and clearing it before reading or mutating
the run. The rejection applies to the whole call, so accompanying edits are not
partially written. Agent and skill edits remain available: agent frontmatter
`tools` overrides are explicitly discarded by `AgentExpander.stripFrontmatter`,
and agent bodies and skill references are injected as prompt instructions by
`AgentExpander`/`SkillExpander`. They do not become harness-native tool or
permission settings. Harness permissions are resolved separately from the
workflow/settings permission configuration and mapped by each harness; those
properties are not editable through MCP. `append_step` has no corresponding
hole because its accepted step schema does not expose `additionalArgs` or
permission properties.

## Steps to Reproduce

1. Run a workflow whose orchestrator step has the ctrlyoke MCP server and a
   pending step after it.
2. From the orchestrator, call `edit_step` on the pending step with
   `updates.additionalArgs` set to a harness permission-bypass flag.
3. The pending step launches with that flag on its command line. No prompt
   or dashboard warning appears beyond the edited step's properties.

## Root Cause

`additionalArgs` was included in the `edit_step` field set alongside harmless
display and routing fields (`name`, `color`, `enabled`, `model`). Nothing in the
MCP layer treats a field that reaches the harness's argv as more sensitive than
one that changes a label.

## Suggested Fix

- Remove `additionalArgs` from `MCP_STEP_UPDATE_SCHEMA` (and therefore
  `clearProperties`). This narrows an MCP tool contract, so per the CLAUDE.md
  compatibility rules it needs a deprecation path. Accept the field for a
  release and reject it with an error that explains why, rather than dropping
  it silently. Note it under **Changed** in `CHANGELOG.md`.
- If a use case for agent-set harness flags turns up, make it an author opt-in:
  an allowlist of flags in the workflow, enforced in the MCP layer.
- Audit the other `edit_step` fields the same way. `agent` and `skills` can
  carry instructions and, depending on the harness, tool settings from the
  agent file; confirm they can't widen tool permissions, or gate them too.
- Add a test that `edit_step` rejects `additionalArgs`.
