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

## Inline definitions

Use an inline prompt or script when the child needs its own run or worktree but
does not need a separate workflow file. The child inherits the parent's
workflow-level settings as an ordinary step of the parent would: harness,
model, execution mode, agent, skills, MCP servers, hooks, secrets, additional
arguments, tool permissions, sandbox and sandbox mode, prior-context detail,
error behavior, and the workflow-level pre- and end conditions. It also gets
the parent's effective variables, including host-provided `--var` values,
substituted once in the child. Values on the inline step take precedence.

Without its own `worktree`, the child runs where the parent runs, including
the parent's worktree. Relative file references in the inline step resolve
from the parent workflow file's folder, and external roots approved for the
parent workflow file apply to the child.

```yaml
vars:
  target: src/core
steps:
  - type: workflow
    name: check core
    workflow:
      type: script
      script: "npm test -- --grep '{{target}}'"
      worktree:
        mode: managed
```

Inline definitions contain exactly one prompt or script step. Only `worktree`
is accepted as a workflow-only key; `vars`, `maxSteps`, `trustedExternalRoots`,
and other workflow defaults come from the parent. The child is materialized at
launch and its run file is self-contained. It starts a new session, so the
parent's `sessionId`, `resumeSession`, and relative `priorContext` selectors are
not inherited; a run-address `priorContext` (`{ workflow, run }`) is.

The child workflow is named after the step's `name`, or else after the parent
and its position, such as `Release · step 3` or `Release · final step pass 2`.

Sub-workflow steps can appear in `steps` or `finalStep`. A file can also consist
of a single workflow step at its root:

```yaml
type: workflow
workflow: workflows/next.ctrlyoke.yaml
```

The root-level form starts a one-step workflow that can be extended with later
steps. Workflow steps can also be members of a `parallel` group; see
[Parallel sub-workflow steps](#parallel-sub-workflow-steps).

## Which workflow settings apply

A file-referenced child is its own workflow. It uses its own harness, variables,
and `finalStep`; these are not inherited from the parent. Host-level `--var`
overrides still apply to the child. The `workflow` path is resolved like a
prompt file reference and is not variable-substituted. A relative path is
resolved using the same workflow and workspace locations as a prompt file path.

## Execution directory and worktrees

The child's own `worktree` setting is honoured:

| Child workflow setting | Where it runs                                                                      | Branches from                    | `merge: true` merges into |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------- | ------------------------- |
| `worktree` omitted     | In the parent's execution root, including the parent's worktree when there is one. | —                                | —                         |
| `worktree: false`      | In the workspace's main checkout.                                                  | —                                | —                         |
| Managed worktree       | In a new managed worktree.                                                         | `base`, else the parent's `HEAD` | The parent's checkout     |
| Named worktree         | In the named worktree, created or reused.                                          | `base`, else the parent's `HEAD` | — (named never merges)    |

A worktree child treats the parent's checkout as its source checkout, as a
top-level run treats the workspace's: its branch starts from the parent's
current commit, its target branch is the parent's branch, and `merge: true`
merges into the parent's checkout. A child of a managed parent therefore
merges into the parent's worktree branch, and the parent's own settlement
carries that work on; a child of a parent in the main checkout merges into
main. The parent waiting on the child does not block that merge, but another
child still working in the same checkout does. The child's run history stays
with the parent's, under the checkout the run was started from. New worktrees
go in the main checkout's worktrees folder (`<main>.worktrees/`, or
`worktrees.root` when set), beside the parent's, never inside it.

Continuing a child run directly, from its own run or with `ctrlyoke continue`,
keeps the checkout its worktree branched from: it reuses its worktree and base,
its target branch is still the parent's, and `merge: true` still merges into the
parent's checkout. If that checkout has since been removed, the continue fails
and names it rather than merging somewhere else.

Before a fresh child with a worktree starts, ctrlyoke checks the parent's
execution checkout. A clean checkout proceeds. Dirty changes in a ctrlyoke
managed worktree are checkpoint-committed with the same deterministic message
used when settling that worktree, so the child starts with those changes. If the
parent is in the main checkout or a named worktree, startup fails with the dirty
file count; commit or stash those changes first. `worktree` omitted or
`worktree: false` does not trigger this check. Reattaching to an existing child
also skips it because its worktree already exists.

## Parallel sub-workflow steps

A `parallel` group can hold workflow steps beside prompt and script steps. Each
workflow member is its own child run, so a member whose child sets `worktree`
works in its own checkout, index and branch, and its siblings never see its
edits. That makes a whole-tree command such as a test suite or `git add -A`
safe inside one lane:

```yaml
steps:
  - parallel:
      - type: workflow
        name: Lint rules
        workflow:
          prompt: Implement the lint rules described in the plan, run the tests, then commit.
          worktree:
            mode: managed
      - type: workflow
        name: Palette
        workflow:
          prompt: Implement the command palette described in the plan, run the tests, then commit.
          worktree:
            mode: managed
    failFast: false
  - name: Integrate
    prompt: Merge the branches reported in $step:summary:1-2, run the tests, and commit.
```

