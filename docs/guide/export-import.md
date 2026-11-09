# Exporting and importing runs

A run bundle lets you share a run or move a pending run to another machine. It
does not synchronize history: importing creates a separate history entry, and
the original run stays where it is.

## Share a run

Use **Export Run…** from a settled run's workflow menu, or run
[`ctrlyoke export`](/cli/ctrlyoke#ctrlyoke-export). The `.ctrlyokerun` bundle
contains the workflow as authored, a step summary, and the recorded timeline.
Referenced attachments are copied into `assets/`; a generated prompt body with
no file of its own is included inline. A run with pending work also includes
its runtime state and, by default, the workspace changes needed to continue.

Paths inside the workspace (including a managed or named worktree) use the
`${workspaceFolder}/…` token. Paths under your home folder use `~/…`. Paths
outside both locations are left as written and appear in the export report.

Export redaction is best effort. It removes declared secret values and values
that match credential rules (`secrets-v1`); the report gives counts by rule
(`byRule`) and by bundle file (`byFile`). This cannot guarantee that every
sensitive value is found. Workspace snapshots can contain file contents and
are off by default; opt in only when you intend to share them. Review the
bundle, redaction report, external paths, changed-file list, and warnings before
attaching it to a bug report or pull request.

For `changes.patch`, redaction applies only to added lines in valid UTF-8 text
hunks. Context, removed lines, patch headers, binary hunks, and text hunks that
are not valid UTF-8 are preserved byte-for-byte so the patch remains applicable.
If added patch content is redacted, the export report and import preview show
the count; those values appear as `[REDACTED]` in the continued checkout.

## Start over or import history

If you want to run a workflow again from its first step, use **Load** on the
workflow. Load puts the workflow definition in the editor; it does not import
the old run or its timeline.

To keep a run in this workspace's history, use **Import Run…** in the
dashboard or [`ctrlyoke import`](/cli/ctrlyoke#ctrlyoke-import). Import adds a
separate, viewable run. It does not start any steps unless you choose **Import
and Continue** (or pass `--continue`). The preview shows the bundle origin,
pending steps, session availability, and any blockers before import.

## Move a pending run to another machine

Export a stopped, paused, or errored run that still has pending work. Before
continuing elsewhere, the workspace needs to be a Git repository with at least
one commit. Make the exported base commit reachable in that
workspace: push it from the source machine and fetch it on the destination.
The import preview checks whether the commit is available. If it is missing,
the run can still be imported for viewing, but it cannot continue until the
base is available.

A run stopped mid-step moves the same way it continues locally. The step that
was running stays cancelled and continuing starts at the next step. Any edits
the cancelled step made before it stopped are in the exported changes. To run
that step again, rerun it after importing. This also applies to a run whose
VS Code window or CLI process exited while a step was running.

For a continuable bundle, choose where its patch should go:

- **Worktree** creates a managed worktree at the exported base commit. This is
  the default for runs that already used a managed worktree.
- **Checkout** applies the patch to the current checkout. The checkout must be
  clean and at the exported base commit.
- **Skip** leaves the patch unapplied and compares the current tree with it.
  Use this when you have applied or synced the changes yourself.

Choose **Import** to add the run to history without starting it, or **Import
and Continue** to import and resume its pending work. A history-only bundle,
missing base commit, or patch that cannot be applied remains view-only. Continue
reports the reason for a view-only import. After fixing the issue, import the
bundle again; a continuable import whose changes were placed, or explicitly
skipped after syncing, can be continued later from the dashboard.

### Resuming an earlier conversation

Harness conversations are stored by each harness and usually do not move with
the bundle. If a pending step tries to resume a conversation that is not on the
new machine, ctrlyoke warns and starts a fresh session. The import preview
lists the earlier executed steps that shared the missing session. You can
accept the fresh session, or add that context explicitly before continuing.

For example, if the preview lists steps 1, 3, and 7, set the pending step's
`priorContext` to `[1, 3, 7]`, or add `$step:1,3,7` to its prompt. You can also
remove its `sessionId` or set `resumeSession: false`. **Reply to Step** sets
`priorContext` to an explicit None, so change that value; adding steps to it
alone will not add context.

## After import

The dashboard marks an imported run with an origin badge. Steps from the
imported timeline are read-only, including undo: their file changes happened
before this import and cannot be undone from the imported copy. Steps executed
after import are part of the new local run and work normally, including undo.

Import is a one-time copy into history, not a sync. Later changes to either
copy do not update the other, and exporting does not change the original run.
