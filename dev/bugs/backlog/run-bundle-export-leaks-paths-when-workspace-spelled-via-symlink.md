# Run bundle export leaves absolute checkout paths when the workspace path is a symlink spelling

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/RunBundleExporter.ts`, `src/utils/RunBundlePaths.ts`, `src/cli/CliWorkspaceBootstrap.ts`
- **Severity:** medium (privacy: the bundle names the user's checkout and home)

## Symptom

`docs/cli/ctrlyoke.md` (the `export` section) says workspace paths become
`${workspaceFolder}/…` "so the bundle names neither your checkout nor your
user". That fails when the run and the export see the workspace under
different spellings of the same directory, for example `/tmp/x` and
`/private/tmp/x` on macOS, or any symlinked checkout. The bundle then keeps raw
absolute paths in `run.json` (`originalFile`) and `events.jsonl`, and
`externalPaths` reports the workspace itself as an outside path.

## Steps to Reproduce

On macOS, where `/tmp` is a symlink to `/private/tmp`:

```bash
mkdir -p /tmp/ws && cd /tmp/ws      # process.cwd() is /private/tmp/ws
# a one-step script workflow m.ctrlyoke.yaml
node <repo>/out/cli.js run m.ctrlyoke.yaml --json
node <repo>/out/cli.js export --cwd /tmp/ws --workflow <key> --out /tmp/b --json
```

Observed: `"externalPaths": ["/private/tmp/ws"]`, and the bundle's `run.json`
keeps `"originalFile": "/private/tmp/ws/m.ctrlyoke.yaml"`. The reverse
(`run --cwd /tmp/ws`, then `export` from inside the folder) gives
`externalPaths: ["/tmp/ws"]` with the raw paths left in. With the same spelling
for both commands the paths become `${workspaceFolder}/m.ctrlyoke.yaml` and
`externalPaths` is empty.

## Root Cause

- `bootstrapCliWorkspace` (`src/cli/CliWorkspaceBootstrap.ts:55`) uses
  `path.resolve(options.cwd ?? process.cwd())`, which never resolves symlinks.
  `process.cwd()` is already the real path, while `--cwd` keeps whatever was
  typed.
- History lookup already tolerates both spellings
  (`dev/bugs/implemented/project-history-key-splits-on-symlinked-paths.md`), so
  the export finds the run.
- The exporter builds its rewrite roots from those strings only
  (`RunBundleExporter.ts:447-454`, and the `sourceRoot`/`homeDir` rewrite near
  `:576`). `createPortablePathRewriter` (`src/utils/RunBundlePaths.ts:98-114`)
  matches each root literally, so the other spelling is never rewritten.

## Suggested Fix

In the exporter, add the real path (`fs.realpathSync.native`, ignoring errors)
of each workspace root, worktree root and `homeDir` next to the spelled root
before building the rewriter. `createPortablePathRewriter` already
de-duplicates and puts longer (nested) roots first. Apply the same expansion
wherever `externalPaths` is computed, so the workspace is never reported as
external. Add a test that creates a symlink to a temp workspace, records run
paths under one spelling, exports under the other, and asserts that no raw
path survives and that `externalPaths` is empty.
