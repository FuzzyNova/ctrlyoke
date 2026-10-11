# Codex CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`codex-cli` lets ctrlyoke drive Codex-based workflows from the same schema used by the other CLI harnesses.

![The dashboard after a three-step demo workflow ran on Codex, with Codex selected in the harness picker](/screenshots/rate-limiter-codex-1200x800.png)

## Good fit

- Teams already using Codex in local or CI workflows
- Workflows that benefit from Codex-specific sandbox and approval controls

## Prerequisites

- **Command:** `codex`, on your `PATH`.
- **Install:** see [Install](#install).
- **Sign in:** run `codex` once in a terminal and sign in with your ChatGPT account or an API key.
- **Version:** at least the minimum listed under
  [Supported versions](/harnesses/compatibility#supported-versions). Update with `codex update`.

If the CLI is missing or too old, the harness picker shows a red dot next to Codex, and its
tooltip gives the install command, or the update command when the installed version is below the
minimum. An amber dot means it runs but is older than the recommended version. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No AI harness CLI is available** panel with the install command
for every harness.

## Install

Install the Codex CLI with OpenAI's installer:

macOS and Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Homebrew (`brew install --cask codex`) and npm (`npm install -g @openai/codex`) also work.

See [the Codex README](https://github.com/openai/codex#quickstart) for other install methods.

## Example

```yaml
harness: codex-cli
model: gpt-5.5

steps:
  - prompt: Review @src/cli.ts and simplify the option parsing where practical.
```

## Notes

- Codex uses sandbox and approval modes rather than individual tool patterns, so `allowedTools` / `deniedTools` are **not enforced** on this harness. The permission `mode` maps to Codex flags:
  - `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox`
  - `allowAll` → `--sandbox workspace-write --ask-for-approval on-request`
  - `custom` → `-s <permissions.codexSandboxMode> -a <permissions.codexApprovalPolicy>`
  - `none` → no permission flags (Codex's own defaults)
- `permissions.codexSandboxMode` (`read-only`, `workspace-write`, `danger-full-access`; default `workspace-write`) and `permissions.codexApprovalPolicy` (`untrusted`, `on-request`, `never`; default `on-request`) are only read in `custom` mode.
- Headless runs use `codex exec`, which does not accept an approval flag, so only the sandbox flag is passed there.
- Directories in `permissions.trustedExternalRoots` are passed to Codex as `--add-dir`.
- Hooks, MCP servers and approvals are all passed as `-c` overrides, so ctrlyoke never edits your Codex configuration. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#codex-cli).

## Usage and rate limits

Codex reports its rate-limit windows, usually a short window and a weekly one. ctrlyoke reads
them through `codex app-server`, without starting a session, when Codex is version 0.146 or newer.
Run **ctrlyoke: Refresh Harness Usage** to fetch them again. When `codex app-server` isn't
available, ctrlyoke picks up the same numbers from Codex's session log during each run instead.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the **Stats & Usage** settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).
