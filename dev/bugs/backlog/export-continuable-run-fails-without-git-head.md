# Exporting a continuable run fails outside a git repository or before the first commit

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/RunBundleExporter.ts` (`getContinuationInfo`, `getRunBundleExportPreview`, `exportRunBundle`)
- **Severity:** medium

## Symptom

ctrlyoke runs workflows in a folder that is not a git repository, and in a
repository that has no commits yet. A completed run from such a folder
exports fine. A run that stopped, paused or errored with pending steps does
not export at all:

```
$ ctrlyoke export --workflow n --out /tmp/b --no-changes
Error: Command failed: git rev-parse HEAD
fatal: not a git repository (or any of the parent directories): .git
```

In a repository with no commits the error is
`fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.`
`--no-changes` does not help. The dashboard's export dialog calls the same
code through `getRunBundleExportPreview` (`WebviewMessageRouter`,
`REQUEST_RUN_EXPORT_INFO`), so it fails for the same runs.

`docs/guide/export-import.md` says a bundle that cannot continue "can still be
imported for viewing". Here the user gets no bundle at all, and a raw git
error instead of an explanation.

## Steps to Reproduce

```sh
R=/tmp/cyexp; rm -rf $R; mkdir -p $R/ws && cd $R/ws      # no git init
export CTRLYOKE_HOME=$R/home
printf 'name: n\nsteps:\n  - type: script\n    script: exit 1\n  - type: script\n    script: echo later\n' > n.ctrlyoke.yaml
ctrlyoke run n.ctrlyoke.yaml --headless      # ✗ error, step 1 still pending
ctrlyoke export --workflow n --out $R/b --no-changes
#   Error: Command failed: git rev-parse HEAD … not a git repository
git init -q
ctrlyoke export --workflow n --out $R/b --no-changes
#   Error: … ambiguous argument 'HEAD' …
```

## Root Cause

`getContinuationInfo` (`RunBundleExporter.ts` around line 190) returns
continuation info for any STOPPED / PAUSED / ERROR run with pending steps.
When the run has no managed worktree it reads the base commit with
`execGit(["rev-parse", "HEAD"], { cwd: executionRoot })` and the branch with
`git branch --show-current`, without catching failure. Both
`exportRunBundle` (around line 414) and `getRunBundleExportPreview` (around
line 253) call it before checking `includeChanges`, so the error escapes
even when no patch is wanted.

## Suggested Fix

When the execution root has no resolvable `HEAD` (not a git repository, or an
unborn branch), treat the run as not continuable: have `getContinuationInfo`
return `undefined` for that case, so export writes a view-only bundle exactly
as it does for a completed run and the preview reports
`continuable: false`. Only swallow the "no HEAD / not a repository" case.
Keep other git failures surfacing as errors. A helper that runs
`git rev-parse --verify --quiet HEAD` and returns `undefined` on a non-zero
exit is enough.

Tell the user why: the CLI export output (and `--json` result, additively) and
the dashboard export dialog should say the bundle is view-only because the
workspace has no git commit to continue from. Check how `ExportRunDialog.tsx`
already words the non-continuable case and reuse it. Add a sentence to
`docs/guide/export-import.md` ("Move a pending run to another machine") saying
continuing elsewhere needs a git repository with at least one commit.

Tests: export of an ERROR run with pending steps from a non-git temp folder
and from an unborn repo succeeds and is not continuable (extend the existing
`RunBundleExporter` tests under `src/test/`), and the preview returns
`continuable: false`. Add a `CHANGELOG.md` **Fixed** entry.
