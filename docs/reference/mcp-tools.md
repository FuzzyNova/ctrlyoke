# MCP tools

ctrlyoke exposes built-in tools for workflows that need to inspect or adjust the active run.

## Built-in tool list

| Tool                    | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `workflow_status`       | Return workflow metadata and step state            |
| `append_step`           | Add prompts to the current workflow                |
| `edit_step`             | Change a pending step's prompt or configuration    |
| `remove_step`           | Remove a pending step                              |
| `reorder_steps`         | Reorder the pending steps                          |
| `list_harnesses`        | Return available harnesses and supported models    |
| `read_output`           | Read output from completed prompts                 |
| `global_status`         | List other workflows in the workspace              |
| `submit_commit_message` | Submit a commit message when explicitly instructed |

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

## `read_output`

By default this returns every requested step's full response text. `indices` selects
zero-based step numbers; omit it to read them all.

For a long response, three optional arguments return a bounded slice instead. All
three require `indices` to name **exactly one** step — supplying them with zero or
several indices is an error rather than a silently ignored argument.

- `limit`: maximum characters to return.
- `cursor`: resume where a previous read stopped. Pass back the `nextCursor` from an
  earlier `read_output` response exactly as received; it is opaque and must never be
  constructed by hand.
- `tail`: return the last N characters instead of reading forward. Cannot be combined
  with `cursor` or `limit`.

A step's entry gains `nextCursor` only when the slice returned stopped short of the end
of that step's output; its absence means you have read to the end. Tail reads never
return one. Omitting all three arguments reproduces the unpaged response exactly.

## `global_status`

This is a cross-worktree radar for noticing what other workflows are doing and for
recognizing failures they may have caused. It is informational only: it is not a
collision check and it does not act as a lock.

## `submit_commit_message`

Submit the complete generated commit message. Call this tool only when explicitly
instructed to do so.

## When these tools are available

- through the built-in ctrlyoke MCP server when you include `"ctrlyoke"` in `mcpServers`
