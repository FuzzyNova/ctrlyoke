# `ctrlyoke`

The standalone CLI currently exposes these commands:

```text
ctrlyoke run [file]
ctrlyoke validate <file>
ctrlyoke history prune [--yes]
ctrlyoke history relink <oldPath> <newPath> [--yes]
```

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

Validate a workflow file without running it:

```bash
ctrlyoke validate my-workflow.ctrlyoke.yaml
```

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
