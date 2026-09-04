# Settings

ctrlyoke's current global configuration schema lives in `.ctrlyoke/settings.json`.

## Where settings come from

The core config model is defined in:

- `schemas/settings-schema.json`
- `src/types/CtrlYokeSettings.ts`

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
| `mcp`                  | Default MCP servers                                               |
| `hooks`                | Global user-defined hooks                                         |
| `queue`                | Queue size, parallelism, and execution time limits                |
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
    "antigravity-cli": "gemini-3.6-flash-medium"
  }
}
```

### Set execution defaults

```json
{
  "execution": {
    "scriptTimeout": 30,
    "maxPromptTimeout": 10800
  },
  "defaults": {
    "executionMode": "interactive"
  }
}
```

### Limit parallel group execution

`queue.maxParallelSteps` controls the maximum number of active members in a
parallel step group. A group larger than this value drains through the limit;
`1` keeps grouped steps sequential. Members share the workflow workspace and
the one managed or named worktree for the run; this setting limits concurrency,
but does not provide per-member isolation or merging.

```json
{
  "queue": {
    "maxParallelSteps": 6
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

### Allow external file roots

Workspace files are trusted by default. External directories are opt-in through
`permissions.allowedExternalFileRoots`:

```json
{
  "permissions": {
    "allowedExternalFileRoots": [
      "C:/Users/me/.codex/sessions",
      "C:/temp/repros"
    ]
  },
  "ui": {
    "offerTrustForUntrustedFileLinks": true
  }
}
```

The same setting can be written at two scopes:

- **User scope** applies to every workspace and is trusted immediately because
  editing the user's own settings is the approval.
- **Workspace scope** applies only to the current workspace. A root declared in
  workspace settings is a request and needs a separate, per-machine approval.
  Use the dashboard approval flow or `ctrlyoke trust-external-roots <file>` to
  review it. Decisions are stored locally and are never written into the
  workspace settings file.

`ui.offerTrustForUntrustedFileLinks` controls whether an untrusted
AI-generated file link may offer the Trust Parent Folder action. It does not
grant access or disable the external-root boundary.

For a single workflow, use the workflow-level `trustedExternalRoots` field to
inherit, replace, or disable the user/workspace set. See
[YAML workflow format](/workflows/yaml-format#workflow-scoped-external-roots).

## Notable defaults

Current defaults include:

- `harness: "copilot-cli"`
- `defaults.executionMode: "interactive"`
- `execution.scriptTimeout: 30`
- `workflow.defaultFormat: "yaml"`
- `workflow.resumeExistingSession: false`
- `workflow.priorContext: "none"`

See `src/types/CtrlYokeSettings.ts` for the full default object.
