# Settings inputs flash back to the old value after blur until the host echoes the setting, and a quick refocus loses the edit

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (review of ~0bc578438)
- **Area:** `src/ui/webview-react/hooks/useLocalInput.ts` (`useLocalValue`)
- **Severity:** medium

## Symptom

The fix for
`dev/bugs/implemented/local-input-shows-uncommitted-value-after-normalized-commit.md`
made `onBlur` call `onCommit(value)` and then immediately
`setValue(externalValueRef.current)`. None of the settings consumers update the
store optimistically: `GlobalSettingsDrawer.handleUpdate` (and
`sendGlobalSetting` in the status-line controls) only post
`UPDATE_GLOBAL_SETTING`, and the `value` prop changes only when the host
writes the setting and echoes settings back. So:

- After every blur, the field shows the **old** value for the whole round
  trip, then jumps to the new one. In the hosted browser dashboard over a
  websocket this window is clearly visible and looks like the edit was lost.
- If the user blurs and refocuses the field before the echo arrives,
  external updates are ignored while editing, so they continue editing the
  reverted old text. The next blur commits that and overwrites the edit they
  just made.

Affected: every `LocalNumberInput`/`LocalTextInput` in the settings sections
(Queue, Coordination, General, Execution, Server, Terminal, Worktrees,
Harnesses, Defaults, RunHistory, StatusLine, ModelPricing, LimitSelect), plus
`HookCommandField` and `LocalAdditionalArgsEditor`, which use `useLocalValue`
directly.

## Steps to Reproduce

1. Render a `LocalNumberInput` with `value={5}` whose `onCommit` does not
   update the `value` prop synchronously (as in the settings drawer).
2. Focus, type `7`, blur.
3. The input shows `5` until the parent re-renders with `value={7}`.
   Expected: it keeps showing `7`.

The new test in `src/ui/webview-react/test/hooks/useLocalInput.test.tsx`
("shows the committed value after a normal commit…") only asserts after a
manual `rerender`, so it skips the window where the old value shows.

## Root Cause

`useLocalInput.ts` `onBlur` resets local state to the last external value
unconditionally, instead of only when the commit was normalized to a value
that leaves the external value unchanged.

## Suggested Fix

Keep the committed value as *pending*: after blur, display the committed value
until `externalValue` changes (then follow the external value as usual), and
resolve the normalized case without a round trip. For example, let callers
supply the normalized form (`LocalNumberInput` knows `parse`), compare it with
the current external value, and reset to the external value only when they are
equal; otherwise show the typed value until the echo arrives. Preserve the
original bug's fix (typing `0` into a field parsed to `1` must show `1` after
blur) and the guarantee that external updates are ignored while editing. Add
tests covering both the async round-trip window and the normalized case.
