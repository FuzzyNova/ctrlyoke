# MCP tools

FlightPath exposes built-in tools for workflows and chat integrations that need to inspect or extend the active queue.

## Built-in tool list

| Tool                      | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `flightpath_queue_status` | Return queue metadata and step state            |
| `flightpath_append_queue` | Append prompts to the current queue             |
| `flightpath_capabilities` | Return available harnesses and supported models |
| `flightpath_read_output`  | Read output from completed prompts              |

## `flightpath_append_queue`

This tool accepts:

- `prompts`: array of prompts to add
- `position`: `next` or `end`
- `source`: optional source label
- `reason`: optional explanation

Use it when the harness discovers follow-up work during a run.

## When these tools are available

- as language model tools in the extension
- through the built-in FlightPath MCP server when you include `"flightpath"` in `mcpServers`
