# Common errors

## The workflow file validates in my head, but ctrlyoke refuses to run it

Check the schema shape first. Multi-step workflows use `steps`, not `prompts`.

## A later step did not continue the conversation I expected

Check:

- whether the step set `resumeSession: true` or `sessionId`
- whether the earlier step actually captured a runtime session ID
- whether you changed harnesses between steps

## My validation script failed and the workflow stopped

That usually means the script hit an execution error rather than a retryable validation failure. Check:

- the script path or command
- the timeout
- the exit code
- whether `compareSource`, `operator`, and `expected` describe the check you meant — a numeric operator (`gte`/`gt`/`lte`/`lt`) fails outright when either side is not a number, and `matches` is an unanchored regex unless you add `^` and `$`

## Dynamic queue did nothing

Confirm that the step includes:

```yaml
mcpServers:
  - ctrlyoke
```

Without the built-in server, the harness cannot call the queue tools.

## The CLI finished, but I wanted an interactive session

Use `--interactive` on `ctrlyoke run`, or make sure stdin and stdout are attached to a TTY so the CLI does not auto-select headless mode.
