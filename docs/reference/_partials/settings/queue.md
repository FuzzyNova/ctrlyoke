`queue.maxParallelSteps` caps how many members of a
[parallel group](/reference/workflow-schema#parallel-group) run at once. If a
group has more members than the cap, the extra members wait for a free slot.
Set it to `1` to run grouped steps one at a time. Members share the workflow's
workspace and its worktree. This setting limits how many run at once. It does
not isolate members from each other or merge their work.
