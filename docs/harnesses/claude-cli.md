# Claude CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`claude-cli` runs ctrlyoke workflows through Claude Code while keeping the same workflow file format used elsewhere.

## Good fit

- Teams that already use Claude Code directly
- Workflows that want the ctrlyoke queue, history, and script gating on top of Claude Code

## Install

Install Claude Code with Anthropic's native installer, which keeps itself up to date:

macOS and Linux:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Homebrew (`brew install --cask claude-code`), WinGet (`winget install Anthropic.ClaudeCode`), and npm (`npm install -g @anthropic-ai/claude-code`) also work, but do not update themselves.

See [Claude Code's setup guide](https://code.claude.com/docs/en/setup) for other install methods.

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

- Sign in with `claude` once before selecting this harness.
- Claude uses short model aliases (`fable`, `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]`, `haiku`), not Copilot-style IDs like `claude-sonnet-4.6`, so keep model overrides harness-specific.
- Session IDs are harness-specific. Reuse only Claude sessions with Claude steps.
- When you need custom tool permission behavior, configure it in workflow `toolPermissions` or `defaults.toolPermissions` in settings.
- Directories in `permissions.trustedExternalRoots` are passed to Claude as `--add-dir`.
