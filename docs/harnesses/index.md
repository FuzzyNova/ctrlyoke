# Harness overview

Harnesses are the reason ctrlyoke can keep one workflow model while talking to very different AI assistants.

See the [generated harness compatibility matrix](/harnesses/compatibility) for
capability fidelity, evidence, version scope, caveats, and remediation guidance.

## At a glance

| Harness           | Drives                         | Notes                                     |
| ----------------- | ------------------------------ | ----------------------------------------- |
| `copilot-cli`     | GitHub Copilot CLI (`copilot`) | Fine-grained tool permission patterns     |
| `claude-cli`      | Claude Code (`claude`)         | Fine-grained tool permission patterns     |
| `codex-cli`       | OpenAI Codex CLI (`codex`)     | Sandbox/approval modes, not tool patterns |
| `opencode-cli`    | OpenCode (`opencode`)          | Provider-flexible `provider/model` IDs    |
| `qwen-cli`        | Qwen Code (`qwen`)             | No image attachments                      |
| `antigravity-cli` | Google Antigravity CLI (`agy`) | Coarse permission modes only              |

## Choosing a harness

There is no preferred harness. Use the one you already have installed, subscribe to, or trust
with your code — ctrlyoke gives each of them the same prompt syntax, workflow format, output
view, and controls. Out of the box the default is **Auto-detect**: the first installed harness in
alphabetical order. Choose a specific one with the **Default harness** setting in ctrlyoke
Settings, override it per workflow, or pick a different harness for each step in the same run.

All harnesses use the same workflow schema and share the core runtime: interactive terminal mode, headless execution, per-harness `additionalArgs`, CLI session IDs, MCP server attachment, and portable agents and skills. What differs is enforcement of tool permission lists, which hook events fire, per-server MCP tool filtering, and image attachments — check the [compatibility matrix](/harnesses/compatibility) before relying on one of those.

See the per-harness pages for setup notes and tradeoffs.
