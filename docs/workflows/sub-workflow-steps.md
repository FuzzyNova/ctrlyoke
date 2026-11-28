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

The rule applies at every level, so a worktree child can fan out itself. With a
parent in the main checkout, a managed child with `merge: true` whose own
`parallel` group runs lanes with `merge: true` has each lane branch from the
child's worktree and merge into it. Once the child's steps finish, it merges
the combined work into the main checkout. All three worktrees sit side by side
in `<main>.worktrees/`.

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

A member whose child sets a named worktree (`worktree: lane/docs` or
`{ mode: named, branch: lane/docs }`) works in that worktree, creating it from
its `base`, else the parent's `HEAD`, or reusing it when it already exists. A
named worktree never merges, and ctrlyoke never commits to it: the child's own
steps commit, and the branch stays for a later step to use. Only one run can
hold a named worktree at a time, so two members whose children name the same
branch cannot share a group. `refs/heads/lane/docs` and `lane/docs` are the
same branch. The group fails before any member starts and names both members;
give each member its own branch, or move one of them out of the group. A branch
built from a `{{variable}}` is only known once the child starts, so a clash
between those fails the later member at its start instead. A child that names
the named worktree its own parent runs in fails to start, under its `onFail`.

Members whose children have no `worktree` share the parent's checkout the way
prompt and script members do, including the parent's own worktree. Several of
them can run side by side in a managed or named parent's worktree, and they see
each other's edits there. A `merge: true` member still cannot join them, for
the reason above.

