# Escape in a modal inside Settings also closes the whole settings drawer

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx`
- **Severity:** low

## Symptom

Pressing Escape to dismiss a dialog opened from the Settings drawer also closes the drawer itself. Affected dialogs include Set secret, the Worktrees delete and reset confirmations, Clear history, Recently deleted, License, and the status-line disable confirmation. The user lands back on the dashboard instead of the settings page they were on. The drawer unmounts its content about 220ms later, so any in-progress state, such as a half-typed secret or a pending confirmation, is lost.

## Steps to Reproduce

1. Open the dashboard and open Settings (the global settings drawer).
2. Go to the Secrets page and click "Set secret".
3. Optionally type a name, then press Escape.
4. Observe: the dialog closes and the Settings drawer slides closed too. Expected: only the dialog closes.

## Root Cause

`src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx:190-205` adds a document `keydown` listener while the drawer is open. On Escape it closes the settings search or the drawer unless `e.defaultPrevented` is already set (line 193). The listener is registered before any child dialog mounts, so it fires first.

`src/ui/webview-react/components/shared/Modal.tsx:72-81` registers its own, later document `keydown` listener. That listener calls `onClose` on Escape but never checks or sets `defaultPrevented` and never stops propagation. Nothing marks the event as consumed by the modal before the drawer's handler runs, so both handlers act on the same keypress.

Modals mounted inside the drawer include `SecretsSection.tsx:288`, `WorktreesSection.tsx:566` and `:590`, `RunHistorySection.tsx:202` and `:206`, `LicenseSection.tsx:505`, and `stats/StatusLineTrackingControls.tsx:275` (all under `src/ui/webview-react/components/settings/`).

## Suggested Fix

Make Modal's Escape handling take priority and consume the event. One option is to register Modal's listener in the capture phase (`document.addEventListener("keydown", h, true)`) and call `e.preventDefault()` before `onClose`, adding `e.stopPropagation()` if needed. The drawer's existing `e.defaultPrevented` guard then skips the event. Another option is to have the drawer ignore Escape whenever a dialog is open (for example, `document.querySelector('[role="dialog"][aria-modal="true"]')`), or to keep a shared modal stack. Either way, Modal should also skip the event if `e.defaultPrevented` is already set, so nested modals close one at a time.

Add a Vitest case that opens the Secrets dialog inside `GlobalSettingsDrawer`, fires Escape, and asserts that the dialog closes and the drawer stays open.
