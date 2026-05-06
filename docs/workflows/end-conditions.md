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

## Important fields

| Field | Meaning |
| --- | --- |
| `script` | Command or script path to execute |
| `returns` | Expected value |
| `compareSource` | Compare against `stdout`, `stderr`, `exitCode`, or `auto` |
| `maxRetries` | Retry limit after validation failure |
| `retryPrompt` | Template sent back to the harness on retry |
| `resumeSessionOnRetry` | Whether retries stay in the same conversation |

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
