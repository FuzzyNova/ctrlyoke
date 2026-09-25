# CLI overview

ctrlyoke ships with two command-line entry points:

| Command        | Purpose                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `ctrlyoke`     | Run, continue, and validate workflows; inspect run history; manage secrets; generate commits |
| `ctrlyoke-mcp` | Run the standalone ctrlyoke MCP server that harnesses use for queue and output tools         |

Both are Node.js programs and require Node.js 22.12 or later. The harness CLIs
you run workflows with (Copilot CLI, Claude Code, and so on) must be installed,
on `PATH`, and signed in, exactly as for the extension.

## What the CLI shares with the extension

- the same workflow file formats
- the same schema validation
- the same end condition and pre-condition behavior
- the same core orchestration logic
- the same settings files (`~/.ctrlyoke/settings.json` and
  `<workspace>/.ctrlyoke/settings.json`)
- the same run history: runs started by the CLI appear in the dashboard's
  history, and a CLI run that is executing is mirrored live in the VS Code
  dashboard for the same project

## What is different

- no dashboard UI; headless output is formatted for the terminal, and
  interactive mode passes the harness's own terminal UI through
- headless runs default to the `dangerouslyAllowAll` tool permission mode
  unless you pass `--permission-mode` or allow/deny patterns
- structured exit codes and `--json` output for scripting and CI

Read [ctrlyoke](/cli/ctrlyoke) for every command and option, and
[ctrlyoke-mcp](/cli/ctrlyoke-mcp) for the MCP server.
