# Copilot CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`copilot-cli` is the default ctrlyoke harness and the easiest place to start if you already use GitHub Copilot.

## Why use it

- First-class fit with ctrlyoke defaults
- Good support for interactive terminal workflows
- Natural choice if your team already authenticates with GitHub

## Typical setup

1. Install the GitHub Copilot CLI (`npm install -g @github/copilot`)
2. Authenticate it
3. Set ctrlyoke's harness to `copilot-cli`
4. Optionally pick a model override in your workflow or settings

## Example

```yaml
harness: copilot-cli
model: claude-sonnet-4.6

steps:
  - prompt: Review @src/ for the highest-priority reliability issue.
```

## Notes

- Tool permissions can be tuned through workflow `toolPermissions` overrides or `defaults.toolPermissions` in `.ctrlyoke/settings.json`.
- Directories outside the workspace are granted through `permissions.allowedExternalFileRoots`; ctrlyoke passes each approved root to Copilot as `--add-dir`. To pass `--allow-all-paths` instead, add it to `defaults.additionalArgs["copilot-cli"]`.
- If you need a workflow to continue a previous Copilot conversation, use `resumeSession` or `sessionId`.
