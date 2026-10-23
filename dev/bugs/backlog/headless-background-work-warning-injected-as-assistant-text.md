# Headless background-work warning is injected as assistant text

- **Found:** 2026-10-23 by Claude Code, bug-drain final-step review of 2a7699a9b
- **Area:** `src/core/harness/shared/CliResponseCollector.ts` (`collectHeadlessResponse`)
- **Severity:** medium

## Symptom

When a headless step ends while the parser still reports pending background
work, ctrlyoke appends `Warning: The step ended with N background task(s) still
running; …` to the step's output. The warning is a `CLI_EVENT_TYPES.TEXT` event,
the same type as the model's own reply, so it:

- renders as an AI reply bubble in the output pane instead of a ctrlyoke notice;
- becomes the last line of the step's response text (`getTranscriptText` and
  `getAssistantText` in `src/utils/StepOutputText.ts` both include every TEXT
  event). End conditions, `$previous`/`$step:N`, `read_output`, and commit
  message generation (`CommitMessageGenerator`, which uses `getAssistantText`)
  all see ctrlyoke's text as if the model had written it. An end condition that
  checks the reply's final line or a completion keyword can fail or pass because
  of the warning.

## Steps to Reproduce

1. Run a headless Claude Code step whose agent starts a background Bash command
   and ends its turn before it finishes.
2. The step output ends with the warning in an assistant text row.
3. The step's response text, as used by end conditions and `$previous`, ends
   with the warning sentence.

## Root Cause

2a7699a9b emits the warning as a plain TEXT event before
`const responseText = getTranscriptText(parsedOutput.events)` in
`CliResponseCollector.collectHeadlessResponse`. Nothing marks it as
ctrlyoke-authored. The interactive equivalent already uses a display-only event
type: `CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD` (`BackgroundWorkHoldData` in
`src/types/CliOutputTypes.ts`), which the text projections and
`PriorContextTranscript` skip.

## Suggested Fix

Add a display-only CLI event type (for example
`BACKGROUND_WORK_ABANDONED: "backgroundWorkAbandoned"`) to `CLI_EVENT_TYPES` in
`DashboardConstants.ts`, with a data interface in `CliOutputTypes.ts` carrying
`pendingTasks: BackgroundTaskSummary[]`. Emit it from `CliResponseCollector`
instead of the TEXT event. Handle it everywhere `BACKGROUND_WORK_HOLD` is
handled: render it as a warning row (`OutputRow.tsx`, `outputRows.ts` height
estimate, `useOutputVirtualization.ts`), in `CliTerminalFormatter.ts` and
`markdownExport.ts`, and exclude it from `PriorContextTranscript.ts`. The
`satisfies never` switch there and in the other exhaustive switches will
point to any missing cases. Adding an event type is additive to the persisted
timeline, so no schema bump is needed, but confirm that older readers ignore an
unknown event type. Tests: the warning event is present and the step's
response text is unchanged.
