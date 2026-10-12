# YAML format

YAML is the most readable way to author multi-step workflows by hand.

The YAML schema flags unknown keys as editor squiggles when the Red Hat YAML
extension is version 1.20 or newer. Older versions still provide ordinary YAML
and type checking, but do not recognize the schema's unknown-key closures.

## Example

```yaml
harness: copilot-cli
model: claude-sonnet-4.6

steps:
  - name: inspect
    prompt: |
      Inspect @src/core/ and identify the biggest reliability risk.

  - name: verify-workspace
    type: script
    script: npm test
    compareSource: exitCode
    expected: 0
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

| Field                  | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `harness`              | Select the harness                                                    |
| `model`                | Override the harness model                                            |
| `steps`                | Ordered list of work to run                                           |
| `finalStep`            | Prompt or script that runs after the queue                            |
| `vars`                 | Workflow-level variables for <code v-pre>{{name}}</code> substitution |
| `trustedExternalRoots` | Workflow-scoped external directory access                             |

## Workflow-scoped external roots {#workflow-scoped-external-roots}

`trustedExternalRoots` lists the folders outside the workspace this workflow
may use. Each new root needs a one-time approval on your machine before it
takes effect.

```yaml
trustedExternalRoots:
  - C:/Users/me/.codex/sessions
```

See [Trusted external folders](/workflows/permissions#trusted-external-roots).

## Prompt step fields you will use first

| Field           | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `name`          | Human-readable label in the dashboard                          |
| `prompt`        | Inline prompt text or a path to `.prompt.md`, `.md`, or `.txt` |
| `resumeSession` | Continue the previous compatible session                       |
| `sessionId`     | Resume a step's session (`1`), an exact ID, or `finalStep`     |
| `endCondition`  | Validate after the step completes                              |
| `preCondition`  | Gate before the step runs                                      |

A `prompt` value is read as a file path only when the whole value is a path that
starts with `./`, `../`, or an absolute path, or in a multi-root workspace a
path that starts with a workspace folder name (for example
`prompt: ./prompts/review.prompt.md`). The file is looked up next to the
workflow file first, then in the workspace root, then in `.ctrlyoke/`. Anything
else, including `prompts/review.prompt.md` without the `./`, is sent as inline
prompt text.

## Script steps {#script-steps}

Set `type: script` to run a shell command or script file as a step, with no AI
involved:

```yaml
steps:
  - name: lint
    type: script
    script: npm run lint
    onFail: stopWorkflow
```

See [Script steps and condition scripts](/workflows/script-steps).

## Parallel steps {#parallel-steps}

A `parallel` queue item runs a flat group of prompt or script steps concurrently
before the next queue item starts:

```yaml
steps:
  - parallel:
      - prompt: Research the authentication flow.
      - prompt: Research the data model.
```

See [Parallel steps](/workflows/parallel-steps).
