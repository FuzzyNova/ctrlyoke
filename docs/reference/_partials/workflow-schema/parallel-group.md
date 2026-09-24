```yaml
steps:
  - parallel:
      - name: inspect-api
        prompt: Inspect the API surface.
      - name: inspect-ui
        prompt: Inspect the dashboard surface.
    failFast: true
```

Group members share the workflow's workspace and its one managed or named
worktree. ctrlyoke does not isolate members or merge their work, so give each
member independent work. The
[`queue.maxParallelSteps`](/reference/settings#queue-maxparallelsteps) setting
caps how many members run at once. Groups cannot be nested, `finalStep` cannot
be a group, and group members cannot use the built-in `ctrlyoke` MCP server.
