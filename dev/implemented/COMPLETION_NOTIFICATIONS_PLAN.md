# Workflow Completion Notifications Plan

## Problem

When a workflow runs in the background - headless mode, interactive mode while the
user is focused elsewhere, or server mode from a phone - there is no reliable signal
when it finishes. The user has to keep checking the dashboard or status bar. For
workflows that take 5-30+ minutes this is significant friction.

The notification system should cover:

- VS Code users who want native `vscode.window.showInformationMessage` toasts.
- Browser dashboard users connected through the FlightPath hosted server.
- Mobile browser users, including phones added to a home screen, where notifications
  need service worker support.
- Users who want workflow-level notifications only, plus users who want more granular
  prompt-level notifications.

---

## Current Code Shape

The plan needs to target the newer structured settings model in
`src/types/FlightPathSettings.ts`, not separate legacy `flightpath.notifications.*`
settings in `package.json`.

Current relevant settings groups:

- `execution`: completion behavior such as `closeTerminalOnComplete`.
- `queue`: queue limits and the existing `notifyOnExtension` boolean.
- `ui`: dashboard and confirmation preferences.
- `server`: hosted browser dashboard settings, including `enabled`, `bindAddress`,
  and `tls`.

`src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` renders settings
by tab. Sections live under `src/ui/webview-react/components/settings/` and receive:

```ts
settings: FullGlobalSettings;
onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
```

So notification settings should be added as a new top-level group and edited through
a new drawer tab, not squeezed into Execution or Queue.

---

## Research Notes: Browser Notifications

Browser notifications split into two different capabilities:

1. **Local page notifications while the dashboard is open.** The page receives the
   workflow event over the existing WebSocket, then asks the browser to show a
   notification. Desktop can often use `new Notification(...)`. Mobile browsers
   should use `ServiceWorkerRegistration.showNotification()` instead.
2. **Push notifications when the page is closed or backgrounded.** This requires a
   service worker, Push API subscription, VAPID keys, server-side subscription
   storage, and the server sending Web Push payloads to browser push endpoints.

Important constraints from current browser docs:

- Notification permission must be requested from a user gesture, such as clicking an
  "Enable browser notifications" button. Browsers increasingly block permission
  prompts that are not user-initiated.
- Notifications and Push API require a secure context. `localhost` may work for
  desktop development, but phones using `http://<LAN IP>:4747` will not have a secure
  context. Mobile browser support should require `server.tls.enabled` with a trusted
  certificate or a secure tunnel.
- MDN notes that the `Notification()` constructor is fine for desktop, but mobile
  should register a service worker and call `ServiceWorkerRegistration.showNotification()`.
- iOS/iPadOS Web Push is supported for Home Screen web apps on iOS/iPadOS 16.4+.
  The app must be added to the Home Screen, permission must be requested from a direct
  user interaction, and standards-based Push API + Notifications API + Service Worker
  plumbing is used.

Sources:

- MDN, Using the Notifications API:
  https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
- MDN, Push API:
  https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- WebKit, Web Push for Web Apps on iOS and iPadOS:
  https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Apple, Sending web push notifications in web apps and browsers:
  https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers

---

## Notification Surfaces

### 1. VS Code Toast Notification

Use `vscode.window.showInformationMessage`, `showWarningMessage`, or
`showErrorMessage` from extension-side code.

This is the v1 default because it is simple, native to extension users, and does not
require browser permission state.

Actions:

- `Open Dashboard`
- `View Output`
- `Dismiss`

Rules:

- Workflow success -> information notification.
- Workflow failure -> error notification.
- Workflow timeout/stopped by runtime limit -> warning notification.
- Manual pause/cancel -> no notification by default because the user initiated it.
- Prompt-level success -> disabled by default because it can be noisy.
- Prompt-level failure -> allowed as a granular option.

### 2. In-App Dashboard Toast

The React UI already has transient toast state in `uiStore`. Keep this as a passive
dashboard-local signal, useful when browser notification permissions are denied or
unsupported.

This should not be the only surface because it requires the dashboard to be visible.

### 3. Browser System Notification While Connected

For the hosted server dashboard, show a browser system notification when the browser
client is connected over WebSocket and a matching event arrives.

Implementation approach:

- Add notification support detection in the webview React app.
- Add an explicit "Enable browser notifications" button in the Notifications settings
  page.
