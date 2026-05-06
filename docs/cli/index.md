# CLI overview

FlightPath ships with two command-line entry points:

| Command | Purpose |
| --- | --- |
| `flightpath` | Execute or validate workflow files |
| `flightpath-mcp` | Run the standalone FlightPath MCP server |

## What the CLI shares with the extension

- the same workflow file formats
- the same schema validation
- the same end condition and pre-condition behavior
- the same core orchestration logic

## What is different

- no VS Code dashboard UI
- no Copilot Chat window harness
- terminal-oriented output instead of the panel UI

Read [flightpath](/cli/flightpath) for the user-facing commands.
