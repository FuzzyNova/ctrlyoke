# Git stderr-text fallbacks break under a non-English locale

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/utils/GitUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

Several fallbacks decide what happened by matching git's English stderr. Git
translates those messages, so under a German (or any translated) locale they
never match and the error is thrown instead of handled:

- **Non-git workspace:** `findWorkflowFilesInWorkspace` (from
  `src/utils/WorkflowFileDiscovery.ts`) in a plain folder containing
  `a.ctrlyoke.yaml` returns the file under `LC_ALL=C`. Under
  `LC_ALL=de_DE.UTF-8` it throws
  `Schwerwiegend: Kein Git-Repository …` instead of falling back to the
  filesystem walk (`WorkflowFileDiscovery.ts:123`). Workflow discovery fails
  outright for a workspace that is not a git repo. `CompletionFileDiscovery.ts`,
  `WorkspaceFileIndex.ts` and `RunBundleExporter.ts` use the same check.
- **Missing blob:** `getBlobBytes(repo, "HEAD", "nope")` returns `null` under C
  and throws under German (`Pfad 'nope' existiert nicht in 'HEAD'`), which
  breaks the hosted viewer's diff for added/deleted files and root commits
  (`HostedWorkspaceViewerService.ts`).

Commit 51bc96cd5 fixed the same class of bug for CommitMessageGenerator's
unborn-HEAD check only
(`dev/bugs/implemented/commit-all-in-unborn-repo-fails-with-non-english-git.md`).

## Steps to Reproduce

1. `mkdir /tmp/nogit && touch /tmp/nogit/a.ctrlyoke.yaml` (not a git repo).
2. In node with `process.env.LC_ALL = "de_DE.UTF-8"`, call
   `findWorkflowFilesInWorkspace("/tmp/nogit")` from
   `out/utils/WorkflowFileDiscovery.js`.
3. It throws the German "Kein Git-Repository" error. With `LC_ALL=C` it returns
   the file.

(The German git message catalog must be installed; it is with most git builds
and Homebrew/Git for Windows.)

## Root Cause

`src/utils/GitUtils.ts`:

- line 400: `isNotGitRepositoryError` matches `/fatal:\s*not a git repository\b/`;
- line 415: `isGitUnavailableError` matches `/detected dubious ownership/`;
- lines 955-960: `getBlobBytes` matches `"does not exist in"`,
  `"exists on disk, but not in"` and `"invalid object name"`.

ctrlyoke never sets a locale for git, so these strings are translated.

## Suggested Fix

Make git's diagnostics locale-independent rather than adding translations:
run git with `LC_ALL=C` (keeping the rest of `process.env`) in the shared git
spawn helpers (`execGit`/`execGitBuffer` and the `execFileAsync("git", …)`
call sites these checks serve), or check structurally instead of parsing
stderr: `git rev-parse --git-dir` for "not a repo", and
`git cat-file -e <spec>` / `rev-parse --verify --quiet` exit codes for missing
blobs. Note `LC_ALL=C` must not change how paths are output (ctrlyoke already
uses `-z`/`core.quotePath` handling) and must not affect commands whose output
is shown to the user verbatim in their own language; if that matters, scope
the env override to the probing commands only. Add tests that set
`LANGUAGE=de` and `LC_ALL=de_DE.UTF-8` (as `CommitMessageGenerator.test.ts`
does) and assert `isNotGitRepositoryError` fallbacks and `getBlobBytes`
return their handled results.
