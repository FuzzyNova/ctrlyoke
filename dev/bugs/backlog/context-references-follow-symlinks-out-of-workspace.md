# `#selection`, `#sym`, `@file` and `@dir/` follow symlinks and junctions out of the workspace

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced against compiled `out/` with a junction)
- **Area:** `src/utils/ContextExpander.ts` (`resolveReference`), `src/utils/AttachmentBuilders.ts`
- **Severity:** medium (security)

## Symptom

Take a workspace containing a junction or symlink `link -> <outside>/secret`, where
`secret/key.txt` lies outside the workspace. Then:

- `#selection:link/key.txt:1-2` attaches the outside file's lines, with nothing skipped;
- `@link/` lists the outside directory.

`..\secret\key.txt` is correctly blocked. `docs/workflows/permissions.md` says "ctrlyoke only reads
files inside the workspace", and the code comment says the boundary "must be enforced regardless of
intent", because workflows may be shared. Git checks out symlinks on macOS and Linux, so a cloned
repo or a shared workflow bundle can carry one.

## Steps to Reproduce

1. `mklink /J ws\link C:\tmp\secret` (or `ln -s /tmp/secret ws/link`).
2. Run a step whose prompt contains `#selection:link/key.txt:1-2`.
3. The outside file's content is attached.

## Root Cause

The containment check is lexical. `ContextExpander.ts:1151` and `AttachmentBuilders.ts:128` call
`isPathWithinAnyDirectory` on a `path.resolve` result, then read through the link with
`fs.stat`/`readFile`. `PathSecurity.ts` itself says both paths "must already be resolved (e.g.
via `path.resolve`/`fs.realpath`)". Other containment code already canonicalizes
(`WorkflowBundleAnalyzer.ts` `realpathRoots`).

## Suggested Fix

Realpath the candidate (and, memoized, every trusted root) before the containment check.

**Decision (2026-10-16):** block by default. A link inside the workspace that resolves outside it
is treated like any other outside path: the reference is skipped unless its real target lies under
an approved `permissions.trustedExternalRoots` entry. Links that resolve inside the workspace keep
working.

- Check the realpath of the target against the realpaths of the workspace folders and the
  approved trusted roots, so a trusted root that is itself reached through a link still matches.
- A missing target (`ENOENT` from `realpath`) keeps today's behaviour: the reference is skipped.
- The skip message should name the resolved target and point to `trustedExternalRoots`, so a user
  with a deliberate monorepo link knows how to allow it.
- Document the behaviour in `docs/workflows/permissions.md`.
- Tests: a junction/symlink to an outside folder is skipped for `@file`, `@dir/`, `#selection`
  and `#sym`; the same link is allowed once its target is a trusted root; an inside-to-inside link
  still works.
