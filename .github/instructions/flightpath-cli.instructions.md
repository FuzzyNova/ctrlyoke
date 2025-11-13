---
applyTo: "src/flightpath/cli/**"
---

<purpose>
Default integration using GitHub Copilot CLI. Deterministic completion, no UI dependencies.
</purpose>

<architecture>
- `copilot` command blocks until complete (no polling)
- Process exit = completion signal
- Stdout mixed: response + statistics (parse via delimiter detection)
- Session support: `--resume-session <id>` for multi-turn conversations
</architecture>

<differenceFromChat>
- No timing delays or UI automation
- Direct response text access (not clipboard-based)
- No tool instruction XML needed (deterministic completion)
- Structured output (response + statistics separated)
</differenceFromChat>

<configuration>
- `copilotCliModel`: AI model selection
- `copilotCliAllowedDirs`: Additional accessible directories
- `copilotCliToolPermissions`: Tool access control
- `showCliOutput`: Output panel visibility
</configuration>
