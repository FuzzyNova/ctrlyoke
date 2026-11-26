# Run bundle export writes an unappliable `changes.patch` under common user git diff settings

- **Found:** 2026-11-25 by bug-hunt workflow final step (reproduced with plain git 2.56.1)
- **Area:** `src/core/orchestration/RunBundleExporter.ts` (`collectWorkspaceChanges`, ~283-329)
- **Resolution:** fixed in this commit

## Symptom

Exporting a run bundle (`ctrlyoke export` or the dashboard export action) builds
`changes.patch` with porcelain `git diff --cached --binary --full-index <base>`.
Porcelain `git diff` follows the user's git config, so any of these settings
produce a patch the import side (`RunChangesPlacer`, `git apply`) cannot use, or
make the export itself fail:

| User config                                | Effect on `changes.patch`                                           | `git apply --check`                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `color.ui=always` (or `color.diff=always`) | ANSI escapes on every line                                          | `error: No valid patches in input`                                                      |
| `diff.noprefix=true`                       | `--- f` / `+++ f` without `a/` `b/`                                 | `git diff header lacks filename information when removing 1 leading pathname component` |
| `diff.external=<tool>`                     | external tool output (or export fails: `fatal: external diff died`) | `No valid patches in input`                                                             |

`diff.mnemonicPrefix=true` also swaps the prefixes to `i/`/`w/`, and a
`textconv` driver can replace binary/text content with its converted form.

The bundle carries the broken patch silently, and the failure only shows up on
the importing machine.

## Steps to Reproduce

1. In a scratch repo: commit `f` = `a`, change it to `b`, `git add f`.
2. `git -c color.ui=always diff --cached --binary --full-index HEAD > p.patch`
   (the exact args `collectWorkspaceChanges` uses, with the config a user may
   have globally).
3. Clone the repo before the change and run `git apply --check p.patch`.
4. **Actual:** `error: No valid patches in input`. Repeat with
   `-c diff.noprefix=true` and `-c diff.external=false` for the other rows.

**Expected:** `changes.patch` is a plain git patch with `a/`/`b/` prefixes no
matter what diff settings the exporting user has.

## Root Cause

`RunBundleExporter.ts` ~311-318 calls
`execGitBuffer(["diff", "--cached", "--binary", "--full-index", baseCommit], …)`
with no options that pin the output format. Unlike `GitUtils`'s diff helpers it
does not even pass `GIT_DIFF_NO_EXT_DIFF_OPTION`
(`src/utils/GitUtils.ts:18`). The same gap for attachment diffs was fixed in
`dev/bugs/implemented/git-diff-attachments-run-external-diff-tool.md`, but this
call was not covered.

## Suggested Fix

Pin the format on the patch-producing call:
`--no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/`
(explicit prefixes rather than `--default-prefix`, which needs git 2.41+).
Single-source these as an exported constant array in `GitUtils.ts` (for example
`GIT_PATCH_FORMAT_OPTIONS`) next to `GIT_DIFF_NO_EXT_DIFF_OPTION` so other
patch producers can reuse it. Add a test in the run-bundle exporter test
(`src/test/unit/RunBundleExporter*.test.ts`) that sets repo-local
`color.ui=always`, `diff.noprefix=true` and `diff.external=false`, exports, and
asserts the patch applies cleanly (`git apply --check`) to a clone of the base.
