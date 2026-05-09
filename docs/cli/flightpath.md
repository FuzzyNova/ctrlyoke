# `flightpath`

The standalone CLI currently exposes two commands:

```text
flightpath run [file]
flightpath validate <file>
```

## `flightpath run`

Run a prompt or workflow file:

```bash
flightpath run my-workflow.flightpath.yaml
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
flightpath run review.flightpath.yaml --harness claude-cli --model sonnet
flightpath run lint-fix.prompt.md --prompt "Fix the lint errors" --headless
flightpath run build.flightpath.json --json --quiet
```

## `flightpath validate`

Validate a workflow file without running it:

```bash
flightpath validate my-workflow.flightpath.yaml
```
