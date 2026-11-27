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
run. Before a fresh child with a worktree starts, ctrlyoke checks the parent's
execution checkout. A clean checkout proceeds. Dirty changes in a ctrlyoke
managed worktree are checkpoint-committed with the same deterministic message
used when settling that worktree, so the child starts with those changes. If the
parent is in the main checkout or a named worktree, startup fails with the dirty
file count; commit or stash those changes first. `worktree` omitted or
`worktree: false` does not trigger this check. Reattaching to an existing child
also skips it because its worktree already exists.

## Outcomes, Stop, and Pause

A completed child completes the parent step. If the child fails or cannot
start, `onFail: stopWorkflow` fails the step and stops the parent; `continue`
records the failure and moves on. A stopped child always stops the parent,
regardless of `onFail`.

Stopping the parent stops its active child, and stopping the child directly
stops the parent. Pausing the parent forwards the pause to the child, which
pauses at its next step boundary. The parent stays in its pausing state for as
long as the child is paused, because its current step is the child run.
Resuming the parent resumes the child, which continues its own run. Pausing or
resuming a child directly does not pause or resume the parent.

## In the dashboard

Workflow steps appear with a Workflow badge, the referenced workflow file, and a
live child state when that child is tracked. Once the child run is created, use
**Open run →** to view its own output and history. The parent's output shows the
child outcome and any worktree branch and merge result. The child's run row and
header identify the parent run; the link is unavailable when that parent is not
present in the current project.

If a child tries to launch a workflow already active earlier in the same chain,
the step fails with a cycle path. Reusing a workflow after an earlier child has
finished is allowed.

When a parent run resumes a step that already started a child, ctrlyoke reconnects
to that child run. Completed children settle the parent step without running again;
stopped, failed, or interrupted children continue from their saved run. Starting
an explicit new run from the parent definition starts a fresh child. Each
`finalStep` pass has its own child run.

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

## Inspecting a child run from an agent

When a step needs more detail than prior context includes, call MCP
`read_output` with the child's `workflowKey` and `runRef` from the workflow
step's `childRun` metadata. `workflow_status` accepts the same `run` object to list the
child's steps first. Both tools accept this attached run itself and runs started by
this workflow's sub-workflow steps, including descendants at any depth; `indices`, `cursor`,
`limit`, and `tail` work as usual.

```json
{
  "run": { "workflowKey": "<childWorkflowKey>", "runRef": "<childRunRef>" },
  "indices": [1],
  "tail": 4000
}
```

From a shell, use the main checkout as the CLI directory, especially when the
step runs in a managed worktree:

```sh
ctrlyoke history show --workflow <childWorkflowKey> --run <childRunRef> -d <main checkout>
```
