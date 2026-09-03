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
| `trustedExternalRoots` | Workflow-scoped external directory access    |

## Workflow-scoped external roots

Use `trustedExternalRoots` when a workflow needs an explicit external-root
policy:

```yaml
trustedExternalRoots:
  - C:/Users/me/.codex/sessions
```

The field has three states:

- Omit it to inherit the approved user- and workspace-scope roots.
- Set an array to replace that inherited set with exactly those roots.
- Set it to `null` to disable external-root access for this workflow.

Declaring a root is only a request; it is not an approval. Each newly requested
root requires a separate, per-machine approval associated with the workspace
and workflow file. This prevents a shared or committed workflow from silently
gaining access to a newly declared directory: `ctrlyoke run` fails closed until
the user approves the request in the dashboard or with
`ctrlyoke trust-workflow-external-roots <file>`. The approval decision is stored
locally and is not committed with the workflow.

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
