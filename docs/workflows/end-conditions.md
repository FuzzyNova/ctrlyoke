# End conditions and pre-conditions

Script gates make workflows react to project state instead of trusting the model to declare success.

## End condition

An end condition runs after a prompt step completes.

```yaml
endCondition:
  script: npm test
  timeoutSec: 60
  maxRetries: 2
  retryPrompt: |
    Validation failed.
    stdout:
    $endCondition:stdout

    stderr:
    $endCondition:stderr
```

A failed validation is re-prompted with the retry prompt while retry budget
remains. That happens with the default `onFail: stopWorkflow` as well as with
`onFail: retry`, as long as a retry prompt is available — the step's
`retryPrompt`, or the `defaults.endCondition.retryPrompt` setting. Without a retry
prompt there are no failure retries, so always pair `onFail: retry` with a
`retryPrompt`. When the budget runs out the step fails and the workflow stops.
`onFail: continue` skips retries and advances immediately.

`onPass: retry` works in the other direction: it re-prompts when a passing
validation means the step should keep working. Pass retries use
`passRetryPrompt`, then the default pass-retry prompt from settings, and finally
the step's own prompt when no template is configured. They reuse the same
`maxRetries` budget as failure retries and the same session by default.

When a pass-retry budget is exhausted while validation still passes, the step
succeeds and the workflow advances. If a re-evaluation inside the pass-retry
loop fails, the normal `onFail` action handles that result.

For example, this keeps asking for a regression test until the test actually
fails, then advances to the next step:

```yaml
steps:
  - prompt: Write a regression test for issue #123. Do not fix the bug.
    endCondition:
      script: npm test
      onPass: retry
      onFail: continue
      maxRetries: 3
      passRetryPrompt: |
        npm test still passes, so the new test does not reproduce the bug.
        Strengthen the test until it fails for the right reason.
```

This `onPass: retry` plus `onFail: continue` combination is the regression-test
recipe: keep working while the condition passes, and advance once it fails.

## Important fields

| Field                  | Meaning                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script`               | Command or script path to execute (required)                                                                                                                                                         |
| `env`                  | Extra environment variables for the script. Secrets only as `${secret:NAME}` values                                                                                                                  |
| `timeoutSec`           | Timeout in seconds. Defaults to the `execution.scriptTimeoutSec` setting                                                                                                                             |
| `shell`                | Shell for inline command text, e.g. `pwsh`, `bash`, `cmd`. Ignored for script files                                                                                                                  |
| `compareSource`        | Which output to compare: `exitCode` (default), `stdout`, `stderr`                                                                                                                                    |
| `operator`             | How to compare: `eq` (default), `ne`, `contains`, `notContains`, `gte`, `gt`, `lte`, `lt`, `matches`, `isEmpty`, `isNotEmpty`                                                                        |
| `expected`             | Value to compare against. Omit it to pass on exit code 0                                                                                                                                             |
| `ignoreCase`           | Case-insensitive text compare (string operators only)                                                                                                                                                |
| `maxRetries`           | Shared retry limit across pass and failure retries. `0` = none, `-1` = unlimited, max `100`. Unset: `1` when `onPass`/`onFail` is `retry`, else the `defaults.endCondition.maxRetries` setting (`0`) |
| `retryPrompt`          | Template sent after validation failure                                                                                                                                                               |
| `passRetryPrompt`      | Template sent after validation passes with `onPass: retry`                                                                                                                                           |
| `resumeSessionOnRetry` | Whether retries stay in the same conversation (default `true`)                                                                                                                                       |
| `onPass`               | `continue` (default), `retry`, or `stopWorkflow`                                                                                                                                                     |
| `onFail`               | `continue`, `retry`, or `stopWorkflow` (default)                                                                                                                                                     |

`endCondition` and `preCondition` can also be set once at the workflow level (or
in the `defaults` settings) and are inherited by every prompt step. Set either to
`null` on a step to switch an inherited condition off.

## Comparing output

A condition with no `compareSource`/`operator`/`expected` **passes when the script
exits 0**. That covers most checkpoints — `npm test`, `npm run lint`, `tsc` — and
is why the examples above carry no comparison fields at all. There is no boolean
form: `true` and `false` are not accepted as exit-code values, because exit 0
means "no error", not "true".

To compare output instead, state all three parts. They read as a sentence, and
the dashboard shows the same sentence under the controls:

```yaml
endCondition:
  script: npm test
  compareSource: stdout # which output: exitCode (default), stdout, stderr
  operator: contains # how to compare: eq (default), contains, gte, matches, …
  expected: "0 failing" # what to compare against
