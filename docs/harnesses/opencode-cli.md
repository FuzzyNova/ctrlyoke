# OpenCode CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`opencode-cli` is the OpenCode-backed harness for teams that already rely on OpenCode as their command-line assistant layer.

![The dashboard after a three-step demo workflow ran on OpenCode with the opencode/big-pickle model](/screenshots/rate-limiter-opencode-1200x800.png)

## Good fit

- Provider-flexible environments that already use OpenCode
- Workflows where you want ctrlyoke orchestration without switching assistant tooling

## Prerequisites

- **Command:** `opencode`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** connect at least one model provider in OpenCode, then check that `opencode models`
  lists the models you want. ctrlyoke's default OpenCode model, `opencode/big-pickle`, is
  OpenCode's free model.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with
  `opencode upgrade`.

If the CLI is missing or too old, the harness picker shows a red dot next to OpenCode, and its
tooltip gives the install command, or the update command when the installed version is below the
minimum. An amber dot means it runs but is older than the recommended version. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No AI harness CLI is available** panel with the install command
for every harness.

## Install

Install OpenCode with its install script on macOS and Linux. It has no native Windows installer script, so use npm (or Scoop or Chocolatey) there; OpenCode recommends WSL for the best Windows experience.

macOS and Linux:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Windows (PowerShell):

```powershell
npm install -g opencode-ai
```

Homebrew (`brew install anomalyco/tap/opencode`), Scoop (`scoop install opencode`), and Chocolatey (`choco install opencode`) also work.

See [OpenCode's install guide](https://opencode.ai/docs/) for other install methods.

## Example

```yaml
harness: opencode-cli
model: opencode/big-pickle

steps:
  - prompt: Summarize the responsibilities of @src/platform/ and suggest one cleanup.
```

## Notes

- The workflow surface is the same as the other CLI harnesses.
- Models use OpenCode's `provider/model` form. The dashboard lists what `opencode models` reports for your setup.
- Tool permissions (`mode`, `allowedTools`, `deniedTools`), MCP servers, and ctrlyoke's completion plugin are delivered per process through `OPENCODE_CONFIG_CONTENT`; ctrlyoke does not write a workspace `opencode.json`. OpenCode's own categories are coarser than tool patterns (for example, `write` and `edit` both map to OpenCode's `edit` permission). See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#opencode-cli).
- `permissions.trustedExternalRoots` is not passed to OpenCode; it has no `--add-dir` equivalent.

## Usage and rate limits

OpenCode doesn't report a quota, so the harness picker shows no percentage for it. ctrlyoke
records what it observes in the runs it starts instead: the tokens each step used and, where the
model's pricing is known (see [`modelPricing`](/reference/settings#modelpricing)), an estimated
cost. Those totals are on the [**Stats & Usage**](/guide/usage-and-stats) settings tab, and each step shows its
own token count in the steps panel. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).
