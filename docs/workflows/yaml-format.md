# YAML format

YAML is the most readable way to author multi-step workflows by hand.

## Example

```yaml
harness: copilot-cli
model: claude-sonnet-4.5

steps:
  - name: inspect
    prompt: |
      Inspect @src/ctrlyoke/ and identify the biggest reliability risk.

  - name: verify-workspace
    type: script
    script: npm test
    compareSource: exitCode
    returns: "0"
    onFail: stopWorkflow

  - name: implement
    resumeSession: true
    prompt: |
      Fix the issue you identified and update any directly related docs.

finalStep:
  prompt: |
    Review the completed work for obvious edge cases.
```

## Root-level fields you will use first

| Field       | Purpose                                              |
| ----------- | ---------------------------------------------------- |
| `harness`   | Select the harness                                   |
| `model`     | Override the harness model                           |
| `steps`     | Ordered list of work to run                          |
| `finalStep` | Prompt or script that runs after the queue           |
| `vars`      | Workflow-level variables for `{{name}}` substitution |

## Prompt step fields you will use first

| Field           | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `name`          | Human-readable label in the dashboard                          |
| `prompt`        | Inline prompt text or a path to `.prompt.md`, `.md`, or `.txt` |
| `resumeSession` | Continue the previous compatible session                       |
| `sessionId`     | Resume a specific prior step or exact session                  |
| `endCondition`  | Validate after the step completes                              |
| `preCondition`  | Gate before the step runs                                      |

## Script steps

Set `type: script` to run shell logic directly in the workflow:

```yaml
steps:
  - name: lint
    type: script
    script: npm run lint
    compareSource: exitCode
    returns: "0"
    onPass: continue
    onFail: stopWorkflow
```
