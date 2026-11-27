# Current-step detail in MCP `global_status`

## Status (2026-11-26)

Not started. Waiting for the `big-feature` worktree's workflow step work
(`WORKFLOW_STEP_PLAN.md`) to merge, because that work is rewriting the same MCP
handlers in `src/mcp-server.ts`. The CLI half shipped on `main`:
`ctrlyoke status` now prints the `ctrlyoke history steps` command below its
table (`formatStepsHint` in `src/cli/CliStatusCommand.ts`).

## Problem

`global_status` is the only MCP tool that reports on other workflows. Each row
gives the state and the current step's number, but not what that step is doing
or how long it has been at it. A step coordinating with a sibling ("is it working
in my area right now?", "is it about to finish?") has to guess from the number.

## Where the line sits

MCP gets what a step needs to coordinate with siblings while doing its own job.
The CLI gets everything about operating ctrlyoke as a whole, which includes
inspecting other workflows in depth (`ctrlyoke history steps`, `history show`).

This follows from `dev/rejected/MCP_CONTROL_SURFACE_PLAN.md`. That plan rejected
any MCP tool that acts on another run. Its standing constraint keeps
`global_status` as the single read-only exception. Reads are permitted, but they
have a cost too. The built-in server is auto-approved, so anything
`global_status` returns goes into the context of every step of every workflow.
Another workflow's step names and prompts are text written by other agents, so
each one is a small prompt-injection channel. Keep what crosses that boundary to
the minimum that coordination needs.

The case that prompted this sits on the CLI side. A session was asked how another
long-running workflow was going, which is supervision rather than in-flow
coordination, and `ctrlyoke history steps` answers it fully. The CLI fix was
making that command easy to find.

## Proposal

Add to each `global_status` row:

- `currentStepName`: the executing step's `name` (or the final step's name
  during a pass), truncated to a short fixed length, or `null` when the step has
  none.
- `currentStepStartedAt`: that step's `_runtime.startedAt`, or `null`.

Not included: a per-step list, prompt or script previews, and any output. Those
stay CLI-only.

- **Additive.** These are new optional fields within the current response
  version, and they also appear in `ctrlyoke status --json`, which shares the
  row type (`GlobalWorkflowStatusRow`).
- **Single source.** Read them in `GlobalWorkflowStatusService`, which both
  surfaces already use.
- **Persisted-state safety.** A run file written by a newer ctrlyoke reports
  `null` for both fields rather than being parsed.

## Also update

- The `global_status` tool description in `src/mcp-server.ts`.
- The `ctrlyoke-mcp-tools` skill (`src/templates/skills/`): for more than
  `global_status` shows about another workflow, use `ctrlyoke history steps
--workflow <key> --json` through the shell.
- The `ctrlyoke status` text table could show the step name in its STEP column.
- `src/utils/ctrlyokeToolViews/globalStatusModel.ts` and its React view.
- `docs/workflows/coordination.md`, `docs/cli/ctrlyoke.md`, and a CHANGELOG
  **Added** entry.
- Tests: `GlobalWorkflowStatusService.test.ts`, `McpServer.test.ts`,
  `CliStatusCommand.test.ts`.
