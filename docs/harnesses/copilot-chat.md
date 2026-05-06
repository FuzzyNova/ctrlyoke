# Copilot Chat

`copilot-chat` uses the GitHub Copilot Chat window inside VS Code instead of launching a CLI process.

## When to use it

- You want to stay entirely inside the chat UI
- Your workflow is extension-first rather than terminal-first
- You do not need standalone CLI execution

## Notes

- This harness is only available in VS Code.
- Chat-window behavior differs from the CLI harnesses, so CLI-specific flags and PTY features do not apply.
- Workflow syntax stays the same, which makes it easy to move between `copilot-chat` and a CLI harness later.
