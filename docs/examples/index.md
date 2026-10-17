# Workflow examples

These examples are intentionally small so you can adapt them quickly.

## Architecture review

Use this for a quick repository orientation and one focused design observation.
See [core concepts](/guide/concepts) for ctrlyoke's workflow model.

```yaml
harness: codex-cli
steps:
  - prompt: Explain the structure of @src/ and point out one coupling problem.
```

## Implement with validation

Use an end condition when the change should be checked by a command after the
prompt completes. See [end conditions](/workflows/end-conditions) for validation
and retry behavior.

```yaml
harness: claude-cli
model: sonnet
steps:
  - prompt: Fix the failing tests in @src/test/
    endCondition:
      script: npm test
      compareSource: exitCode
      expected: 0
```

## Script gate before an AI step

Use a script step to run a check before asking a harness to make changes. See
[script steps](/workflows/script-steps) for script execution and comparison
options.

```yaml
steps:
  - type: script
    name: check-format
    script: npm run format:check
    compareSource: exitCode
    expected: 0
    onFail: stopWorkflow

  - prompt: Update the docs after the formatting check passes.
```

## Final-step review loop

Use `finalStep` to review completed work or append follow-up tasks after the
queued steps finish. See [dynamic workflows](/workflows/dynamic-workflows) for
the append flow.

```yaml
steps:
  - prompt: Implement the requested feature in @src/

finalStep:
  prompt: Review the work and append follow-up tasks if anything is missing.
  mcpServers:
    - ctrlyoke
```

## Implement with one harness, review with another

Use separate harnesses when you want one model to make a change and another to
review it with a fresh perspective. Each step can select its own harness and
model. See [workflow properties](/workflows/properties-panel) for execution
settings and [session management](/workflows/session-management) for how
conversations continue between steps.

```yaml
harness: claude-cli
model: sonnet
steps:
  - name: Implement
    prompt: Add input validation to @src/api/users.ts and update the relevant tests.
  - name: Review
    harness: codex-cli
    model: gpt-6-luna
    prompt: Review the implementation and tests from the previous step. Fix any issues you find.
```

## Parallel research group

Use a parallel group to investigate independent parts of a problem at the same
time, then synthesize the findings in a later step. Group members share one
workspace, so keep their tasks read-only or assign them independent files. See
[parallel steps](/workflows/parallel-steps) for group behavior and limits.

```yaml
harness: claude-cli
model: sonnet
steps:
  - name: Research authentication
    prompt: Trace the authentication flow and summarize its entry points and checks.
  - parallel:
      - name: Research API
        prompt: Identify the API routes related to account recovery and summarize their behavior.
      - name: Research persistence
        harness: codex-cli
        model: gpt-6-luna
        prompt: Find how account recovery data is stored and summarize relevant constraints.
    failFast: true
  - name: Synthesize
    prompt: Combine the earlier findings into a concise account recovery implementation plan.
```

## Run in a managed worktree

Use a managed worktree to isolate a change on its own branch while you keep
working in your regular checkout. The setup command installs dependencies in
the new worktree, and `keep: true` leaves its directory available for review.
See [worktrees](/workflows/worktrees) for lifecycle and merge details.

```yaml
worktree:
  mode: managed
  setup: npm ci
  keep: true
harness: claude-cli
model: sonnet
steps:
  - name: Add validation
    prompt: Add input validation to @src/api/users.ts and update the relevant tests.
  - type: script
    name: Run tests
    script: npm test
```

## Retry while validation passes

Use `onPass: retry` when a passing check means the requested result is not ready
yet. This example strengthens a regression test until it fails for the expected
reason, then continues. See [end conditions](/workflows/end-conditions) for
pass retries, retry prompts, and retry limits.

```yaml
harness: claude-cli
model: sonnet
steps:
  - name: Write regression test
    prompt: Write a regression test for the reported bug. Do not fix the bug.
    endCondition:
      script: npm test
      onPass: retry
      onFail: continue
      maxRetries: 3
      passRetryPrompt: |
        The test suite still passes, so the regression test does not reproduce the bug.
        Strengthen the test until it fails for the expected reason.
```
