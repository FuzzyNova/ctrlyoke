Each run keeps a working copy of its workflow at
`run-<timestamp>/workflow.ctrlyoke.json`. ctrlyoke adds the fields on this
page to that copy while the run executes. The dashboard uses them to restore
a run's state, and they help when you debug a run.

These fields are written by ctrlyoke. Do not author them in your own workflow
files. For the fields you write yourself, see the
[workflow schema reference](/reference/workflow-schema).
