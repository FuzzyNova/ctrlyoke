# Prompt-file resolution follows symlinks out of the workspace

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, reproduced against `out/`)
- **Area:** `src/core/PromptFileResolver.ts`
- **Resolution:** fixed in this commit

## Symptom

A step whose `prompt` is a file path (`prompt: ./prompts/x.md`) is read
through a symlink without a containment check, so the link's target outside
the workspace is loaded and sent as the prompt. The same path used as a
context reference (`@prompts/x.md`, `#selection:prompts/x.md:1-1`) is
correctly blocked with "resolves outside the workspace and was blocked".

`docs/workflows/permissions.md` ("Trusted external folders") says ctrlyoke
only reads files inside the workspace and that the check follows symbolic
links and Windows junctions. Git checks symlinks out on macOS and Linux, so a
shared workflow plus a committed link (`prompts/x.md -> ~/.ssh/id_ed25519`)
exfiltrates the target on the first run.

## Steps to Reproduce

```
ws/prompts/x.md -> /tmp/outside/secret.md      # file link
ws/linkdir      -> /tmp/outside                # directory link
```

```js
const r = new PromptFileResolver({ workspaceRoot: ws, namedRoots: [], trustedRoots: [ws], approvedExternalRoots: [] });
await r.resolve("prompts/x.md");      // { status: "resolved", content: "SECRET\n" }
await r.resolve("linkdir/secret.md"); // { status: "resolved", content: "SECRET\n" }
```

Expected: both blocked, as `ContextExpander` blocks `@prompts/x.md`.

## Root Cause

`PromptFileResolver.isCandidateAllowed` (`src/core/PromptFileResolver.ts`
~501-515) passes the lexical candidate path to `evaluateFileAccess`, which
does not resolve links. `resolve` then reads `readable.path` (~152) through
the link. `ContextExpander.resolveReference` (`src/utils/ContextExpander.ts`
~1233) resolves links first with `RealpathContainmentChecker`
(`src/utils/PathSecurity.ts:47`); the fix for
`dev/bugs/implemented/context-references-follow-symlinks-out-of-workspace.md`
covered only `ContextExpander`/`AttachmentBuilders`.

## Suggested Fix

In `findReadableFile` (and the sync `resolvePathSync` path, if it gates
reads), resolve each candidate with `realpath` and check it with a
`RealpathContainmentChecker` built from the same trusted, approved external
and own-state roots before accepting it; report a blocked candidate with the
same "resolves outside the workspace" reason the context expander uses. Keep
links that resolve back inside the workspace or under an approved external
root working. Keep the existing "no roots configured" behavior for callers
that pass none. Add tests for a file link and a directory link pointing out,
and one pointing back in. Note the change under **Changed** in `CHANGELOG.md`.
