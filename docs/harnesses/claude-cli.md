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

- The CLI harness model names differ from Copilot CLI model names, so keep model overrides harness-specific.
- Session IDs are harness-specific. Reuse only Claude sessions with Claude steps.
- When you need custom tool permission behavior, configure it in workflow `toolPermissions` or global settings.
