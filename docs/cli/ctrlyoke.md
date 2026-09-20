# `ctrlyoke`

The standalone CLI currently exposes these commands:

```text
ctrlyoke run [file]
ctrlyoke validate <file>
ctrlyoke trust-external-roots
ctrlyoke trust-workflow-external-roots <file>
ctrlyoke history prune [--yes]
ctrlyoke history relink <oldPath> <newPath> [--yes]
ctrlyoke history list [--cwd <path>] [--all] [--json]
ctrlyoke history runs --workflow <key> [--cwd <path>] [--json]
ctrlyoke step edit [file] --workflow <key> --run <ref|runId> --index <index> [--prompt <text>]
ctrlyoke step remove --workflow <key> --run <ref|runId> --index <index>
ctrlyoke step reorder --workflow <key> --run <ref|runId> --order <indices>
ctrlyoke secret set <NAME> [--stdin] [--scope user|workspace]
ctrlyoke secret list
ctrlyoke secret rm <NAME> [--yes] [--scope user|workspace]
ctrlyoke secret check [file]
```

The `secret` commands never accept a value as an argument. `secret set` reads
from a hidden TTY prompt by default, or from stdin with `--stdin`; `secret list`
prints names and safe state metadata only. There is intentionally no
`secret get` command.

Managed secrets use the host OS credential store and are never written to a
plaintext fallback file. The CI-friendly path does not require a credential
backend: export the declared names in the environment and run the workflow as
usual. For example:

```bash
export DEPLOY_TOKEN="..."
ctrlyoke run deploy.ctrlyoke.yaml --headless
```

`secret check` performs the same declared-secret preflight as `run` without
starting a harness. It exits non-zero when a declared name cannot resolve and
reports the name and resolution scope.

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

## `ctrlyoke run`

Run a prompt or workflow file:

```bash
ctrlyoke run my-workflow.ctrlyoke.yaml
```

### Important options

| Option                       | Meaning                                |
| ---------------------------- | -------------------------------------- |
| `-H, --harness <harness>`    | Harness override                       |
| `-m, --model <model>`        | Model override                         |
| `-d, --cwd <path>`           | Working directory                      |
| `-t, --timeout <seconds>`    | Overall prompt timeout                 |
| `--script-timeout <seconds>` | End-condition script timeout           |
| `--headless`                 | Force headless mode                    |
| `--interactive`              | Force interactive mode                 |
| `--allow-tool <pattern>`     | Allow tool pattern                     |
| `--deny-tool <pattern>`      | Deny tool pattern                      |
| `--allow-all-tools`          | Dangerously allow all tools            |
| `--add-dir <path>`           | Add an allowed directory               |
| `--var key=value`            | Set a substitution variable            |
| `-p, --prompt <text>`        | Inline prompt instead of a file        |
| `--resume <session-id>`      | Resume a session                       |
| `--new-session`              | Ignore resume behavior and start fresh |
| `--json`                     | Emit JSON output                       |
| `-q, --quiet`                | Only print errors                      |
| `--verbose`                  | Enable debug output                    |
| `--no-color`                 | Disable colored output                 |

### Examples

```bash
ctrlyoke run review.ctrlyoke.yaml --harness claude-cli --model sonnet
ctrlyoke run lint-fix.prompt.md --prompt "Fix the lint errors" --headless
ctrlyoke run build.ctrlyoke.json --json --quiet
```

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
warnings with `--strict lossy`, `--strict unverified`, or `--strict all`.
Lossy findings include unsupported and partial translations; unverified findings
mean the installed version is outside the compatibility evidence. Invalid
harness IDs, strict policies, or conflicting target options are usage errors.

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

## `ctrlyoke history prune`

List user-scoped project directories whose recorded `statePath` no longer
exists:

```bash
ctrlyoke history prune
```

This is a dry run by default. In a non-interactive shell, pass `--yes` to
delete the listed orphaned project history:

```bash
ctrlyoke history prune --yes
```

Inaccessible repository paths are reported as unknown and are never deleted.
Projects with a live `runner.json` are also refused. The command scans the
user project registry under `<ctrlyokeStateHome>/projects/` and does not need a
workspace to be open.

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
be passed to commands that accept `--run`. The JSON form is an array of the
stable `RunSummary` records used by the dashboard.

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
