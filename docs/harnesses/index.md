# Harness overview

Harnesses are the reason FlightPath can keep one workflow model while talking to very different AI assistants.

## At a glance

| Harness | Runs where | Best for | Notes |
| --- | --- | --- | --- |
| `copilot-cli` | CLI | Default path for GitHub users | Good general-purpose default |
| `claude-cli` | CLI | Long-form reasoning and coding | Strong session continuity |
| `codex-cli` | CLI | OpenAI Codex workflows | Exposes Codex-specific sandbox controls |
| `opencode-cli` | CLI | Provider-flexible OpenCode setups | Useful when OpenCode is already your standard |
| `qwen-cli` | CLI | Qwen Code users | Similar workflow model to other CLI harnesses |
| `gemini-cli` | CLI | Gemini-based coding workflows | Supports MCP config support |
| `copilot-chat` | VS Code chat UI | Users who want to stay in the chat window | No standalone CLI equivalent |

## Choosing a starting harness

- Start with **`copilot-cli`** if you want the path FlightPath is built around by default.
- Use **`claude-cli`** if your team already works in Claude Code.
- Use **`copilot-chat`** if you want a VS Code-native experience and do not need the standalone CLI.
- Reach for the other CLI harnesses when they already match your preferred assistant or hosting model.

## Capability differences

All harnesses use the same workflow schema, but they do not expose identical runtime behavior.

| Capability | CLI harnesses | `copilot-chat` |
| --- | --- | --- |
| Interactive terminal mode | Yes | No |
| Headless execution | Yes | No |
| Per-harness CLI args | Yes | No |
| Chat UI integration | No | Yes |
| CLI session IDs | Yes | No |

See the per-harness pages for setup notes and tradeoffs.
