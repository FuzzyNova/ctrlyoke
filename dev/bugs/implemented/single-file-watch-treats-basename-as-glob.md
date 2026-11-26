# Watching a single file treats its basename as a glob, so `[id].tsx` or `{a,b}.md` never update

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/platform/NodeFileWatcher.ts`, `src/platform/VsCodeFileWatcher.ts`, callers of `FileWatcherFactory.create(dirname, basename)`
- **Resolution:** fixed in this commit

## Symptom

To watch one file, callers call `fileWatcherFactory.create(path.dirname(file), path.basename(file))`.
The basename is then used as a glob pattern. A file whose name contains glob
metacharacters is never matched. Instead, siblings that happen to match the
pattern trigger it:

- `[id].tsx` is the character class `[id]` followed by `.tsx`, so it matches
  `i.tsx` and `d.tsx` and never `[id].tsx` itself.
- `{a,b}.md` matches `a.md` and `b.md`.

The hosted workspace viewer's live file watch
(`CtrlYokeHostedServer.ts:3272`, `watchWorkspaceFile`) is the most exposed
caller. Next.js, SvelteKit, Nuxt and Remix route files (`pages/[id].tsx`,
`[...slug].tsx`, `+page.svelte` is fine) never refresh while open, and a write
to an unrelated sibling can trigger a refresh instead. Other basename callers
(prompt-file, external-run, coordination and settings watchers) are affected
only when the watched name contains `*?[]{}`.

## Steps to Reproduce

Against the compiled `out/platform/NodeFileWatcher.js`:

1. Create `[id].tsx`, `plain.tsx` and `{a,b}.md` in a temp dir.
2. Watch each with `create(dir, basename)` and rewrite all three files.
3. Only `plain.tsx` reports a change.

## Root Cause

`NodeFileWatcher.ts:31-34` treats a single segment as a literal path only
when it has no `*?[]{}`. Otherwise it watches the directory and filters events
with `minimatch(relativePath, glob)` (line 71), which interprets the brackets.
`VsCodeFileWatcher.ts:22-24` passes the same string to `vscode.RelativePattern`,
whose glob also supports `[]` and `{}`, so the extension host most likely has
the same problem. Only the Node side has been reproduced.

## Suggested Fix

Add a literal single-file entry point to the `FileWatcherFactory` contract in
`src/core/HostPorts.ts`, for example `createForFile(absolutePath)`, and move
every `create(dirname, basename)` caller to it (`grep -rn "path.basename" src`
around `.create(`). On Node, watch the exact path. On VS Code, either escape the
glob metacharacters in the basename or watch the directory and filter events
by exact `fsPath`. Cover `[id].tsx` and `{a,b}.md` in
`src/test/helpers/fileWatcherContract.ts` so both host implementations are tested.
