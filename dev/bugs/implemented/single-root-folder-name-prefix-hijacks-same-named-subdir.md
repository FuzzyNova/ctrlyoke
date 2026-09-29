# In a single-root workspace, `@<rootname>/…` resolves against the root instead of a same-named subdirectory

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/platform/WorkspaceRootResolver.ts`, `src/platform/CliAdapter.ts`, `src/platform/VsCodeWorkspaceRoot.ts`
- **Resolution:** fixed in this commit

## Symptom

In a single-folder workspace whose folder name matches one of its own subdirectories (Django's
`mysite/mysite/`, Python packages like `requests/requests/`, many monorepos), a file reference to
the subdirectory resolves to the wrong file. `@mysite/settings.py` resolves to
`<root>/settings.py` instead of `<root>/mysite/settings.py`. Usually that file doesn't exist, so
the reference is silently skipped (ENOENT) and nothing is attached; if it does exist, the wrong
file is attached. The same resolver feeds link decoration, `PromptEditorSupportService`,
`AttachmentBuilders` and `fromViewerPath`, so links and the viewer point at the wrong place too.

## Steps to Reproduce

1. Workspace `…/mysite` containing `mysite/settings.py`.
2. Both adapters report `namedRoots = [{ name: "mysite", fsPath: <root> }]` for a single root
   (`CliAdapter.getNamedWorkspaceRoots`, around line 104; `getVsCodeNamedWorkspaceRoots`, around
   line 83).
3. `expandContextSplit("Review @mysite/settings.py")` (via `ContextExpander`, whose named roots
   come from `HarnessIntegration.ts` around line 584).
   - Observed: `<root>/settings.py`, `base: namedRoot`, skipped with ENOENT.
   - Expected: `<root>/mysite/settings.py`, `base: workspace`. Passing `namedRoots: []` gives the
     correct result.

## Root Cause

`resolveWorkspaceOrNamedPath` (around lines 249-282) strips a leading segment that matches any
named root's name or basename, even when the only named root is the primary root itself. Folder-
name prefixes only make sense in multi-root workspaces: completions never insert one in a
single-root window (`asRelativePath(uri, false)`), and the prompt-file resolver already restricts
prefix handling to more than one named root.

## Suggested Fix

In `resolveWorkspaceOrNamedPath`, only try named-root prefix matching when `namedRoots.length > 1`
(and never strip a prefix that names the primary root itself when it is the only root). Keep that
rule in the one resolver rather than in each caller.

Regression tests in `src/test/unit/WorkspaceRootResolver.test.ts`: a single named root whose
basename equals a subdirectory resolves to `primaryRoot/<name>/…` with base `workspace`; a
multi-root case still resolves `root2/src/index.ts` to root2. Add a `ContextExpander` test showing
the single-root case lands in `directFileRefs` (use a real temp directory).
