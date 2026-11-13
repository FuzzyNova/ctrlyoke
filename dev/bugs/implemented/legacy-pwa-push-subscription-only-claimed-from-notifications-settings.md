# A PWA set up before push ownership is only matched to its project from Notifications settings

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading (every caller traced)
- **Area:** `src/ui/webview-react/utils/browserNotifications.ts` (`getBrowserNotificationStatus`), `src/server/WebPushService.ts` (`isDeliverable`)
- **Resolution:** fixed in this commit

## Symptom

The 0.7.0 entry in `CHANGELOG.md` promises: "A PWA set up before this fix is matched to
its project the next time you open it, and until then it keeps receiving every
project's notifications." Opening the PWA does not match it. It is matched only when
the user opens **Settings → Notifications** inside the PWA, or when a completion event
arrives over the live socket while the window is unfocused. A PWA that is opened and
used normally, or never opened again (e.g. for a project that no longer runs), keeps
receiving every project's push notifications indefinitely.

## Steps to Reproduce

1. On 0.6.x, install the hosted dashboard as a PWA for project A and enable Push. Its
   registry entry has no `workspaceKey`.
2. Upgrade and run `ctrlyoke server` (or VS Code with the server) for projects A and B.
3. Open A's PWA, use the dashboard while it is focused, close it. Don't open
   Settings → Notifications.
4. Finish a workflow in project B: A's PWA still receives B's push notification, and
   every later one.

## Root Cause

The claim step lives inside `getBrowserNotificationStatus()`
(#selection:src/ui/webview-react/utils/browserNotifications.ts:73-84): it re-registers
the browser's subscription when the server doesn't list the stored id, which records
the workspace on it. Only two callers reach it:

- `NotificationsSection.tsx` (`refreshStatus` in a `useEffect`), which mounts only when
  the Notifications settings tab is open.
- `handleCompletionNotificationEvent`
  (#selection:src/ui/webview-react/utils/browserNotifications.ts:166-186), which returns
  before the status check when the browser mode is `never`, or when
  `onlyWhenWindowUnfocused` is set (the default) and the dashboard is visible and
  focused. A backgrounded phone PWA has no socket, so this path does not run either.

Nothing at app startup runs the claim. Meanwhile `WebPushService.isDeliverable`
(#selection:src/server/WebPushService.ts:386-391) delivers every entry with no
`workspaceKey` from every server.

`docs/guide/notifications.md` (the Push row of the mode table) also still says Push
goes "to every subscribed browser or phone"; it now goes only to devices registered
through this project's server.

## Suggested Fix

Extract the claim into an exported `claimPushSubscriptionIfUnowned()` in
`browserNotifications.ts` (standalone, push supported, secure context, a current
`pushManager.getSubscription()`, stored id not in the server's list → register it) and
have `getBrowserNotificationStatus()` reuse it. Call it once per dashboard load in
hosted standalone mode (App startup or after the hosted socket connects), best-effort
and silent on failure. Add a Vitest case that a standalone load with an unlisted
subscription registers it without the Notifications section being mounted. Fix the
Push row in `docs/guide/notifications.md`.
