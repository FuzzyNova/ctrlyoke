# Output-row build re-normalizes a step's whole event list once per activity message

- **Found:** 2026-10-26 by Claude (dashboard CPU and allocation profile with `scripts/profile-dev-host.mjs --target dashboard`)
- **Area:** `src/ui/webview-react/utils/outputRows.ts`, `src/utils/StepOutputText.ts`, `src/utils/CliEventNormalizer.ts`
- **Resolution:** fixed in this commit

## Symptom

With a large workflow open and one step running, the dashboard was busy for 72 s of a
112 s capture. Single `buildOutputRows` calls blocked the main thread for **3.7, 6.8,
7.4, 8.4, 9.8, 13.3 and 15.4 s**, each longer than the last as the running step produced
more output. During those stretches clicks and incoming messages wait. This is why
sending a prompt to a big workflow, or clicking Pause, seems to do nothing.

Profile breakdown (`.ctrlyoke/logs/profiles/dashboard-2026-10-26T03-04-46-717Z.cpuprofile`
and `.heapprofile`):

| Frame (total time) | ms |
| --- | --- |
| `buildOutputRows` | 64,799 |
| `getCliTextForCopy` → `getStepAssistantTextForCopy` → `getAssistantText` | 60,664 |
| `normalizeCliEvents` → `append` | 59,443 |
| `recognizeMcpSkillCommand` / `rewrite` | 24,358 |

That is **94% of the row build spent working out the Copy-output text**. The capture
allocated **86.8 GB** in 112 s, 47 GB of it in `McpSkillCommandRecognizer.rewrite`, which
the normalizer calls for every event.

## Steps to Reproduce

1. Open a workflow with a few thousand output messages (20+ tool-heavy steps).
2. Run a step and let it stream for a minute or two.
3. Profile the dashboard (`node scripts/profile-dev-host.mjs --target dashboard --seconds 90`
   with the dev host started with `CTRLYOKE_DEV_HOST_RENDERER_PORT`).
4. `buildOutputRows` stretches grow for as long as the step runs, and almost all of the
   time is under `getCliTextForCopy`.

## Root Cause

`buildOutputRows` calls `getCliTextForCopy(output)` inside its **per-message** loop
(#selection:src/ui/webview-react/utils/outputRows.ts:2602-2602). A single attempt is
split into many activity messages (`liveActivity=4615` across 27 entries in the session
log), and every one of them shares the attempt's `output`. So the step's entire event list
goes through `normalizeCliEvents` once per activity message. That is
O(activity messages × events) per attempt, so it grows quadratically while a step
streams.

`getAssistantText` (#sym:src/utils/StepOutputText.ts:getAssistantText:21-26) copies and
normalizes the full event array on every call, and nothing caches the result. The
normalizer's per-event work is itself heavy:
`findOutputIndexForCompletionFallback`, `getToolCallId` and
`recognizeMcpSkillCommand` → `tokenizeCommand` all rank among the top self-time frames.

The value is only consumed by the trailing `STATS` row (`hasStatsRow` and the row's
`outputText` field, around lines 3027–3046), and only as presence plus the text for the
Copy button. It is also computed while the output is streaming, when the Copy button is
hidden (`!aggregateOutput.isStreaming`).

Every rebuild repeats all of this. The rebuild-per-message bug
(`replayed-step-outputs-rebuild-output-rows-per-message.md`) multiplies it further.

## Suggested Fix

1. **Compute it once per attempt, and only where it is used.** Move the
   `getCliTextForCopy` call under `emitsTrailingChrome`, use `aggregateOutput`, and skip it
   while `isStreaming`. This alone removes the quadratic term.
2. **Cache by output identity.** Use a module-level `WeakMap<CliOutputType, string |
   undefined>` in `getStepAssistantTextForCopy`. A completed step's output object is
   stable across rebuilds, so it is normalized once for the life of the entry. The step
   chips (`WorkflowStepRow`, `PromptChipRail`, `WorkflowStepsPanel`) call the same helper
   on render and would benefit too.
3. **Better still, make it lazy.** The stats row only needs to know that there is text;
   the Copy click can compute the text. A cheap "has a TEXT event" check is enough for
   `hasStatsRow`.
4. Separately: `McpSkillCommandRecognizer.rewrite` allocated 47 GB here. It should
   return the input unchanged without building new strings when a command contains no
   skill or MCP reference.
