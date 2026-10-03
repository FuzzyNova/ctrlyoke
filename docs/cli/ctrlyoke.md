# `ctrlyoke`

The standalone CLI exposes these commands. Run `ctrlyoke <command> --help` for
the authoritative option list of any command.

```text
ctrlyoke run [file] [options]
ctrlyoke rerun --workflow <key> [--from <ref|runId>] [options]
ctrlyoke append [file] --workflow <key> --run <ref|runId> [--prompt <text>] [options]
ctrlyoke continue --workflow <key> --run <ref|runId> [options]
ctrlyoke validate <file> [--harness <id> | --all-installed-harnesses] [--strict <policy>] [--json]
ctrlyoke commit [--model <model>] [--hint <text>] [--print-only] [--all] [--yes] [--cwd <path>]
ctrlyoke about [--json]
ctrlyoke trust-external-roots [--yes] [--cwd <path>]
ctrlyoke trust-workflow-external-roots <file> [--yes] [--cwd <path>]
ctrlyoke trust-secret-grants <file> [--yes] [--cwd <path>]
ctrlyoke history prune [--yes]
ctrlyoke history relink <oldPath> <newPath> [--yes]
ctrlyoke history list [--cwd <path>] [--all] [--state <state...>] [--since <when>] [--limit <n>] [--json]
ctrlyoke history runs --workflow <key> [--cwd <path>] [--json]
ctrlyoke history steps --workflow <key> [--run <ref|runId>] [--json] [--full-prompts]
ctrlyoke history show --workflow <key> [--run <ref|runId>] [--step <selector>] [--attempt <n|latest|all>] [--json]
ctrlyoke history search <query> [filters] [--json]
ctrlyoke history trash list|restore <id>|purge <id>|empty [--yes]
ctrlyoke step edit [file] --workflow <key> --run <ref|runId> --index <index> [--prompt <text>]
ctrlyoke step remove --workflow <key> --run <ref|runId> --index <index>
ctrlyoke step reorder --workflow <key> --run <ref|runId> --order <indices>
ctrlyoke secret set <NAME> [--stdin] [--scope user|workspace] [--cwd <path>]
ctrlyoke secret list [--cwd <path>]
ctrlyoke secret rm <NAME> [--yes] [--scope user|workspace] [--cwd <path>]
ctrlyoke secret check <file> [--cwd <path>]
```

