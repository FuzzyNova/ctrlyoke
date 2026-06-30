# Dynamic queue

Dynamic queue extension lets a workflow add more work while it is already running.

## Enable it

Add the built-in ctrlyoke MCP server:

```yaml
mcpServers:
  - ctrlyoke
```

## What it provides

The built-in server exposes queue tools that let the harness:

- inspect the current queue
- append new prompts after the current position or at the end
- read previous output when planning follow-up work

## Typical pattern

Use `ctrlyoke` in the `finalStep` so the harness can review the current run, append follow-up tasks, and loop until it decides the queue is complete.

```yaml
finalStep:
  prompt: Review the implementation and append any missing follow-up work.
  mcpServers:
    - ctrlyoke
```