Before the group starts, ctrlyoke resolves and checks every member's child once.
A missing or invalid child file, or a cycle, fails that member alone, and its
`onFail` decides whether the parent continues once the group finishes. A member
that waits for a free slot starts from its child file as it is when the member
starts, so an edit made in the meantime is picked up, as it is for a step that
runs on its own.

A member whose child sets `merge: true` merges into the parent's checkout, so
it cannot share a group with a member that works in that checkout: a prompt or
script member, a workflow member whose child has no `worktree`, or, when the
parent runs in the main checkout, one whose child sets `worktree: false`. The
merge would land while that member is still editing. The group fails before
any member starts and names both members. This applies even when the group
runs one member at a time (`queue.maxParallelSteps: 1`). Give the editing
member its own worktree, or drop `merge` and leave the merge to a step after
the group.
Members whose children all have their own worktrees, with or without
`merge`, can share a group.

When the group runs members side by side, the parent's checkout is checked once
for the whole group, using the
[worktree rule](#execution-directory-and-worktrees) above, so every worktree
member branches from the same commit. If that check refuses a dirty checkout,
only the members whose child creates a worktree fail. When the group runs one
member at a time (`queue.maxParallelSteps: 1`), each worktree member is checked
when it starts instead, because an earlier member may have changed the checkout.

`queue.maxParallelSteps` caps how many children run at once, and each child's
own parallel groups apply their own limit on top. With `failFast: true` (the
default), a failing member stops its running siblings' children. Those siblings
are cancelled, not stopped by you, so the group fails for the failing member's
reason, and that member's `onFail` decides what the parent does, as with prompt
members. Stopping the parent stops every member's child. In the CLI, children
that run beside each other run their steps headless, because only one of them
could use the terminal.

Stopping one member's child directly, from its own run, cancels only that
member. Its siblings keep running, and once they finish the parent stops rather
than moving on without that member's work. Continuing the parent keeps the
members that finished and reconnects the stopped member to its child run, which
re-runs the step its stop interrupted, then continues after the group.

A window reload or a crash while members run leaves the parent stopped inside
the group. Continuing it keeps the members that finished and reconnects each
member that was still running to its child run, in the worktree that child
already has, so no lane starts over in a second worktree. Each reconnected
child re-runs the step the reload interrupted.

Members with `merge: true` that finish close together merge one at a time.
The later one waits up to two minutes for the earlier one's merge, then merges
on top of it: a fast-forward or a merge commit, or `conflict` with the
conflicting files when both changed the same lines. It is reported as
`blocked` only if the earlier merge is still running after that wait, or if
something other than a sibling's merge holds the parent's checkout. To resolve
the lanes together in one place, drop `merge` and leave the merge to a step
after the group, as in the example.

### Agent-queued lanes {#agent-queued-lanes}

An agent can queue lanes too, through the built-in ctrlyoke MCP server's
`append_step`, but only from worktree presets the workflow author declares in
the root `worktreePresets` map. A worktree's `setup` is a script, and agents
never supply scripts, so the author owns every field of a preset; the agent only
names one. A preset is always the managed form, so each lane gets a fresh
branch:

```yaml
worktreePresets:
  lane:
    mode: managed
    merge: true
    setup: npm ci
conditions:
  committed:
    script: git status --porcelain
    compareSource: stdout
    operator: isEmpty
steps:
  - prompt: Split the plan into independent tasks and queue each one as a lane.
    mcpServers:
      - ctrlyoke
```

The agent adds `worktree: { "use": "lane" }` to a step, flat or as a parallel
group member, and ctrlyoke queues it as an inline workflow step whose child
runs in its own worktree, exactly like an authored lane. The preset is copied
into the step when it is queued, so editing the preset later does not change
lanes already queued. `workflow_status` lists the presets under
`metadata.worktreePresets`; an empty list means the workflow declares none, and
then `append_step` refuses `worktree` altogether. See
[MCP tools](/reference/mcp-tools#append-step) for the request shape.

## Outcomes, Stop, and Pause

A completed child completes the parent step. If the child fails or cannot
start, `onFail: stopWorkflow` fails the step and stops the parent; `continue`
records the failure and moves on. A stopped child always stops the parent,
regardless of `onFail`.

Stopping the parent stops its active child, and stopping the child directly
stops the parent; for a member of a `parallel` group, the parent stops once
the group's other members finish (see
[Parallel sub-workflow steps](#parallel-sub-workflow-steps)). Pausing the parent forwards the pause to the child, which
pauses at its next step boundary. The parent stays in its pausing state for as
long as the child is paused, because its current step is the child run.
Resuming the parent resumes the child, which continues its own run. A stop or
pause that arrives while the child is still starting, or still reconnecting to
its saved run, reaches it as soon as it starts; a child paused that early
pauses before its next step. Pausing or
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
stopped, failed, or interrupted children continue from their saved run. A stopped
child runs the step its stop interrupted again, unlike continuing a stopped
workflow on its own, which moves on past that step. Starting an explicit new run
from the parent definition starts a fresh child. Each `finalStep` pass has its own
child run; continuing a pass that was stopped reconnects to that pass's child.

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
