# Files in a nested repo or submodule are resolved to the outer repo

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a script and with real git
- **Area:** `src/utils/WorkspaceRepoDiscovery.ts` (`findRepoForPath` ~95, `mapRootPrefixesToRepos` ~116)
- **Resolution:** fixed in this commit

## Symptom

In a multi-root workspace with roots `app` and `app/vendor/lib`, where the second is a
submodule or nested repo, `discoverRepos` correctly finds two repos. But every file
under `vendor/lib` is still assigned to `app`. In the hosted dashboard, staging the file
runs `git -C app add -- vendor/lib/x.ts`, which fails with `fatal: Pathspec
'vendor/lib/x.ts' is in submodule 'vendor/lib'`. Diff and file history break the same
way, as does every other `requireRepoRootForPath` caller, and the SCM repo selector
defaults to the wrong repo.

## Steps to Reproduce

`findRepoForPath("C:/ws/app/vendor/lib/src/x.ts", [app(C:/ws/app), lib(C:/ws/app/vendor/lib)])`
returns `app`; it should return `lib`. `mapRootPrefixesToRepos` maps `vendor-lib` to `app`.

## Root Cause

`findRepoForPath` returns the first containing repo (`repos.find`) instead of the
deepest one. Separately, `mapRootPrefixesToRepos` checks `root.name in map` on a `{}`
literal, so a root named `constructor` or `toString` is always skipped.

## Suggested Fix

Among the containing repos, pick the one with the longest resolved `rootPath`, and
update the doc comment. Use `Object.hasOwn` (or a null-prototype object) for the
duplicate-name check. Add unit tests for both.
