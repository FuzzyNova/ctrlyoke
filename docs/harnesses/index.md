# Harness overview

Harnesses are the reason ctrlyoke can keep one workflow model while talking to very different AI assistants.

See the [generated harness compatibility matrix](/harnesses/compatibility) for
capability fidelity, evidence, version scope, caveats, and remediation guidance.

## At a glance

| Harness           | Runs where | Best for                          | Notes                                         |
| ----------------- | ---------- | --------------------------------- | --------------------------------------------- |
| `copilot-cli`     | CLI        | Default path for GitHub users     | Good general-purpose default                  |
| `claude-cli`      | CLI        | Long-form reasoning and coding    | Strong session continuity                     |
| `codex-cli`       | CLI        | OpenAI Codex workflows            | Sandbox/approval modes, not tool patterns     |
| `opencode-cli`    | CLI        | Provider-flexible OpenCode setups | Useful when OpenCode is already your standard |
| `qwen-cli`        | CLI        | Qwen Code users                   | No image attachments                          |
| `antigravity-cli` | CLI        | Google Antigravity workflows      | Uses `agy`; coarse permission modes only      |

## Choosing a starting harness

- Start with **`copilot-cli`** if you want the path ctrlyoke is built around by default.
- Use **`claude-cli`** if your team already works in Claude Code.
- Reach for the other CLI harnesses when they already match your preferred assistant or hosting model.

All harnesses use the same workflow schema and share the core runtime: interactive terminal mode, headless execution, per-harness `additionalArgs`, CLI session IDs, MCP server attachment, and portable agents and skills. What differs is enforcement of tool permission lists, which hook events fire, per-server MCP tool filtering, and image attachments — check the [compatibility matrix](/harnesses/compatibility) before relying on one of those.

See the per-harness pages for setup notes and tradeoffs.
