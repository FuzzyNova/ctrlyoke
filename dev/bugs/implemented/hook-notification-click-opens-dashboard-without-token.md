# Clicking a hook-event browser/push notification opens the hosted dashboard without its token (401 page)

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code-path review
- **Area:** `src/core/harness/shared/HookEventMonitor.ts`, `src/server/CtrlYokeHostedServer.ts` (`dispatchCompletionNotification`), `src/server/ctrlyoke-service-worker.js`
- **Resolution:** fixed in this commit

## Symptom

With hook-event notifications enabled (e.g. `notifications.events.hookEvents.stop`)
and browser notifications in `push` or `connectedOnly` mode, clicking a
"ctrlyoke - Agent stop" (or any hook) notification navigates the open dashboard
window to `/`, or opens a new window there. The page is the hosted server's
"You need a valid ctrlyoke access token" 401 page. Workflow-completion and
prompt-completion notifications open the dashboard correctly.

## Steps to Reproduce

1. Enable `ctrlyoke.enableServer`, set `notifications.browser.mode` to `push`
   (or `connectedOnly`), and enable `notifications.events.hookEvents.stop`.
2. Open the hosted dashboard (installed PWA or secure context) and allow notifications.
3. Run a workflow, then click the hook notification when it appears.
4. The dashboard window shows the 401 page instead of the dashboard.

## Root Cause

- `HookEventMonitor.ts` (~line 80) calls
  `buildHookNotificationEvent(artifact, settings)` without a `url`, so the event's
  `url` (`CompletionNotificationFactory.ts` ~395) is always `undefined`.
- `CtrlYokeHostedServer.dispatchCompletionNotification` (~2112) broadcasts the
  event and sends it to `WebPushService` unchanged. Completion events get
  `url: this.publicUrl` where they are built (~405, ~624). Hook events don't.
- `ctrlyoke-service-worker.js` falls back to `"/"` (lines ~21/29) and, on
  `notificationclick`, calls `client.navigate(targetUrl)` on the first window
  client (~39) or `openWindow("/")`.
- `requestHasValidToken` (~2066) accepts only the `x-ctrlyoke-token` header or a
  `?token=` query, so a navigation to `/` gets `sendUnauthorizedPage`.
- The connected path (`src/ui/webview-react/.../browserNotifications.ts` ~248)
  also passes `url: undefined` to `registration.showNotification`, so its clicks
  go through the same handler.

## Suggested Fix

1. In `dispatchCompletionNotification`, default a missing URL to the
   authenticated public URL (`event.url ?? this.publicUrl`) before broadcasting
   or pushing, so every notification kind is covered from one place.
2. Harden the service worker: when `data.url` is missing, only `focus()` an
   existing client and do not `navigate()` it; open a new window only when a
   real URL exists.

Add a hosted-server unit test showing that a hook event without a URL is
dispatched with the tokenized public URL.
