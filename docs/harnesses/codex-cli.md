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
for every harness and a **Check again** button.

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

## Headless prompts

In headless steps, ctrlyoke includes generated sections such as agent instructions, skills and
prior-step context in the first message. Codex 0.146.0 and later receive that message through
`codex app-server`'s `turn/start` JSON-RPC request; older versions keep using `codex exec` and
stdin. Turn off
[`execution.inlineGeneratedPromptOnStdin`](/reference/settings#execution-inlinegeneratedpromptonstdin)
to use categorized temporary files and references instead.

Headless app-server steps answer Codex command, file-change and additional-permission approval
requests through the headless approval policy. The default is **Deny**; set
`toolPermissions.headlessApprovals: ask` to show requests in the dashboard. The configured
approval timeout applies directly because Codex does not expire unanswered requests. An optional
denial message stays in the dashboard approval card; Codex's approval responses cannot carry it
back to the model.

On Codex 0.146.0 and later, **Send Steer Message** injects a message into the current headless
turn, and **End Step Early** (on the running step's menu) ends that turn without stopping the workflow. If a turn completes
before Codex accepts a steer, ctrlyoke reports that the message was not queued; start a new step
to send it.

## Model selection {#model-selection}

When ctrlyoke starts, it asks the installed Codex which models your account can use, so the
**Model** picker shows the same models, names and order as Codex's own `/model` picker. Models
Codex hides from its picker are listed too, but they start out in the picker's hidden section:
click **Show hidden** to see them, and unhide one to keep it in the list. ctrlyoke asks without
starting a session, so the lookup uses none of your quota.

If Codex isn't installed or doesn't answer, the picker falls back to the list built into ctrlyoke:
`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra` and `gpt-5.6-luna`.

Set `model` on the workflow or on a step. Without one, ctrlyoke uses
[`defaults.models["codex-cli"]`](/reference/settings#defaults-models), which is `none` out of the
box: no `--model` flag is passed, so Codex uses the model from its own configuration. A model Codex
didn't list is replaced by your default, with a warning in the log; if the
default is `none`, no `--model` flag is passed. The
`ctrlyoke` CLI doesn't look the list up, so it passes the model to Codex as you wrote it.

`model: none` passes no `--model` flag, so Codex uses the model from its own configuration. See
[How step properties inherit](/workflows/yaml-format#property-inheritance).

A newer model can need a newer Codex than ctrlyoke's minimum. If a model you expect is missing, or
a step fails because the model is not supported, run `codex update` and restart ctrlyoke.

## Notes

Codex declares exact support for terminal write containment. Network access is a
separate harness policy and does not reduce that declaration.

- Codex uses sandbox and approval modes rather than individual tool patterns, so `allowedTools` is **not enforced** on this harness. `deniedTools` is enforced only for `mcp__<server>__<tool>` entries naming an MCP server the workflow attaches; they're passed as that server's `disabled_tools`. Shell patterns, wildcard tool names, and servers configured only in Codex's own `config.toml` are not enforced. Approval and containment are separate flags:
  - Approval (`-a`) follows the permission mode: `dangerouslyAllowAll` passes `-a never`, `allowAll` and `custom` pass `-a on-request`, and `none` passes nothing. `auto` uses the auto reviewer (`on-request` for headless runs).
  - Containment (`-s`) follows [`sandbox`](/workflows/permissions#sandboxing) alone: `true` passes `-s workspace-write` or `-s read-only` (from `sandboxMode`), `false` (the default) passes `-s danger-full-access`, and `null` passes nothing, so the `sandbox_mode` in your `config.toml` applies.
  - A step with `sandbox: true` fails at launch if `additionalArgs` contradicts that `-s`: `--dangerously-bypass-approvals-and-sandbox` (Codex lets it win over `-s` and runs uncontained), a second `-s`/`--sandbox`, a `-c` override of `sandbox_mode`, `sandbox_workspace_write.*` (which can add writable roots or turn on the network) or `sandbox_permissions`, or `--add-dir` (which adds a writable root outside the workspace, and makes interactive Codex exit under `read-only`). To give a contained step another writable directory, approve it as an [external root](/workflows/permissions#external-roots-and-the-sandbox) instead.
  - `dangerouslyAllowAll` with the sandbox Off (`-s danger-full-access -a never`) is the same policy as `--dangerously-bypass-approvals-and-sandbox`: Codex shows it as YOLO mode, and shell commands, network access and MCP tool calls run without asking. With the sandbox On, `-a never` instead returns a command the sandbox blocks to the model rather than asking you to run it outside.
  - In `auto`, the reviewer may approve sandbox escalations out of the sandbox. This makes Auto wider than headless `custom`, which has no escalation path.
  - A denied `write` or `shell` is reported as not enforced; it does not make the sandbox read-only. Use `sandboxMode: read-only`.
- Under `sandbox: null`, ctrlyoke still passes approved external roots with `--add-dir`. If your `config.toml` sets `sandbox_mode = "read-only"`, interactive Codex exits at launch with "Error adding directories" (`codex exec` ignores the roots instead; checked with Codex 0.166.0), so use `sandbox: true` with `sandboxMode: read-only` instead. See [External roots and the sandbox](/workflows/permissions#external-roots-and-the-sandbox).
- With containment on, network access is off unless `sandbox_workspace_write.network_access` in your Codex `config.toml` turns it on. **On Windows it stays on regardless**: Codex's Windows sandbox blocks writes outside the writable roots, but does not block network access, even with `network_access = false` (checked with Codex 0.167.0). The writable roots include the workspace and approved external roots, temp directories, harness caches, the Git common directory, and for linked worktrees their own Git directory. Granting both Git directories lets contained steps stage and commit changes.
- Headless runs on Codex 0.146.0 and later use `codex app-server`; earlier versions keep using `codex exec`. Both receive ctrlyoke's model, sandbox, approval, MCP and hook configuration without editing Codex's config files.
- In a headless run, ctrlyoke reads the step's output, including file diffs, from Codex's session log under `~/.codex/sessions` (or `$CODEX_HOME/sessions`). App-server stdout carries JSON-RPC control traffic, not the user-facing event stream; it supplies the session ID and request errors while `CodexLogParser` reads the rollout.
- An interactive turn that fails with an API error fails the step with Codex's error text, read from the session log, although Codex fires no Stop hook for it.
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
