```yaml
steps:
  - parallel:
      - name: inspect-api
        prompt: Inspect the API surface.
      - name: inspect-ui
        prompt: Inspect the dashboard surface.
    failFast: true
```

See [Dynamic workflows: parallel groups](/workflows/dynamic-workflows#parallel-groups) for what a
member can do through the `ctrlyoke` MCP server.
