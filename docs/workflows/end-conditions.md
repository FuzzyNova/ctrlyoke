# End conditions and pre-conditions

Script gates make workflows react to project state instead of trusting the model to declare success.

## End condition

An end condition runs after a prompt step completes.

```yaml
endCondition:
  script: npm test
  timeout: 60000
  maxRetries: 2
  retryPrompt: |
    Validation failed.
    stdout:
    $endCondition:stdout

    stderr:
    $endCondition:stderr
```

The pass and failure directions are independent actions. `onFail: retry`
re-prompts after a failed validation, while `onPass: retry` re-prompts when a
passing validation means the step should keep working. Pass retries use
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

| Field                  | Meaning                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `script`               | Command or script path to execute                                                                                             |
| `compareSource`        | Which output to compare: `exitCode` (default), `stdout`, `stderr`                                                             |
| `operator`             | How to compare: `eq` (default), `ne`, `contains`, `notContains`, `gte`, `gt`, `lte`, `lt`, `matches`, `isEmpty`, `isNotEmpty` |
| `expected`             | Value to compare against. Omit it to pass on exit code 0                                                                      |
| `ignoreCase`           | Case-insensitive text compare (string operators only)                                                                         |
| `maxRetries`           | Shared retry limit across pass and failure retries                                                                            |
| `retryPrompt`          | Template sent after validation failure                                                                                        |
| `passRetryPrompt`      | Template sent after validation passes with `onPass: retry`                                                                    |
| `resumeSessionOnRetry` | Whether retries stay in the same conversation                                                                                 |
| `onPass`               | `continue`, `retry`, or `stopWorkflow`                                                                                        |
| `onFail`               | `continue`, `retry`, or `stopWorkflow`                                                                                        |

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

A pre-condition runs before a prompt step and decides whether to continue, skip the prompt, or stop the workflow.

```yaml
preCondition:
  script: npm run lint
  onFail: stopWorkflow
```

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