When the group runs members side by side, the parent's checkout is checked once
for the whole group, using the
[worktree rule](#execution-directory-and-worktrees) above, so every worktree
member branches from the same commit. If that check refuses a dirty checkout,
only the members whose child creates a worktree fail. When the group runs one
member at a time (`queue.maxParallelSteps: 1`), each worktree member is checked
when it starts instead, because an earlier member may have changed the checkout.

### Authored waves {#authored-waves}

A long change can be run as waves: a group of lanes that each work in their
own worktree, a step that merges their branches and fixes what breaks, then the
next group, which starts from that merged result. Each lane is a workflow file
of its own, with `worktree: { mode: managed }` and whatever steps it needs:

```yaml
name: editor-intelligence
worktree: false
steps:
  - parallel:
      - { type: workflow, workflow: waves/location.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/lint-rules.ctrlyoke.yaml }
    failFast: false
  - name: Merge wave 1 and fix
    prompt: |
      Merge every branch reported in $step:summary:1-2 into the current branch,
      resolve conflicts, run the tests, fix failures, and commit the result.
  - parallel:
      - { type: workflow, workflow: waves/completions.ctrlyoke.yaml }
      - { type: workflow, workflow: waves/diagnostics.ctrlyoke.yaml }
    failFast: false
```

Both lanes of a wave branch from the same commit. A lane without `merge` keeps
its branch when it settles, and the step's output reports it, so
`$step:summary:1-2` gives the merge step every lane's branch at a bounded size.
`failFast: false` keeps one failing lane from cancelling the others' work.

The next wave branches from the parent's `HEAD` when it starts, so the merge
step must commit. If it leaves the main checkout dirty, every worktree member
of the next wave fails to start under its `onFail`, with the number of dirty
files, before any of them runs. In a managed parent the leftover changes are
checkpoint-committed instead, as described
[above](#execution-directory-and-worktrees).

A script merge step cannot read `$step:summary`. Give the lanes named
worktrees instead, so the script knows each branch in advance, or read each
lane's branch from the `subWorkflowSettled` events in the run's
`events.jsonl`, which sits beside the file named by `CTRLYOKE_WORKING_FILE`.
To have each lane merge as it settles instead, set `merge: true` in its file;
a conflict is then reported in its step output for the merge step to resolve.

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

Lanes that finish close together settle one at a time: each lane in turn
commits its work, merges it when its child sets `merge: true`, and removes
its worktree. A lane with `merge: true` waits up to two minutes for its
siblings' settlements and merges, then merges on top of them: a fast-forward
or a merge commit, or `conflict` with the conflicting files when both changed
the same lines. It is reported as `blocked` only if its siblings are still
settling after that wait, or if something other than a sibling's merge holds
the parent's checkout. Stopping the run while a lane waits ends the wait at
once: the lane's merge is reported as `blocked`, and its branch is kept with
its work on it. To resolve the lanes together in one place, drop
`merge` and leave the merge to a step after the group, as in the example.

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

The built-in [Spec-Driven Loop](/workflows/templates) template declares a
`lane` preset like the one above, with its `laneSetup` template variable as
`setup`, and its orchestrator agent queues parallel work as lanes whenever the
workflow declares a preset. It follows each group of lanes with a sequential
step that merges any lane that did not merge cleanly and runs the tests on the
combined result.

A lane should carry an end condition that checks its work was committed, such
as the `committed` preset above. When the workflow declares condition presets,
`append_step` warns about each lane queued without one, flat or in a parallel
group. Plain parallel members are not warned about, because they share the
parent's checkout and a clean-tree check would fail on their siblings' edits.

While a lane is pending, the agent can change it with `edit_step`: edit its
prompt and other prompt-step fields, switch it to another preset, or clear
`worktree` to turn it back into an ordinary prompt step. Setting `worktree` on
a pending prompt step makes it a lane. Any pending workflow step with exactly a
lane's shape (an inline prompt step with a managed worktree and no `onFail`)
counts as a lane, whoever wrote it; other workflow steps cannot be edited
through MCP. `workflow_status` lists a lane as a workflow step with
its child run, the child's live state and branch while it runs, and its merge
result once it settles.

A lane with `merge: true` follows the
[merge rule](#parallel-sub-workflow-steps) when it joins a running step
through `append_step`'s `parallelWithCurrent`: it is refused beside a running or
pending prompt or script step, or beside a workflow step whose child has no
worktree, because that member is editing the checkout the lane would merge
into. A lane without `merge`, or one joining a group of lanes, is admitted.
`edit_step` follows the same rule for a pending member of the running group:
switching it to a merging preset, wrapping it into a merging lane, or turning
it back into a prompt step beside a merging lane is refused the same way.

## Queuing a workflow file as a sub-workflow

In VS Code, right-click a workflow file in the Explorer or on its editor tab,
or use the **Run with ctrlyoke** menu in the editor title bar, and choose
**Queue as Sub-workflow with ctrlyoke**. Like **Queue Steps with ctrlyoke**,
it appears once the active queue has at least one step.
This adds one workflow step that runs the file as a child run, instead of
copying the file's steps into the workflow the way **Queue Steps with
ctrlyoke** does. The child keeps its own settings, history and `worktree`.

The step goes onto the workflow the dashboard panel is showing:

- If that workflow is running, pausing or paused, the step is added to the end
  of its queue and runs after the steps already queued.
- If it is a run that has finished, stopped or failed, the step is added and
  the run continues with it.
- Otherwise it is added to the queue like any other step.

In the dashboard, the same action is in three places. Each one puts the step on
the workflow you are viewing. The workspace viewer uses the file you
right-clicked; the other two ask for the file, through VS Code's file picker in
the panel or a workspace file list in the browser dashboard:

- **New → Queue as Sub-workflow…**, while a workflow is open. While you view
  a run it reads **Append and Continue as Sub-workflow…**.
- In the workspace viewer, right-click a workflow file and choose **Queue as
  Sub-workflow** (**Append and Continue as Sub-workflow** while you view a
  run).
- In the workflow dropdown, right-click the run you are viewing and choose
  **Queue Workflow to Run Next…** while it runs, pauses or once it has
  finished. The item is offered only on that run's row, so open a run before
  queuing onto it. It is unavailable for a run that another process (the CLI,
  or another window) is executing.

To run a file beside the step that is running now instead of after it, choose
**Run Workflow Alongside Current Step…** from the same right-click menu while
the run is running a step. The step joins the parallel group that is running, or
turns the running step into a new group with `failFast: false`, and follows
the [parallel sub-workflow rules](#parallel-sub-workflow-steps): a child that
sets `merge: true` is refused beside a member that edits the run's checkout,
and a child naming a named worktree already in use fails when it starts. A
member that fails like that, or that cannot join for any other reason found
when it starts, fails alone under its `onFail` and never cancels the members
already running, even with `failFast: true`. It is unavailable while the run is
in its final step, or when `queue.maxParallelSteps` is 1.

The step's `workflow` path is relative to the workspace when the file is
inside it (in a multi-root workspace, prefixed with the folder name when the
file is outside the first folder), and absolute otherwise. A file outside the
workspace must be in a trusted external root (`permissions.trustedExternalRoots`),
as the step needs one to start. ctrlyoke reads the file when you queue it, so a
file that does not parse, or that the step could not start from, is refused
right away instead of failing when the step starts. Queued onto a run that
executes in a worktree, the file is looked up from that worktree, as the step
will be, so a file that so far exists only on the run's branch can be queued;
it is written relative to the workspace, like any other file in it.

## In the step editor

Choose **Workflow** in the step editor's **Prompt** / **Script** / **Workflow**
switch to write a sub-workflow step, or click a workflow step in the steps
panel to edit it. The editor shows:

- **Workflow file**: the path the step runs. Type it (backslashes become
  forward slashes), or use **Browse…** to pick it: VS Code opens its file
  picker, and the browser dashboard lists the workspace's workflow files.
  Either way a picked file is written the way **Queue as Sub-workflow** writes
  it: relative to the workspace when it is inside it, else absolute. A file
  the step could not start from, such as one outside the workspace and its
  trusted external roots, is refused with the message the step would fail
  with. A pick that finishes after you have moved to another step is
  ignored.
- **On Fail**: **Stop Workflow** (the default) or **Continue**, as `onFail`
  above.
- The step colour, when step colours are on. The step's name and its enable
  toggle are in the editor header, as for every step.

**Run**, **Queue** and **Update** save the step as
`{ type: workflow, workflow: <path> }` plus the fields you set. A field you
set back to its default is removed from the step. The editor does not check
the file when you save; a file that is missing or does not parse fails the
step when it starts, under its `onFail`.

A step whose `workflow` is an [inline definition](#inline-definitions) opens
read-only in the editor, with a note. Edit the workflow file to change it.
**Move to Editor** is unavailable for such a step, and, as with a script
draft, while the new-step editor holds an unsaved workflow file path.

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
child outcome and any worktree branch, merge result and conflicting files.

An inline step is titled by its `name`, or else by its prompt or script, with
the prompt or script below a name. An inline prompt shows the harness and model
it inherits, as an ordinary step in its place would, and is coloured by that
harness in the steps list, the chip rail and the output. While its child runs,
the harness and model are marked **(expected)**, because they come from the
current settings. Once the child settles, the row shows the harness and model
the child actually ran with, unmarked, and is coloured by that harness. A
child that never started a prompt step keeps the expected values. A child
that is continued shows the expected values again until it settles once more.
A lane, an inline step with its own `worktree`, also has a worktree badge,
which names the branch: a named worktree's from the definition, a managed
one's once the child creates it. On a narrow row, such as a lane inside a
`parallel` group, the worktree badge shrinks to its icon and the Workflow badge
folds into the step's workflow icon, so the title keeps most of the row; hover
the badge for the branch and the icon for the step kind. A lane
that completes but whose
`merge: true` ends `conflict` or `blocked` keeps its completed status and gets a
**Merge conflict** or **Merge blocked** badge; hover it for the reason and any
conflicting files. A clean merge adds no badge. In a parallel group's output,
each lane's chip filters its outcome block like any member's output. The child's run row and
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
