# Toast Severity Threshold Plan

## Overview

`NotificationsSection.tsx`'s "VS Code toasts" toggle
(`notifications.vscode.enabled`) once silenced every native popup. It no
longer does: the `USER_FEEDBACK`/toast-queue system added by
[`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md)
is a deliberately separate channel from completion notifications, and that
plan states explicitly (its "Decided: a toast is not a notification"
section) that operational toast is "governed by Nothing. Never
suppressed." `notifications.vscode.enabled` only gates
`NotificationManager` — completion popups for workflow/prompt-done events
(`src/ui/NotificationManager.ts:118-130`). It has no effect on operational
toast (save failed, validation error, action result, etc.), and there is
currently no setting anywhere that does.

This plan adds one new setting — a **toast severity threshold** — and
supersedes that specific "never suppressed" decision for operational toast
only. Completion-notification gating (`vscode.enabled`, `browser.mode`,
`events.workflowComplete`/`promptComplete`, `onlyWhenWindowUnfocused`) is
unrelated and unchanged.

**Deliberately excluded from this plan:** a per-toast "never show again"
registry (each toast site gets a stable ID, dismissal persists, a settings
page lists every toast and its show/hide state). That was considered and
rejected for now — see "Not In Scope" — in favor of the smaller change that
gets users an actual silence control.

---

## Why this is cheap: exactly two chokepoints already exist

The toast/native-feedback system was already funneled to two points by the
time `BROWSER_USER_FEEDBACK_PLAN.md`'s Phase 6 (host-aware dispatch)
landed. Confirmed by reading the code, not inferred from the plan docs:

1. **`src/ui/webview-react/store/uiStore.ts`'s `enqueueToast`/`showToast`
   actions** (~line 1755-1807) — the only two places `ToastItem`s are ever
   pushed onto `toastQueue`, which `ToastViewport.tsx`
   (`src/ui/webview-react/components/shared/ToastViewport.tsx`) renders.
   A repo-wide search confirms only two production call sites reach these
   actions directly: `useMessageHandler.ts` (the `USER_FEEDBACK` handler at
   line 1259-1268, the standalone-only "Created workflow" toast at
   1617-1630, and the `NOTIFICATION_EVENT`→toast translation gated on
   `isStandalone`) and `src/ui/webview-react/utils/notifyUser.ts`.
2. **`src/platform/VsCodeUserFeedbackSink.ts`'s `notify()`** (line 19-33)
   — the only place operational feedback becomes a native
   `vscode.window.show{Information,Warning,Error}Message` call. One
   instance is constructed in `extension.ts:270`
   (`vscodeUserFeedbackSink`) and reused for **both** paths that reach
   native VS Code UI: composed into `CompositeUserFeedbackSink`
   (`extension.ts:323-326`) for backend-originated `USER_FEEDBACK`, and
   wired directly as `handleNativeFeedback` in
   `CtrlYokeWebviewProvider.ts:217-218` for webview-originated feedback
   routed through the `SHOW_NATIVE_FEEDBACK` message
   (`WebviewMessageRouter.ts:405-420`).

`notifyUser.ts` (`src/ui/webview-react/utils/notifyUser.ts`) is itself
already the single frontend entry point every Group A/B call site in
`BROWSER_USER_FEEDBACK_PLAN.md` uses: it branches on `isStandalone`,
calling `uiStore.showToast()` directly in the browser or posting
`SHOW_NATIVE_FEEDBACK` to the extension host in the VS Code panel, which
lands on the same `VsCodeUserFeedbackSink` instance. So the two chokepoints
above are exhaustive — no per-call-site migration is needed.

This means `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s architecture goal
(funnel everything through a small number of injected ports) is *already
satisfied* for this specific purpose. This plan does not depend on any
stage of that plan and does not need to wait for it.

---

## Design

### New constant and setting

`src/types/DashboardConstants.ts`, alongside `USER_FEEDBACK_SEVERITY`
(line 764-769):

```typescript
// ============================================================================
// TOAST LEVEL MODES - Minimum severity threshold for operational toast/feedback
// ============================================================================
export const TOAST_LEVEL_MODES = {
  ALL: "all",
  WARNING_AND_ERROR: "warningAndError",
  ERROR_ONLY: "errorOnly",
  OFF: "off",
} as const;

export type ToastLevelMode =
  (typeof TOAST_LEVEL_MODES)[keyof typeof TOAST_LEVEL_MODES];
```

A shared helper, next to the constant, decides whether a given
`UserFeedbackSeverity` clears a given `ToastLevelMode` threshold — one
function, used by both chokepoints, so the ordering between "success"
(never suppressed by this threshold — see Open Questions) and
"info/warning/error" lives in exactly one place rather than being
re-derived twice:

```typescript
export function meetsToastLevel(
  severity: UserFeedbackSeverity,
  level: ToastLevelMode
): boolean {
  if (level === TOAST_LEVEL_MODES.OFF) return false;
  if (level === TOAST_LEVEL_MODES.ALL) return true;
  if (level === TOAST_LEVEL_MODES.ERROR_ONLY) {
    return severity === USER_FEEDBACK_SEVERITY.ERROR;
  }
  // WARNING_AND_ERROR
  return (
    severity === USER_FEEDBACK_SEVERITY.WARNING ||
    severity === USER_FEEDBACK_SEVERITY.ERROR
  );
}
```

### Settings shape

Add one field to `CtrlYokeNotificationSettings`
(`src/types/CtrlYokeSettings.ts:269-284`), as a sibling of `vscode`/
`browser`/`events`, not nested under either — it governs a third,
independent channel:

```typescript
export interface CtrlYokeNotificationSettings {
  vscode: { enabled: boolean };
  browser: { mode: BrowserNotificationMode };
  events: { ... };
  toastLevel: ToastLevelMode; // NEW
  includeWorkflowName: boolean;
  includePromptName: boolean;
  onlyWhenWindowUnfocused: boolean;
}
```

Default: `TOAST_LEVEL_MODES.ALL` (line ~531, alongside the existing
`onlyWhenWindowUnfocused: true` default) — today's behavior is the default,
nothing changes for a user who never opens the setting.

Mirror the same field into `schemas/settings-schema.json`'s `notifications`
object (starts line 790), matching the existing enum-string shape used for
`browser.mode`.

### Where the threshold is checked

**`uiStore.ts`** — both `enqueueToast` and `showToast` read the current
threshold and no-op (return unchanged state) when the incoming severity
doesn't clear it:

```typescript
enqueueToast: (toast) =>
  set((state) => {
    const level = useSettingsStore.getState().fullGlobalSettings?.settings
      .notifications.toastLevel ?? TOAST_LEVEL_MODES.ALL; // fail open before settings load
    if (!meetsToastLevel(toast.severity, level)) return state;
    // ...existing dedupe/enqueue logic unchanged
  }),
```

Same guard added to `showToast`. `useSettingsStore` is already the
project's settings store (`src/ui/webview-react/store/settingsStore.ts`);
`uiStore.ts` does not currently import it, but nothing prevents a
`getState()` read the way other cross-store reads are done elsewhere in the
webview — confirm this is an accepted pattern here (see Open Questions if
not; the fallback is threading the setting in as an argument from the two
callers instead).

**`VsCodeUserFeedbackSink.ts`** — reads the same setting via the existing
module-singleton `configService` (`src/config/CtrlYokeConfigService.ts`),
matching exactly how `NotificationManager.ts:55` already does
(`configService.getAll().notifications`) rather than adding a new
constructor-injected dependency:

```typescript
import { configService } from "../config/CtrlYokeConfigService";
import { meetsToastLevel, TOAST_LEVEL_MODES } from "../types/DashboardConstants";

notify(message: UserFeedback): void {
  const level = configService.getAll().notifications.toastLevel ?? TOAST_LEVEL_MODES.ALL;
  if (!meetsToastLevel(message.severity, level)) return;
  // ...existing switch unchanged
}
```

This covers every path identified in the earlier audit except the two that
are correctly out of scope:

| Surface | Covered? |
|---|---|
| `USER_FEEDBACK` in-app toast (`ToastViewport`) | ✅ via `enqueueToast` |
| Direct webview `showToast()`/`notifyUser()` calls (former Group A/B) | ✅ via `showToast` / `VsCodeUserFeedbackSink` |
| Native VS Code popups from backend `USER_FEEDBACK` | ✅ via `VsCodeUserFeedbackSink` |
| Native VS Code popups from webview `SHOW_NATIVE_FEEDBACK` | ✅ same sink instance |
| `NOTIFICATION_EVENT`→toast translation (standalone only) | ✅ incidentally, same `showToast()` call |
| Boundary-only native popups (`extension.ts` commands, `DevCommands`, `ContextMenuReferenceCommands`, `ScmCommitCommand`, `ExternalFileTrustPrompt`) | ❌ out of scope — these are direct VS Code command/editor integrations, not operational feedback toast; see Non-Goals |
| `NotificationManager` completion popups | ❌ out of scope — governed by `vscode.enabled`/`browser.mode`/event modes already; a separate, unrelated channel by design |
| Browser push / OS notifications | ❌ out of scope — governed by `browser.mode` already |
| CLI/headless `ConsoleUserFeedbackSink` | ❌ out of scope — see Non-Goals |

### Settings UI

`src/ui/webview-react/components/settings/NotificationsSection.tsx` gets
one new row, placed under a new or existing "Noise control" grouping
(there's already a "Noise control" section at line 427-441 for
`onlyWhenWindowUnfocused`), mirroring the existing `EVENT_MODE_OPTIONS` /
`CustomSelect` pattern used for `notif.events.workflowComplete`
(line 340-354):

```tsx
const TOAST_LEVEL_OPTIONS = [
  { value: TOAST_LEVEL_MODES.ALL, label: "All (info, success, warnings, errors)" },
  { value: TOAST_LEVEL_MODES.WARNING_AND_ERROR, label: "Warnings and errors" },
  { value: TOAST_LEVEL_MODES.ERROR_ONLY, label: "Errors only" },
  { value: TOAST_LEVEL_MODES.OFF, label: "Off" },
];
```

```tsx
<SettingInputRow
  label="Toast notifications"
  id="notif-toast-level"
  path="notifications.toastLevel"
  {...rowProps}
>
  <CustomSelect
    id="notif-toast-level"
    value={notif.toastLevel}
    onChange={(value) => onUpdate("notifications.toastLevel", value)}
    options={TOAST_LEVEL_OPTIONS}
  />
  <p className="mt-1 text-xs text-description-fg">
    Controls in-app and native popups for action results (save failed,
    validation errors, etc.) — separate from the completion notifications
    configured above.
  </p>
</SettingInputRow>
```

The description line matters: without it, a user who already sees
"Browser notifications" / event-mode controls above will reasonably assume
this new control is redundant with those. Say explicitly that it's a
different channel.

---

## Type/Message Changes

- `src/types/DashboardConstants.ts`: add `TOAST_LEVEL_MODES`,
  `ToastLevelMode`, `meetsToastLevel()`.
- `src/types/CtrlYokeSettings.ts`: add `toastLevel: ToastLevelMode` to
  `CtrlYokeNotificationSettings` (line 269-284) and its default object
  (line ~508-531).
- `schemas/settings-schema.json`: add `toastLevel` enum to the
  `notifications` object (starts line 790).
- `src/ui/webview-react/store/uiStore.ts`: threshold check in
  `enqueueToast`/`showToast` (line ~1755-1807).
- `src/platform/VsCodeUserFeedbackSink.ts`: threshold check in `notify()`
  (line 19-33).
- `src/ui/webview-react/components/settings/NotificationsSection.tsx`: new
  `TOAST_LEVEL_OPTIONS` + row.

No message-protocol changes — `USER_FEEDBACK` and `SHOW_NATIVE_FEEDBACK`
payloads are unchanged; only the receiving end's decision to render
changes.

---

## Edge Cases

- **Settings not yet loaded in the webview** (`fullGlobalSettings === null`,
  e.g. very early in panel/tab startup). Fail open (`ALL`) rather than
  silently dropping early toasts — a brief window of "can't yet suppress"
  is much less surprising than "toasts silently vanish before settings
  arrive and nobody knows why."
- **`success` severity under `WARNING_AND_ERROR`/`ERROR_ONLY`.** Treated as
  below threshold (not shown) under both — a user asking for
  "warnings and errors" almost certainly wants routine success toast
  suppressed too, not just info. Confirm this matches intent; it's the one
  place `meetsToastLevel`'s behavior isn't fully mechanical from the level
  name alone (see Open Questions).
- **Multiple connected browser clients with different local settings.**
  Settings are workspace/server-scoped, not per-client, so every connected
  browser shares the same `toastLevel` — consistent with how `browser.mode`
  already works today. No new per-client complexity.
- **`OFF` and an error that genuinely blocks progress.** This plan does not
  change or reintroduce any blocking-modal path — `EndConditionHandler`'s
  two `showChoice()` blocking sites are already deleted per
  `BROWSER_USER_FEEDBACK_PLAN.md` Phase 2.5, and `toastLevel: off` only
  suppresses the fire-and-forget toast, never a decision the user must
  make. No workflow can get stuck because toast is off.

---

## Not In Scope (YAGNI)

- **Per-toast "never show again" / a settings-page table of every toast
  site.** Considered and explicitly deferred. It solves a different
  problem (recurring, specific noise) than a global threshold (general
  volume), needs every one of the ~15 webview call sites plus ~39 backend
  scoped-reply sites to carry a stable registered key, needs persisted
  per-key state, and needs its own settings UI. If pursued later, scope it
  to informational/noise-tier toasts only (reusing `ToastItem.dedupeKey` as
  the candidate stable ID) — muting a specific *error* permanently is
  usually the wrong default, since it can hide a real recurring problem
  silently.
- **Changing `notifications.vscode.enabled` to regain its old "silences
  everything" meaning.** That would re-couple two channels
  (`BROWSER_USER_FEEDBACK_PLAN.md` deliberately split apart) and reintroduce
  the risk that a validation error silently vanishes for anyone with
  notifications off — the exact failure mode that plan's Phase 1 called out
  by name. A separate `toastLevel` setting keeps the two channels
  independently controllable, which is also strictly more flexible.
- **Suppressing at the emission points** (`CompositeUserFeedbackSink`,
  `HostedWebSocketUserFeedbackSink`) to save broadcast bandwidth. Not
  needed for a first version — client-side suppression in `uiStore` is
  simpler, matches how `browser.mode`/completion-notification gating
  already work (client renders or doesn't based on synced settings), and
  toast volume is not a bandwidth concern at this scale.
- **`ConsoleUserFeedbackSink` (CLI headless mode).** Console/stderr output
  isn't "toast noise" in the nuisance sense the setting is aimed at — a
  headless `ctrlyoke run` user expects full output. Leave it unfiltered.
- **The boundary-only native popups** in `extension.ts`, `DevCommands.ts`,
  `ContextMenuReferenceCommands.ts`, `ScmCommitCommand.ts`,
  `ExternalFileTrustPrompt.ts`. These are direct VS Code command/editor
  integrations (e.g. "no active editor" warnings), not instances of the
  operational-feedback channel this plan targets, and
  `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` already treats them as a
  permanent, intentional native boundary.

---

## Open Questions

1. Does `uiStore.ts` reading `useSettingsStore.getState()` directly violate
   any existing store-isolation convention in this codebase, or is
   cross-store `getState()` read already an accepted pattern elsewhere in
   `webview-react/store/`? If not accepted, the fallback is passing the
   resolved `ToastLevelMode` in as a parameter from the two callers
   (`useMessageHandler.ts`, `notifyUser.ts`) instead of reading it inside
   the store action itself.
2. Should `success`-severity toast be treated as below the
   `WARNING_AND_ERROR` threshold (current design), or should it get its own
   tier? Leaning toward current design (success is noise-adjacent to info,
   not warning-adjacent), but worth confirming against actual user intent
   once this ships.
3. Naming: `toastLevel` vs. something that more clearly distinguishes it
   from the `events.*` completion-notification modes at a glance in the
   settings JSON (e.g. `feedbackLevel`, `operationalToastLevel`). No strong
   reason to prefer one over another yet.
