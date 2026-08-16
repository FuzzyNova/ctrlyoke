# MCP tools

ctrlyoke exposes built-in tools for workflows and chat integrations that need to inspect or extend the active queue.

## Built-in tool list

| Tool                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `ctrlyoke_queue_status` | Return queue metadata and step state            |
| `ctrlyoke_append_queue` | Append prompts to the current queue             |
| `ctrlyoke_capabilities` | Return available harnesses and supported models |
| `ctrlyoke_read_output`  | Read output from completed prompts              |

## `ctrlyoke_append_queue`

This tool accepts:

- `prompts`: array of prompts to add
- `position`: `next` or `end`
- `source`: optional source label
- `reason`: optional explanation

Use it when the harness discovers follow-up work during a run.

## When these tools are available

- through the built-in ctrlyoke MCP server when you include `"ctrlyoke"` in `mcpServers`
