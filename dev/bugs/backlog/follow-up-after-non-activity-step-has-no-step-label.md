# Follow-up output after a non-activity step block gets no step label

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/utils/outputRows.ts`
- **Severity:** low

## Symptom

b15ca0684 labels a follow-up slice when an open terminal resumes writing under a
step whose output sits above another step's output. If the step in between
produced only non-activity output (for example a silent script step, which
streams no chunk), the follow-up is rendered without a label, so it reads as
output of the later step. That contradicts the new sentence in
`docs/guide/terminal.md` and the CHANGELOG entry.

## Steps to Reproduce

Feed `buildOutputRows` these messages, in order:

1. Step 1 activity text "A" (`OUTPUT_ACTIVITY_KINDS.TEXT`, sequence 1).
2. Step 2 non-activity CLI message: a script with `responseText: ""`, `exitCode: 0` (sequence 2).
3. Step 1 activity structured event "A-followup" (sequence 3).

The step-1 structured-event row after step 2's block has `activityFirst`
undefined and no `activityLabel`. The expected result is `activityFirst: true` with label "Step 1".

## Root Cause

`stampActivityFirst` is gated on `activityFirst`, i.e.
`previousActivityTargetKey !== targetKey`. That key only changes on activity
messages. `resumesAfterOtherStep` correctly sees that rows switched to step 2
(`previousRowTargetKey`), but because step 2's block was non-activity,
`previousActivityTargetKey` still points at step 1 and the gate fails. Both the
CLI path (`outputRows.ts` ~2736-2746) and the status path (~2547-2565) have the
same gate.

## Suggested Fix

Stamp when `message.isActivity && (resumesAfterOtherStep || (isInParallelGroup(target) && previousActivityTargetKey !== targetKey))`,
or update `previousActivityTargetKey` when a non-activity message emits rows.
Do this on both paths and add a test with a silent script step in between.
