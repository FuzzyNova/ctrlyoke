# End conditions and pre-conditions

Script gates make workflows react to project state instead of trusting the model to declare success.
You can write them in the workflow file or set them from the Validation tab of the
[Workflow properties panel](/workflows/properties-panel#validation).

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

A failed validation is re-prompted while retry budget remains. A `retryPrompt`
alone does not enable retries: set `maxRetries` above 0 on the condition or in
`defaults.endCondition.maxRetries`, or use `onFail: retry`. With `onFail: retry`,
no template is required: ctrlyoke sends a fallback prompt containing the expected
and actual values and script output. The implicit retry limit is one when
`onFail: retry` is set and `maxRetries` is omitted. When the budget runs out the
step fails and the workflow stops. `onFail: continue` skips retries and advances
immediately.

`onPass: retry` works in the other direction: it re-prompts when a passing
validation means the step should keep working. Pass retries use
`passRetryPrompt`, then the default pass-retry prompt from settings, and finally
the step's own prompt when no template is configured. They reuse the same
`maxRetries` budget as failure retries and the same session by default.

`maxSteps` is a separate run-wide cap on entries in the workflow's `steps`
array. It counts queued steps regardless of whether the workflow author, an
agent, or the dashboard added them, but it does not count `finalStep`
iterations or end-condition retries. A workflow can set `maxSteps: -1` to
override a numeric global `queue.maxSteps` cap. See [Dynamic workflows](/workflows/dynamic-workflows)
for the cap and append behavior.

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

| Field                  | Meaning                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `script`               | Command or script path to execute (required)                                                                                                                                                                                                                             |
| `env`                  | Extra environment variables for the script. Secrets only as `${secret:NAME}` values                                                                                                                                                                                      |
| `timeoutSec`           | Timeout in seconds. Defaults to the `execution.scriptTimeoutSec` setting                                                                                                                                                                                                 |
| `shell`                | Shell for inline command text, e.g. `pwsh`, `bash`, `cmd`. Ignored for script files                                                                                                                                                                                      |
| `compareSource`        | Which output to compare: `exitCode` (default), `stdout`, `stderr`                                                                                                                                                                                                        |
| `operator`             | How to compare: `eq` (default), `ne`, `contains`, `notContains`, `gte`, `gt`, `lte`, `lt`, `matches`, `isEmpty`, `isNotEmpty`                                                                                                                                            |
| `expected`             | Value to compare against. Omit it to pass on exit code 0                                                                                                                                                                                                                 |
| `ignoreCase`           | Case-insensitive text compare (string operators only)                                                                                                                                                                                                                    |
| `maxRetries`           | Shared retry limit across pass and failure retries. `0` = none, `-1` = unlimited, max `100`. Unset: `1` when `onPass`/`onFail` is `retry`; otherwise the configured default applies only when this condition has its own `retryPrompt`, and the limit is `0` without one |
| `retryPrompt`          | Optional template sent after validation failure; `onFail: retry` uses a fallback prompt when no template is configured                                                                                                                                                   |
| `passRetryPrompt`      | Template sent after validation passes with `onPass: retry`                                                                                                                                                                                                               |
| `resumeSessionOnRetry` | Whether retries stay in the same conversation (default `true`)                                                                                                                                                                                                           |
| `onPass`               | `continue` (default), `retry`, or `stopWorkflow`                                                                                                                                                                                                                         |
| `onFail`               | `continue`, `retry`, or `stopWorkflow` (default)                                                                                                                                                                                                                         |

`endCondition` and `preCondition` can also be set once at the workflow level (or
in the `defaults` settings) and are inherited by every prompt step. Set either to
`null` on a step to switch an inherited condition off.

## Comparing output {#comparing-output}

A condition with no `compareSource`/`operator`/`expected` **passes when the script
exits 0**. To compare stdout, stderr or the exit code against an expected value
instead, state all three parts:

```yaml
endCondition:
  script: npm test
  compareSource: stdout
  operator: contains
  expected: "0 failing"
```

Every operator and comparison rule is described in
[Script steps and condition scripts: Comparing output](/workflows/script-steps#comparing-output).

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

## How scripts run {#how-scripts-run}

Condition scripts are resolved and run exactly like script steps: a file path is
looked up in the execution directory, the workspace root, `.ctrlyoke/` and
`~/.ctrlyoke/scripts/`, and anything else runs as a shell command. Condition
scripts always run headless. A script that cannot be run at all is an internal
error handled by `errorBehavior`, not a failed validation. See
[Script steps and condition scripts: How scripts run](/workflows/script-steps#how-scripts-run).

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