`ctrlyoke --version` prints the CLI version. `ctrlyoke about` also shows
where this copy is installed (see [`ctrlyoke about`](#ctrlyoke-about)).

The CLI treats its working directory (or `--cwd`) as the workspace root: it
reads `<cwd>/.ctrlyoke/settings.json` on top of `~/.ctrlyoke/settings.json` and
records run history for that directory. Run it from the directory that holds
your `.ctrlyoke/` folder, or pass `--cwd`.

## Exit codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                                                      |
| `1`  | The workflow failed (a step or end condition failed), or a validation check failed                                           |
| `2`  | Usage, parse, or unexpected error; also unapproved external roots or secret grants, or run state written by a newer ctrlyoke |
| `3`  | A harness failed because its CLI could not be found (not installed, not on `PATH`)                                           |
| `4`  | A step failed with a timeout                                                                                                 |
| `5`  | Interrupted with Ctrl+C or `SIGTERM`; the run is stopped and its runner lock released                                        |

## `ctrlyoke run`

Run a prompt or workflow file:

```bash
ctrlyoke run my-workflow.ctrlyoke.yaml
ctrlyoke run --prompt "Fix the failing unit tests" --headless
```

Pass either a file or `--prompt`, not both.

### Options

| Option                       | Meaning                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-H, --harness <harness>`    | Harness override: `copilot-cli`, `claude-cli`, `codex-cli`, `opencode-cli`, `qwen-cli`, or `antigravity-cli`. Default: the workflow's `harness`, then the `defaults.harness` setting |
| `-m, --model <model>`        | Override the workflow model for this run (step-level `model` values still take precedence)                                                                                           |
| `-p, --prompt <text>`        | Run an inline prompt instead of a file                                                                                                                                               |
| `--var <key=value>`          | Set a workflow variable (repeatable). CLI values override the workflow's own `vars`                                                                                                  |
| `--session-id <id>`          | Resume this harness session in the first step (implies `--resume-session`)                                                                                                           |
| `--resume-session`           | Force every AI step to resume its existing session                                                                                                                                   |
| `--no-resume-session`        | Force every AI step to start a new session, ignoring any recorded session                                                                                                            |
| `--dry-run`                  | Print the redacted execution preview and its diagnostics without starting a harness                                                                                                  |
| `--headless`                 | Force headless mode (CI, no user interaction)                                                                                                                                        |
| `--interactive`              | Force interactive mode (the harness TUI is passed through; you end the session)                                                                                                      |
| `--permission-mode <mode>`   | Override the `defaults.toolPermissions.mode` setting: `dangerouslyAllowAll`, `allowAll`, `custom`, or `none`                                                                         |
| `--allow-tool <pattern>`     | Allow a tool pattern (repeatable)                                                                                                                                                    |
| `--deny-tool <pattern>`      | Deny a tool pattern (repeatable)                                                                                                                                                     |
| `-d, --cwd <path>`           | Workspace directory (default: current directory)                                                                                                                                     |
| `-t, --timeout <seconds>`    | Override the `execution.maxPromptTimeoutSec` setting for this run (`-1` = unlimited)                                                                                                 |
| `--script-timeout <seconds>` | Override the `execution.scriptTimeoutSec` setting with a positive whole number of seconds; a condition's own `timeoutSec` still wins                                                    |
| `--json`                     | Print one JSON result object on stdout when the run ends                                                                                                                             |
| `-q, --quiet`                | Suppress all output except errors                                                                                                                                                    |
| `--verbose`                  | Print debug information (execution mode, workspace root, harness, model, vars)                                                                                                       |
| `--no-color`                 | Disable colored output                                                                                                                                                               |

### Headless and interactive mode

Without `--headless` or `--interactive`, the CLI runs interactively when both
stdin and stdout are a TTY and headless otherwise (pipes, CI). Interactive mode
passes the harness's own terminal UI through with minimal ctrlyoke framing.
Headless mode streams formatted output: step headers, streamed text, tool
calls, diffs, script verdicts, and per-step statistics.

### Tool permissions

The CLI resolves tool permissions for each step exactly as the extension does,
and headless versus interactive mode does not change the result. The first
match wins:

1. the step's own `toolPermissions`
2. the workflow's `toolPermissions`
3. `defaults.toolPermissions` from settings

`--permission-mode`, `--allow-tool`, and `--deny-tool` override only the
settings layer (step 3), taking precedence over the workspace and user settings
files for this run. A workflow or step that sets its own `toolPermissions`
still wins over them. `--allow-tool` and `--deny-tool` replace the settings
allow and deny lists but leave the mode alone.

An unattended run whose resolved mode can still prompt for approval may stall
on that prompt. For CI, set the mode you want in the workflow or in the CI
workspace's settings, or pass `--permission-mode`.

### JSON output

With `--json`, decorative output is suppressed and one line of JSON is written
to stdout when the run ends. It is a versioned envelope (`schemaVersion: 1`)
with the overall `success`, `status`, `workflowKey`, `runRef`, `harness`,
`model`, timing, a `summary` of step counts, a `steps` array (status, attempts,
session ID, pre/end-condition results, files changed, script output, error),
the `finalStep` result, and a top-level `error`. The `workflowKey` and `runRef`
feed directly into `history show`, `rerun`, `append`, `continue`, and the
`step` commands. Diagnostics go to `.ctrlyoke/logs/ctrlyoke-cli-<timestamp>.log`,
never to stdout.

With `--dry-run --json`, the JSON is the execution preview instead, and the
command exits `1` when the preview reports an error diagnostic.

### Examples

```bash
ctrlyoke run review.ctrlyoke.yaml --harness claude-cli --model sonnet
ctrlyoke run release.ctrlyoke.yaml --var version=1.4.0 --headless
ctrlyoke run build.ctrlyoke.json --json --quiet
ctrlyoke run review.ctrlyoke.yaml --dry-run
```

### Pre-run approvals

`run` refuses to start (exit code `2`) and names the command to run when:

- the workspace requests `permissions.trustedExternalRoots` that have not
  been reviewed: run `ctrlyoke trust-external-roots`
- the workflow's `trustedExternalRoots` include roots that have not been
  reviewed: run `ctrlyoke trust-workflow-external-roots <file>`
- the workflow declares secret grants that have not been approved: run
  `ctrlyoke trust-secret-grants <file>`

## `ctrlyoke rerun`

Seed a new run from an existing run's definition and execute it:

```bash
ctrlyoke rerun --workflow release
ctrlyoke rerun --workflow release --from 7 --harness claude-cli
```

`--from` accepts a numeric run ID or a stable run reference and defaults to the
lineage's newest run. `--harness` and `--model` override the seeded run. It
refuses while another run in the same lineage is executing. `rerun` accepts the
same execution options as `run` apart from `--prompt`, `--var`, the session
flags, and `--dry-run`.

## `ctrlyoke append`

Append steps to an existing run and continue executing it:

```bash
ctrlyoke append followup.ctrlyoke.yaml --workflow release --run 7
ctrlyoke append --workflow release --run 7 --prompt "Also update the changelog"
```

The file must contain at least one workflow step; `--prompt` appends a single
prompt step. The run's effective `maxSteps` cap applies to this append: the
workflow's `maxSteps` when present, otherwise the global `queue.maxSteps`
setting. A workflow value of `-1` removes the cap even when the global setting
is numeric.

## `ctrlyoke continue`

Resume the unchanged pending work of a stopped, paused, or interrupted run:

```bash
ctrlyoke continue --workflow release --run 7
```

A run left `running` or `paused` by a process that no longer holds its runner
lock can be adopted this way. `continue` refuses while the lineage has an
unsaved draft or pending edit, while any run in the lineage is executing, or
while the target run is pausing or cancelling.

## `ctrlyoke validate`

Validate a workflow file without starting a harness or executing a workflow:

```bash
ctrlyoke validate my-workflow.ctrlyoke.yaml
```

This checks the file against the workflow schema and then runs the same
semantic pass the dashboard runs when it loads a workflow, so a file the
extension would refuse is not reported as valid here. Compatibility analysis is
opt-in:

```bash
ctrlyoke validate my-workflow.ctrlyoke.yaml --harness claude-cli
ctrlyoke validate my-workflow.ctrlyoke.yaml --all-installed-harnesses --json
```

`--harness <id>` analyzes every enabled AI consumer as the selected harness.
`--all-installed-harnesses` probes the supported harness CLIs and analyzes only
those currently available. The two target options are mutually exclusive;
neither starts a workflow or an AI session. `--json` emits one JSON line with a
versioned `schemaVersion: 1` envelope and the shared compatibility diagnostics.

Compatibility errors fail validation by default. Bare `--strict` also treats
unknown workflow fields as errors, which is useful in CI:

```bash
ctrlyoke validate my-workflow.ctrlyoke.yaml --strict
```

With `--harness` or `--all-installed-harnesses`, add `lossy`, `unverified`, or
`all` to also fail on the matching compatibility warnings. Lossy findings
include unsupported and partial translations; unverified findings mean the
installed version is outside the compatibility evidence.

Exit codes: `0` valid, `1` compatibility analysis failed, `2` the file is
missing, fails schema or semantic validation, or the options are invalid.

### Workflow warnings

Validation reports workflow findings that hold whatever harness runs the file.
Unknown fields are ignored by the current ctrlyoke version and reported as
warnings; the message suggests the nearest valid key and notes that the field
may come from a newer ctrlyoke. Other warnings describe settings that will not
take effect. Findings print under the result and appear in `--json` as a
`warnings` array of `{ code, message, propertyPointer }`, where
`propertyPointer` is an RFC 6901 pointer to the authored value. Identify a
finding by its `code`, not by its message.

| Code                           | Meaning                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `unknown-property`             | A field is not recognized at this location and will be ignored by this ctrlyoke version.                                        |
| `script-comparison-incomplete` | A script comparison names a `compareSource` or `operator` but no `expected`, so it is ignored and the check uses exit code `0`. |

Warnings do not change the exit code by default. Bare `--strict` fails on
`unknown-property` warnings; `--strict <policy>` also applies that rule while
failing on the selected compatibility warnings.

## `ctrlyoke commit`

Generate a commit message with the commit harness and commit:

```bash
ctrlyoke commit
ctrlyoke commit --hint "mention the migration" --yes
git commit -m "$(ctrlyoke commit --print-only)"
```

The message is generated from staged changes. If nothing is staged, the CLI
prints the generated message and exits with code `2` without committing, unless
`--all` is given to stage all changes first. The harness, model, and prompt come
from the `commit` settings;
`--model` overrides the model. Without `--yes`, the CLI asks for confirmation.
`--print-only` writes only the message to stdout and does not commit.

## `ctrlyoke about`

Show this CLI's version, how it was installed (the npm package, or the copy
bundled with the VS Code extension), its package folder, the Node.js version,
the ctrlyoke state folder, and any other ctrlyoke installations used on this
machine in the last 30 days:

```bash
ctrlyoke about
ctrlyoke about --json
```

Use it to tell which copy a shell is running when the extension and an npm
install are both present. `--json` prints one JSON object with a
`schemaVersion` field.

## `ctrlyoke trust-workflow-external-roots`

Review and approve the external directories requested by a workflow's
`trustedExternalRoots` field:

```bash
ctrlyoke trust-workflow-external-roots my-workflow.ctrlyoke.yaml
```

The command lists pending roots and asks for confirmation before recording an
allow or deny decision for that workflow on the local machine. Use
`--yes` to approve all pending roots in automation. A workflow with pending
roots cannot run; `ctrlyoke run` exits with code `2` and prints this command as
the remediation.

`ctrlyoke trust-external-roots` is the corresponding command for
workspace-scope `permissions.trustedExternalRoots` requests. User-scope
roots are trusted immediately when added to the user's settings.

## `ctrlyoke trust-secret-grants`

Review and approve the secret grants a workflow declares:

```bash
ctrlyoke trust-secret-grants deploy.ctrlyoke.yaml --yes
```

Declining records a deny decision; the grants stay blocked until approved.

## `ctrlyoke secret`

The `secret` commands never accept a value as an argument. `secret set` reads
from a hidden TTY prompt by default, or from stdin with `--stdin`; `secret list`
prints names, scope, set state, and source (`managed`, `environment`, or
`unavailable`) only. There is intentionally no `secret get` command. `--scope`
defaults to `user`.

Managed secrets use the host OS credential store and are never written to a
plaintext fallback file. The CI-friendly path does not require a credential
backend: export the declared names in the environment and run the workflow as
usual. For example:

```bash
export DEPLOY_TOKEN="..."
ctrlyoke run deploy.ctrlyoke.yaml --headless
```

`secret check <file>` performs the same declared-secret preflight as `run`
without starting a harness. It exits `1` when a declared name cannot resolve
(and reports the name and resolution scope) and `2` when the file cannot be
loaded. Unlike `run`, which only warns about a missing secret unless
`execution.contextResolutionFailure` is `fail`, `secret check` always fails on
one.

## `ctrlyoke history prune`

List user-scoped project directories whose recorded `statePath` no longer
exists:

```bash
ctrlyoke history prune
```

This is a dry run unless you confirm the interactive prompt. In a
non-interactive shell, pass `--yes` to delete the listed orphaned project
history:

```bash
ctrlyoke history prune --yes
```

Inaccessible repository paths are reported as unknown and are never deleted.
Projects with a live or indeterminate `runner.json` are also refused. The
command scans the user project registry under `<ctrlyokeStateHome>/projects/`
and does not need a workspace to be open.

## `ctrlyoke history relink`

Move history after a repository is renamed or moved:

```bash
ctrlyoke history relink /old/repository /new/repository --yes
```

Without `--yes`, the command only previews the relink (or asks for confirmation
when attached to an interactive terminal). It refuses live runners and
destinations containing history. A matching empty destination scaffold may be
replaced automatically. Relinking operates on the user project tree even when
`storage.runHistoryLocation` is currently `workspace`; changing that setting
does not migrate history.

## `ctrlyoke history list`

List workflow lineages in the current workspace and discover the keys needed by
the other history and execution commands:

```bash
ctrlyoke history list
ctrlyoke history list --all
ctrlyoke history list --json
ctrlyoke history list --state running paused --since 7d --limit 10
```

System-generated lineages are hidden by default. The text output shows each
lineage's key, name, run count, newest run time, and newest manifest state.
`--json` emits an array containing descriptor metadata and the newest run
summary.
`--state` filters by the latest run's outcome, `--since` filters by its start
time (ISO-8601 or a relative value such as `7d`, `24h`, or `30m`), and `--limit`
caps the returned lineages.

## `ctrlyoke history runs`

List the runs in one workflow lineage, newest first:

```bash
ctrlyoke history runs --workflow release
ctrlyoke history runs --workflow release --json
```

The text output includes each run's numeric ID and stable reference, which can
be passed to commands that accept `--run` or `--from`. The JSON form is an
array of the stable `RunSummary` records used by the dashboard.

## `ctrlyoke history steps`

Show a compact overview sourced from the run's current workflow working file.
The default prompt column contains only the first line; `--full-prompts` prints
complete prompts. `--run` defaults to the lineage's latest run.

```bash
ctrlyoke history steps --workflow release
ctrlyoke history steps --workflow release --run 7 --json
```

JSON output is one object with `runRef`, `steps[]`, and `finalStep`. Each queue
step carries its zero-based `selector` for `history show --step`; the final step
uses `selector: "final"`. Attempt and final-pass counts come from streamed
attempt lifecycle records.

## `ctrlyoke history show`

Print the recorded output for one run. `--run` accepts either the numeric run
ID or its stable reference. `--step` accepts zero-based queue indices and
inclusive ranges (`3,7,10-12`), `final` for every final-step pass, `final:N` for
one 1-based final-step pass, `final:latest`, `running`, or `latest`. `--attempt`
accepts a 1-based attempt number, `latest`, or `all` (the default). Omitting
`--run` selects the latest run:

```bash
ctrlyoke history show --workflow release --run 7
ctrlyoke history show --workflow release --run run-2026-09-20T12-00-00-000Z --step 2
ctrlyoke history show --workflow release --run 7 --step final --no-color
ctrlyoke history show --workflow release --step 3,7,10-12 --attempt latest
ctrlyoke history show --workflow release --step final:3
ctrlyoke history show --workflow release --step running
ctrlyoke history show --workflow release --step 2
```

When a valid queue step has no attempt, text output reports its state from the
run's working file, such as `Step 57 has not started (pending)` or
`Step 57 was skipped`. A pause is rendered as `Run paused`.

Pass `--json` to emit one raw attempt record per line as NDJSON. This is
deliberately different from commands such as `validate --json`, which emit one
versioned JSON document; NDJSON keeps large runs streamable and includes an
`unterminated` marker for attempts interrupted before their terminal event.

## `ctrlyoke history search`

Search indexed output across this workspace's run history:

```bash
ctrlyoke history search "EPERM" --kind bash --kind response --limit 3
ctrlyoke history search "timeout" --workflow release --deep --exact-count
ctrlyoke history search "permission" --since 7d --json
ctrlyoke history search "EP.*RM" --regex
```

| Option                | Meaning                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--workflow <key...>` | Restrict to workflow lineage keys                                                                                    |
| `--this-workflow`     | Restrict to the workflow named by `CTRLYOKE_WORKING_FILE` (set for harness and workflow-script processes)            |
| `--kind <kind...>`    | Restrict to event kinds, such as `prompt`, `response`, `thinking`, `bash`, `fileEdit`, `tool`, `script`              |
| `--harness <id...>`   | Restrict to harnesses                                                                                                |
| `--state <state...>`  | Restrict to run outcomes (`completed`, `error`, `stopped`, `paused`)                                                 |
| `--path <substring>`  | Restrict to events touching a file path                                                                              |
| `--since` / `--until` | Runs started at or after / before an ISO-8601 time (`--until` date-only values include the whole day; offset-less date-times are UTC) or a relative `7d`, `24h`, `30m` |
| `--deep`              | Re-read matching runs past the 2,000-character indexed text cap                                                      |
| `--regex`             | Treat the query as a case-insensitive regular expression                                                             |
| `--limit <n>`         | Maximum results (default 20, maximum 100)                                                                            |
| `--offset <n>`        | Absolute result offset                                                                                               |
| `--snippet <chars>`   | Context characters around each match                                                                                 |
| `--exact-count`       | Scan the whole history for an exact total                                                                            |
| `--no-rebuild`        | Search the existing index without rebuilding it                                                                      |
| `--no-fallback`       | Fail rather than serve results from the unindexed disk scan                                                          |

`ctrlyoke history search --help` lists every valid `--kind`, `--harness`, and
`--state` value.

Text results include a copy-pasteable `--workflow ... --run ... --step ...`
selector for `history show`. A result represents one
matching event or field, not one occurrence. Unless `--exact-count` is supplied,
the reported total is a lower bound and is marked with `+`.

Without `--deep`, matching uses indexed text capped at 2,000 characters per
event. A term that appears only later in a long output may therefore be missed;
use `--deep` or inspect a known run with `history show`. The text footer always
discloses the shallow/deep mode, substring/regex mode, and index/count state.

`--regex` searches may be slower than substring searches because the raw-line
prefilter can only use a literal extracted from the pattern; patterns without a
required literal may parse every candidate document.

`--json` emits one versioned JSON result blob bounded by `--limit` (up to 100
results). This is deliberately different from `history show --json`, which
emits NDJSON because a run can contain an unbounded stream of attempts.

## `ctrlyoke history trash`

Deleting a run or workflow from the dashboard, including Clear all history,
moves it to Recently deleted instead of erasing it. It stays there for
`storage.trashRetentionDays` (30 days by default) and can be restored until
then:

```bash
ctrlyoke history trash list
ctrlyoke history trash restore 2026-09-30T00-02-13-403Z-1a2b3c4d
ctrlyoke history trash purge 2026-09-30T00-02-13-403Z-1a2b3c4d --yes
ctrlyoke history trash empty --yes
```

`list` prints each entry's id, what it holds, its size, and how many days it
has left, and removes entries that have expired; `--json` emits them as one
versioned document. `restore` puts an entry back; a run whose slot has been
taken again stays in Recently deleted and is reported. `purge` and `empty`
delete permanently, so they ask first, and refuse without `--yes` when not run
interactively.

## `ctrlyoke step`

These commands edit a persisted run without starting or resuming a harness.
They address steps by their zero-based absolute index and require both the
workflow lineage key and a run reference or numeric run ID.

### `ctrlyoke step edit`

Edit a pending step with an inline prompt:

```bash
ctrlyoke step edit --workflow release --run 7 --index 3 --prompt "Correct the deployment target"
```

Instead of `--prompt`, pass a file containing exactly one workflow step. The
step's authored fields are merged into the addressed step, which allows a file
to change configuration as well as the prompt:

```bash
ctrlyoke step edit replacement.ctrlyoke.yaml --workflow release --run 7 --index 3
```

`--prompt` and the file argument are mutually exclusive. An edit is accepted
for any not-yet-executed step, including while another process executes the
target run; the completed prefix and in-flight step remain protected.

### `ctrlyoke step remove`

```bash
ctrlyoke step remove --workflow release --run 7 --index 3
```

### `ctrlyoke step reorder`

Pass every not-yet-started step's absolute zero-based index exactly once, in
the desired execution order. Never include a running or completed step:

```bash
ctrlyoke step reorder --workflow release --run 7 --order 3,4,5
```

All three commands support `--cwd <path>` and `--json`. JSON output is a
versioned one-line result envelope; failures exit with code `2`.

## Environment variables

| Variable                | Effect                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CTRLYOKE_HOME`         | Moves the user state home (`<ctrlyokeStateHome>`, default `~/.ctrlyoke`) that holds run history. Settings stay in `~/.ctrlyoke/settings.json` |
| `CTRLYOKE_WORKING_FILE` | Set by ctrlyoke for harness and workflow-script processes; names the run a step belongs to. Used by `history search --this-workflow`          |
| `CTRLYOKE_MAX_STEPS`    | Set for the built-in MCP server process to the global `queue.maxSteps` value; a workflow's `maxSteps` can override it for that run            |
| Declared secret names   | Resolve a workflow's declared secrets without a credential store (env passthrough)                                                            |
