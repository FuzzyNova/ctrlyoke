# End conditions and pre-conditions

Script gates make workflows react to project state instead of trusting the model to declare success.

## End condition

An end condition runs after a prompt step completes.

```yaml
endCondition:
  script: npm test
  returns: "0"
  compareSource: exitCode
  timeout: 60000
  maxRetries: 2
  retryPrompt: |
    Validation failed.
    stdout:
    {stdout}

    stderr:
    {stderr}
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
      returns: "true"
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

| Field                  | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `script`               | Command or script path to execute                          |
| `returns`              | Expected value                                             |
| `compareSource`        | Compare against `stdout`, `stderr`, `exitCode`, or `auto`  |
| `maxRetries`           | Shared retry limit across pass and failure retries         |
| `retryPrompt`          | Template sent after validation failure                     |
| `passRetryPrompt`      | Template sent after validation passes with `onPass: retry` |
| `resumeSessionOnRetry` | Whether retries stay in the same conversation              |
| `onPass`               | `continue`, `retry`, or `stopWorkflow`                     |
| `onFail`               | `continue`, `retry`, or `stopWorkflow`                     |

## Pre-condition

A pre-condition runs before a prompt step and decides whether to continue, skip the prompt, or stop the workflow.

```yaml
preCondition:
  script: npm run lint
  compareSource: exitCode
  returns: "0"
  onFail: stopWorkflow
```

## Placeholder variables

Retry templates can use:

- `{stdout}`
- `{stderr}`
- `{exitCode}`
- `{actual}`
- `{expected}`
- `{compareSource}`
