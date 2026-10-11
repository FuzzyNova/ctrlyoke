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
at all, the dashboard shows a **No AI harness CLI is available** panel with the install command
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

## Notes

- The model list comes from the `modelProviders` in `~/.qwen/settings.json`; `qwen3.5-plus` is the fallback.
- ctrlyoke registers its completion hooks in the workspace `.qwen/settings.json` for the duration of a run, then restores the file. MCP servers are passed per process with `--mcp-config`. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#qwen-code).
- Image references are not attached on this harness, and `error` hooks do not fire. See the [compatibility matrix](/harnesses/compatibility).
- `permissions.trustedExternalRoots` is not passed to Qwen; it has no `--add-dir` equivalent.

## Usage and rate limits

Qwen Code doesn't report a quota, so the harness picker shows no percentage for it. ctrlyoke
records what it observes in the runs it starts instead: the tokens each step used and, where the
model's pricing is known (see [`modelPricing`](/reference/settings#modelpricing)), an estimated
cost. Those totals are on the **Stats & Usage** settings tab, and each step shows its own token
count in the steps panel. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

ctrlyoke also installs a status line command in `~/.qwen/settings.json` so Qwen's own terminal UI
shows the model, context and usage. See
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line).
