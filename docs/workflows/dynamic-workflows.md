# Dynamic workflows

A dynamic workflow adds and adjusts its own steps while it is running: the harness can append
follow-up steps, edit or reorder steps that haven't started, and keep going until the work is
done.

## Enable it

Add the built-in ctrlyoke MCP server:

```yaml
mcpServers:
  - ctrlyoke
```

ctrlyoke starts the server for each harness launch and attaches it to the current run, so the tools always act on the run that launched them. The harness is pre-approved to call it, so unattended runs never stop at a tool-approval prompt.

## What it provides

The built-in server lets the harness:

- inspect the run's steps and their status (`workflow_status`)
- append steps or parallel groups next, at the end, at a specific index, or into the parallel group that is currently running (`append_step`)
- edit, remove, or reorder steps that have not started yet (`edit_step`, `remove_step`, `reorder_steps`)
- check which harnesses and models are installed before choosing them (`list_harnesses`)
- read earlier steps' output, paging through long responses (`read_output`)
- see what other workflows in the workspace are doing, and coordinate with them (`global_status` and the coordination tools)

See [MCP tools](/reference/mcp-tools) for parameters and responses.

Step changes are only accepted while the run is executing (running, pausing, paused, or
cancelling). A harness session left open after its workflow finished cannot add steps that would
never run; the tool refuses instead. The run is capped by the effective `maxSteps` value: the
workflow's `maxSteps` when present, otherwise `queue.maxSteps` (100 by default). A workflow
value of `-1` means Unlimited and overrides a numeric global cap. The count covers every entry
in the run's `steps` array, whether authored or appended later, including parallel members and
disabled steps; it does not count `finalStep` iterations or retries.

## Typical pattern

Use `ctrlyoke` in the `finalStep` so the harness can review the current run and append follow-up tasks. After the workflow's steps finish, the final step runs; if it appended new steps, those run and the final step runs again. The loop ends when a final step appends nothing.

```yaml
steps: []
maxSteps: 30
finalStep:
  prompt: Review the implementation and append any missing follow-up work.
  mcpServers:
    - ctrlyoke
```

A workflow can even start with an empty `steps` list and let the `finalStep` build the whole workflow.

## Parallel groups

Parallel-group members may use the built-in `ctrlyoke` server. A member can:

- append a future parallel group with `position: "end"`, `"next"`, or an index — `"next"` always lands after the running group, never inside it
- join the running group with `position: "parallelWithCurrent"` (flat steps only), subject to the `queue.maxParallelSteps` limit
- read output only from steps before the group started

To let members read state but not change the workflow's steps, deny the mutation tools:

```yaml
mcpServers:
  - id: ctrlyoke
    deniedTools: [append_step, edit_step, remove_step, reorder_steps]
```

## Skill mode

The `execution.ctrlyokeMcpMode` setting controls how the tools reach the harness. `native` (the default) attaches the MCP server. `skill` attaches built-in skills (`ctrlyoke-mcp-tools` and `ctrlyoke-coordination-tools`) instead, which tell the harness how to call the same tools as one-shot shell commands (the [`ctrlyoke-mcp`](/cli/ctrlyoke-mcp) script's `--tool` mode). Use it when MCP servers are blocked or unavailable in your environment (for example by an organization policy). Commit-message generation follows the same setting. Denied tools are left out of the skills.
