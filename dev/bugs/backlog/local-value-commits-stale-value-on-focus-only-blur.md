# useLocalValue commits a stale value on blur after focus-only interaction, reverting external changes

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useLocalInput.ts`
- **Severity:** medium

## Symptom

Settings drawer text, number and textarea fields (`worktrees.root`, `server.port`, `terminal.shellExecutable`, `commit.model`, and others) silently write their old value back when they lose focus. This happens if the setting changed underneath them while they were focused, even when the user never typed. The newer value in `settings.json` is overwritten without any warning.

## Steps to Reproduce

1. Open the dashboard Global Settings drawer and go to the Worktrees tab (or any section that uses `LocalTextInput`, `LocalNumberInput` or `LocalTextarea`).
2. Click into the `worktrees.root` field so it has focus. Do not type.
3. While the field still has focus, change `worktrees.root` to a new value outside the dashboard. Either edit `.ctrlyoke/settings.json` (or the user settings file) directly, or change the setting from a second hosted-dashboard client. The new settings are broadcast and the prop value changes.
4. The field keeps showing the old value, because `editing.current` is true and the `externalValue` effect skips `setValue`.
5. Click somewhere else to blur the field.
6. `onBlur` calls `onCommit` with the old value, which posts `UPDATE_GLOBAL_SETTING` for `worktrees.root`. The setting on disk reverts to the old value.

## Root Cause

- `src/ui/webview-react/hooks/useLocalInput.ts:31-33`: `onFocus` sets `editing.current = true` even when the user has not typed anything.
- `useLocalInput.ts:18-23`: while `editing.current` is true, the `externalValue` effect does not update the local value.
- `useLocalInput.ts:34-36`: `onBlur` always calls `onCommit(value)` with the local buffer and never checks whether the user changed it. A focus-only interaction therefore commits a stale snapshot.
- `src/ui/webview-react/components/shared/LocalInputs.tsx:19-20, 45-51, 67-68`: these components spread the full hook result, including `onFocus`, onto the elements.
- `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx:248-256` (`handleUpdate`) posts `UPDATE_GLOBAL_SETTING` with no comparison against the current value. Example caller: `src/ui/webview-react/components/settings/WorktreesSection.tsx:453-456`.
- `HookCommandField` (`src/ui/webview-react/components/editor/HooksEditor.tsx:62`) and `LocalAdditionalArgsEditor` (`src/ui/webview-react/components/shared/AdditionalArgsEditor.tsx:271`) wire only `onBlur`, not `onFocus`, so focus alone does not trigger this for them.

## Suggested Fix

Track whether the buffer is dirty instead of treating focus as editing:

- Set the flag only in `onChange` (or keep a `dirty` ref set by `onChange`).
- Leave `onFocus` as a no-op, or drop it.
- In `onBlur`, call `onCommit` only when the user changed something, e.g. `if (dirty.current) onCommit(value)`. Otherwise resync with `setValue(externalValueRef.current)`, then clear the flag.

This keeps the protection against delayed host echoes while the user is typing, and stops focus-and-blur from committing a stale value. It also stops it from writing a redundant explicit override into the active scope.

Add a test in `src/ui/webview-react/test/hooks/useLocalInput.test.tsx`: focus the field, rerender with a new external value, blur, then assert that `onCommit` was not called and the input shows the new value.
