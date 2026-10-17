# Web Push VAPID subject is a placeholder `mailto:ctrlyoke@example.com`

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, code-sanity auditor)
- **Area:** `src/server/WebPushService.ts` (~L95, ~L265), `src/server/CtrlYokeHostedServer.ts` (~L406)
- **Severity:** medium

## Symptom

Every web push sent from the hosted dashboard carries `mailto:ctrlyoke@example.com` in the VAPID
JWT `sub` claim. Push services use that claim to contact the sender, and some (notably Apple's)
are known to reject invalid subjects. The line also holds the only `TODO` in shipped `src/`
("update this with a valid support email when we get one"), and `support@ctrlyoke.dev` now exists.

## Steps to Reproduce

1. Enable push notifications on the hosted dashboard and trigger a notification.
2. Decode the VAPID JWT in the push request. `sub` is `mailto:ctrlyoke@example.com`.

## Root Cause

`WebPushService`'s constructor default for `vapidSubject` is the placeholder, and its only caller
passes `undefined`.

## Suggested Fix

Add a support-contact constant (e.g. in `DashboardConstants.ts`) set to `mailto:support@ctrlyoke.dev`,
use it as the default, and remove the TODO.
