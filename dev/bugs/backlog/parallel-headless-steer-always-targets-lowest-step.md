# Steering a parallel group of headless steps always targets the lowest-numbered member

- **Found:** 2026-11-17 by Claude (live test with two headless Claude members)
- **Area:** `src/ui/webview-react/hooks/useActiveSteerTarget.ts`, `src/ui/webview-react/hooks/useInterruptTurnTarget.ts`
- **Severity:** medium

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

Let the output pane's focus choose the headless target. The parallel group header already
has per-member solo chips (`ParallelGroupHeaderRowView`). When exactly one member is soloed,
target that member's channel. When none is soloed and more than one target is open, disable
steer with a reason such as "Several headless steps are running — select one in the output
filter". Consider the same rule for choosing between a selected PTY and a headless step
(e.g. a soloed headless member wins over the rail tab). The target choice should be one
shared selector so steer and interrupt cannot disagree.
