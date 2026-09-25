# `ctrlyoke`

The standalone CLI exposes these commands. Run `ctrlyoke <command> --help` for
the authoritative option list of any command.

```text
ctrlyoke run [file] [options]
ctrlyoke rerun --workflow <key> [--from <ref|runId>] [options]
ctrlyoke append [file] --workflow <key> --run <ref|runId> [--prompt <text>] [options]
ctrlyoke continue --workflow <key> --run <ref|runId> [options]
ctrlyoke validate <file> [--harness <id> | --all-installed-harnesses] [--strict <policy>] [--json]
ctrlyoke commit [--model <model>] [--hint <text>] [--print-only] [--yes] [--cwd <path>]
ctrlyoke trust-external-roots [--yes] [--cwd <path>]
ctrlyoke trust-workflow-external-roots <file> [--yes] [--cwd <path>]
ctrlyoke trust-secret-grants <file> [--yes] [--cwd <path>]
ctrlyoke history prune [--yes]
ctrlyoke history relink <oldPath> <newPath> [--yes]
ctrlyoke history list [--cwd <path>] [--all] [--json]
ctrlyoke history runs --workflow <key> [--cwd <path>] [--json]
ctrlyoke history show --workflow <key> --run <ref|runId> [--step <index|final>] [--json]
ctrlyoke history search <query> [filters] [--json]
ctrlyoke step edit [file] --workflow <key> --run <ref|runId> --index <index> [--prompt <text>]
ctrlyoke step remove --workflow <key> --run <ref|runId> --index <index>
ctrlyoke step reorder --workflow <key> --run <ref|runId> --order <indices>
ctrlyoke secret set <NAME> [--stdin] [--scope user|workspace] [--cwd <path>]
ctrlyoke secret list [--cwd <path>]
ctrlyoke secret rm <NAME> [--yes] [--scope user|workspace] [--cwd <path>]
ctrlyoke secret check <file> [--cwd <path>]
```

`ctrlyoke --version` prints the CLI version.

The CLI treats its working directory (or `--cwd`) as the workspace root: it
reads `<cwd>/.ctrlyoke/settings.json` on top of `~/.ctrlyoke/settings.json` and
records run history for that directory. Run it from the directory that holds
your `.ctrlyoke/` folder, or pass `--cwd`.

## Exit codes

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | Success                                                                               |
| `1`  | The workflow failed (a step or end condition failed), or a validation check failed    |
| `2`  | Usage, parse, or unexpected error; also unapproved external roots or secret grants    |
| `3`  | A harness failed because its CLI could not be found (not installed, not on `PATH`)    |
| `4`  | A step failed with a timeout                                                          |
| `5`  | Interrupted with Ctrl+C or `SIGTERM`; the run is stopped and its runner lock released |

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
| `-m, --model <model>`        | Model for the harness selected by `--harness` (Copilot CLI when `--harness` is omitted). Pass both when you override a model                                                         |
| `-p, --prompt <text>`        | Run an inline prompt instead of a file                                                                                                                                               |
| `--var <key=value>`          | Set a workflow variable (repeatable). CLI values override the workflow's own `vars`                                                                                                  |
| `--session-id <id>`          | Resume this harness session in the first step (implies `--resume-session`)                                                                                                           |
| `--resume-session`           | Force every AI step to resume its existing session                                                                                                                                   |
| `--no-resume-session`        | Force every AI step to start a new session, ignoring any recorded session                                                                                                            |
| `--dry-run`                  | Print the redacted execution preview and its diagnostics without starting a harness                                                                                                  |
| `--headless`                 | Force headless mode (CI, no user interaction)                                                                                                                                        |
| `--interactive`              | Force interactive mode (the harness TUI is passed through; you end the session)                                                                                                      |
| `--permission-mode <mode>`   | Tool permission mode: `dangerouslyAllowAll`, `allowAll`, or `custom`                                                                                                                 |
| `--allow-tool <pattern>`     | Allow a tool pattern (repeatable)                                                                                                                                                    |
| `--deny-tool <pattern>`      | Deny a tool pattern (repeatable)                                                                                                                                                     |
| `-d, --cwd <path>`           | Workspace directory (default: current directory)                                                                                                                                     |
| `-t, --timeout <seconds>`    | Accepted, but not currently applied; set `execution.maxPromptTimeout` in settings instead                                                                                            |
| `--script-timeout <seconds>` | Accepted, but not currently applied; set `execution.scriptTimeout` in settings or `timeout` on the condition instead                                                                 |
| `--add-dir <path>`           | Accepted, but not currently applied; grant extra directories with `trustedExternalRoots` or `permissions.allowedExternalFileRoots`                                                   |
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

Unless you pass `--permission-mode`, the CLI chooses one:

- `custom` when any `--allow-tool` or `--deny-tool` is given
- `dangerouslyAllowAll` in headless mode, so an unattended run is never blocked
  by an approval prompt
- `allowAll` in interactive mode

Pass `--permission-mode` or explicit allow/deny patterns to restrict what a
headless run may do.

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

- the workspace requests `permissions.allowedExternalFileRoots` that have not
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
prompt step. The queue-size limit (`queue.maxSize`) applies.

## `ctrlyoke continue`

Resume the unchanged pending work of a stopped, paused, or interrupted run:

```bash
ctrlyoke continue --workflow release --run 7
```

