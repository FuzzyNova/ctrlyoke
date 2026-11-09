# Follow-up output from earlier sequential steps has no step attribution

- **Found:** 2026-11-09 by user
- **Area:** `src/ui/webview-react/utils/outputRows.ts` (`buildOutputRows`, activity label stamping)
- **Resolution:** fixed in this commit

## Symptom

When several completed interactive steps keep their terminals open and each gets a follow-up,
the follow-up output lands at the bottom of the output pane, in arrival order, with nothing
saying which step wrote it. Step 1's follow-up appears right under step 3's output and looks like
it belongs to step 3. When the follow-ups arrive at about the same time, their slices interleave
and it becomes impossible to tell them apart.

Three things fail together:

- **No `Step N` activity label.** The label that marks a switch between writers in parallel
  groups is never stamped, because none of these steps is in a parallel group.
- **The `Follow-up` divider is not a step marker, and only appears once per attempt.**
  `FOLLOW_UP_RESUMED` renders `Follow-up — <time>` with no step name. It is added only to the
  attempt's first follow-up burst (`hasFollowUpDivider` in
  `SessionActivityRecorder.persistResumedSessionActivity` and in the store's
  `computeStreamingEventsToMerge`). A second follow-up turn on the same step, or a step's
  output resuming after another step's slice, gets no divider at all.
- **The identity colour bar does not separate the steps.** Each sequential step resolves to its
  harness colour, and the tie-break palette only applies inside a parallel group
  (`resolveStepColor` gets `group` only from `getParallelGroupForStep`). So three `claude-cli`
  steps all paint the same orange bar.

The sticky step header does not help either. The follow-up slices form new sections in
`buildOutputStepSections` (`outputViewportSteps.ts`) that have no `cli-header` row, so nothing is
pinned while you read them.

## Steps to Reproduce

1. Run a workflow with 3 sequential interactive steps. Set each step to start a new session
   (resume session off), and leave `execution.reuseRunningTerminal` and
   `execution.closeTerminalOnComplete` at their defaults so all three terminals stay open after
   the workflow finishes.
2. Ask each of the 3 open terminals a follow-up question at about the same time, either with
   Send Steer Message or by typing into the terminal.
3. Watch the follow-up responses stream into `OutputPane`: there is no step label on them, the
   bars are the same colour, and they read as more output from step 3.

## Root Cause

The live and persisted paths both handle follow-ups correctly up to the row builder:

- `SessionActivityRecorder.handleSessionActivityResumed` routes each burst to the attempt that
  owns the session (`latestCompletedActivityBySession`), so the target is right.
- The store (`appendStreamingEventsToOutputState`, `workflowStore.ts`) and the timeline
  (`recordFollowUpResponse` writes `cliOutputEventsAppended`) both turn the burst into an
  `OutputActivityEntry` stamped with the arrival time.
- `mapOrderedHistoryEntriesToMessages` (`outputProjection.ts`) sorts activities by
  `timestampMs`/`sequence`, so the bursts interleave in arrival order after step 3's output.
  That is the intended chronological layout.

The attribution goes missing in `buildOutputRows`. The predicate for a writer switch is right:
`previousActivityTargetKey !== targetKey` is true on every follow-up slice that comes after
another step's slice. But the label is only stamped inside a parallel group, both for CLI slices
(`outputRows.ts` ~2763–2767, then `sliceOpener` at ~3092–3101) and for status slices
(~2575–2580):

```ts
const stampActivityFirst =
  activityFirst &&
  getParallelGroupForStep(input.parallelGroups, target.index) !== undefined;
```

That gate came from step 3 of `dev/implemented/OUTPUT_STEP_ATTRIBUTION_UX_PLAN.md` (§1), which
assumed that on a sequential run "rows are chronological and only one step can be writing".
Open interactive terminals break that assumption: once a step has completed, its session can keep
writing while later steps run and after the workflow ends. Being in a parallel group is a stand-in
for "this output interleaves with another step's", and that stand-in misses this case.

## Suggested Fix

Gate the label on whether the output actually interleaves, not on group membership. A slice gets
the label when it switches writer **and** continues a step that already has rows above
another step's output:

