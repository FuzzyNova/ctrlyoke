Each run keeps a working copy of its workflow at
`run-<timestamp>/workflow.ctrlyoke.json`. ctrlyoke adds the fields on this
page to that copy while the run executes. The dashboard uses them to restore
a run's state, and they help when you debug a run.

These fields are written by ctrlyoke. Do not author them in your own workflow
files. For the fields you write yourself, see the
[workflow schema reference](/reference/workflow-schema).

### Where run files live

By default, run history lives under
`~/.ctrlyoke/projects/<project>-<hash>/.runs/`. The
[`storage.runHistoryLocation`](/reference/settings#storage-runhistorylocation)
setting can move it to `.ctrlyoke/.runs/` inside the workspace instead. To keep
user-scope run history somewhere other than `~/.ctrlyoke`, set the
`CTRLYOKE_HOME` environment variable. Your user `settings.json` stays in
`~/.ctrlyoke` either way. Each workflow gets its own folder under `.runs/`:

| Path                                     | Contents                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workflow.json`                          | The workflow's history entry: name, favorite flag, latest run, and next run number.                                    |
| `runner.json`                            | Present only while a run executes. It names the run and the process that owns it.                                      |
| `draft/workflow.ctrlyoke.json`           | The workflow definition before its first run.                                                                          |
| `run-<timestamp>/workflow.ctrlyoke.json` | The run's working copy, described on this page.                                                                        |
| `run-<timestamp>/manifest.json`          | Run summary: state, timestamps, step count, and token totals.                                                          |
| `run-<timestamp>/events.jsonl`           | The run's event log, one JSON event per line. AI responses and script output are stored here, not in the working copy. |

ctrlyoke treats a `runner.json` lock as stale, and reclaims it, when its owning
process has exited or its heartbeat has been silent for 30 seconds. Deleting it
by hand is only needed when two synced machines share one run-history folder.
