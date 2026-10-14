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

## Model selection {#model-selection}

Claude Code has no command that lists its models, so the **Model** picker shows a fixed list of
Claude's short aliases: `fable`, `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]` and `haiku`. Claude Code
resolves each alias to its current model.

Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["claude-cli"]`](/reference/settings#defaults-models), which is `sonnet` out of
the box. A Copilot-style ID such as `claude-sonnet-4.6` is mapped to the alias for its family
(`sonnet`), so it loses any version or `[1m]` suffix. Any other value is replaced by your default,
with a warning in the log. Keep model overrides harness-specific.

`model: none` passes no `--model` flag, so Claude Code uses its own default model. To pass a model
the list doesn't have, such as a full model ID, set `model: none` and put `--model <id>` in
`additionalArgs`. See [How step properties inherit](/workflows/yaml-format#property-inheritance).

## Permissions {#permissions}

The permission `mode` maps to Claude Code flags:

- `dangerouslyAllowAll` → `--dangerously-skip-permissions`. The deny list is ignored.
- `allowAll` → `--permission-mode bypassPermissions --tools default`, plus `--disallowedTools`
  with the deny list
- `custom` → `--allowedTools` with the allow list and `--disallowedTools` with the deny list. In
  headless runs ctrlyoke also passes `--permission-mode dontAsk`, which denies any tool that isn't
  pre-approved. Interactive runs keep Claude's default mode, which asks you in the terminal.
- `none` → no permission flags (Claude's own settings, such as `~/.claude/settings.json`)

Tool names are translated to Claude's spelling, and arguments are kept: `shell` and `bash` become
`Bash`, `write` becomes `Write`, and `read`, `edit`, `multiedit`, `glob`, `grep`, `ls`, `webfetch`
and `todowrite` become `Read`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `WebFetch` and
`TodoWrite`. The default deny list therefore reaches Claude as
`--disallowedTools Bash(rm:*) Bash(git push:*) …`. MCP patterns such as
`mcp__github__create_issue` pass through unchanged.

In headless `custom` runs, allow rules in Claude's own settings also count as pre-approved, so they
can add to your allow list. See [Permissions](/workflows/permissions) for the modes, the pattern
syntax and [the default lists](/workflows/permissions#the-default-lists).

## Notes

- Session IDs are harness-specific. Reuse only Claude sessions with Claude steps.
- Directories in `permissions.trustedExternalRoots` are passed to Claude as `--add-dir`.
- Hooks and MCP servers are passed per process with `--settings` and `--mcp-config`, so ctrlyoke writes nothing to your project's `.claude/` folder. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#claude-code).

## Usage and rate limits

Claude Code reports its 5-hour and 7-day quota windows only to its status line, so ctrlyoke
installs a status line command in `~/.claude/settings.json` to read them. If you already have a
status line, ctrlyoke keeps running yours underneath; see
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

Because of that, the quota updates only while a Claude session that ctrlyoke started is running,
and only while the Claude status line is turned on in [**Settings → Status Line**](/guide/usage-and-stats#status-line). Claude Code has
no way to ask for the quota on demand, so **ctrlyoke: Refresh Harness Usage** can't update it.
Between runs, ctrlyoke keeps showing the last value along with the time it was read.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the [**Stats & Usage**](/guide/usage-and-stats) settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Status line {#status-line}

ctrlyoke changes your global Claude Code settings: the first time it runs Claude Code, it points
the `statusLine` key in `~/.claude/settings.json` at its own status line command. That is how it
reads the quota, and Claude's terminal UI shows the model, context and quota as well. The change
stays in place between runs, in every project. If you already had a status line command, ctrlyoke
keeps running it underneath.

To undo it, turn Claude Code off in [**Settings → Status Line**](/guide/usage-and-stats#status-line).
ctrlyoke then puts your original command back, and stops tracking Claude's quota. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

## Sign-in problems {#sign-in}

If your Claude Code sign-in expires during a run, the next step that starts Claude Code fails, and
the workflow stops unless `errorBehavior` retries it. A headless step shows Claude's error in its
output; for an interactive step, look at the **Terminal** tab. Retries fail the same way until you
sign in again.

To recover, run `claude` in a terminal and complete the sign-in, then click **Resume** in the
dashboard to retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell an
expired sign-in from any other error Claude Code reports, so it counts as a failed step. Code `3`
means only that the `claude` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.
