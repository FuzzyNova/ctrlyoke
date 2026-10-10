# A workspace setting write auto-approves sensitive values added to the file externally

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against the real `CtrlYokeConfigService` + `FileConfigBackend`)
- **Area:** `src/config/CtrlYokeConfigService.ts` (`set`, `approveNewWorkspaceSensitiveValues`), `src/config/FileConfigBackend.ts` (`getAll` cache)
- **Resolution:** fixed in this commit

## Symptom

A program-launching value is added to `.ctrlyoke/settings.json` after ctrlyoke
has read the file. That covers `terminal.shellExecutable`, `defaults.hooks`,
stdio `defaults.mcpServers`, `defaults.additionalArgs`, and
`defaults.endCondition`/`defaults.preCondition` scripts. Typical ways it arrives
are `git pull`, a branch checkout, a teammate's commit, or a hand edit. The next
time the user changes **any** workspace-scope setting through ctrlyoke, even an
unrelated one like `ui.stepColorMode`, the externally added value is recorded as
`allow` in the workspace settings trust store and takes effect. The approval
prompt never appears.

That breaks the documented rule in `approveNewWorkspaceSensitiveValues`'s JSDoc
and in `dev/bugs/implemented/workspace-settings-choose-terminal-shell-executable.md`:
only a value the user saved through ctrlyoke is auto-approved, and "an
unapproved value committed to the file by someone else stays pending".

## Steps to Reproduce

1. The workspace `settings.json` is `{ "ui": { "stepColorMode": "none" } }`.
   ctrlyoke reads it once, so `FileConfigBackend` caches it.
2. Externally rewrite the file to add
   `"terminal": { "shellExecutable": "C:/evil/payload.exe" }`.
   No watcher clears the cache, by design.
3. `await configService.set("ui.stepColorMode", "harness", "workspace")`.
4. The trust decision for `terminal.shellExecutable` is now `allow`, and the
   effective shell is `C:/evil/payload.exe`.

## Root Cause

`CtrlYokeConfigService.set()` computes
`sensitiveBefore = this.getWorkspaceSensitiveSettingRequests()` from the
backend's **cached** content (`FileConfigBackend.getAll()` returns
`state.cache`). External-edit watching was removed on purpose, so nothing
refreshes that cache. `FileConfigBackend.set()` then calls `this.load()`, which
reads the current file from disk (including the external value), writes it back,
and clears the cache. Then `approveNewWorkspaceSensitiveValues(sensitiveBefore)`
diffs the fresh content against the stale "before" snapshot. It treats every
externally added sensitive value as "new from this write" and calls
`setDecisions(..., TRUST_DECISIONS.ALLOW)` on it.

## Suggested Fix

Build the "before" set from the same disk read that the write modifies, inside
the backend's write queue, not from the cache. For example:

- Have `ConfigBackend.set()` (the interface plus `FileConfigBackend` and any
  other implementations or test doubles) return or report the settings object
  it loaded **before** applying the change.
- Build `before` from that object, passed through the same workspace filtering
  that `getWorkspaceSensitiveSettingRequests()` applies.

Better still, approve only the sensitive request(s) under the `path` actually
being written. A write to `ui.stepColorMode` should never approve
`terminal.shellExecutable`. A simple invalidate-the-cache-first approach leaves
a race with an external edit landing between the read and the write, so prefer
the in-queue snapshot.

Test in `src/test/unit/CtrlYokeConfigService.test.ts`: use a real
`FileConfigBackend` on a temp file and an in-memory trust store. Read once, add
the sensitive value externally, write an unrelated workspace setting. Assert
that the external value's decision is still `undefined` and the effective value
is still the default. Keep the existing test passing: writing a sensitive value
through ctrlyoke still auto-approves it.
