# MCP tools

ctrlyoke exposes built-in tools for workflows that need to inspect or adjust the active run.

## Built-in tool list

| Tool              | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `workflow_status` | Return workflow metadata and step state         |
| `append_step`     | Add prompts to the current workflow             |
| `edit_step`       | Change a pending step's prompt or configuration |
| `remove_step`     | Remove a pending step                           |
| `reorder_steps`   | Reorder the pending steps                       |
| `capabilities`    | Return available harnesses and supported models |
| `read_output`     | Read output from completed prompts              |

## `append_step`

This tool accepts:

- `steps`: array of steps to add
- `position`: `next`, `end`, or a zero-based step index
- `source`: optional source label

Use it when the harness discovers follow-up work during a run.

## Step mutations

`edit_step` takes a zero-based `index` and an `updates` object. Use it to correct a
pending prompt or change its configuration. `remove_step` takes the same `index`.
`reorder_steps` takes `indices`, all pending steps' absolute zero-based indices in
the desired execution order. When a step is running, include it first in that order.

## When these tools are available

- through the built-in ctrlyoke MCP server when you include `"ctrlyoke"` in `mcpServers`
