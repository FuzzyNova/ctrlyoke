# UPDATE_GLOBAL_SETTING handler drops the async promise, so write failures become unhandled rejections with no client feedback

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/WebviewMessageRouter.ts`
- **Severity:** low

## Symptom

When `.ctrlyoke/settings.json` (or the user settings file) contains invalid JSONC, changing a setting from the dashboard has no visible effect. The write is refused and the extension host logs an unhandled promise rejection, but the user sees no error toast or message. The client never receives `GLOBAL_SETTING_UPDATED` or a settings reload, so a control that holds local draft or optimistic state can keep showing a value that was never saved. The settings write also runs outside the router's serialized message queue.

## Steps to Reproduce

1. Open a workspace with ctrlyoke and add a syntax error to `.ctrlyoke/settings.json`, for example by deleting a closing brace.
2. Open the dashboard Global Settings drawer at workspace scope, or use the Explorer "hide git-ignored files" toggle, and change any setting.
3. No error is shown. The extension host log has an unhandled rejection, `Cannot update settings file because it contains invalid JSON: ...`, and no `[WebviewMessageRouter] Error handling webview message (UPDATE_GLOBAL_SETTING)` entry. No `GLOBAL_SETTING_UPDATED` is posted back.

## Root Cause

`src/ui/WebviewMessageRouter.ts:2313-2320` registers the handler as `(message, ctx) => { this.settingsSync.handleUpdateGlobalSetting(...); }`. Because the block body neither awaits nor returns the promise, `routeSingleMessage` (`src/ui/WebviewMessageRouter.ts:504-536`) awaits `undefined`, and its catch block never runs.

`handleUpdateGlobalSetting` awaits `configService.set` at `src/ui/WebviewSettingsSync.ts:1350` without a try/catch. That call rejects in two places:

- `src/config/CtrlYokeConfigService.ts:473-497`, for workspace-forbidden or machine-scoped keys written at workspace scope.
- `src/config/FileConfigBackend.ts:99-110`, when the settings file has invalid JSON or a newer schema version.

After a rejection, the success-path reload and the `GLOBAL_SETTING_UPDATED` emit at `src/ui/WebviewSettingsSync.ts:1375-1380` are skipped, and the failure is never reported to the user.

## Suggested Fix

- Make the router entry await the promise, the way `DISABLE_STATUS_LINE_TRACKING` does: `table.set(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, async (message, ctx) => { await this.settingsSync.handleUpdateGlobalSetting(...); });`.
- In `handleUpdateGlobalSetting`, wrap `configService.set` and the work that follows it in a try/catch. On failure, report the error through the user feedback sink (the same pattern as `reportStatuslineFailure`). Then call `handleGlobalSettingsLoadRequest(postMessage)` anyway, so the client resyncs to the value that is actually persisted.
- Add a unit test in which `configService.set` rejects, and assert that the user is notified and settings are reloaded.
