# Workflow schema reference

This page summarizes the current public workflow schema from `schemas/prompt-schema.json`.

## Multi-step workflow shape

```yaml
harness: copilot-cli
model: claude-sonnet-4.5
steps:
  - prompt: Review @src/
finalStep:
  prompt: Summarize what changed.
```

## Workflow-level fields

| Field             | Type                | Notes                                           |
| ----------------- | ------------------- | ----------------------------------------------- |
| `harness`         | string              | One of the supported harness IDs                |
| `model`           | string              | Harness-specific model name                     |
| `agent`           | string or `null`    | Custom agent name                               |
| `skills`          | string[] or `null`  | Skill names                                     |
| `resumeSession`   | boolean             | Default session behavior                        |
| `sessionId`       | string or number    | Exact session, step reference, or `"finalStep"` |
| `mcpServers`      | array or `null`     | Include `"ctrlyoke"` for dynamic queue support  |
| `hooks`           | array or `null`     | User-defined harness hook commands              |
| `endCondition`    | object or `null`    | Post-step validation defaults                   |
| `preCondition`    | object or `null`    | Pre-step gating defaults                        |
| `priorContext`    | keyword or number[] | Prior-output injection rules                    |
| `additionalArgs`  | string or `null`    | Extra CLI arguments                             |
| `toolPermissions` | object or `null`    | Per-workflow tool permission overrides          |
| `steps`           | array               | Required for multi-step workflows               |
| `finalStep`       | step                | Optional loop/review step                       |
| `vars`            | object              | `{{name}}` substitutions                        |

## Prompt step fields

| Field      | Type       | Notes                                    |
| ---------- | ---------- | ---------------------------------------- |
| `type`     | `"prompt"` | Optional; prompt is the default          |
| `name`     | string     | Dashboard label                          |
| `prompt`   | string     | Inline prompt text or a prompt file path |
| `_runtime` | object     | Added automatically during execution     |

Prompt steps also accept the execution fields listed in the workflow-level table.

## Script step fields

| Field           | Type                                   | Notes                  |
| --------------- | -------------------------------------- | ---------------------- |
| `type`          | `"script"`                             | Required               |
| `name`          | string                                 | Optional label         |
| `script`        | string                                 | Command or script path |
| `compareSource` | `auto`, `stdout`, `stderr`, `exitCode` | Comparison source      |
| `returns`       | string                                 | Expected result        |
| `timeout`       | number                                 | Milliseconds           |
| `onPass`        | `continue`, `stopWorkflow`             | Pass behavior          |
| `onFail`        | `continue`, `stopWorkflow`             | Failure behavior       |

## End condition fields

| Field                  | Type                                | Notes                       |
| ---------------------- | ----------------------------------- | --------------------------- |
| `script`               | string                              | Command or script path      |
| `returns`              | string                              | Expected result             |
| `compareSource`        | enum                                | Output source to compare    |
| `timeout`              | number                              | Milliseconds                |
| `maxRetries`           | number                              | `-1` for unlimited          |
| `retryPrompt`          | string                              | Retry template              |
| `resumeSessionOnRetry` | boolean                             | Reuse same session on retry |
| `onPass`               | `continue`, `stopWorkflow`         | Pass behavior               |
| `onFail`               | `continue`, `retry`, `stopWorkflow` | Failure behavior            |

## Tool permissions

`toolPermissions` contains:

- `mode`: `dangerouslyAllowAll`, `allowAll`, `custom`, or `passthrough`
- `allowedTools`: allow-list patterns
- `deniedTools`: deny-list patterns

Use `passthrough` when you want ctrlyoke to omit its permission flags and rely on the harness's own local configuration.
