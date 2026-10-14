# Antigravity CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`antigravity-cli` integrates Google's Antigravity CLI (`agy`) into ctrlyoke.

![The dashboard after a three-step demo workflow ran on Antigravity with Gemini 3.8 Flash (Low)](/screenshots/rate-limiter-agy-1200x800.png)

## Good fit

- You want Google's current CLI path for coding workflows
- You need Antigravity model choices such as Gemini Flash, Claude, or GPT-OSS
- You want ctrlyoke workflow execution, MCP, agents, skills, and history around `agy`

## Prerequisites

- **Command:** `agy`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** run `agy` once in a terminal and sign in with your Google account.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with `agy update`.

If the CLI is missing or too old, the harness picker shows a red dot next to Antigravity CLI, and
its tooltip gives the install command, or the update command when the installed version is below
the minimum. An amber dot means it runs but is older than the recommended version. After
installing or updating, click **Retry harness detection** in the harness picker. If no harness CLI
is available at all, the dashboard shows a **No AI harness CLI is available** panel with the
install command for every harness.

## Install

Install `agy` with Google's installer. It is not published to npm.

macOS and Linux:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

From Windows CMD, run `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd` instead.

See [the Antigravity CLI docs](https://antigravity.google/docs/cli-overview) for other install methods.

## Example

```yaml
harness: antigravity-cli
model: gemini-3.8-flash-low
steps:
  - prompt: Update the implementation and run the focused tests.
```

## Model selection {#model-selection}

The **Model** picker lists the models that `agy models` reports, with agy's own labels, such as
"Gemini 3.8 Flash (Low)". ctrlyoke reads that list when it starts, so reload the window after agy
adds a model. If the command fails, ctrlyoke uses its built-in list instead.

Workflow files and settings use the ID `agy models` prints, such as `gemini-3.8-flash-low` or
`claude-sonnet-4-6`, not the label. The effort tier is part of the ID (`-low`, `-medium`, `-high`).
Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["antigravity-cli"]`](/reference/settings#defaults-models), which is
`gemini-3.8-flash-medium` out of the box, not agy's own Claude Sonnet default. ctrlyoke passes any
value to agy as is. agy rejects a model it doesn't know with an error rather than falling back to
its default, so the step fails.

`model: none` passes no `--model` flag, so agy uses its own default model. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

## Notes

- Permissions are coarse modes only: `dangerouslyAllowAll` passes `--dangerously-skip-permissions`, `custom` passes `--sandbox`, and `allowAll` passes nothing, so `agy` applies its own approval behavior. `allowedTools` / `deniedTools` are not enforced, and MCP servers cannot be filtered per tool. Image references are not attached.
- Only the `preToolUse`, `postToolUse`, `sessionStart`, and `stop` hook events fire; `userPromptSubmit`, `permissionRequest`, `notification`, and `error` do not.
- MCP servers are written to the workspace `.agents/mcp_config.json`, which `agy` discovers on its own. There is no per-prompt server scoping, so parallel workflows in one workspace share that file's servers.
- ctrlyoke's hooks go in `~/.gemini/config/hooks.json` and are removed when the run ends. Its status line command goes in `~/.gemini/antigravity-cli/settings.json` and stays there between runs. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#antigravity-cli).
- For manual test runs, prefer a Gemini Flash tier to avoid exhausting the much smaller Claude quota.
- Antigravity stores some user-level config under `~/.gemini/`; those paths are expected and are not Gemini CLI support.

## Usage and rate limits

Antigravity reports a separate quota for each model tier in your plan, as a percentage with a
reset time. It reports them only to its status line, so ctrlyoke installs a status line command in
`~/.gemini/antigravity-cli/settings.json` to read them. If you already have a status line, ctrlyoke
keeps running yours underneath; see
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

Because of that, the quota updates only while an `agy` session that ctrlyoke started is running,
and only while the Antigravity status line is turned on in [**Settings → Status Line**](/guide/usage-and-stats#status-line). `agy` has no
way to ask for the quota on demand, so **ctrlyoke: Refresh Harness Usage** can't update it. Between
runs, ctrlyoke keeps showing the last value along with the time it was read.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the [**Stats & Usage**](/guide/usage-and-stats) settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Status line {#status-line}

ctrlyoke changes your global Antigravity settings: the first time it runs `agy`, it points the
`statusLine` key in `~/.gemini/antigravity-cli/settings.json` at its own status line command. That
is how it reads the quota, and agy's terminal UI shows the model, context and quota as well. The
change stays in place between runs, in every project. If you already had a status line command,
ctrlyoke keeps running it underneath. agy reads the setting when it starts, so a change affects
only `agy` processes started afterwards.

To undo it, turn Antigravity off in [**Settings → Status Line**](/guide/usage-and-stats#status-line).
ctrlyoke then puts your original command back, and stops tracking Antigravity's quota. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

## Sign-in problems {#sign-in}

If your Google sign-in expires during a run, the next step that starts `agy` fails, and the
workflow stops unless `errorBehavior` retries it. A headless step shows agy's error in its output;
for an interactive step, look at the **Terminal** tab. Retries fail the same way until you sign in
again.

To recover, run `agy` in a terminal and sign in with your Google account, then click **Resume** in
the dashboard to retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell an
expired sign-in from any other error agy reports, so it counts as a failed step. Code `3` means
only that the `agy` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.

A used-up model quota is a different error: agy reports it as an individual quota limit with a
reset time. Switch to another model, such as a Gemini Flash tier, or wait for the reset.
