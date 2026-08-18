# Antigravity CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`antigravity-cli` integrates Google's Antigravity CLI (`agy`) into ctrlyoke.

Use it when:

- You want Google's current CLI path for coding workflows
- You need Antigravity model choices such as Gemini Flash, Claude, or GPT-OSS
- You want ctrlyoke workflow execution, hooks, MCP, agents, skills, and history around `agy`

```yaml
harness: antigravity-cli
model: gemini-3.6-flash-low
steps:
  - prompt: Update the implementation and run the focused tests.
```

Notes:

- Install and authenticate `agy` before selecting this harness.
- ctrlyoke requires `agy` 1.0.15 or newer.
- Models are the IDs `agy models` prints (`gemini-3.6-flash-low`, `claude-sonnet-4-6`, …). The dashboard shows agy's friendlier labels ("Gemini 3.6 Flash (Low)"), and `agy` itself accepts either spelling, but workflow files and settings use the ID.
- For manual test runs, prefer a Gemini Flash tier to avoid exhausting the much smaller Claude quota.
- Antigravity stores some user-level config under `~/.gemini/`; those paths are expected and are not Gemini CLI support.
