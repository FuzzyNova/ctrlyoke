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

## Script steps

Set `type: script` to run shell logic directly in the workflow:

```yaml
steps:
  - name: lint
    type: script
    script: npm run lint
    compareSource: exitCode
    expected: 0
    onPass: continue
    onFail: stopWorkflow
```

## Parallel steps

Use a `parallel` queue item for a flat group of prompt or script steps that may run
concurrently before the following queue item starts:

```yaml
steps:
  - name: setup
    prompt: Read the repository and identify the relevant areas.

  - parallel:
      - name: research-auth
        prompt: Research the authentication flow.
      - name: research-data
        prompt: Research the data model and persistence layer.
      - name: research-performance
        prompt: Identify likely performance bottlenecks.
    failFast: true

  - name: synthesize
    priorContext: [2, 3, 4]
    prompt: Synthesize the independent research into one implementation plan.
```

The members are flattened into the normal step numbers, so the example has steps
1-5 and the synthesis step can refer to members 2, 3, and 4. The next queue item
starts only after the group join has settled every enabled member. `failFast: true`
(the default) cancels other in-flight members after a terminal failure; `false`
allows independent members to finish. `queue.maxParallelSteps` sets the global
width for every group, and setting it to `1` deliberately makes a group
sequential.

Group members are intended for independent work. They share the workflow's one
workspace and one run timeline; there is no per-member workspace isolation or
automatic merge in v1. A run using a managed or named worktree likewise gives the
whole group that one worktree. Do not put conflicting edits in the same group.
Terminal controller arbitration is per workflow, not per session, so multiple
member terminals still belong to the same workflow controller scope.

A group needs at least two members. Before the group starts, ctrlyoke checks
that the members resolve to distinct harness sessions: two members that would
resume the same session are rejected. If the host cannot run several
interactive terminals at once, it also rejects multiple interactive members. In
that case, set `executionMode: headless` on those members.

Groups cannot be nested, cannot contain a `worktree` or
`trustedExternalRoots` override, and cannot be used as `finalStep`. Members may
enable the built-in `ctrlyoke` dynamic-queue MCP server. A member can edit,
remove, or append steps that have not started yet, but a step that has already
started cannot be changed.
