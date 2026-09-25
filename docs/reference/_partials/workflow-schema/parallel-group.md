```yaml
steps:
  - parallel:
      - name: inspect-api
        prompt: Inspect the API surface.
      - name: inspect-ui
        prompt: Inspect the dashboard surface.
    failFast: true
```

See [Dynamic queue: parallel groups](/workflows/dynamic-queue#parallel-groups) for what a
member can do through the `ctrlyoke` MCP server.
