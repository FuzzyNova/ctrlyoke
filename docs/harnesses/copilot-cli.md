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
at all, the dashboard shows a **No CLI coding agent is available** panel with the install command
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

## Model selection {#model-selection}

The **Model** picker lists the models that `copilot help config` reports. ctrlyoke reads that list
when it starts, so reload the window after Copilot adds a model. If the command fails, ctrlyoke
uses its built-in list instead.

Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["copilot-cli"]`](/reference/settings#defaults-models), which is
`claude-sonnet-4.6` out of the box. A model that isn't on the list is replaced by that default,
with a warning in the log.

`model: none` passes no `--model` flag, so Copilot uses its own default model. `copilot help
config` sometimes lags behind the models Copilot accepts; to use one it doesn't list yet, set
`model: none` and pass `--model <id>` in `additionalArgs`. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

## Permissions {#permissions}

The permission `mode` maps to Copilot flags:

- `dangerouslyAllowAll` → `--yolo`. The deny list is ignored.
- `allowAll` → `--allow-all-tools`, plus `--deny-tool` with the deny list
- `custom` → `--allow-tool` with the allow list, plus `--deny-tool` with the deny list
- `none` → no permission flags (Copilot's own configuration)

Copilot uses the same pattern syntax as ctrlyoke, so patterns pass through unchanged: the default
deny list reaches Copilot as `--deny-tool shell(rm:*) shell(git push:*) …`. Two exceptions:

- MCP patterns are rewritten to Copilot's form: `mcp__github__create_issue` becomes
  `github(create_issue)`.
- Read-only tools (`read`, `read_file`, `grep`, `list_files` and `search_files`) are dropped from
  both lists, because Copilot always allows them.

See [Permissions](/workflows/permissions) for the modes, the pattern syntax and
[the default lists](/workflows/permissions#the-default-lists).

## Notes

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
turns on for every Copilot process it starts.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the [**Stats & Usage**](/guide/usage-and-stats) settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Status line {#status-line}

ctrlyoke changes your global Copilot settings: the first time it runs Copilot, it points the
`statusLine` key in `~/.copilot/settings.json` at its own status line command, so Copilot's
terminal UI shows the model, context and usage. The change stays in place between runs, in every
project. If you already had a status line command, ctrlyoke keeps running it underneath.

To undo it, turn Copilot off in [**Settings → Status Line**](/guide/usage-and-stats#status-line).
ctrlyoke then puts your original command back. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

## Sign-in problems {#sign-in}

If your Copilot sign-in expires during a run, the next step that starts Copilot fails, and the
workflow stops unless `errorBehavior` retries it. A headless step shows Copilot's error in its
output; for an interactive step, look at the **Terminal** tab. Retries fail the same way until you
sign in again. When ctrlyoke's quota check finds you signed out, Copilot's tooltip in the
harness picker reads **Needs auth** instead of a quota.

To recover, run `copilot` in a terminal and sign in with `/login`, then click **Resume** in the
dashboard to retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell an
expired sign-in from any other error Copilot reports, so it counts as a failed step. Code `3`
means only that the `copilot` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.
