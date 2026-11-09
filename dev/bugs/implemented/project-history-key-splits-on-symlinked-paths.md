# Project history key depends on how the path is spelled, so symlinked paths split history and `history relink` loses it

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ProjectStatePaths.ts` (`projectKey`), `src/utils/ProjectStateLifecycle.ts` (`relinkUserProject`), `src/cli/CliWorkspaceBootstrap.ts`
- **Resolution:** fixed in this commit — keys are derived from the real path (option 1) with split history adopted on startup, and relink canonicalizes both paths

## Symptom

User-scoped run history lives under
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/`, where the hash is taken from
`path.resolve(stateRoot)`. Symlinks are never resolved, so one repository
reached by two spellings gets two separate histories:

- `cd /tmp/repo && ctrlyoke …` uses `process.cwd()`. Node's `getcwd` already
  returns the real path (`/private/tmp/repo` on macOS), so this is one key.
- `ctrlyoke … --cwd /tmp/repo` uses `path.resolve("/tmp/repo")`, which is a
  different key. The same is true of a VS Code window opened on the symlinked
  spelling, and of any repo under a symlinked directory (for example a
  symlinked `~/dev`).

`ctrlyoke history relink <old> <new>` makes this worse, because it hashes the
arguments exactly as typed:

- When `<old>` is typed with the symlinked spelling, relink fails with
  `Source project state is missing project.json`, even though the history
  exists.
- When `<new>` is typed with the symlinked spelling, relink reports
  `Relinked project history to …` but moves the history to a key that `cd
<new> && ctrlyoke history list` never looks at. The user sees empty history
  right after a "successful" relink.

## Steps to Reproduce

macOS, where `/tmp` is a symlink to `/private/tmp`:

```sh
export CTRLYOKE_HOME=/tmp/cyh/home
mkdir -p /tmp/cyh/ws && cd /tmp/cyh/ws && git init -q
printf 'steps:\n  - type: script\n    script: echo hi\n' > s.ctrlyoke.yaml
ctrlyoke run s.ctrlyoke.yaml            # history under ws-<hash of /private/tmp/cyh/ws>
ctrlyoke history list --cwd /tmp/cyh/ws # empty: different key
cp -R /tmp/cyh/ws /tmp/cyh/ws2
ctrlyoke history relink /tmp/cyh/ws /tmp/cyh/ws2
#   Error: Source project state is missing project.json: …/ws-22cc718e444f
ctrlyoke history relink /private/tmp/cyh/ws /tmp/cyh/ws2 --yes
#   Relinked project history to …/ws2-9c3efabfabc6
cd /tmp/cyh/ws2 && ctrlyoke history list
#   KEY  NAME  RUNS  LATEST  STATE   (empty: cwd is /private/tmp/cyh/ws2 → ws2-4828974ee205)
```

## Root Cause

- `projectKey` (`src/utils/ProjectStatePaths.ts`, around line 40) hashes
  `foldPathForCompare(path.resolve(stateRoot))`, deliberately without
  `realpath` (see `dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md` §3.1).
- `bootstrapCliWorkspace` (`src/cli/CliWorkspaceBootstrap.ts:55`) takes
  `path.resolve(options.cwd ?? process.cwd())`, so `--cwd` keeps the spelling
  the user typed while the default cwd is already canonical.
- `relinkUserProject` (`src/utils/ProjectStateLifecycle.ts:130-139`) hashes
  `path.resolve(oldPath)` and `path.resolve(newPath)` and records the new
  spelling as `statePath`, with no check that it matches the key the
  workspace will be opened under.

## Suggested Fix

This needs a design decision, because changing how the key is derived moves
existing users' history:

1. Canonicalize the state root with `fs.realpathSync.native` (falling back to
   the nearest existing ancestor for a path that no longer exists) everywhere
   a project key is derived, and migrate on read: when the canonical key has
   no `project.json` but the `path.resolve` key does, adopt or relink it. This
   fixes the split for VS Code, `--cwd` and relink together.
2. Smaller, no-migration option: leave the key alone, but make
   `history relink` try the realpath spelling of `<old>` when the typed one has
   no state, and warn (or refuse without `--yes`) when `<new>` differs from its
   realpath, naming the key a `cd <new>` would use.

Add regression tests in `src/test/unit/` using a temp directory reached through
a symlink.
