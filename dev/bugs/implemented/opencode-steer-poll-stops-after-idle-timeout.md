# OpenCode headless steering stops working after 20 s with no steer

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against the compiled host channel and V2 plugin with a fake OpenCode context)
- **Area:** `src/scripts/ctrlyoke-opencode-plugin-v2/index.ts` (`startSteerPolling` ~347-380), `src/core/harness/opencode/OpenCodeHeadlessControlChannel.ts` (`handleSteerPoll` ~448-482)
- **Resolution:** fixed in this commit

## Symptom

On an OpenCode headless step, a steer sent within ~20 s of the turn starting is
delivered. Once a turn has gone 20 s with no steer, every later steer from the
dashboard hangs until the turn ends and is then rejected with "OpenCode session
has already ended; the steer message was not queued." `session.prompt` is never
called for it.

## Steps to Reproduce

1. Run an OpenCode (2.3.0+) headless step whose turn lasts longer than 20 s
   (e.g. a long tool call).
2. Wait more than 20 s without steering.
3. Send a steer message to the step from the dashboard.
4. The steer is not delivered; at turn end it fails with the message above.

## Root Cause

The host answers an empty long-poll with `204 No Content` after
`STEER_POLL_TIMEOUT_MS = 20_000` (`OpenCodeHeadlessControlChannel.ts:54`,
`finishSteerPoll(poll, HTTP_STATUSES.NO_CONTENT)` at ~476). That means "no steer
yet, poll again". A finished session is reported with `410 Gone`.

The plugin's poll loop treats both the same and stops polling for good:

```ts
if (response.status === 204 || response.status === 410) return;
```

(`src/scripts/ctrlyoke-opencode-plugin-v2/index.ts:362`). After that, no poll is
pending, so `sendUserMessage` leaves the steer in `queuedSteers` until
`rejectQueuedSteers` fires at turn end. The surrounding `while (!signal.aborted)`
loop, with its `continue` on an empty body, shows the loop was meant to keep
polling.

`OpenCodePlugin.test.ts` has no steering coverage.

## Suggested Fix

In the plugin, `continue` on 204 and `return` only on 410 (and on abort). Add a
plugin test where an empty poll answers 204, a later poll returns a steer, and
`session.prompt` is called with `delivery: "steer"`. Remember the plugin is a
deployed script: check whether the deployed copy needs a version bump or
re-deploy so existing installs pick up the fix.
