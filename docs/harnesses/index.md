# Harness overview

Harnesses are the reason ctrlyoke can keep one workflow model while talking to very different AI assistants.

## At a glance

| Harness           | Runs where | Best for                          | Notes                                         |
| ----------------- | ---------- | --------------------------------- | --------------------------------------------- |
| `copilot-cli`     | CLI        | Default path for GitHub users     | Good general-purpose default                  |
| `claude-cli`      | CLI        | Long-form reasoning and coding    | Strong session continuity                     |
| `codex-cli`       | CLI        | OpenAI Codex workflows            | Exposes Codex-specific sandbox controls       |
| `opencode-cli`    | CLI        | Provider-flexible OpenCode setups | Useful when OpenCode is already your standard |
| `qwen-cli`        | CLI        | Qwen Code users                   | Similar workflow model to other CLI harnesses |
| `antigravity-cli` | CLI        | Google Antigravity workflows      | Uses `agy`; supports MCP config support       |

## Choosing a starting harness

- Start with **`copilot-cli`** if you want the path ctrlyoke is built around by default.
- Use **`claude-cli`** if your team already works in Claude Code.
- Reach for the other CLI harnesses when they already match your preferred assistant or hosting model.

All harnesses use the same workflow schema and expose the same runtime capabilities (interactive terminal mode, headless execution, per-harness CLI args, and CLI session IDs).

See the per-harness pages for setup notes and tradeoffs.
