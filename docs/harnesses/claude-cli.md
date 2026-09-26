# Claude CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`claude-cli` runs ctrlyoke workflows through Claude Code while keeping the same workflow file format used elsewhere.

## Why use it

- Strong fit for multi-step conversational coding workflows
- Good option when your team already standardizes on Claude Code
- Supports the same script gating, session management, and queue features as the other CLI harnesses

## Example

```yaml
harness: claude-cli
model: sonnet

steps:
  - name: analyze
    prompt: Inspect @src/server/ for security gaps.
  - name: fix
    resumeSession: true
    prompt: Implement the fixes.
```

## Notes

- Install with `npm install -g @anthropic-ai/claude-code` and sign in before selecting this harness.
- Claude uses short model aliases (`fable`, `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]`, `haiku`), not Copilot-style IDs like `claude-sonnet-4.6`, so keep model overrides harness-specific.
- Session IDs are harness-specific. Reuse only Claude sessions with Claude steps.
- When you need custom tool permission behavior, configure it in workflow `toolPermissions` or `defaults.toolPermissions` in settings.
- Directories in `permissions.trustedExternalRoots` are passed to Claude as `--add-dir`.