```

| Operator                    | Compares                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `eq` (default) / `ne`       | The **whole** trimmed value, literally. No characters are special.                 |
| `contains` / `notContains`  | Whether the value contains `expected` as a substring.                              |
| `gte` / `gt` / `lte` / `lt` | Numbers. **Both sides must parse as a number**, or the condition fails.            |
| `matches`                   | `expected` as a regular expression, **unanchored** — add `^`/`$` for a full match. |
| `isEmpty` / `isNotEmpty`    | Whether the value is empty. Takes no `expected`.                                   |

Three things worth knowing:

- **The operator is never inferred.** The comparison you write is the comparison
  that runs, whatever the script happens to print.
- **Text comparisons ignore the exit code**, and `exitCode` comparisons ignore the
  text. If you need both, that is two conditions, not one.
- **Text is trimmed and case-sensitive.** Add `ignoreCase: true` for a
  case-insensitive `eq`/`ne`/`contains`/`notContains`.

Operators are word tokens (`gte`, not `>=`) because symbols are not usable as
YAML values — `operator: >=` is a parse error, and `operator: !=` parses as a YAML
tag and silently becomes an empty string. The dashboard still shows you `>=`
and `!=`.

## Pre-condition

A pre-condition runs before a prompt step and decides whether to run the prompt, skip it, or stop the workflow. It uses the same script and comparison fields as an end condition (no retry fields).

```yaml
preCondition:
  script: npm run lint
  onFail: stopWorkflow
```

| Field    | Values                                                             |
| -------- | ------------------------------------------------------------------ |
| `onPass` | `continue` (default, run the prompt), `skipPrompt`, `stopWorkflow` |
| `onFail` | `continue`, `skipPrompt` (default), `stopWorkflow`                 |

`onFail: continue` makes the pre-condition advisory: the prompt runs anyway, and
its output is still available through `$preCondition:*` references.

## How scripts run

`script` is either a path to a script file or an inline command.

A path is looked up relative to the execution directory (the worktree, when the
run uses one), then the workspace root, then `.ctrlyoke/`, then
`~/.ctrlyoke/scripts/`. A resolved file must stay inside the workspace or
`~/.ctrlyoke/scripts/`. The interpreter follows the file extension:

| Extension             | Runs with                                    |
| --------------------- | -------------------------------------------- |
| `.py`                 | `python3`, falling back to `python`          |
| `.js`, `.mjs`, `.cjs` | `node`                                       |
| `.ts`                 | `node` with a local `tsx` or `ts-node`       |
| `.sh`                 | `sh` (`bash` on Windows)                     |
| `.ps1`                | PowerShell (`-ExecutionPolicy Bypass -File`) |
| `.bat`, `.cmd`        | `cmd /c` (Windows only)                      |

Files without one of these extensions run directly when executable, or through
the interpreter named in their shebang line.

Anything that does not resolve to a file runs as a shell command — pin that
shell with `shell`, otherwise the `terminal.shellExecutable` setting or the
platform default is used. Scripts run in the execution directory, and workflow
variables are exported to them as `CTRLYOKE_VAR_<KEY>` environment variables.

A script that cannot be run at all — for example an unsupported file type or a
spawn failure — is an internal error, not a failed validation. It is handled by
the step's `errorBehavior` policy (`stop`, `retry`, or `continue`) rather than by
`onFail`.

## Condition output references

Retry templates can use `$endCondition:*` references:

- `$endCondition:stdout`
- `$endCondition:stderr`
- `$endCondition:exitCode`
- `$endCondition:actual`
- `$endCondition:expected`
- `$endCondition:compareSource`

`$preCondition:*` references use the same six fields and work in both the
step prompt and its retry prompt. `$endCondition:*` references are only
available in retry prompts because the end condition runs after the prompt.
