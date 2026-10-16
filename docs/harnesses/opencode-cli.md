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
at all, the dashboard shows a **No CLI coding agent is available** panel with the install command
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

## Model selection {#model-selection}

The **Model** picker lists the models that `opencode models` reports for the providers you have
connected. ctrlyoke reads that list when it starts, so reload the window after you connect a
provider. If the command fails, ctrlyoke falls back to `opencode/big-pickle`,
`opencode/claude-haiku-4-5` and `opencode/claude-sonnet-4-6`.

Models use OpenCode's `provider/model` form. Set `model` on the workflow or on a step. Without one,
ctrlyoke uses [`defaults.models["opencode-cli"]`](/reference/settings#defaults-models), which is
`opencode/big-pickle`, OpenCode's free model, out of the box. Any `provider/model` value is passed
to OpenCode as is, even one the list doesn't show. A value without a `/` is replaced by your
default, with a warning in the log.

`model: none` passes no `-m` flag, so OpenCode uses the model from its own configuration. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

## Notes

- The workflow surface is the same as the other CLI harnesses.
- Tool permissions (`mode`, `allowedTools`, `deniedTools`), MCP servers, and ctrlyoke's completion plugin are delivered per process through `OPENCODE_CONFIG_CONTENT`; ctrlyoke does not write a workspace `opencode.json`. OpenCode's own categories are coarser than tool patterns (for example, `write` and `edit` both map to OpenCode's `edit` permission). See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#opencode-cli).
- `permissions.trustedExternalRoots` is not passed to OpenCode; it has no `--add-dir` equivalent.

## Usage and rate limits

OpenCode doesn't report a quota, so the harness picker shows no percentage for it. ctrlyoke
records what it observes in the runs it starts instead: the tokens each step used and, where the
model's pricing is known (see [`modelPricing`](/reference/settings#modelpricing)), an estimated
cost. Those totals are on the [**Stats & Usage**](/guide/usage-and-stats) settings tab, and each step shows its
own token count in the steps panel. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Sign-in problems {#sign-in}

If a provider's credentials expire during a run, the next step that uses a model from that
provider fails, and the workflow stops unless `errorBehavior` retries it. A headless step shows
OpenCode's error in its output; for an interactive step, look at the **Terminal** tab. Retries fail
the same way until you reconnect the provider.

To recover, reconnect the provider in OpenCode and check that `opencode models` lists the model
again, then click **Resume** in the dashboard to retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell
expired credentials from any other error OpenCode reports, so it counts as a failed step. Code `3`
means only that the `opencode` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.
