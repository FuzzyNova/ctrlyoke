# Copilot CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`copilot-cli` runs ctrlyoke workflows through the GitHub Copilot CLI while keeping the same workflow file format used elsewhere.

![The dashboard after a three-step demo workflow ran on Copilot CLI, with Copilot CLI selected in the harness picker](/screenshots/rate-limiter-copilot-1200x800.png)

## Good fit

- Teams that already have a GitHub Copilot subscription and use the Copilot CLI
- Workflows that want Copilot's model catalog behind the ctrlyoke queue, history, and script gating

## Prerequisites

- **Command:** `copilot`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** run `copilot` once in a terminal and sign in with `/login`.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with `copilot update`.

If the CLI is missing or too old, the harness picker shows a red dot next to Copilot CLI, and its
tooltip gives the install command, or the update command when the installed version is below the
minimum. An amber dot means it runs but is older than the recommended version. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No AI harness CLI is available** panel with the install command
for every harness.

## Install

Install the GitHub Copilot CLI with GitHub's installer:

macOS and Linux:

```bash
curl -fsSL https://gh.io/copilot-install | bash
```

Windows (PowerShell):

```powershell
winget install GitHub.Copilot
```

Homebrew (`brew install copilot-cli`) and npm (`npm install -g @github/copilot`) also work. Windows needs PowerShell 6 or newer.

See [GitHub's install guide](https://github.com/github/copilot-cli#installation) for other install methods.

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
- Copilot has no command-line option for hooks, so ctrlyoke writes a hook file for each step to `.github/hooks/` and removes it afterwards. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#copilot-cli).

## Usage and rate limits

Copilot reports your account's monthly quota: premium requests or AI credits, depending on your
plan (labelled **Premium interactions** when Copilot doesn't say which), plus chat and completions
on plans that cap them. ctrlyoke asks the Copilot CLI for it
directly, without starting a session or using a model turn, so it is available between runs too.
Run **ctrlyoke: Refresh Harness Usage** to fetch it again.

The context-window bar on each step comes from Copilot's OpenTelemetry export, which ctrlyoke
turns on for every Copilot process it starts. ctrlyoke also installs a status line command in
`~/.copilot/settings.json` so Copilot's own terminal UI shows the model, context and usage. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the **Stats & Usage** settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).
