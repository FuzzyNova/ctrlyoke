# Node file watcher drops every event for a dotfile or a path under a dot directory

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/platform/NodeFileWatcher.ts`
- **Severity:** medium

## Symptom

On the Node host (`ctrlyoke server`, CLI, MCP server), a watch with a glob
such as `**/*` never reports a path that has a segment starting with `.`, for
example `.gitignore`, `.github/ci.yml`, `.env.example` or `src/.eslintrc`.
VS Code's watcher reports these paths, so the two hosts disagree.

The completion index watcher is the visible victim. `NodeHostServices.ts:140`
creates it as `fileWatcherFactory.create(cwd, "**/*")`, and
`WorkspaceFileIndex.ts:197-203` rebuilds the `@` index when `.gitignore` or
`.git/info/exclude` changes. Under `ctrlyoke server` that change event never
arrives, so an edited `.gitignore` takes effect only after a restart. Dotfiles
that are created or deleted never enter or leave the index either.

## Steps to Reproduce

Against the compiled `out/platform/NodeFileWatcher.js`:

1. `new NodeFileWatcherFactory().create(tmpDir, "**/*")` with `.github/` and
   `src/` already present.
2. Create `.github/ci.yml`, `src/a.ts`, `.env.example` and `src/.eslintrc`.
3. Only `create: src/a.ts` is reported. The other three events are dropped.

## Root Cause

The event filter at `NodeFileWatcher.ts:71` is
`if (!relativePath || !minimatch(relativePath, glob)) return;`. minimatch
leaves `*` and `**` unmatched against dot segments unless you pass `{ dot: true }`.
The `ignored` predicate a few lines above (line ~61) does pass `dot: true`, so
chokidar walks into dot directories, and then the event filter discards what
it finds there.

## Suggested Fix

Pass `{ dot: true }` in the event-filter `minimatch` call so it matches the
`ignored` predicate and VS Code's glob semantics. Add a case to the shared
contract in `src/test/helpers/fileWatcherContract.ts`: under `**/*`, a dotfile
and a file inside a dot directory must both fire. The existing
`DEFAULT_FILE_WATCHER_EXCLUDES` still keep `.git/objects` and similar paths out.
