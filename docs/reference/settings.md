# Settings

FlightPath's current global configuration schema lives in `.flightpath/settings.json`.

## Where settings come from

The core config model is defined in:

- `schemas/settings-schema.json`
- `src/types/FlightPathSettings.ts`

These settings apply to both the extension and the standalone CLI where relevant.

## Top-level sections

| Section                | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `harness`              | Default harness                                                   |
| `models`               | Per-harness model defaults                                        |
| `additionalArgs`       | Per-harness extra CLI arguments                                   |
| `execution`            | Interactive vs headless behavior, prompt timeout, script timeout  |
| `tools`                | Permission mode, allow/deny lists, harness-specific tool controls |
| `workflow`             | Defaults for new workflows                                        |
| `chat`                 | Copilot Chat behavior                                             |
| `mcp`                  | Default MCP servers                                               |
| `hooks`                | Global user-defined hooks                                         |
| `queue`                | Queue size and execution time limits                              |
| `history`              | Output history retention                                          |
| `terminal`             | Embedded terminal behavior                                        |
| `ui`                   | Webview and prompt-editor behavior                                |
| `server`               | Hosted dashboard server settings                                  |
| `notifications`        | VS Code and browser notification preferences                      |
| `enableDiagnosticLogs` | Extra logging                                                     |

## Common settings

### Choose a default harness

```json
{
  "harness": "copilot-cli"
}
```

### Set default models per harness

```json
{
  "models": {
    "copilot-cli": "claude-sonnet-4.5",
    "claude-cli": "sonnet",
    "gemini-cli": "gemini-2.5-pro"
  }
}
```

### Set execution defaults

```json
{
  "execution": {
    "mode": "interactive",
    "scriptTimeout": 30,
    "maxPromptTimeout": 10800
  }
}
```

### Set tool permission defaults

```json
{
  "tools": {
    "permissionMode": "allowAll",
    "allowed": ["write", "shell(git status)", "shell(npm:*)"],
    "denied": ["shell(rm:*)", "shell(git push:*)"]
  }
}
```

## Notable defaults

Current defaults include:

- `harness: "copilot-cli"`
- `execution.mode: "interactive"`
- `execution.scriptTimeout: 30`
- `workflow.defaultFormat: "yaml"`
- `workflow.resumeExistingSession: false`
- `workflow.priorContext: "none"`

See `src/types/FlightPathSettings.ts` for the full default object.
