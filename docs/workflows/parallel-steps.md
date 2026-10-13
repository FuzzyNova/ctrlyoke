# Parallel steps

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

## Step numbers and joining

The members are flattened into the normal step numbers, so the example has steps
1-5 and the synthesis step can refer to members 2, 3, and 4. The next queue item
starts only after the group join has settled every enabled member.

## Failures and width

`failFast: true` (the default) cancels other in-flight members after a terminal
failure; `false` allows independent members to finish. `queue.maxParallelSteps`
sets the global width for every group, and setting it to `1` deliberately makes a
group sequential.

## Shared workspace

Group members are intended for independent work. They share the workflow's one
workspace and one run timeline; there is no per-member workspace isolation or
automatic merge. A run using a managed or named worktree likewise gives the
whole group that one worktree. Do not put conflicting edits in the same group.
Terminal controller arbitration is per workflow, not per session, so multiple
member terminals still belong to the same workflow controller scope.

## Rules

A group needs at least two members. Before the group starts, ctrlyoke checks
that the members resolve to distinct harness sessions: two members that would
resume the same session are rejected. A numeric `priorContext` or `sessionId` in
a member cannot point at another member of the same group. If the host cannot run
several interactive terminals at once, it also rejects multiple interactive
members. In that case, set `executionMode: headless` on those members.

Groups cannot be nested, cannot contain a `worktree` or
`trustedExternalRoots` override, and cannot be used as `finalStep`.

## Changing the queue from a member

Members may enable the built-in `ctrlyoke` MCP server that makes a workflow dynamic. A member can
edit, remove, or append steps that have not started yet, but a step that has
already started cannot be changed. A member can also join the running group, and
it can only read output from steps that finished before the group started. See
[Dynamic workflows: parallel groups](/workflows/dynamic-workflows#parallel-groups) for
the details.

## See also

- [Parallel group reference](/reference/workflow-schema#parallel-group)
- [Core concepts: parallel groups](/guide/concepts#parallel-groups)
