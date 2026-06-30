# `ctrlyoke`

The standalone CLI currently exposes two commands:

```text
ctrlyoke run [file]
ctrlyoke validate <file>
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