- On click, call `Notification.requestPermission()`.
- Register a service worker in hosted-browser mode.
- Prefer `registration.showNotification(...)` when a service worker is available.
- Fall back to `new Notification(...)` only on desktop browsers where supported.

This covers desktop browsers and mobile browsers while the page/PWA is open enough to
receive the WebSocket event. It does not cover a phone after the browser tab is closed.

### 4. Web Push Notification While Disconnected

Add as phase 2. This is required for "I visited the FlightPath server on my phone and
want a notification even after switching apps or closing the tab."

Implementation approach:

- Serve a web app manifest from `FlightPathHostedServer`.
- Serve a service worker script from `FlightPathHostedServer`.
- Generate and persist VAPID keys.
- Add server routes for browser push subscription registration and deletion.
- Store subscriptions under `.flightpath/` or user settings, scoped by workspace and
  authenticated by the existing server token.
- On workflow/prompt completion, send Web Push payloads to subscribed clients whose
  settings match the event.
- Remove expired/410 subscriptions.

Mobile requirements:

- HTTPS is required for phone access. For LAN use, the cert must be trusted by the
  phone OS/browser; self-signed certs are a developer convenience but may still block
  service worker or push registration until trusted.
- iPhone/iPad users need iOS/iPadOS 16.4+ and should add the FlightPath server page to
  the Home Screen for push while backgrounded.
- Android Chrome/Edge/Firefox can use standard Web Push when service worker, secure
  context, and permission requirements are met.

---

## Settings Model

Add a top-level `notifications` group to `FlightPathGlobalSettings`.

Suggested types:

```ts
export type NotificationEventMode = "all" | "failuresOnly" | "never";
export type BrowserNotificationMode = "connectedOnly" | "push" | "never";

export interface FlightPathNotificationSettings {
  vscode: {
    enabled: boolean;
  };
  browser: {
    mode: BrowserNotificationMode;
  };
  events: {
    workflowComplete: NotificationEventMode;
    promptComplete: NotificationEventMode;
  };
  includeWorkflowName: boolean;
  includePromptName: boolean;
  onlyWhenWindowUnfocused: boolean;
}
```

Add to `FlightPathGlobalSettings`:

```ts
notifications: FlightPathNotificationSettings;
```

Add defaults:

```ts
notifications: {
  vscode: {
    enabled: true,
  },
  browser: {
    mode: "never",
  },
  events: {
    workflowComplete: "all",
    promptComplete: "never",
  },
  includeWorkflowName: true,
  includePromptName: true,
  onlyWhenWindowUnfocused: true,
}
```

Why this shape:

- Channel enablement is separate from event granularity.
- Workflow and prompt notifications can evolve independently.
- Browser support can start with `connectedOnly` and later enable `push` without
  changing the event settings shape.
- `queue.notifyOnExtension` can remain where it is for now because it is queue-limit
  behavior, not completion behavior. A future cleanup could move it into
  `notifications.events.queueExtended`.

Possible future extension:

```ts
events: {
  workflowComplete: NotificationEventMode;
  promptComplete: NotificationEventMode;
  finalStepIterationComplete: NotificationEventMode;
  queueExtended: NotificationEventMode;
}
```

Do not add per-harness notification settings in v1. Completion events are workflow
events and should behave consistently across harnesses.

---

## Settings UX

Add a new `NotificationsSection.tsx` under
`src/ui/webview-react/components/settings/`.

Update `GlobalSettingsDrawer.tsx`:

- Import `NotificationsSection`.
- Add `{ id: "notifications", label: "Notifications", icon: "codicon-bell" }`
  to `ALL_TABS`.
- Place it after `Execution` and before `Terminal`; that keeps it near runtime
  behavior without burying browser setup under Server.
- Render it with `settings={fullSettings}` and `onUpdate={handleUpdate}`.

Update `src/ui/webview-react/components/settings/index.ts` to export it.

Suggested layout:

1. **Channels**
   - `VS Code toasts` checkbox -> `notifications.vscode.enabled`
   - `Browser notifications` select -> `notifications.browser.mode`
     - `Off`
     - `While dashboard is open`
     - `Push when backgrounded`
   - Browser permission status row:
     - `Unsupported`
     - `Blocked`
     - `Needs permission`
     - `Allowed`
   - `Enable browser notifications` button. This must be the direct user gesture that
     calls `Notification.requestPermission()`.
