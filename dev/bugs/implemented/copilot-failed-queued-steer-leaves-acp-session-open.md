# A queued Copilot steer that fails after the turn ends leaves the ACP session open forever

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/shared/CliTransportCoordinator.ts` (`activeHeadlessControlSend`, `closeAfterTurnEnd`), `src/core/harness/copilot/CopilotHeadlessControlChannel.ts` (`sendQueuedUserMessage`)
- **Resolution:** fixed in this commit

## Symptom

A headless Copilot ACP step is running. The user sends a steer, and the
running `session/prompt` then fails, for example with
`{"id":3,"error":{"message":"rate limited"}}`. The steer is rejected with the
*previous turn's* error ("rate limited"). stdin is never ended, so
`copilot --acp` waits for input forever and the step never finishes. The same
run without a steer settles normally and ends stdin.

Any other failure of a queued send after TURN_END has the same effect (for
example, a write that fails).

## Steps to Reproduce

Reproduced with the real coordinator and `CopilotHeadlessControlChannel`
bundled against a fake process:

1. Start a headless step. The channel sends `session/prompt` (id 3).
2. While it runs, call the active steer send. The steer queues and waits on
   prompt 3.
3. Have the fake child reply to id 3 with a JSON-RPC error.

The output was `steer rejected: rate limited`, then
`run: HUNG after 2s stdinEnded: false`. The control run without step 2 gave
`settled:true stdinEnded: true`.

## Root Cause

- A steer sent mid-turn is reserved into `queuedSteersSubmittedDuringTurn`
  (`reserveSteer`, around line 625).
- At TURN_END, `updateSteerStateAtTurnEnd()` (around line 831) moves the steer
  to `queuedSteersAwaitingTurn` and keeps `controlTurnActive = true`.
  `closeAfterTurnEnd` then returns early because `hasOutstandingSteers()` is
  true (around line 730).
- When `controlChannel.sendUserMessage(text)` throws, the catch (around line
  1011) only calls `releaseReservation()`. That empties the queue and clears
  `controlTurnActive`, but nothing calls `closeAfterTurnEnd()` again. No
  prompt was sent, so no further TURN_END arrives, and stdin is never closed.
- The throw comes from `CopilotHeadlessControlChannel.ts:164-167`:
  `sendQueuedUserMessage` runs `await priorRequest.result`, so it rejects with
  the error of the prompt it was queued behind.

## Suggested Fix

1. In the steer send's catch, after `releaseReservation()`, re-run the
   close-after-turn-end check: close when `!controlTurnActive &&
   !hasOutstandingSteers()`. Doing this inside the release function itself
   would also work.
2. In `CopilotHeadlessControlChannel.sendQueuedUserMessage`, don't hand the
   earlier prompt's rejection to the steer. Wait with
   `priorRequest.result.catch(() => undefined)`, then send the steer or fail
   it with a steer-specific error.

Tests:

- `src/test/unit/CliTransportCoordinator.test.ts`: a queued steer that fails
  after TURN_END must still end stdin and settle the step.
- `src/test/unit/CopilotHeadlessControlChannel.test.ts`: a steer queued behind
  a prompt that errors is not rejected with that prompt's error.
