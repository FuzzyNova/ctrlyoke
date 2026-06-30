# CLI overview

ctrlyoke ships with two command-line entry points:

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `ctrlyoke`     | Execute or validate workflow files       |
| `ctrlyoke-mcp` | Run the standalone ctrlyoke MCP server |

## What the CLI shares with the extension

- the same workflow file formats
- the same schema validation
- the same end condition and pre-condition behavior
- the same core orchestration logic

## What is different

- no VS Code dashboard UI
- no Copilot Chat window harness
- terminal-oriented output instead of the panel UI

Read [ctrlyoke](/cli/ctrlyoke) for the user-facing commands.
