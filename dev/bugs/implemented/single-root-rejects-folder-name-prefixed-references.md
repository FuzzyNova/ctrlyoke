# In a single-root workspace, `@<rootname>/…` references are reported "File not found" and never attached

- **Found:** 2026-10-06 by Nathan (manual testing)
- **Area:** `src/platform/WorkspaceRootResolver.ts`
- **Resolution:** fixed in this commit

## Symptom

A folder-name-prefixed reference such as `@ctrlyoke/src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`
works in a multi-root workspace but, with the same folder opened on its own, the prompt editor's
CodeMirror lint marks it "File not found" and the file is silently not attached at execution.
Prompts and workflows that use the prefix therefore can't be shared between single-root and
multi-root workspaces.

## Steps to Reproduce

1. Open `C:\dev\ctrlyoke` as a single-folder workspace (no `ctrlyoke/ctrlyoke/` subdirectory).
2. Type `@ctrlyoke/dev/implemented/MULTI_ROOT_WORKSPACE_PLAN.md` in a prompt.
   - Observed: lint warning "file not found"; the harness receives no attachment.
   - Expected: resolves to `<root>/dev/implemented/MULTI_ROOT_WORKSPACE_PLAN.md`, as it does in a
     multi-root workspace.

## Root Cause

A regression from `26876bf78`, which fixed
`single-root-folder-name-prefix-hijacks-same-named-subdir.md` by gating named-root prefix matching
in `resolveWorkspaceOrNamedPath` on `namedRoots.length > 1`. That bug's premise — "folder-name
prefixes only make sense in multi-root workspaces" — overlooked references authored in a
multi-root workspace and run in a single-root one. With the gate, `ctrlyoke/…` resolved to
`<root>/ctrlyoke/…`. The lint (`PromptEditorSupportService.resolveContextReferencePath`), attachment
expansion (`ContextExpander`), link decoration and the viewer all share this resolver, so all of
them failed together.

## Fix

In a single root, a `<rootname>/…` prefix is decided by layout: if a same-named subdirectory
`<root>/<rootname>/` exists, the prefix always means that subdirectory (so the Django
`mysite/mysite/` case stays fixed, and a file missing from it reports "not found" instead of
silently attaching a root-level namesake); otherwise the prefix names the root itself. Multi-root
behaviour is unchanged.

Accepted tradeoff: in a repo that does have a same-named subdirectory, a multi-root-authored
`@<rootname>/x` meaning the root-level `x` reports "not found" when the folder is opened alone.
That layout was already ambiguous for the prefix, and failing loudly beats attaching the wrong file.

Regression tests: `src/test/unit/WorkspaceRootResolver.test.ts` (prefix resolves to the root
without a same-named subdirectory; the subdirectory owns the prefix even when the file exists only
at the root) and `src/test/contextExpander.test.ts` (the prefixed reference lands in
`directFileRefs`).
