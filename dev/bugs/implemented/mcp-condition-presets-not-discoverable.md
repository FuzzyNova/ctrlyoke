# MCP agents cannot discover the workflow's condition presets

- **Found:** 2026-11-16 by the user, during a `yoke-driven-loop` run (plan step, claude-cli)
- **Area:** `src/mcp-server.ts` (`handleWorkflowStatus`, `handleAppendStep`), `src/utils/McpConditionPresetResolver.ts`, `src/templates/agents/workflow-orchestrator.agent.md`
- **Resolution:** fixed in this commit

## Symptom

A `yoke-driven-loop` workflow declares a `committed` preset in its root
`conditions` map, and the `workflow-orchestrator` agent is told to attach it
"when the workflow declares a `committed` condition preset". The planning
agent called `workflow_status` and then queued 13 steps with no
`endCondition`. It reported: "No condition preset was declared, so no
`endCondition` is attached." The preset was in the run's working file, and
`{ use: "committed" }` would have resolved.

## Steps to Reproduce

1. Run a workflow whose root `conditions` declares a preset, and have its step
   call `workflow_status`.
2. The response contains no preset information. The `append_step` schema
   describes `use` only as "Name of a preset in workflow conditions."
3. Call `append_step` without a condition. It succeeds silently.

## Root Cause

No MCP tool reported which presets a workflow declares. The only feedback was
the "Available presets" list in the unknown-preset error. An agent that
believed there were no presets never sent a name, so it never saw that
error. The agent instruction was conditional on something the agent could
not check.

## Fix

- `workflow_status` reports `metadata.conditionPresets` (`name`, a one-line
  `script` preview, `params`, effective `maxRetries`), built by
  `summarizeMcpConditionPresets`.
- `append_step` warns when a sequential step it added runs with no end
  condition (its own or a workflow-level one) while presets exist. Parallel
  members are excluded because they share one working tree.
- The unknown-preset error lists each preset's params and points to
  `metadata.conditionPresets`.
- The `use` field description, the `workflow_status` description, and the
  orchestrator agent tell the caller where to look.
