# Copilot CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`copilot-cli` runs ctrlyoke workflows through the GitHub Copilot CLI while keeping the same workflow file format used elsewhere.

## Good fit

- Teams that already have a GitHub Copilot subscription and use the Copilot CLI
- Workflows that want Copilot's model catalog behind the ctrlyoke queue, history, and script gating

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
- Directories outside the workspace are granted through `permissions.trustedExternalRoots`; ctrlyoke passes each approved root to Copilot as `--add-dir`. To pass `--allow-all-paths` instead, add it to `defaults.additionalArgs["copilot-cli"]`.
- If you need a workflow to continue a previous Copilot conversation, use `resumeSession` or `sessionId`.
