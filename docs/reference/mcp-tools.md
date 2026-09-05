# MCP tools

ctrlyoke exposes built-in tools for workflows and chat integrations that need to inspect or extend the active queue.

## Built-in tool list

| Tool                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `workflow_status` | Return queue metadata and step state            |
| `append_step` | Append prompts to the current queue             |
| `capabilities` | Return available harnesses and supported models |
| `read_output`  | Read output from completed prompts              |

## `append_step`

This tool accepts:

- `prompts`: array of prompts to add
- `position`: `next` or `end`
- `source`: optional source label
- `reason`: optional explanation

Use it when the harness discovers follow-up work during a run.

## When these tools are available

- through the built-in ctrlyoke MCP server when you include `"ctrlyoke"` in `mcpServers`