```ts
const resumesAfterOtherStep =
  !isFirstForTarget &&
  previousRowTargetKey !== targetKey &&
  !emitsLeadingChrome;
const stampActivityFirst =
  activityFirst &&
  (getParallelGroupForStep(input.parallelGroups, target.index) !== undefined ||
    resumesAfterOtherStep);
```

- `isFirstForTarget` is already computed at the top of the message loop (~2521). The first slice
  of a step is never a resume, because its `cli-header` already names the step.
- `previousRowTargetKey` must track the target of the last message that **emitted rows**,
  whether or not it was an activity. Today `previousActivityTargetKey` only advances on activity
  messages, so a non-activity aggregate between two slices (for example a script step with no
  streamed chunk) would hide a real switch. Update it everywhere rows are pushed, after the
  hidden-target `continue`s, so hidden steps don't count as writers.
- `!emitsLeadingChrome`: a slice that opens a new attempt or run already has a header, so a
  label above it would repeat it. This only affects the non-parallel branch; leave the parallel
  branch as it is.

How this keeps the current behaviour where it should:

- **A single-step workflow with follow-ups does not change.** There is only one target, so a
  switch never happens and no label is stamped. Only the existing `Follow-up` divider shows.
- **Follow-ups that only come after their own step's output do not change either**, for example
  a follow-up on the last step, or a follow-up that finishes before the next step starts. The
  step's rows stay contiguous, so it is never a resume after another step.
  `test/utils/outputRows.test.ts` ~1110 (contiguous `A1, A2, B1`, no labels) must still pass
  unchanged.
- **The repro gets a label on every switch**: step 1's follow-up under step 3, then step 2's,
  then step 1's again whenever the bursts alternate. That is the same "once per contiguous run"
  behaviour the parallel path has.

Keep the gating on the stamp side, as the attribution plan requires. `outputRowActivityChrome`
(`outputLineMetrics.ts` ~352) charges 20px per row with `activityFirst`, so the estimator follows
the new predicate with no change. Gating in `ActivityAttribution` instead would put the flag and
the rendered label out of step.

### Single-source the label while you are there

The status path builds its own label (`` `Step ${target.index + 1}` ``,
`getStepKind(input.steps[target.index])`), while the CLI path uses `stepLabel`, `stepName` and
`workflowStep`, which handle the final step. Inside a parallel group only queue steps could reach
the status branch, so the difference never showed. Under the new predicate a final-step pass's
follow-up can be stamped too, and the status branch would label it `Step <loopIndex + 1>`. Move
both onto one helper that returns `{ activityLabel, activityName, activityStepType }` for a
target (built with `formatStepTargetLabel` / `formatFinalPassLabel`, as the CLI path already
does).

### Out of scope / follow-ups to consider

- **Colour tie-breaking for sequential steps.** The label is what fixes this bug. Extending the
  tie-break palette to sequential steps that interleave would recolour a step when its follow-up
  arrives, which breaks the "a step's colour is stable" rule in §4 of the attribution plan. Don't
  do it here.
- **Per-burst `Follow-up` divider.** Adding a divider to every resumed burst, not just the first
  per attempt, would also mark the second follow-up on a single step. That changes the
  single-step case, which should stay as it is, so it is a separate decision.
- **Sticky header for resumed sections.** `buildOutputStepSections` could reuse the step's
  earlier `cli-header` as the pinned header for a resumed section with no header of its own.
  That would give a pinned label while scrolling through a long follow-up. It is a good extra,
  but the stamped label is the main fix.

### Tests

Add these to `src/ui/webview-react/test/utils/outputRows.test.ts`, next to the existing
"stamps activity labels once per contiguous run in parallel output" test (~1159):

1. Sequential steps A, B, C, then follow-up slices A′, B′, A″ with no `parallelGroups`: exactly
   A′, B′ and A″ are stamped `activityFirst`, each with its own step label, name and kind.
2. Sequential A, B, then a follow-up on B only: no label is stamped.
3. A single step with a follow-up after its output: no label is stamped.
4. A follow-up on the final step after a queue step's follow-up: the label is the final-pass
   label, on both the CLI path and the status path.
5. The estimator: a stamped resume row estimates 20px more than the same row unstamped, as the
   existing check at ~1409 does for the parallel case.