2. **Events**
   - `Workflow complete` select -> `notifications.events.workflowComplete`
     - `Success and failure`
     - `Failures only`
     - `Off`
   - `Prompt complete` select -> `notifications.events.promptComplete`
     - `Success and failure`
     - `Failures only`
     - `Off`
3. **Content**
   - `Include workflow name` checkbox.
   - `Include prompt name` checkbox.
4. **Noise control**
   - `Only notify when FlightPath is not focused` checkbox.

Browser-specific helper text:

- In VS Code webview mode, show that browser notifications apply to the hosted server
  dashboard, not the VS Code sidebar.
- If `notifications.browser.mode !== "never"` and `server.tls.enabled` is false, show:
  "Phone notifications require HTTPS. Enable server TLS or use a secure tunnel."
- If on iOS and not running as a standalone Home Screen app, show:
  "For iPhone/iPad push while backgrounded, add FlightPath to the Home Screen first."

---

## Notification Events

### Workflow Complete

Fires once per workflow run when the workflow reaches a terminal state:

- `EXECUTION_STATES.COMPLETED`
- `EXECUTION_STATES.ERROR`
- timeout-driven stopped state, if distinguishable from user cancel

Payload should include:

- `workflowId`
- `workflowName`
- `fileName`
- terminal state
- completed prompt count
- total prompt count
- duration
- failed step index/name when available
- whether the terminal state was user-initiated

### Prompt Complete

Fires when a single prompt or script step reaches a terminal state:

- completed
- failed
- cancelled by timeout

Default is `never`. If enabled, use `failuresOnly` or `all`.

Rules:

- Notify for failed prompt/script steps when `promptComplete` is `failuresOnly` or `all`.
- Notify for successful prompt/script steps only when `promptComplete` is `all`.
- Do not double-notify final workflow success for the last prompt. If the last prompt
  completes and the workflow immediately completes, prefer the workflow notification
  unless prompt-level notifications are explicitly set to `all`.
- Include final-step loop notifications only in a later setting; looping final steps
  can be too noisy.

---

## Notification Content

### Workflow Success

**FlightPath - Workflow Complete**

`refactor.flightpath.yaml` - 4 prompts completed in 3m 42s

Actions: `Open Dashboard`

### Workflow Failure

**FlightPath - Workflow Failed**

`refactor.flightpath.yaml` - failed at step 2 "implement" after 2 retries

Actions: `Open Dashboard`, `View Output`

### Workflow Timeout

**FlightPath - Workflow Timed Out**

`refactor.flightpath.yaml` - completed 2 of 4 prompts before timeout

Actions: `Open Dashboard`, `View Output`

### Prompt Complete

**FlightPath - Prompt Complete**

`refactor.flightpath.yaml` - step 2 "implement" completed in 1m 08s

Actions: `Open Dashboard`, `View Output`

### Prompt Failure

**FlightPath - Prompt Failed**

`refactor.flightpath.yaml` - step 2 "implement" failed after 2 retries

Actions: `Open Dashboard`, `View Output`

Respect `includeWorkflowName` and `includePromptName` when building the content.

---

## Implementation

### Phase 1: VS Code + Connected Browser Notifications

1. Add `notifications` to `FlightPathGlobalSettings`, `PartialFlightPathSettings`,
   and `FLIGHTPATH_SETTINGS_DEFAULTS`.
2. Add constants for notification modes to `DashboardConstants.ts` instead of using
   repeated string literals across files.
3. Update config loading:
   - `configService.getAll()` will pick up defaults automatically once the type/default
     are updated.
   - Add `"notifications"` to the `keys` array in
     `WebviewSettingsSync.handleGlobalSettingsLoadRequest()`.
4. Add `NotificationsSection.tsx` and wire it into `GlobalSettingsDrawer.tsx`.
5. Add message types for browser permission/subscription flow:
   - `BROWSER_NOTIFICATION_STATUS_REQUEST`
   - `BROWSER_NOTIFICATION_STATUS`
   - `BROWSER_NOTIFICATION_PERMISSION_REQUEST`
   - `BROWSER_NOTIFICATION_PERMISSION_RESULT`
   These should be added to `DashboardConstants.ts` and typed in
   `WebviewMessageTypes.ts`.
6. Add a `NotificationManager` under `src/ui/` for VS Code toasts.
   - It should consume terminal workflow and prompt events, not harness-specific hook
     files.
   - Keep message construction in one helper to avoid duplicating title/body/action
     strings.
