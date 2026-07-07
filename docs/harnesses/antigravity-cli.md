# Antigravity CLI

`antigravity-cli` integrates Google's Antigravity CLI (`agy`) into ctrlyoke.

Use it when:

- You want Google's current CLI path for coding workflows
- You need Antigravity model choices such as Gemini Flash, Claude, or GPT-OSS
- You want ctrlyoke workflow execution, hooks, MCP, agents, skills, and history around `agy`

```yaml
harness: antigravity-cli
model: Gemini 3.5 Flash (Low)
steps:
  - prompt: Update the implementation and run the focused tests.
```

Notes:

- Install and authenticate `agy` before selecting this harness.
- ctrlyoke requires `agy` 1.0.15 or newer.
- For manual test runs, prefer `Gemini 3.5 Flash (Low)` to avoid exhausting the default Claude quota.
- Antigravity stores some user-level config under `~/.gemini/`; those paths are expected and are not Gemini CLI support.
