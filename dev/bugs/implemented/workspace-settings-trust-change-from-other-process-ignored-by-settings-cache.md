# A workspace-settings trust decision made in another process is ignored until a settings file changes

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against `out/`)
- **Area:** `src/config/CtrlYokeConfigService.ts` (`getAll` ~532-547, `getWorkspaceSettings` ~772-803), `src/config/WorkspaceSettingsTrustStore.ts` (~57-60)
- **Resolution:** fixed in this commit

## Symptom

Sensitive workspace settings (shell executable, hooks, MCP commands,
end-condition and tool-permission values) only apply after the user approves
them. When the decision is changed from another process, for example
`ctrlyoke trust-workspace-settings --all` revoking an earlier allow, a running
extension host, hosted dashboard or MCP server keeps serving the old merged
settings:

- a **revoked** value keeps applying;
- a **new approval** does not take effect.

That lasts until one of the two `settings.json` files changes or the host
restarts.

## Steps to Reproduce

1. `npm run compile:extension`.
2. In a temp workspace, set `terminal.shellExecutable: "/tmp/evil-shell"` in
   `.ctrlyoke/settings.json`.
3. Create a `CtrlYokeConfigService` with a `WorkspaceSettingsTrustStore`
   ("extension"), and a second `WorkspaceSettingsTrustStore` on the same trust
   file ("CLI").
4. `getAll()` → `terminal.shellExecutable` is withheld (correct).
5. Allow via the CLI store. The extension store's `getDecision` now returns
   `allow`, but `getAll()` still withholds the value.
6. `notify()` → value appears. Deny via the CLI store. The extension store
   reports `deny`, but `getAll()` still returns `/tmp/evil-shell`.

**Expected:** `getAll()` reflects the trust file's current decisions on every
call, the same way it already reflects external `settings.json` edits.

## Root Cause

`CtrlYokeConfigService.getAll()` (~537-547) reuses `mergedSettingsCache`
whenever the user backend, workspace backend and CLI overlay objects are
unchanged. Trust decisions, which `getWorkspaceSettings()` (~772-803) applies
on a cache miss, are not part of the cache key. `WorkspaceSettingsTrustStore`
(~57-60) re-reads its file on mtime change precisely because another process
may write it, but the merged cache in front of it hides that. Same-process
decisions work only because `recordWorkspaceSettingsTrustDecisions` calls
`configService.notify()`; `extension.ts` (~492-506) watches only the two
`settings.json` files. Regression from `9b05684ef` (settings cache added for
secret redaction).

## Suggested Fix

Give the trust-decision interface a cheap revision token (for example the
identity of the store's loaded data, or its mtime from the existing `load()`
check), store it in `mergedSettingsCache`, and compare it in `getAll()`. Only
consult it when the workspace has sensitive settings, so the redaction fast path
stays cheap. Update `FakeWorkspaceSettingsTrust` (tests) to implement the new
member. Watching the trust file in `extension.ts` alone would not cover the MCP
or hosted server.

Test in `src/test/unit/CtrlYokeConfigService.test.ts`: two
`WorkspaceSettingsTrustStore` instances on one temp file; allow, then deny, from
the second instance and assert `getAll()` follows each change without
`notify()`.
