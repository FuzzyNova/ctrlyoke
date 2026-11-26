# Workspace-scope tool permission edits made in the dashboard are left pending approval

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/config/CtrlYokeConfigService.ts` (`approveNewWorkspaceSensitiveValues`), `src/ui/webview-react/components/settings/defaults/DefaultsPermissionsPage.tsx`
- **Severity:** medium

## Symptom

In the dashboard Settings page, at **Workspace** scope, the user changes the
default tool permission mode or adds an allowed or denied tool. The value is
saved to `.ctrlyoke/settings.json`, but it is held back as an undecided
workspace-sensitive setting. The user's own change does not take effect: the
user-scope or default permissions still apply, and a trust prompt for
`defaults.toolPermissions` is queued for a value the user just chose.

The docs say this should not happen
(`docs/reference/_partials/settings/intro.md:46`: "You don't need to approve a
value you saved through the dashboard's Settings page"). Writing the whole
`defaults.toolPermissions` object is auto-approved correctly.

After the first sub-path write, even a later whole-object write of the same
value stays pending, because the value already counts as previously requested.
The bug fails safe (it is not a security hole), but the dashboard shows a
workspace permission mode that is silently not applied.

## Steps to Reproduce

Run the real `CtrlYokeConfigService` with a `FileConfigBackend` and a
`WorkspaceSettingsTrustStore` on temp files, against a trusted workspace
identity. Then write at workspace scope:

| Write path                                 | Resulting trust state for `defaults.toolPermissions` |
| ------------------------------------------ | ---------------------------------------------------- |
| `defaults.toolPermissions.mode` (dashboard) | `undecided`. The effective mode is still the user's `allowAll`. |
| `defaults.toolPermissions` (whole object)  | `allow` (correct) |
| `defaults.toolPermissions.allowedTools`    | `undecided` |

## Root Cause

`approveNewWorkspaceSensitiveValues` (`CtrlYokeConfigService.ts:676-681`)
approves a new request only when its `settingPath` equals the written path or
lies **below** it:

```ts
(request.settingPath === writtenPath ||
  request.settingPath.startsWith(`${writtenPath}.`))
```

`defaults.toolPermissions` is registered as one whole-value setting
(`SENSITIVE_SETTING_SHAPES.VALUE`, `WorkspaceSensitiveSettings.ts:285-292`), so
its request path is `defaults.toolPermissions`. The dashboard writes the child
paths instead (`DefaultsPermissionsPage.tsx:132, 151, 173`, via
`DashboardSettingsSync.handleUpdateGlobalSetting`). A written path **deeper**
than the request path never matches. This filter came from the fix in
`dev/bugs/implemented/workspace-setting-write-auto-approves-external-sensitive-values.md`.
The same problem applies to any other `VALUE`-shaped sensitive setting the
dashboard writes field by field, such as `defaults.endCondition.*` or
`defaults.sandbox.*`.

## Suggested Fix

In `approveNewWorkspaceSensitiveValues`, also approve a new request when
`writtenPath.startsWith(`${request.settingPath}.`)`, meaning the write landed
inside a whole-value setting. Keep the protection against external edits: only
do this when `before` held no undecided or denied request at the same
`settingPath`. Otherwise a user's tweak to `.mode` would also approve an
`allowedTools` list that someone else committed to the file.

Add tests beside "approves a value the user writes at workspace scope…" in
`src/test/unit/CtrlYokeConfigService.test.ts`:

- A write to `defaults.toolPermissions.mode` is approved.
- A sub-path write over an already-pending, externally committed
  `defaults.toolPermissions` stays pending.
