# Claude CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`claude-cli` runs ctrlyoke workflows through Claude Code while keeping the same workflow file format used elsewhere.

![The dashboard after a three-step demo workflow ran on Claude Code, with 5% quota used shown next to Claude Code in the harness picker](/screenshots/rate-limiter-claude-1200x800.png)

## Good fit

- Teams that already use Claude Code directly
- Workflows that want the ctrlyoke queue, history, and script gating on top of Claude Code

## Prerequisites

- **Command:** `claude`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** run `claude` once in a terminal and complete the sign-in.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with `claude update`.

If the CLI is missing or too old, the harness picker shows a red dot next to Claude Code, and its
tooltip gives the install command, or the update command when the installed version is below the
minimum. An amber dot means it runs but is older than the recommended version. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No AI harness CLI is available** panel with the install command
for every harness.

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

- Claude uses short model aliases (`fable`, `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]`, `haiku`), not Copilot-style IDs like `claude-sonnet-4.6`, so keep model overrides harness-specific.
- Session IDs are harness-specific. Reuse only Claude sessions with Claude steps.
- When you need custom tool permission behavior, configure it in workflow `toolPermissions` or `defaults.toolPermissions` in settings.
- Directories in `permissions.trustedExternalRoots` are passed to Claude as `--add-dir`.
- Hooks and MCP servers are passed per process with `--settings` and `--mcp-config`, so ctrlyoke writes nothing to your project's `.claude/` folder. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#claude-code).

## Usage and rate limits

Claude Code reports its 5-hour and 7-day quota windows only to its status line, so ctrlyoke
installs a status line command in `~/.claude/settings.json` to read them. If you already have a
status line, ctrlyoke keeps running yours underneath; see
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

Because of that, the quota updates only while a Claude session that ctrlyoke started is running,
and only while the Claude status line is turned on in **Settings → Status Line**. Claude Code has
no way to ask for the quota on demand, so **ctrlyoke: Refresh Harness Usage** can't update it.
Between runs, ctrlyoke keeps showing the last value along with the time it was read.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the **Stats & Usage** settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).
