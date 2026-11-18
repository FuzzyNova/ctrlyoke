# Steering a parallel group of headless steps always targets the lowest-numbered member

- **Found:** 2026-11-17 by Claude (live test with two headless Claude members)
- **Area:** `src/ui/webview-react/hooks/useActiveSteerTarget.ts`, `src/ui/webview-react/hooks/useInterruptTurnTarget.ts`
- **Resolution:** fixed in this commit. Instead of the "convenience" bullet below (moving the
  soloed or rail-selected session to the top of the Run menu), a step's own context menu
  carries **Send Steer to Step**, which sends the prompt editor's draft to that step's live
  session; the Run menu order never depends on solo or rail state.

## Symptom

With several headless members of a parallel group running, **Send Steer Message** and
**Interrupt Turn** always go to the member with the lowest step index. There is no way to
steer or interrupt the others. Interactive members do not have this problem: steering follows
the terminal tab selected in the rail.

## Steps to Reproduce

1. Run a `parallel` group with two headless Claude members that each run a long command.
2. Open the Run menu. The tooltip reads "Sends to the live Claude Code session (step 1)".
3. Nothing selects step 2.

## Root Cause

`terminalStore.headlessControlTargets[workflowId]` holds every open target sorted by step
index, and `useActiveSteerTarget` returns `targets[0]` when no AI-CLI PTY is rail-active.
`useInterruptTurnTarget` likewise takes the first interruptible target. Separately, a
rail-active PTY always takes priority, so while a retained interactive terminal is selected,
a running headless step cannot be steered at all.

## Suggested Fix

Make the destination an explicit choice in the menu, not something inferred from where the
user has scrolled, what they have soloed or which rail tab is selected.

- **One shared selector**, `useSteerTargets(workflowId)`, returns every live destination:
  each open headless control target (`headlessControlTargets[workflowId]`) and each
  `AI_CLI` PTY in `terminalStore.sessions[workflowId]` whose status is `RUNNING`. That
  includes retained idle terminals from completed steps, which `STEER_MESSAGE_PLAN.md`
  designed for on purpose ("between runs ... the safer and arguably primary one"). Each
  entry carries `sessionId`, `stepIndex`, `harnessId`, `steerDelivery`, `canInterruptTurn`
  and whether its step is executing now. Sort executing steps first, by step index, then
  idle terminals. `useActiveSteerTarget`, `useInterruptTurnTarget` and
  `useRunDispatchTargets` all derive from it, so steer and interrupt cannot disagree.
- **One destination:** the Run menu stays exactly as today, with a single
  "Send Steer Message" whose tooltip names the step.
- **Several destinations:** "Send Steer Message" is replaced by a flat list of items in
  the same `SplitButton` menu (no submenu, no post-click dialog), one per destination,
  followed by the existing divider. For example:
  - `Steer Step 2 · Claude Code`
  - `Steer Step 3 · Qwen Code (after turn)`, the suffix marking `QUEUE` delivery
  - `Steer Step 1 · Claude Code (finished)`, an idle retained terminal

  The tooltip keeps today's per-delivery wording. Each item sends its own `sessionId` in the
  unchanged `SEND_STEER_MESSAGE` payload; the host already routes by session id
  (`WorkflowInstance.sendSteerMessage`).

- **Interrupt Turn becomes End Step Early, on the step's own context menu** (decided
  2026-11-17). It ends that step's current turn, keeps the output so far, records the step
  as succeeded and lets the workflow continue (see "End Step Early" in the Decisions of
  `dev/implemented/HEADLESS_SESSION_CONTROL_PLAN.md`). The name "Interrupt Turn" suggested
  the TUI meaning (stop and wait for me), which is the opposite of what it does.
  - Add an **End Step Early** item to `useStepContextMenu`, shown only on a running step,
    after Reply to Step. It is enabled when that step's open control target has
    `canInterruptTurn`. Otherwise it is disabled with a reason, e.g. "End Step Early needs
    a headless Claude Code, Codex or Qwen step". Tooltip: "Stops step N's current turn,
    keeps its output so far, and continues the workflow."
  - The pressed step _is_ the target, so End Step Early needs no picker. It looks up its
    control target by `stepIndex` in the shared selector, not by "first interruptible".
  - Remove Interrupt Turn from the header Stop button's context menu; see
    [`header-control-buttons-have-context-menus.md`](header-control-buttons-have-context-menus.md).
  - Rename the user-facing strings only: the CHANGELOG entry (still under Unreleased, so
    there is no compatibility concern), `docs/guide/dashboard.md`,
    `docs/harnesses/codex-cli.md`, and the `useInterruptTurnTarget` titles.
    `INTERRUPT_HEADLESS_TURN` and the channel `interrupt()` methods keep their names;
    they describe the protocol action.
- **Convenience, not gating:** a soloed parallel member or the rail-selected terminal can
  move its entry to the top of the list with a marker (e.g. a check or "selected"), but it
  never hides the other destinations and never disables steer.
- The host already re-checks liveness, so a destination that ends between opening the
  menu and clicking still gets today's "That harness session has ended" error.

Rejected alternatives: requiring a solo or scroll position to pick the target (hidden
state, extra steps); a modal picker after clicking (an extra click every time, and the
menu already knows the list); a submenu (the list is short and a submenu is fiddly in a
`menuPlacement="top"` portal menu on touch).
