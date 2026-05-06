# Copilot CLI

`copilot-cli` is the default FlightPath harness and the easiest place to start if you already use GitHub Copilot.

## Why use it

- First-class fit with FlightPath defaults
- Good support for interactive terminal workflows
- Natural choice if your team already authenticates with GitHub

## Typical setup

1. Install the GitHub Copilot CLI
2. Authenticate it
3. Set FlightPath's harness to `copilot-cli`
4. Optionally pick a model override in your workflow or settings

## Example

```yaml
harness: copilot-cli
model: claude-sonnet-4.5

steps:
  - prompt: Review @src/ for the highest-priority reliability issue.
```

## Notes

- Tool permissions can be tuned through workflow overrides or `.flightpath/settings.json`.
- Additional allowed directories can be granted when the harness needs access outside the workspace root.
- If you need a workflow to continue a previous Copilot conversation, use `resumeSession` or `sessionId`.
