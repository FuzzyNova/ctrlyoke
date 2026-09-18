# Workflow schema reference

This page summarizes the current public workflow schema from
`schemas/workflow-schema.json`.

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

| Field             | Type                | Notes                                                                                                                 |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `harness`         | string              | One of the supported harness IDs                                                                                      |
| `model`           | string              | Harness-specific model name                                                                                           |
| `agent`           | string or `null`    | Portable ctrlyoke prompt attachment; resolved into categorized prompt references and wrapped in `<agentInstructions>` |
| `skills`          | string[] or `null`  | Portable ctrlyoke prompt attachments resolved into categorized prompt references                                      |
| `resumeSession`   | boolean             | Default session behavior                                                                                              |
| `sessionId`       | string or number    | Exact session, step reference, or `"finalStep"`                                                                       |
| `mcpServers`      | array or `null`     | Include `"ctrlyoke"` for dynamic queue support                                                                        |
| `hooks`           | array or `null`     | User-defined harness hook commands                                                                                    |
| `endCondition`    | object or `null`    | Post-step validation defaults                                                                                         |
| `preCondition`    | object or `null`    | Pre-step gating defaults                                                                                              |
| `priorContext`    | keyword or number[] | Prior-output injection rules                                                                                          |
| `additionalArgs`  | string or `null`    | Extra CLI arguments                                                                                                   |
| `toolPermissions` | object or `null`    | Per-workflow tool permission overrides                                                                                |
| `steps`           | array               | Required for multi-step workflows                                                                                     |
| `finalStep`       | step                | Optional loop/review step                                                                                             |
| `vars`            | object              | `{{name}}` substitutions                                                                                              |

## Parallel queue items

An item in the root `steps` array may use `parallel` instead of `prompt` or
`script`:

```yaml
steps:
  - parallel:
      - name: inspect-api
        prompt: Inspect the API surface.
      - name: inspect-ui
        prompt: Inspect the dashboard surface.
    failFast: true
```

`parallel` must contain at least two prompt or script steps. It is normalized
to the flat `steps` array and a `parallelGroups` topology in working files; the
normalized field is runtime/storage metadata, not authored syntax. Groups are
flat and non-nested, and `finalStep` cannot be a parallel group.

Members share the workflow workspace and the single managed or named worktree
for the run. v1 does not provide per-member isolation or automatic merging, so
members should perform independent work. The global `queue.maxParallelSteps`
setting bounds active members; `1` is a supported sequential mode. The built-in
`ctrlyoke` MCP server is rejected on group members, but remains valid on
`finalStep`.

## Prompt step fields

| Field      | Type       | Notes                                    |
| ---------- | ---------- | ---------------------------------------- |
| `type`     | `"prompt"` | Optional; prompt is the default          |
| `name`     | string     | Dashboard label                          |
| `prompt`   | string     | Inline prompt text or a prompt file path |
| `_runtime` | object     | Added automatically during execution     |

Prompt steps also accept the execution fields listed in the workflow-level table.

## Script step fields

| Field           | Type                           | Notes                                            |
| --------------- | ------------------------------ | ------------------------------------------------ |
| `type`          | `"script"`                     | Required                                         |
| `name`          | string                         | Optional label                                   |
| `script`        | string                         | Command or script path                           |
| `compareSource` | `stdout`, `stderr`, `exitCode` | Which output to compare (default `exitCode`)     |
| `operator`      | enum                           | How to compare (default `eq`)                    |
| `expected`      | string \| number               | Value to compare against; omit to pass on exit 0 |
| `ignoreCase`    | boolean                        | Case-insensitive text compare                    |
| `timeout`       | number                         | Milliseconds                                     |
| `onPass`        | `continue`, `stopWorkflow`     | Pass behavior                                    |
| `onFail`        | `continue`, `stopWorkflow`     | Failure behavior                                 |

## End condition fields

| Field                  | Type                                | Notes                                             |
| ---------------------- | ----------------------------------- | ------------------------------------------------- |
| `script`               | string                              | Command or script path                            |
| `expected`             | string \| number                    | Value to compare against; omit to pass on exit 0  |
| `compareSource`        | enum                                | Which output to compare (default `exitCode`)      |
| `operator`             | enum                                | How to compare (default `eq`)                     |
| `ignoreCase`           | boolean                             | Case-insensitive text compare                     |
| `timeout`              | number                              | Milliseconds                                      |
| `maxRetries`           | number                              | `-1` for unlimited                                |
| `retryPrompt`          | string                              | Retry template                                    |
| `passRetryPrompt`      | string                              | Template sent when a passing condition is retried |
| `resumeSessionOnRetry` | boolean                             | Reuse same session on retry                       |
| `onPass`               | `continue`, `retry`, `stopWorkflow` | Pass behavior; exhausting pass retries advances   |
| `onFail`               | `continue`, `retry`, `stopWorkflow` | Failure behavior                                  |

## Tool permissions

`toolPermissions` contains:

- `mode`: `dangerouslyAllowAll`, `allowAll`, `custom`, or `passthrough`
- `allowedTools`: allow-list patterns
- `deniedTools`: deny-list patterns

Allowed Tools and Denied Tools are currently supported by Copilot CLI, Claude
CLI, Qwen Code, and OpenCode. Qwen is inline granular support. OpenCode
delivers permissions through `OPENCODE_CONFIG_CONTENT` and writes no workspace
`opencode.json`. Codex and Antigravity provide a derived mode-only summary;
their Allowed Tools and Denied Tools lists are **NOT ENFORCED**.

Use `passthrough` when you want ctrlyoke to omit its permission flags and rely on the harness's own local configuration.