A run left `running` or `paused` by a process that no longer holds its runner
lock can be adopted this way. `continue` refuses while the lineage has an
unsaved draft or pending edit, or while another process is executing the run.

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

Compatibility errors fail validation by default. CI can additionally fail on
warnings with `--strict lossy`, `--strict unverified`, or `--strict all`;
`--strict` requires `--harness` or `--all-installed-harnesses`. Lossy findings
include unsupported and partial translations; unverified findings mean the
installed version is outside the compatibility evidence.

Exit codes: `0` valid, `1` compatibility analysis failed, `2` the file is
missing, fails schema or semantic validation, or the options are invalid.

### Workflow warnings

Separately from compatibility, validation reports workflow findings that hold
whatever harness runs the file: the workflow is valid and will run, but
something it states will not take effect. These print under the result and
appear in `--json` as a `warnings` array of `{ code, message, propertyPointer }`,
where `propertyPointer` is an RFC 6901 pointer to the authored value. Identify a
finding by its `code`, not by its message.

| Code                           | Meaning                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `script-comparison-incomplete` | A script comparison names a `compareSource` or `operator` but no `expected`, so it is ignored and the check uses exit code `0`. |

Workflow warnings never change the exit code — `--strict` is a compatibility
policy and does not apply to them.

## `ctrlyoke commit`

Generate a commit message with the commit harness and commit:

```bash
ctrlyoke commit
ctrlyoke commit --hint "mention the migration" --yes
git commit -m "$(ctrlyoke commit --print-only)"
```

The message is generated from staged changes; when nothing is staged it falls
back to unstaged and untracked changes and warns you to stage them before
committing. The harness, model, and prompt come from the `commit` settings;
`--model` overrides the model. Without `--yes`, the CLI asks for confirmation.
`--print-only` writes only the message to stdout and does not commit.

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
workspace-scope `permissions.allowedExternalFileRoots` requests. User-scope
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
`execution.strictContextResolution` is `fail`, `secret check` always fails on
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
```

System-generated lineages are hidden by default. The text output shows each
lineage's key, name, run count, newest run time, and newest manifest state.
`--json` emits an array containing descriptor metadata and the newest run
summary.

## `ctrlyoke history runs`

List the runs in one workflow lineage, newest first:

```bash
ctrlyoke history runs --workflow release
ctrlyoke history runs --workflow release --json
```

The text output includes each run's numeric ID and stable reference, which can
be passed to commands that accept `--run` or `--from`. The JSON form is an
array of the stable `RunSummary` records used by the dashboard.

## `ctrlyoke history show`

Print the recorded output for one run. `--run` accepts either the numeric run
ID or its stable reference, and `--step` accepts a zero-based queue-step index
or `final` to show every final-step loop:

```bash
ctrlyoke history show --workflow release --run 7
ctrlyoke history show --workflow release --run run-2026-09-20T12-00-00-000Z --step 2
ctrlyoke history show --workflow release --run 7 --step final --no-color
```

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

| Option                | Meaning                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `--workflow <key...>` | Restrict to workflow lineage keys                                                                       |
| `--this-workflow`     | Restrict to the workflow named by `CTRLYOKE_WORKING_FILE` (set inside a running step)                   |
| `--kind <kind...>`    | Restrict to event kinds, such as `prompt`, `response`, `thinking`, `bash`, `fileEdit`, `tool`, `script` |
| `--harness <id...>`   | Restrict to harnesses                                                                                   |
| `--state <state...>`  | Restrict to run outcomes (`completed`, `error`, `stopped`, `paused`)                                    |
| `--path <substring>`  | Restrict to events touching a file path                                                                 |
| `--since` / `--until` | Runs started at or after / before an ISO-8601 time or a relative `7d`, `24h`, `30m`                     |
| `--deep`              | Re-read matching runs past the 2,000-character indexed text cap                                         |
| `--regex`             | Treat the query as a case-insensitive regular expression                                                |
| `--limit <n>`         | Maximum results (default 20, maximum 100)                                                               |
| `--offset <n>`        | Absolute result offset                                                                                  |
| `--snippet <chars>`   | Context characters around each match                                                                    |
| `--exact-count`       | Scan the whole history for an exact total                                                               |
| `--no-rebuild`        | Search the existing index without rebuilding it                                                         |
| `--no-fallback`       | Fail rather than serve results from the unindexed disk scan                                             |

`ctrlyoke history search --help` lists every valid `--kind`, `--harness`, and
`--state` value.

Text results include a copy-pasteable `--workflow ... --run ... --step ...`
selector for `history show` and the step commands. A result represents one
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

Pass every pending step's absolute zero-based index once, in its desired
execution order. When a step is in flight, include that index first:

```bash
ctrlyoke step reorder --workflow release --run 7 --order 3,4,5
```

All three commands support `--cwd <path>` and `--json`. JSON output is a
versioned one-line result envelope; failures exit with code `2`.

## Environment variables

| Variable                | Effect                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CTRLYOKE_HOME`         | Moves the user state home (`<ctrlyokeStateHome>`, default `~/.ctrlyoke`) that holds run history. Settings stay in `~/.ctrlyoke/settings.json` |
| `CTRLYOKE_WORKING_FILE` | Set by ctrlyoke for harness processes; names the run a step belongs to. Used by `history search --this-workflow`                              |
| Declared secret names   | Resolve a workflow's declared secrets without a credential store (env passthrough)                                                            |
