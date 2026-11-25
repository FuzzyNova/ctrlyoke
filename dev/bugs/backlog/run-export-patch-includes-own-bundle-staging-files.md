# Exporting a run into the workspace puts the bundle's own files into `changes.patch`

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/`)
- **Area:** `src/core/orchestration/RunBundleExporter.ts` (`collectWorkspaceChanges` ~283-314, staging ~436-442), `src/cli/RunExportCommand.ts`
- **Severity:** medium

## Symptom

`ctrlyoke export --workflow release --out release-run` (the example in
`docs/cli/ctrlyoke.md`, ~893) resolves `--out` against the cwd, which is normally the
workspace root. The bundle's staging directory therefore lands inside the workspace. The
staging files then end up in the bundle's own `changes.patch`:

- `changedFiles` and the `diff --git` headers list
  `.release-run.ctrlyokerun.staging-<uuid>/events.jsonl`, `manifest.json`,
  `run.ctrlyoke.json` and `workflow.ctrlyoke.json` alongside the real change.
- A `--force` re-export also picks up the previous bundle directory.
- `ctrlyoke import --changes checkout|worktree` then creates a stray
  `.release-run.ctrlyokerun.staging-*` directory in the destination checkout. That
  leaves it dirty and copies the source run's history into the user's tree.

## Steps to Reproduce

1. In a Git repository, finish (or stop) a run that modified a tracked file, e.g. `base.txt`.
2. From the workspace root: `ctrlyoke export --workflow <key> --out release-run`.
3. Inspect `release-run.ctrlyokerun/changes.patch` and the manifest's changed files.
   They contain the staging directory's files in addition to `base.txt`. Expected: only
   `base.txt`.

## Root Cause

The exporter creates `stagingDir` next to the final bundle (`path.dirname(bundleDir)`,
~438-442). It writes `events.jsonl`, the manifest, the definition, `assets/` and
`run.ctrlyoke.json` into it, and only then calls `writeChangesPatch`. That runs
`collectWorkspaceChanges`, which does `git add -A` over the whole execution root
with a temporary index (~293). Untracked staging files inside the workspace are
added to the diff.

## Suggested Fix

Exclude the export's own output from the patch. Either collect the patch before
anything is staged (keep it in a temp file under `os.tmpdir()`, then move it in), or add
`:(exclude)` pathspecs for the staging directory and the final `bundleDir` (including
a `--force` predecessor) to `git add -A` whenever they lie inside the execution root.
Add a unit test that exports into the workspace and asserts `changes.patch` and the
changed-file list contain only the real change.
