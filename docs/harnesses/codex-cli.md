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

If the CLI is missing, the harness picker shows a red dot next to Codex, and its tooltip gives the
install command. If it is installed but older than the minimum, it still runs: the picker shows an
amber dot and the update command, a workflow that uses it warns when it starts, and a failed step repeats that command. After installing or
updating, click **Retry harness detection** in the harness picker. If no harness CLI is available
at all, the dashboard shows a **No CLI coding agent is available** panel with the install command
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
model: gpt-6-sol

steps:
  - prompt: Review @src/cli.ts and simplify the option parsing where practical.
```

## Model selection {#model-selection}

Codex has no command that lists its models, so the **Model** picker shows a fixed list:
`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and
`gpt-5.6-luna`.

Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["codex-cli"]`](/reference/settings#defaults-models), which is `gpt-6-luna` out of
the box. A model that isn't on the list is replaced by that default, with a warning in the log.

`model: none` passes no `--model` flag, so Codex uses the model from its own configuration. To use
a model the list doesn't have, set `model: none` and put `--model <id>` in `additionalArgs`. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

The list matches the **Tested with** Codex release in
[Supported versions](/harnesses/compatibility#supported-versions). A newer model can need a newer
Codex than ctrlyoke's minimum. If a step fails because the model is not supported, run
`codex update`.

## Notes

Codex declares exact support for terminal write containment. Network access is a
separate harness policy and does not reduce that declaration.

- Codex uses sandbox and approval modes rather than individual tool patterns, so `allowedTools` is **not enforced** on this harness. `deniedTools` is enforced only for `mcp__<server>__<tool>` entries naming an MCP server the workflow attaches; they're passed as that server's `disabled_tools`. Shell patterns, wildcard tool names, and servers configured only in Codex's own `config.toml` are not enforced. Approval and containment are separate flags:
  - Approval (`-a`) follows the permission mode alone: `dangerouslyAllowAll` passes `-a never`, `allowAll` and `custom` pass `-a on-request`, and `none` passes nothing.
  - Containment (`-s`) follows [`sandbox`](/workflows/permissions#sandboxing) alone: `true` passes `-s workspace-write` or `-s read-only` (from `sandboxMode`), `false` (the default) passes `-s danger-full-access`, and `null` passes nothing, so the `sandbox_mode` in your `config.toml` applies.
  - A step with `sandbox: true` fails at launch if `additionalArgs` contradicts that `-s`: `--dangerously-bypass-approvals-and-sandbox` (Codex lets it win over `-s` and runs uncontained), a second `-s`/`--sandbox`, or a `-c` override of `sandbox_mode`, `sandbox_workspace_write.*` (which can add writable roots or turn on the network) or `sandbox_permissions`.
  - `dangerouslyAllowAll` with the sandbox Off (`-s danger-full-access -a never`) is the same policy as `--dangerously-bypass-approvals-and-sandbox`: Codex shows it as YOLO mode, and shell commands, network access and MCP tool calls run without asking. With the sandbox On, `-a never` instead returns a command the sandbox blocks to the model rather than asking you to run it outside.
  - A denied `write` or `shell` is reported as not enforced; it does not make the sandbox read-only. Use `sandboxMode: read-only`.
- Under `sandbox: null`, ctrlyoke still passes approved external roots with `--add-dir`. If your `config.toml` sets `sandbox_mode = "read-only"`, Codex refuses those, so use `sandbox: true` with `sandboxMode: read-only` instead.
- With containment on, network access is off unless `sandbox_workspace_write.network_access` in your Codex `config.toml` turns it on. The writable roots include the workspace and approved external roots, temp directories, harness caches, the Git common directory, and for linked worktrees their own Git directory. Granting both Git directories lets contained steps stage and commit changes.
- Headless runs use `codex exec`, which does not accept an approval flag, so only the sandbox flag is passed there.
- In a headless run, ctrlyoke reads the step's output, including file diffs, from Codex's session log under `~/.codex/sessions` (or `$CODEX_HOME/sessions`). `codex exec --json` reports a changed file without its contents, so stdout supplies only the session ID and request errors such as an unknown model.
- Before resuming, ctrlyoke checks the local rollout store by thread ID. If the
  rollout is missing, or Codex reports `thread <id> not found`, it starts a new
  session and shows a warning in the step output.
- Directories in `permissions.trustedExternalRoots` are passed to Codex as `--add-dir`.
- Hooks, MCP servers and approvals are all passed as `-c` overrides, so ctrlyoke never edits your Codex configuration. See [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#codex-cli).

## Usage and rate limits

Codex reports its rate-limit windows, usually a short window and a weekly one. ctrlyoke reads
them through `codex app-server`, without starting a session, when Codex is version 0.146 or newer.
Run **ctrlyoke: Refresh Harness Usage** to fetch them again. When `codex app-server` isn't
available, ctrlyoke picks up the same numbers from Codex's session log during each run instead.

Quota percentages appear next to the harness in the harness picker, with the reset time in its
tooltip, and on the [**Stats & Usage**](/guide/usage-and-stats) settings tab. If a queued step's harness is above
[`usageTracking.warningPercentUsed`](/reference/settings#usagetracking-warningpercentused) (80% by
default), ctrlyoke warns when the run starts but doesn't stop it. Turn collection off with
[`usageTracking.enabled`](/reference/settings#usagetracking-enabled).

## Sign-in problems {#sign-in}

If your Codex sign-in expires during a run, the next step that starts Codex fails, and the
workflow stops unless `errorBehavior` retries it. A headless step shows Codex's error in its
output; for an interactive step, look at the **Terminal** tab. Retries fail the same way until you
sign in again. When ctrlyoke's usage check finds you signed out, Codex's tooltip in the harness
picker reads **Needs auth** instead of a quota.

To recover, run `codex` in a terminal and sign in again, then click **Resume** in the dashboard to
retry the failed step.

From the `ctrlyoke` CLI, a sign-in failure exits with code `1`, not `3`. ctrlyoke can't tell an
expired sign-in from any other error Codex reports, so it counts as a failed step. Code `3` means
only that the `codex` executable wasn't found. See [Exit codes](/cli/ci#exit-codes), and
[Harness sign-in](/cli/ci#harness-sign-in) for CI runners.
