# Your first workflow

This example shows the pattern most teams end up using first: analyze, implement, validate, then review.

## Example

```yaml
harness: claude-cli
model: sonnet

steps:
  - name: analyze
    prompt: |
      Inspect @src/ and identify the highest-risk
      maintainability issue in this code.

  - name: implement
    resumeSession: true
    prompt: |
      Fix the issue you identified. Keep the change focused and update
      any directly related tests or docs.
    endCondition:
      script: npm test
      compareSource: exitCode
      expected: 0
      maxRetries: 2
      retryPrompt: |
        The validation step failed.
        stdout:
        $endCondition:stdout

        stderr:
        $endCondition:stderr

        Fix the remaining issues and try again.

finalStep:
  name: review
  prompt: |
    Review the completed change for edge cases, missing docs,
    and obvious follow-up tasks.
```

## Why this structure works

- `analyze` creates the plan inside the harness conversation
- `implement` continues that same conversation with `resumeSession: true`
- the end condition stops the workflow from moving on unless the project state passes
- `finalStep` gives you one last pass without mixing the review prompt into the main queue

## Tips

1. Start with two or three steps, not ten.
2. Add validation before you add complexity.
3. Keep the harness fixed while you learn a workflow pattern.
4. Use `name` on important steps so the dashboard is easier to scan.

## After the first run

Open the run's working file, `workflow.ctrlyoke.json`, if you want to inspect persisted runtime
metadata such as the resolved harness, model, session ID, and timestamps. Each run gets its own
`.runs/<workflowKey>/run-<timestamp>/` folder. By default `.runs/` lives under
`~/.ctrlyoke/projects/<slug>-<hash12>/`; with `storage.runHistoryLocation: "workspace"` it lives
at `.ctrlyoke/.runs/` in the workspace. See [Run files](/reference/run-files) for the full layout.
