# Sub-workflow steps

A sub-workflow step runs another workflow file as a child run and waits for it to
finish. The child has its own run history and workflow settings, while the parent
continues with the next step after the child completes.

```yaml
steps:
  - name: implement
    prompt: Implement the change and run the focused tests.

  - type: workflow
    name: verify
    workflow: workflows/verify.ctrlyoke.yaml
    enabled: true
    color: "#6b8e23"
    onFail: continue

  - name: summarize
    prompt: |
      Summarize the verification output:
      $previous:summary
```

## Fields

| Field      | Purpose                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `type`     | Set to `workflow`.                                                                                           |
| `workflow` | Path to the workflow file to run.                                                                            |
| `name`     | Optional label shown for this step.                                                                          |
| `enabled`  | Set to `false` to skip this step; defaults to enabled.                                                       |
| `color`    | Optional step color.                                                                                         |
| `onFail`   | `stopWorkflow` (default) stops the parent when the child fails; `continue` records the failure and advances. |

Sub-workflow steps can appear in `steps` or `finalStep`. A file can also consist
of a single workflow step at its root:

```yaml
type: workflow
workflow: workflows/next.ctrlyoke.yaml
```

The root-level form starts a one-step workflow that can be extended with later
steps. Workflow steps are not currently accepted inside `parallel` groups.

## Which workflow settings apply

A file-referenced child is its own workflow. It uses its own harness, variables,
and `finalStep`; these are not inherited from the parent. Host-level `--var`
overrides still apply to the child. The `workflow` path is resolved like a
prompt file reference and is not variable-substituted. A relative path is
resolved using the same workflow and workspace locations as a prompt file path.

## Execution directory and worktrees

The child's own `worktree` setting is honoured:

| Child workflow setting    | Where it runs                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `worktree` omitted        | In the parent's execution root, including the parent's worktree when there is one. |
| `worktree: false`         | In the workspace's main checkout.                                                  |
| Managed or named worktree | Uses the worktree configuration in the child workflow.                             |

A managed worktree child follows the same base and merge rules as a top-level
run. It does not branch from or merge into the parent's worktree. When starting
a worktree child, ctrlyoke does not check whether the parent's checkout has
uncommitted changes; those changes are not included in a newly created
worktree.

## Outcomes, Stop, and Pause

A completed child completes the parent step. If the child fails or cannot
start, `onFail: stopWorkflow` fails the step and stops the parent; `continue`
records the failure and moves on. A stopped child always stops the parent,
regardless of `onFail`.

Stopping the parent stops its active child, and stopping the child directly
stops the parent. Pausing the parent forwards the pause to the child. The parent
remains in its pausing state until the child reaches its next step boundary and
finishes. Pausing or resuming a child directly does not pause or resume the
parent.

If a child tries to launch a workflow already active earlier in the same chain,
the step fails with a cycle path. Reusing a workflow after an earlier child has
finished is allowed.

## Using child output in later steps

`$previous` and `$step:N` include the workflow step's metadata and the full
output of each child step, including nested child output. Use `:summary` to
bound the output while retaining the child metadata and recent step summaries:

```yaml
steps:
  - type: workflow
    name: checks
    workflow: workflows/checks.ctrlyoke.yaml

  - prompt: |
      Review the child run results:
      $step:summary:1
```

The `:summary` form shares the existing summary budget with other summarized
prior context.