7. For hosted browser clients, add a webview-side notification helper:
   - Detect browser support.
   - Register service worker in hosted mode only.
   - Request permission from the settings button only.
   - Show notifications for events received over the existing WebSocket.

Potential event source options:

- Preferred: add explicit notification event methods to `IDashboardSink` and implement
  message shapes in `PostMessageDashboardSink`, then delegate in `FlightPathHostedServer`
  and `FlightPathWebviewProvider`.
- Acceptable for v1: derive workflow completion from existing execution-state messages
  in a `NotificationManager`, but avoid duplicating state interpretation in both VS Code
  and browser clients.

### Phase 2: Web Push for Background Phones

1. Serve a manifest from `FlightPathHostedServer`:
   - `name`: `FlightPath`
   - `short_name`: `FlightPath`
   - `display`: `standalone`
   - `start_url`: include or recover the authenticated server token safely.
   - icons: reuse existing FlightPath icon assets.
2. Serve a service worker script from `FlightPathHostedServer`.
3. Add CSP allowances needed for service worker and push subscription registration.
4. Generate VAPID keys and expose only the public key to clients.
5. Add authenticated server endpoints:
   - `GET /api/notifications/vapid-public-key`
   - `POST /api/notifications/subscriptions`
   - `DELETE /api/notifications/subscriptions/:id`
6. Persist subscriptions with enough metadata to support cleanup:
   - endpoint hash
   - user agent
   - created/updated timestamps
   - last success/failure
   - client label if the user names the phone/browser
7. On matching workflow/prompt events, send Web Push payloads from the hosted server.
8. Remove expired subscriptions and surface stale subscription count in the settings UI.

Security notes:

- Require the existing server token for subscription management routes.
- Treat Push API endpoints as secrets. Do not log full endpoints.
- Avoid notification payloads that include sensitive prompt output. Use workflow/prompt
  names and status only.

---

## Avoiding Double Notifications

- Deduplicate by `{workflowId, runId, eventKind, target}`.
- For workflow completion, emit once from the state machine terminal transition.
- For prompt completion, emit once when the prompt reaches a terminal status.
- If both VS Code and a hosted browser are open, both channels may notify if both are
  enabled; this is expected because they are different devices/surfaces.
- Within one channel, never show both a prompt-complete and workflow-complete message
  for the same last-step success unless prompt completion is explicitly set to `all`.

---

## CLI Mode

The CLI binary (`src/cli.ts`) already prints completion status to stdout/stderr and
uses exit codes/JSON output as its automation surface.

No desktop notification should be added to pure CLI mode in this plan.

For `flightpath` server mode, browser notifications belong to the hosted dashboard
client and server push implementation, not the CLI process itself.

---

## What Not To Build In V1

- Email, Slack, Discord, Teams, or webhook notifications.
- Sound effects.
- Per-harness notification settings.
- Per-prompt custom notification overrides in workflow files.
- Prompt-output snippets in push payloads.
- Final-step loop notifications, unless added later behind a separate setting.

---

## Effort

Phase 1: 1-2 days.

- Settings model and drawer UI are straightforward.
- VS Code notifications are straightforward.
- Connected browser notifications require service worker setup and compatibility testing,
  especially mobile.

Phase 2: 2-4 additional days.

- Web Push requires manifest/service worker work, VAPID key handling, subscription
  persistence, HTTPS guidance, endpoint cleanup, and manual testing across desktop,
  Android, and iOS/iPadOS Home Screen web apps.

---

## Test Plan

Automated:

- Settings defaults include `notifications`.
- `PartialFlightPathSettings` accepts partial notification settings.
- `WebviewSettingsSync.handleGlobalSettingsLoadRequest()` includes notification source.
- Notification filtering handles:
  - workflow success
  - workflow failure
  - prompt success
  - prompt failure
  - `all`
  - `failuresOnly`
  - `never`
- Deduplication suppresses repeated terminal events.

Manual:

- VS Code toast appears for workflow success/failure.
- `Open Dashboard` focuses the correct workflow.
- `View Output` opens the relevant output.
- Prompt-level success does not notify by default.
- Prompt-level failure notifies when configured.
- Hosted desktop browser requests permission only after button click.
- Hosted desktop browser shows notification while connected.
- Android phone over HTTPS can enable browser notifications and receive connected
  notifications.
- iPhone/iPad over HTTPS can add FlightPath to Home Screen, request permission from
  the settings button, and receive Web Push in phase 2.
