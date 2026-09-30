# Settings: same-file backends keep a stale cache, and a null toolPermissions layer plus a partial overlay crashes permission mappers

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent, esbuild scripts against real source)
- **Area:** `src/config/FileConfigBackend.ts`, `src/config/CtrlYokeConfigService.ts` (`deepMerge`), `src/utils/ConfigurationUtils.ts` (`resolveSpawnToolPermissions`)
- **Severity:** medium

Both are incomplete fixes: 3285cd6b8 (`settings-set-prototype-pollution-and-shared-tmp.md`) and
809823e5b (`settings-default-toolpermissions-null-crashes.md`).

## Symptom

1. **Stale read after a user-scope write when the workspace root is the home directory.** The user
   and workspace settings paths resolve to the same file. `getWriteQueue` now shares the write
   queue per resolved path, but each `FileConfigBackend` still keeps its own `cache`. The file
   starts as `{"ui":{"showCliCommand":true}}`. Read settings, then call
   `configService.set("ui.showCliCommand", false, "user")`. The file now holds `false`, but
   `configService.get("ui").showCliCommand` still returns `true`. The workspace backend's stale
   cache wins the merge and is never invalidated.
2. **`defaults.toolPermissions: null` plus a partial overlay above it crashes the harness mapper.**
   User `settings.json` has `{"defaults":{"toolPermissions":null}}`, which is schema-valid. Then
   either run `ctrlyoke run --permission-mode custom` (`src/cli.ts` ~l.757 builds an overlay of
   just `{mode}`) or write `defaults.toolPermissions.mode` at workspace scope. `deepMerge` replaces
   the `null` target with the partial source, so `getAll().defaults.toolPermissions` is
   `{"mode":"custom"}`. `resolveSpawnToolPermissions(undefined)` returns it unchanged, and
   `QwenToolPermissionMapper.prepare` throws `Cannot read properties of undefined (reading 'length')`
   on `config.allowedTools.length`. Codex and OpenCode read it the same way.

## Steps to Reproduce

See the symptoms. Each reproduces in a `CtrlYokeConfigService` unit test with two backends on one
temp file (1), or a user file containing `toolPermissions: null` plus an overlay `{mode: "custom"}`
followed by `resolveSpawnToolPermissions(undefined)` (2).

## Root Cause

1. `FileConfigBackend.set()` clears only its own `cache` (`this.cache = undefined`). Other
   instances on the same path are left stale.
2. `deepMerge` treats a `null` target as absent and substitutes the source object as-is, rather
   than merging it onto the object default. `resolveSpawnToolPermissions` returns the raw merged
   object without the `?? []` guards the getters use.

## Suggested Fix

1. Keep the per-path shared state in one place, holding both the queue and the cache. Or, simpler
   and what the original doc suggested, make `CtrlYokeConfigService` reuse one backend instance per
   resolved path (case-folded on Windows).
2. In `resolveSpawnToolPermissions`, normalize any non-null config to
   `{ mode, allowedTools: config.allowedTools ?? [], deniedTools: config.deniedTools ?? [] }`
   (single-source this with the getters' null helper). Also, in `deepMerge`, when a nullable
   target is `null` and the source is a partial object, merge the source onto the schema default
   for that path. Tests for both cases.
