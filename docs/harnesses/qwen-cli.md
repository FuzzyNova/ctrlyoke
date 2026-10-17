# Qwen CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`qwen-cli` runs ctrlyoke workflows against Qwen Code while preserving the same step model, session controls, and validation hooks.

![The dashboard after a three-step demo workflow ran on Qwen Code with the qwen3.5-plus model](/screenshots/rate-limiter-qwen-1200x800.png)

## Good fit

- Teams that already use Qwen Code directly
- Workflows where you want the ctrlyoke queue, history, and script gating on top of Qwen

## Prerequisites

- **Command:** `qwen`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** run `qwen` once in a terminal and complete the authentication it asks for.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with
  `npm install -g @qwen-code/qwen-code@latest`.

If the CLI is missing or too old, the harness picker shows a red dot next to Qwen Code, and its
tooltip gives the install command, or the update command when the installed version is below the
minimum. An amber dot means it runs but is older than the recommended version. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No CLI coding agent is available** panel with the install command
for every harness.

## Install

Install Qwen Code with its standalone installer:

macOS and Linux:

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

Windows (PowerShell):

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

Homebrew (`brew install qwen-code`) and npm (`npm install -g @qwen-code/qwen-code@latest`, Node.js 22+) also work. Restart your terminal after installing.

See [the Qwen Code README](https://github.com/QwenLM/qwen-code#installation) for other install methods.

## Example

```yaml
harness: qwen-cli
model: qwen3.5-plus

steps:
  - prompt: Audit @src/utils/ for duplicated logic and recommend one shared helper.
```

## Model selection {#model-selection}

The **Model** picker lists the model IDs under `modelProviders` in `~/.qwen/settings.json`.
ctrlyoke reads that file when it starts, so reload the window after you add a model there. If the
file is missing or lists no models, the picker shows only `qwen3.5-plus`.

Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["qwen-cli"]`](/reference/settings#defaults-models), which is `qwen3.5-plus` out
of the box. ctrlyoke passes any value to Qwen Code as is, even one the list doesn't show, and Qwen
Code checks it against your configured providers.

`model: none` passes no `--model` flag, so Qwen Code uses the model from its own settings. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

## Permissions {#permissions}

The permission `mode` maps to Qwen Code flags:

- `dangerouslyAllowAll` → `-y`. The deny list is ignored.
- `allowAll` → `--approval-mode auto-edit`, plus `--exclude-tools` with the deny list
- `custom` → `--approval-mode default`, plus `--allowed-tools` with the allow list and
  `--exclude-tools` with the deny list
- `none` → no permission flags (Qwen Code's own settings)

Each list is passed as one comma-separated value, translated to Qwen's tool names:

| ctrlyoke pattern                           | Qwen Code                 |
| ------------------------------------------ | ------------------------- |
| `shell(git push:*)`                        | `ShellTool(git push *)`   |
| `shell(git status)`                        | `ShellTool(git status *)` |
| `shell`, `shell(*)`                        | `ShellTool`               |
| `write`                                    | `WriteFile`               |
| `edit`                                     | `Edit`                    |
| `read`                                     | `Read`                    |
| `webfetch`                                 | `WebFetch`                |
| `websearch`                                | `WebSearch`               |
| `mcp__github`, `mcp__github__create_issue` | unchanged                 |

A shell pattern without `:*` gets a trailing `*` too, as the `git status` row shows, so on Qwen
Code it also covers the command with extra arguments. The default deny list therefore reaches Qwen as
`--exclude-tools ShellTool(rm *),ShellTool(del *),…`. Qwen Code has no file-delete tool, so
`delete` and `remove` patterns are skipped with a warning; use `shell(rm:*)` to control deleting
files instead. See [Permissions](/workflows/permissions) for the modes, the pattern syntax and
[the default lists](/workflows/permissions#the-default-lists).

## Notes

- ctrlyoke registers its completion hooks in the workspace `.qwen/settings.json` for the duration of a run, then restores the file. MCP servers are passed per process with `--mcp-config`. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#qwen-code).
- Image references are not attached on this harness, and `error` hooks do not fire. See the [compatibility matrix](/harnesses/compatibility).
- `permissions.trustedExternalRoots` is not passed to Qwen; it has no `--add-dir` equivalent.
- File references containing spaces are escaped on macOS and Linux. On Windows, ctrlyoke gives Qwen the quoted path and asks it to read generated prompt, agent, and skill files with its file tools.

## Usage and rate limits

Qwen Code doesn't report a quota, so the harness picker shows no percentage for it. ctrlyoke
records what it observes in the runs it starts instead: the tokens each step used and, where the
model's pricing is known (see [`modelPricing`](/reference/settings#modelpricing)), an estimated
cost. Those totals are on the [**Stats & Usage**](/guide/usage-and-stats) settings tab, and each step shows its own token
count in the steps panel. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Status line {#status-line}

ctrlyoke changes your global Qwen Code settings: the first time it runs Qwen Code, it points the
`ui.statusLine` key in `~/.qwen/settings.json` at its own status line command, so Qwen's terminal
UI shows the model, context and usage. The change stays in place between runs, in every project.
If you already had a status line command, ctrlyoke keeps running it underneath.

To undo it, turn Qwen Code off in [**Settings → Status Line**](/guide/usage-and-stats#status-line).
ctrlyoke then puts your original command back. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).

## Sign-in problems {#sign-in}

If your Qwen Code authentication expires during a run, the next step that starts Qwen Code fails,
and the workflow stops unless `errorBehavior` retries it. A headless step shows Qwen's error in
its output; for an interactive step, look at the **Terminal** tab. Retries fail the same way until
you sign in again.

To recover, run `qwen` in a terminal and complete the authentication it asks for, then click
**Resume** in the dashboard to retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell an
expired sign-in from any other error Qwen Code reports, so it counts as a failed step. Code `3`
means only that the `qwen` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.
