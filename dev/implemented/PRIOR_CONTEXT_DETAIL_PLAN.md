# Prior Context Detail Plan — step output from events only, full `$previous`, bounded `$summary:`

> **Status:** Implemented 2026-10-13. Phases 0–3 are complete.
> Supersedes D12b (`$summary:`) of
> [`WORKFLOW_STEP_PLAN.md`](../backlog/WORKFLOW_STEP_PLAN.md). That plan keeps D12a (workflow-step output)
> and D12c (pulling child output on demand), and its workflow arm renders through the renderer
> defined here. Phases 0–3 land before launch, in the order given under
> [Sequencing](#sequencing) (decided 2026-10-13; tracked in
> [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md)).
>
> - Phase 0 is done: the resolver excludes condition attempts from step output
>   while preserving their history records.
> - Phase 1 chunk 1a is done: the pure diff helper and transcript projection are implemented
>   with tests; no prior-context consumer uses them yet.
> - Phase 1 chunk 1b is done: prior context renders from structured events, including file changes
>   from earlier attempts, with a shared full-form XML renderer.
> - Phase 1 chunk 1c is done: the machine-specific diff setting is removed, the interim response
>   extractor emits compact annotations, and the docs describe full prior context.
> - Truncation detail settled in chunk 1a: an unbroken line larger than its byte cap is cut at
>   a UTF-8 code-point boundary because no line-boundary cut can satisfy the cap.
> - Phase 1 changes the prompt text that existing `$previous`/`priorContext` workflows send.
> - Phase 2 changes the persisted timeline format.
> - Phase 3 adds `$summary:`.
>
> Every decision is settled and there are no open questions.
>
> The plan has two parts:
>
> - **Part A (D1–D7):** render prior context from structured events, and replace the setting with
>   a per-reference detail level.
> - **Part B (D8):** delete the flattened `CliOutput.response` copy, so every consumer reads step
>   output from one source.

## Problem

What `$previous` sends depends on the machine that ran the earlier step.

`general.includeFullDiffsInPriorContext` (`schemas/settings-schema.json:46-50`, default `true`) is
read inside `extractTextFromEvents` (`src/core/harness/shared/CliResponseTextExtractor.ts:66-68`),
which flattens a step's structured CLI events into one `responseText` string **when the step's
output is captured**. Prior context later renders that frozen string
(`RunOutputResolver.resolvePriorContextItems`, `RunOutputResolver.ts:1025-1027`; rendered by
`buildPriorContextXmlFromItems`, `HarnessIntegration.ts:165-201`).

The setting does **not** affect run history. The diff data lives on the structured
`FILE_EDIT`/`FILE_WRITE` events (`structuredPatch`, `oldContent`/`newContent`), which are written to
`events.jsonl` in full whatever the setting says. The dashboard's diff views and undo read those
events. Only the flattened `cliOutput.response` string, the one prior context reads, changes. So:

1. **Same workflow, different prompt.** Two developers running one shared workflow send different
   context to the next step, depending on a setting that lives outside the workflow.
2. **The setting doesn't do what it says.** Changing it never affects a step that already ran.
   A run captured with `false` renders edit summaries forever, and the settings UI gives no hint
   of that.
3. **The author can't choose per reference.** A review step wants every diff, while a commit or
   handoff step wants a short account of what changed. One global boolean can't express both.
4. **`$previous` is not "everything the step did".** `extractTextFromEvents` keeps text,
   thinking, and file writes/edits/deletes. It drops every `BASH_COMMAND`, `MCP_TOOL_CALL`,
   `TOOL_CALL`, `WEB_SEARCH`, `FILE_READ`, and `ASK_USER_QUESTION` event. A step that ran
   `npm test`, saw it fail, and fixed the failure shows up as "I fixed it" with a diff and no
   trace of the failing command.
5. **The format is stringly coupled.** `[Thinking]…[/Thinking]`, `[Edited: path (+a, -r)]`, and
   fenced diffs are ad-hoc markers inside `<response>`. Consumers that want plain text strip them
   by regex (`CommitMessageGenerator.ts:747-753`).

`$summary:` (D12b) was going to bolt a truncation pass onto that same frozen string. It would
inherit the same problems, so this plan settles the rendering first and adds `$summary:` on top.

## Direction

**Agreed with the proposal: remove the setting; let the reference choose the detail level.**
`$previous` means the step's full record; `$summary:previous` means a bounded account of it.
Prompts then send the same thing on every machine, and the author states the trade-off where it
is visible: in the prompt.

The enabling change is architectural: **render prior context at read time from the structured
events the timeline already stores**, not from the capture-time `responseText` string.
`events.jsonl` already persists every structured event (`CLI_OUTPUT_RECORDED`
`payload.cliOutput.structured.events`, plus `CLI_OUTPUT_EVENTS_APPENDED` deltas), and
`RunOutputResolver.resolveLatestAttempts` already folds them into
`ResolvedRunAttemptValue.output` (`RunOutputResolver.ts:543-549`, `:621-635`). This gives:

- one capture, two renderings: `full` and `summary` come from the same data and cannot drift;
- a retroactive result: runs recorded before this change render in the new format, because the
  events were always there; only the flattened string was lossy;
- prior context no longer depends on the flattened `response` string, which Part B (D8) then
  deletes outright.

## Design

### D1. Full form (`$previous`, `$step:…`, `$all`, `$finalStep`, `$allFinalStep`, `priorContext`)

"Everything the step did", in the order it happened, inside `<response>`:

| Event                         | Rendered as                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Authored prompt               | `<prompt>` in full (the authored prompt, not the expanded one). `finalStep` passes gain it too (D1b)         |
| `TEXT`                        | Plain text, as today                                                                                         |
| `THINKING`                    | `<thinking>…</thinking>` (replaces the `[Thinking]` markers); a redacted block renders its summary, as today |
| `FILE_EDIT`                   | `<edit path="…" added="4" removed="1">` + fenced unified diff — **always**, no setting                       |
| `FILE_WRITE`                  | `<create path="…" added="120">` + fenced diff from `/dev/null`                                               |
| `FILE_DELETE`                 | `<delete path="…"/>`                                                                                         |
| `BASH_COMMAND`                | `<command exitCode="1">` + the command + `<output>` holding the **tail** of stdout/stderr (D1a)              |
| `FILE_READ`                   | `<read path="…" lines="10-40"/>` — path and range only, never the content                                    |
| `MCP_TOOL_CALL`, `TOOL_CALL`  | `<tool name="server/tool">` + compact JSON arguments + tail of the result                                    |
| `WEB_SEARCH`                  | `<search query="…">` + result titles and URLs                                                                |
| `ASK_USER_QUESTION`           | `<question>` + the questions and the user's answers (the answers shaped the step's work)                     |
| `USER_STEER`                  | `<userSteer>` + the human's text (same reason)                                                               |
| `TERMINAL_OUTPUT` (Phase 2)   | `<terminalOutput reason="…">` + the text (the PTY tail after a harness exit, D8a)                            |
| `COMPACTION`, display markers | Omitted (`FOLLOW_UP_RESUMED`, background-hold markers, `CONTEXT_WINDOW_SYNC`, and other display-only events) |
| Failed operations             | The element gains `failed="true"`; a failed edit renders no diff                                             |

Example:

````xml
<step index="2" name="Implement">
<prompt>
Add the retry counter described in @dev/backlog/RETRY_PLAN.md.
</prompt>
<response>
<thinking>
The counter belongs in WorkflowExecutor…
</thinking>
I'll add the counter and run the tests.
<edit path="src/core/WorkflowExecutor.ts" added="4" removed="1">
```diff
--- a/src/core/WorkflowExecutor.ts
+++ b/src/core/WorkflowExecutor.ts
@@ -210,3 +210,6 @@
…
```
</edit>
<command exitCode="1">
npm run test:unit
<output omitted="start" omittedBytes="48211">
  1 failing
  WorkflowExecutor retries … expected 2 to equal 3
</output>
</command>
<read path="src/test/unit/WorkflowExecutor.test.ts" lines="400-460"/>
…
The tests pass now.
</response>
</step>
````

#### D1a. Command output: include the command, truncate the output

The proposal asked whether command output should be truncated, or whether commands belong in
`$previous` at all. **Recommendation: always include the command and exit code; include only the
tail of its output, capped per command.**

- **Commands belong in "everything the step did".** The command and its exit code are small, and
  they are often the most important facts about a step ("ran the migration", "tests failed twice,
  then passed"). Leaving them out is what makes today's `$previous` misleading.
- **Untruncated output is the wrong default.** It is by far the largest and least durable part of
  a transcript. One `npm test` or `git log` can be hundreds of KB, and it would crowd out the
  diffs and the model's own conclusions. The agent that ran the command has usually already
  interpreted it in its text.
- **The tail is the useful part.** Test runners, compilers, and installers put failures and
  summaries at the end, which is also why `$summary:` keeps the tail of the response.
- **Full output stays reachable.** A step whose job is to hand complete output forward should be
  a script step, whose stdout/stderr render in full (unchanged). The run history keeps every
  byte, and the truncation marker names how to read it (`ctrlyoke history show …`, D12c of the
  workflow step plan).

Caps live in one constant in `src/types/DashboardConstants.ts`, alongside the summary caps:

```ts
export const PRIOR_CONTEXT_LIMITS = {
  // full form
  COMMAND_OUTPUT_TAIL_BYTES: 2048, // per BASH_COMMAND, stdout+stderr combined
  TOOL_RESULT_TAIL_BYTES: 1024, // per MCP_TOOL_CALL / TOOL_CALL result
  TOOL_ARGUMENTS_HEAD_BYTES: 512, // compact JSON of the call's arguments
  DIFF_BYTES: 65536, // per file; a safety valve for lockfiles and generated files, not a budget
  // summary form
  PROMPT_HEAD_BYTES: 2048,
  OUTPUT_TAIL_BYTES: 4096,
  WORKFLOW_BUDGET_BYTES: 24576, // workflow-step summaries, WORKFLOW_STEP_PLAN D12a
} as const;
```

`DIFF_BYTES` is the one place this plan deviates from "always full diffs": a regenerated
`package-lock.json` or a minified bundle should not put 2 MB into the next prompt. Diffs under
the cap, which is nearly all of them, are never cut. When a diff is cut, the `<edit>` element
says so (`omitted="end" omittedBytes="…"`) and keeps its `added`/`removed` counts.

**Truncation markers** use one attribute pair everywhere: `omitted="start" | "end"` (which part
was removed) plus `omittedBytes`. This replaces D12b's `truncated="head" | "tail"`, which was
ambiguous about whether it named the part kept or the part removed. Cuts land on line
boundaries, and byte counts are UTF-8 bytes, cut on a code point boundary.

#### D1b. `finalStep` passes carry their prompt

_Previously an open question; decided._ Today a prompt `finalStep` item has no `<prompt>`
(`RunOutputResolver.ts:1048-1061`), so `$finalStep` reads differently from `$step:N`. Each pass
now renders its authored prompt, taken from the attempt's definition snapshot
(`value.definition?.step`, which `resolveStep` already resolves for a `finalStep` target). The
`<step>` element keeps its existing `type` attribute (`PRIOR_CONTEXT_ITEM_TYPES.FINAL_STEP`) and
its 1-based pass number. A script `finalStep`
renders like a queue script step (`<command>`, `<stdout>`, `<stderr>`, `<exitCode>`,
`<verdict/>`) from its `scriptOutput`. Today it reads `responseText` only; Phase 1 adds the
missing script branch.

### D2. Summary form (`$summary:previous`, `$summary:step:1-3`, …)

A bounded account of the step: what was asked, what changed, what the model said at the end.

| Step kind       | Summary                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt          | First 2 KB of the authored prompt; `<filesChanged>`; last 4 KB of the step's **text only** (no thinking, commands, tool calls, or diffs)         |
| Script          | First 2 KB of the command; last 4 KB of stdout and stderr combined; exit code and verdict in full (unchanged from D12b)                          |
| `finalStep`     | As a prompt or script step, including the pass's authored prompt (D1b)                                                                           |
| Workflow (D12a) | Metadata in full; each child step summarized by these rules within `WORKFLOW_BUDGET_BYTES`, earliest children elided first (unchanged from D12b) |

```xml
<step index="2" name="Implement" detail="summary">
<prompt omitted="end" omittedBytes="3120">
Add the retry counter described in …
</prompt>
<filesChanged>
Edited src/core/WorkflowExecutor.ts +4 -1
Added src/test/unit/RetryCounter.test.ts +58
Removed src/core/LegacyRetry.ts
</filesChanged>
<response omitted="start" omittedBytes="9120">
…The tests pass now.
</response>
</step>
```

- **`<filesChanged>` is net per file across the step**, not one line per edit event: three edits
  to one file are one `Edited … +a -r` line. A file created and then edited is `Added … +n`; a
  file created and then deleted is left out. Failed operations don't count. Paths are
  workspace-relative with forward slashes (the proposal's example used backslashes; forward
  slashes match every other ctrlyoke reference and are what `toPortableRelativePath` already
  produces). Files outside the workspace keep their absolute path, as the dashboard does.
- **Reuse the dashboard's projection.** `RunOutputResolver.getFileChange` (`:911-961`) and
  `ProjectionAccumulator.toFileChanges` (`:1257`) already compute scoped, portable,
  failure-filtered per-file operations for the dashboard's files-changed list. The summary list
  extends that projection with line counts instead of building a second one. The `+a -r`
  counting moves out of `CliResponseTextExtractor.ts:109-121` into one shared helper used by the
  projection, `<edit added removed>`, and `<filesChanged>`.
- **Text only, tail.** The response is the concatenation of `TEXT` events (`joinResponseText`),
  cut from the start to `OUTPUT_TAIL_BYTES`. Conclusions are at the end.
- **The prompt is cut from the end**, keeping its first 2 KB (D12b's figure; the proposal
  suggested "like 4 KB"). The authored prompt is in the workflow file the author is already
  looking at; what the next step needs is enough of it to know what was asked.
- **D12b's rule changes.** D12b said "a summary only truncates the full form; it never adds
  anything". The proposed summary also _drops_ element kinds and _replaces_ diffs with
  `<filesChanged>`, so the rule becomes: **a summary is a projection of the full form — the same
  element names and attributes, a subset of the elements, cut with explicit markers — plus the
  `<filesChanged>` digest.** An agent reads both forms the same way.

### D3. Grammar and selection (from D12b, unchanged)

- `$summary:` is a prefix on the existing selectors: `$summary:previous`, `$summary:previous:3`,
  `$summary:step:1,4-5`, `$summary:all`, `$summary:finalStep`, `$summary:allFinalStep`. The body
  after it goes through the same `parseInlinePriorContextBody`, so every selector exists in both
  forms. `$summary` alone or with an unknown body is a diagnostic. The reserved-prefix warning
  (`PRIOR_CONTEXT_SUMMARY_PREFIX`, `prompt.prior-context.reserved-prefix`) is replaced by real
  parsing.
- The YAML equivalent is `priorContextDetail: full | summary` (default `full`), resolved prompt →
  workflow like `priorContext`. All four existing `priorContext` forms keep working.
- When one prompt selects a step at both levels (`$previous` and `$summary:step:2`), full wins.
  `mergePriorContextReferences` tracks a detail per selected index.
- `StepReferenceRenumbering` rewrites the body inside `$summary:step:…` as it does for `$step:…`;
  the parallel-group sibling check applies to both forms.

### D4. Which attempt

"Latest" is per step **within the run being executed**, never across runs. Appending steps to an
older run continues that run in its own directory (`RunLifecycleService.appendAndContinueAtRun`
→ `WorkflowInstance.executeContinuationAtRun`, which reopens that run's `events.jsonl`). The
prior-context resolver is bound to that history file (`WorkflowStartupPipeline.ts:473-474`). So
`$previous` in a step appended to run 2 of five reads run 2's own last step that produced
output. Tests must cover that case: an appended step in a non-latest run resolves `$previous`
and `$summary:previous` from that run only. They must also cover a commit step whose only
attempt was interrupted; today it reads as empty and is skipped (D8f).

Prior context renders the **latest attempt** of each step, as today. Earlier attempts' edits are
still on disk, though, and a retry's transcript often reads "fixed the failing assertion" with
the real work in attempt 1. So:

- **Full:** the latest attempt's transcript; if earlier attempts changed files, a trailing
  `<earlierAttempts count="2">` element lists them in `<filesChanged>` form (no diffs).
- **Summary:** `<filesChanged>` covers every attempt of the step. That is also what the
  dashboard's files-changed list shows.

**Data source.** `resolveLatestAttempts` keeps only the latest value per target, so it can't
supply earlier attempts' files on its own. In the same streamed pass, `resolvePriorContextItems`
feeds each selected target's non-condition attempts into a `ProjectionAccumulator`, the class the
dashboard projection already uses (`RunOutputResolver.ts:1237-1304`). That needs the workspace
roots `getFileChange` uses (`:911-961`), so `resolvePriorContextItems` gains a
`RunOutputProjectionOptions` argument. `createPriorContextResolver` already has `workspaceRoot`
and passes it through, along with any other roots the projection options need. Condition
attempts never count as the step's work (Phase 0).

Post-completion follow-ups (harness auto-resume, TUI steering) are part of their attempt already
(`foldSettledAttempt`), so they render in both forms with no extra work.

### D5. `response` between Phase 1 and Phase 2

Once prior context renders from events, `response` has no prior-context duty, and Part B (D8)
deletes it. Phase 1 makes one interim change: `extractTextFromEvents` is fixed to the setting's
`false` behavior (text, `[Thinking]` blocks, one-line `[Edited: path (+a, -r)]` / `[Created: …]` /
`[Deleted: …]` annotations), and `ResponseTextExtractionOptions` is deleted. That way removing the
setting doesn't leave a dangling read.

Prior context is the only consumer that needs diffs or thinking in this string. End-condition
scripts never receive it (`EndConditionEvaluator.ts:200-208`). The interim change also fixes a
live bug: `CommitMessageGenerator`'s cleanup regex (`:752`) only matches the one-line
`[Edited: …]` form, so with the setting on (the default), a full-diff block's body leaks into the
fallback commit message
([`commit-message-fallback-leaks-full-diff-blocks.md`](../bugs/implemented/commit-message-fallback-leaks-full-diff-blocks.md)).

**Legacy fallback:** when a settled attempt has no structured events, the renderer uses the
recorded `response` as the `<response>` body for both forms (the summary cuts its tail). Every
current harness produces structured events in headless and PTY mode, and no provider turns on
`rawTextOutput` (`ICliProvider.ts:106`). After Phase 2, this fallback only serves timeline-v1
records (D8e).

### D6. One renderer

`buildPriorContextXmlFromItems` stays the single XML writer for live injection and the editor
preview (`PriorContextPreviewBuilder`). What changes is the item it receives:

```ts
export type PriorContextItem = {
  index: number;
  name?: string;
  prompt?: string;
  detail: PriorContextDetail; // "full" | "summary"
  type?: PriorContextItemType;
  /** Ordered transcript entries projected from the attempt's structured events. */
  transcript?: PriorContextTranscriptEntry[];
  /** Fallback body when the attempt has no structured events (D5). */
  text?: string;
  filesChanged?: PriorContextFileChange[]; // summary, and full's earlierAttempts
  scriptOutput?: ScriptRuntimeOutput;
  scriptVerdict?: ScriptVerdict;
};
```

- `PriorContextTranscriptEntry` is a discriminated union (`text`, `thinking`, `edit`, `create`,
  `delete`, `command`, `read`, `tool`, `search`, `question`, `userSteer`), projected once from
  `CliEvent`s by a new pure module `src/core/PriorContextTranscript.ts`. The `CLI_EVENT_TYPES`
  switch is exhaustive (`satisfies never` on the default), so a new event type has to choose a
  rendering to compile. Its kinds are a `const` object in `DashboardConstants.ts`.
- `summarizePriorContextItem` (D12b's `summarizePriorContextItems`) runs before rendering for
  summary items: it filters the transcript to `text`, applies `PRIOR_CONTEXT_LIMITS`, and sets
  the markers. The full form applies only its per-entry caps. Truncation therefore never forks
  the XML format.
- The diff formatters (`formatStructuredPatch`, `formatEditDiff`, `formatCreatedFileDiff`) and the
  `+a -r` line counter move out of `CliResponseTextExtractor.ts` into
  **`src/utils/CliEventDiff.ts`**. It is pure (only the `diff` package), so the transcript
  projection, `StepOutputText` (D8b), and the dashboard's Markdown export (D9a) all share it.
- Event payloads are untrusted model output. Attribute values go through the existing
  `escapeXmlAttribute`; element bodies stay unescaped like `<response>` and `<stdout>` today.

### D7. Memory and size

The full form is larger than today's for any step that ran commands or tools. That is the point
of the change, and the editor's prior-context preview and token count already show the size
before the run. Mitigations:

- per-entry caps (D1a) bound the worst case per tool call;
- `resolvePriorContextItems` already reads only the selected targets' latest attempts in one
  streamed pass, so retained memory stays proportional to what was asked for;
- each selected attempt is projected into capped transcript entries as soon as it is resolved,
  and its raw output is dropped then, so the renderer never holds an uncapped command output.

## Part B

### D8. One source for step output: delete `CliOutput.response`

Every AI attempt's `CLI_OUTPUT_RECORDED` stores the same output twice: as
`cliOutput.structured.events`, and flattened into `cliOutput.response` by `extractTextFromEvents`.
Part A stops prior context reading the flattened copy. Part B deletes it. Every consumer then
derives what it needs from the events (AI steps) or from the script record (script steps), through
one module.

**Verdict: do it.** The research found no good reason to keep a persisted second copy. The
candidate reasons, and why none of them holds:

- **Cheaper reads.** Deriving text is one linear pass over events that every reader already has
  in memory. The resolver already normalizes and folds them (`RunOutputResolver.ts:823`).
- **Public contracts.** The two shipped surfaces that expose output text (D8c) are JSON fields,
  not the persisted shape. They keep their names and return a computed value.
- **Old runs.** Readers keep a legacy branch for timeline-v1 records (D8e). That is a read
  fallback, not a reason to keep writing the field.
- **Content only `response` carries.** Four kinds of output have no other home today. Each gets a
  typed home (D8a). That is the real work in Part B, and it is what makes "everything from events"
  true rather than approximately true.

What the duplicate costs today:

- **Size.** For text- and edit-heavy steps, `response` is roughly 40–50% of the final record, or
  about a quarter to a third of all the bytes an attempt writes. With full diffs on, every
  created file is stored a second time as a `/dev/null` diff. Each post-completion follow-up
  burst rewrites the whole `CliOutput`, response included (`SessionActivityRecorder.ts:365-392`).
- **Drift bugs**, all fixed by deriving instead of storing (D8f).

#### D8a. Content only `response` carries today, and where it moves

| Content                                                                                                                                                                                        | Today                                                                                                                                                                                                                                         | New single home                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script, pre-condition, end-condition, and worktree-setup output                                                                                                                                | Final record's `response` is `sanitizeTerminalOutput(stdout + "\n" + stderr)` (`ScriptExecutionReporter.ts:351-360`). It is the third copy, next to the chunk deltas and `SCRIPT_EXECUTION_RECORDED` (`:383-396`, raw redacted stdout/stderr) | **`SCRIPT_EXECUTION_RECORDED`.** Display text is `sanitizeTerminalOutput` applied on read; it is pure and deterministic. The script's `CLI_OUTPUT_RECORDED` keeps only metadata (exit code, verdict, timing). `CLI_OUTPUT_CHUNK_APPENDED` stays as the live delta stream (D8d). The dashboard's completed-output payload gains a typed **wire-only** `scriptOutput`: set on the live completion dispatch, joined from `SCRIPT_EXECUTION_RECORDED` by `OutputHistoryTimelineAdapter` when history is replayed, and stripped before `saveExecutionOutput` persists a record, so it never becomes a second stored copy. |
| PTY tail after the process exits (last 10 ANSI-stripped lines, `CliFailureTracker.ts:37-40`, preferred by `CliIntegration.ts:1771-1773`)                                                       | Only in the failure record's `response` (`WorkflowExecutor.ts:3862-3890`)                                                                                                                                                                     | **A new `CLI_EVENT_TYPES.TERMINAL_OUTPUT` event** (`{ text, reason }`), appended to the attempt's events. It renders as a terminal block in the dashboard and as `<terminalOutput>` in prior context.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Raw stdout chunks from an AI harness with no log parser (`CliTransportCoordinator.ts:507-519`), and the stop path's fallback to them (`bufferedOutput.response`, `OutputCaptureBuffer.ts:477`) | Folded into `response`                                                                                                                                                                                                                        | **Emit `TEXT` events instead of chunks.** No built-in harness reaches this path, and after the change chunks are script-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Headless failure message used as the response when there's no text (`CliResponseCollector.ts:147`)                                                                                             | `CliResult.response`, and the `onResponseComplete` payload                                                                                                                                                                                    | **Dropped.** `CliOutput.errorMessage` and `ATTEMPT_TERMINATED.payload.reason` already carry it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

#### D8b. One derivation module

`src/utils/StepOutputText.ts` is pure: it has no config or `vscode` import, so the dashboard can
use it through `@root/`. It runs `normalizeCliEvents` first, like the D6 transcript projection,
which is its structured sibling.

```ts
/** TEXT events only. Replaces the webview's `joinCliTextEvents`. */
export function getAssistantText(events: readonly CliEvent[]): string;
/** TEXT, `[Thinking]` blocks, and one-line file annotations (today's `false` behavior). */
export function getTranscriptText(events: readonly CliEvent[]): string;
/** `sanitizeTerminalOutput(stdout + "\n" + stderr)`, the exact text scripts display today. */
export function getScriptOutputText(scriptOutput: ScriptRuntimeOutput): string;
/** Dispatch: a script attempt uses its script record; an AI attempt uses its events; a
 *  timeline-v1 record with neither uses its legacy `response` (D8e). */
export function getStepOutputText(
  source: StepOutputSource,
  mode: StepOutputTextMode
): string;

/** Structural input both the resolver and the dashboard can build. Deliberately not
 *  `ResolvedRunAttemptValue`, which lives in `src/core/` and is not importable by the webview. */
export interface StepOutputSource {
  output?: CliOutput | LegacyCliOutputV1;
  scriptOutput?: ScriptRuntimeOutput;
}
```

`RunOutputResolver`'s `ResolvedRunAttemptValue` declares `extends StepOutputSource`, and the
dashboard's input type does the same. The relationship is then nominal, as the project's coding
principles require.

`StepOutputTextMode` is a `const` object (`ASSISTANT`, `TRANSCRIPT`) in `DashboardConstants.ts`.
`extractTextFromEvents` and `CliResponseTextExtractor.ts` are deleted; their diff formatters move
to the shared helper named in Phase 1.

#### D8c. Consumers

| Consumer                                                                                                                                                                                                                                                                      | After                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prior context                                                                                                                                                                                                                                                                 | Part A. The script `finalStep` arm also gains the `scriptOutput` branch the queue arm has (`RunOutputResolver.ts:1041-1061` reads `responseText` only).                                                                                                                                                                                  |
| `ResolvedRunAttemptValue.responseText` (`RunOutputResolver.ts:74`, `:390`, `:547`, `:629-630`, `:1445`)                                                                                                                                                                       | Field deleted. Readers call D8b.                                                                                                                                                                                                                                                                                                         |
| MCP `read_output`: `outputs[].responseText` and UTF-16 `cursor`/`limit`/`tail`/`nextCursor` (`mcp-server.ts:1637-1660`, `OutputTextPaging.ts`; **public, documented in 0.1.2**, `docs/reference/mcp-tools.md:86-110`)                                                         | Field name and paging kept; value is `getStepOutputText(…, TRANSCRIPT)`. The value changes once: no embedded diffs, and v1 runs keep their recorded text. Cursors are offsets into one call's derived text; document them as opaque, valid only with the same run state.                                                                 |
| `history show --json` `responseText`, text paging, `--events` fallback (`HistoryInspectionCommands.ts:958-1133`, `:1757-1776`, `:1895-1911`; documented in `docs/cli/ctrlyoke.md:600-663`)                                                                                    | `responseText` kept and computed. Text paging stops printing thinking twice: today it is printed from `response` and again as THINKING events when `--kind` includes thinking. The synthetic TEXT event for event-less records (`:1054-1058`) is used only for the v1 legacy branch. HEAD already dropped 0.1.2's raw `output.response`. |
| `ctrlyoke run --json`                                                                                                                                                                                                                                                         | Unaffected; it has no response field (`CliJsonResultBuilder.ts`).                                                                                                                                                                                                                                                                        |
| `CommitMessageGenerator` (`:633-635`, `:735-766`)                                                                                                                                                                                                                             | `getAssistantText` of the step's events, plus a real success check. The regexes are deleted.                                                                                                                                                                                                                                             |
| `onResponseComplete` (`HarnessIntegration`, `CliLogMonitor.ts:383`, `CliResponseCollector.ts:181`, `CliIntegration.ts:1987`, `WorkflowInstance.ts:487`/`:2519`/`:4187`)                                                                                                       | Becomes a payload-less completion signal. The executor's completion path (`WorkflowExecutor.ts:4172-4212`, `:4458-4465`, `:5570-5611`) stops threading a string. The retry callback's unused `responseText` (`:4488-4698`; `EndConditionHandler.ts:425` reads only `attemptIndex`) goes too.                                             |
| `CliResult.response`, `getLastFailureOutput` (`CliOutputTypes.ts:520-529`, `CliIntegration.ts:1770-1785`)                                                                                                                                                                     | `response` deleted. The failure tail becomes a `TERMINAL_OUTPUT` event, and partial log output is already events.                                                                                                                                                                                                                        |
| `SessionActivityRecorder` follow-ups (`:240`, `:365-392`)                                                                                                                                                                                                                     | Appends events only. It also fixes the branch that drops follow-up events when `existingOutput.structured` is undefined (`:368-373`) but still appends their text.                                                                                                                                                                       |
| History search (`HistoryCandidateExtractor.ts:86-92`, `HistoryRunDocumentBuilder.ts:103-110`, `TimelineRecorder.ts:407-423`)                                                                                                                                                  | The AI `RESPONSE` candidate is dropped; TEXT and THINKING are already indexed per event. Script search indexes `SCRIPT_EXECUTION_RECORDED` stdout/stderr, which nothing indexes today. A script hit's `matchField` changes in the search JSON (schemaVersion 1); note it in the changelog.                                               |
| `PromptQueue` `runtimeOutputCache` / `finalStepResponseCache` and their hydration (`PromptQueue.ts:147-151`, `:1731-1743`, `:2630-2683`; `WorkflowInstance.ts:1690-1741`; writers in `WorkflowExecutor.ts`, `SessionActivityRecorder.ts:347-358`)                             | **Dead code: they are read only to append to themselves.** Delete them.                                                                                                                                                                                                                                                                  |
| `CliTerminalFormatter` script rendering (`:873-905`)                                                                                                                                                                                                                          | Live: chunks. History: `getScriptOutputText`.                                                                                                                                                                                                                                                                                            |
| Dashboard fallback rows (`outputRows.ts:2611-2626`, `:2863-2885`)                                                                                                                                                                                                             | A script row reads the typed `scriptOutput`. Activity text feeds the plain row directly instead of being copied into a fake `response`.                                                                                                                                                                                                  |
| Dashboard "Copy output" (`outputUtils.ts:122-130`, `outputRenderUtils.ts:330`, `useOutputContextMenu.tsx:52,115`, `WorkflowStepRow.tsx:150`, `PromptChipRail.tsx:576,688`, `WorkflowStepsPanel.tsx:1409`, `useFinalStepContextMenu.tsx`, stats row `outputRows.ts:2915-2931`) | One helper on top of D8b. Four of these read `latestOutput.response` directly today, so their copies disagree with each other.                                                                                                                                                                                                           |
| Dashboard store follow-up merge (`workflowStore.ts:217-237`), placeholders (`workflowStore.ts:869`, `outputProjection.ts:325`), `PromptDetails.response` (`prompt.ts:68`)                                                                                                     | Deleted.                                                                                                                                                                                                                                                                                                                                 |
| Markdown export fallback (`markdownExport.ts:483-495`)                                                                                                                                                                                                                        | Script text from `scriptOutput`.                                                                                                                                                                                                                                                                                                         |
| Find in output (`outputFind.ts:194-209`)                                                                                                                                                                                                                                      | No change; it follows the rows.                                                                                                                                                                                                                                                                                                          |
| Hosted server and dashboard sinks                                                                                                                                                                                                                                             | Type changes only.                                                                                                                                                                                                                                                                                                                       |

#### D8d. Other duplication

- **`CliOutput.prompt`** repeats `ATTEMPT_STARTED.payload.prompt` and is written on both the
  placeholder and the final record (`WorkflowExecutor.ts:3318`, `:3863`, `:5318`, `:5598`). It is
  dropped from persisted records in the same format bump. The resolver already holds the
  attempt's prompt (`RunOutputResolver.ts:539`).
- **Kept on purpose: deltas, then a sealing aggregate.** `CLI_OUTPUT_EVENTS_APPENDED` and script
  chunks are followed by `CLI_OUTPUT_RECORDED.structured.events` and `SCRIPT_EXECUTION_RECORDED`.
  This is write-ahead logging, not two representations. The deltas make an interrupted attempt
  recoverable, the aggregate is authoritative once it lands, and readers already discard the
  superseded deltas (`OutputHistoryTimelineAdapter.ts:213-221`, `RunOutputResolver.ts:544-545`).
  Two follow-ups are possible but separate and riskier:
  - a seal that references already-flushed deltas instead of repeating them;
  - follow-up bursts that append only new events instead of rewriting the whole output.

#### D8e. Timeline format v2

Removing a required field from persisted records is a breaking change
(`SCHEMA_RELEASE_READINESS_PLAN.md:277-284`). Version 0.1.2 reads `cliOutput.response` with no
fallback (`RunOutputResolver.ts:390`, `StreamingCliOutputAccumulator.ts:64` — which would produce
the literal string `"undefined…"`, `HistoryCandidateExtractor.ts:91`).

1. Bump `TIMELINE` to 2 (`WorkflowTimelineTypes.ts:34`, `PersistedSchemaGuard.ts:56`). Add a
   `{ from: 1 }` manifest migration in `FormatMigrations.ts`; it is a no-op stamp, because only
   the manifest is versioned. Add a `timeline/v2` fixture.
2. **Readers accept both shapes, per line.** There is no per-line upcaster (`events.jsonl` lines
   carry no version). A `LegacyCliOutputV1` type (`CliOutput & { response?: string; prompt?:
string }`) lives in `WorkflowTimelineTypes.ts` and is read only by D8b's legacy branch.
   `CliOutput` itself loses both fields. Add a v1 events fixture (none exists today, only the
   manifest) covering an AI record, a script record, and a failure record with a PTY tail, so the
   legacy read path stays tested.
3. **Continuing a v1 run** (resume, append, rewind) stamps its manifest to v2 and writes v2 lines.
   Because readers are tolerant per line, a mixed run reads correctly on new hosts. Version 0.1.2
   then opens that run read-only, as `PersistedSchemaGuard` intends. It shows empty text for the
   new lines, which is the accepted cost of a bump.
4. Document the record shape change in `docs/reference/run-files.md`.

#### D8f. Bugs fixed by deriving instead of storing

- **An interrupted AI attempt reads as empty.** `finishAttemptState` keeps the placeholder's
  `response: ""` when only events were streamed (`RunOutputResolver.ts:625-631`), so `$previous`
  and `read_output` see nothing even though the events were recorded.
- **The fallback commit message can be the harness failure message.** A headless failure fires
  `onResponseComplete(failure.message)` (`CliResponseCollector.ts:147`, `:181`). The commit message
  generator also leaks full-diff bodies (bug doc linked in D5).
- **`history show` prints thinking twice** in text mode when `--kind` includes thinking.
- **Follow-up events dropped while their text is kept** (`SessionActivityRecorder.ts:368-373`).
- **"Copy output" disagrees with itself.** Some sites read `response` (thinking and markers
  included), and others fall back to TEXT events only.
- **The setting is frozen into records** (Problem 2). There is no stored copy left to freeze.

**Prerequisite bug (Phase 0):**
[`prior-context-resolves-condition-output-as-step-output.md`](../bugs/implemented/prior-context-resolves-condition-output-as-step-output.md).
`resolveLatestAttempts` doesn't skip condition-script attempts. A step that never ran because
its pre-condition failed therefore yields the condition's stdout as its response. So does an
interrupted step whose pre-condition ran first. This was confirmed by reading the code, not yet
reproduced. Every phase below builds on the resolver, so it is fixed first, test first.

### D9. A full-output path on every surface

Copy Output becomes the model's text only (decision 7). That is acceptable only because every
surface keeps a way to get **everything** a step did. That matters most when one workflow needs
another workflow's output (D9c).

#### D9a. Dashboard: Export Output is the full form; add Copy Full Output

Export Output (`useOutputExport.ts`, `generateMarkdownExport` in `markdownExport.ts`; written to
a file, with step-range, command, and metadata options) already renders from events. Its
`renderStructuredEventsToMarkdown` (`:156-316`) includes:

- text and thinking;
- full edit diffs;
- every command with its full stdout/stderr and exit code;
- MCP and generic tool calls with their arguments and results.

So export is already more complete than today's Copy Output, which never included commands.
It still has gaps, and closing them is part of Phase 2:

| Gap                               | Today (`markdownExport.ts`)                            | Fix                                                                                    |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Created files (`FILE_WRITE`)      | `● Wrote path (N bytes)`; content dropped (`:231-245`) | Fenced content, or a `/dev/null` diff through the shared diff helper (Phase 1)         |
| `ASK_USER_QUESTION`, `USER_STEER` | Not rendered (no `case`)                               | Questions with their answers; the human's steering text                                |
| `WEB_SEARCH` results              | Query only (`:281-286`)                                | Result titles and URLs                                                                 |
| `TERMINAL_OUTPUT` (new, D8a)      | —                                                      | Fenced terminal block                                                                  |
| Script output                     | `response` fallback (`:483-495`)                       | `getScriptOutputText(scriptOutput)`                                                    |
| New event types                   | Silently skipped (non-exhaustive `switch`)             | Exhaustive `switch` (`satisfies never`), the same rule as the D6 transcript projection |

**Copy Full Output** is a new item next to Copy Output, in the step context menu
(`stepContextMenuItems.ts:77`) and the output context menu (`useOutputContextMenu.tsx:161`). It
copies `generateMarkdownExport` for that one step (`stepRange: [n]`, `includeMetadata: false`)
to the clipboard. It is the same renderer as Export, not a second one, so the two cannot drift.
That restores the old "copy everything and paste it into another workflow" workflow in a form
that is more complete than before.

#### D9b. CLI and MCP

- **`history show` is the CLI's full view, unchanged.** Its default text output renders every
  structured event. `--json` emits one raw record per attempt, and `--json --events` emits one
  record per event (`docs/cli/ctrlyoke.md:640-663`). Only a paged read (`--limit`/`--tail`/
  `--cursor`) is cut from `responseText`, and that becomes `TRANSCRIPT` text (D8c).
- **MCP `read_output`** returns `TRANSCRIPT` text: text, thinking, and one-line file
  annotations, but no diff bodies or command output. An agent that needs the full record can run
  `ctrlyoke history show --json --events` (D12c of the workflow step plan). A future
  `read_output` `detail: "full"` argument returning the D1 prior-context form is possible, and
  it would be additive.

#### D9c. Prior context across workflows

Prior context already crosses workflow boundaries, though only coarsely. The run-address form
of `priorContext`, `{ workflowKey, runRef }` (`CtrlYokeTypes.ts:516-519`; documented in
`docs/reference/workflow-schema.md`, "Run address"), imports **every step of one completed run**
through `resolveAllPriorContextItems` (`RunOutputResolver.ts:1071-1094`). It renders through the
same items, so Part A applies to it unchanged: full form by default, and `summary` through
`priorContextDetail` once Phase 3 lands.

What it lacks:

- step selection (it is the whole run);
- an inline token (it is YAML-only);
- keys that are known when the workflow is authored (`runRef` is minted at run time).

Those gaps are why copying output across workflows by hand still matters, and they are out of
scope here. If they are wanted, `$run:<workflowKey>:<runRef>:step:2`-style addressing would sit
on top of the D3 grammar and the D6 renderer without changing either. That is additive, so it can
follow launch.

## Implementation phases

### Sequencing

All phases land before launch (decision 6), in this order. Each chunk below is sized for one
session. Each one leaves `npm test` green, updates this plan's status, and commits its own work.

| Order | Chunk                                                                 | Depends on | Why this order                                                                                                       |
| ----- | --------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Phase 0: condition-attempt resolver fix                               | —          | Every later chunk reads step output through `resolveLatestAttempts`                                                  |
| 1a    | Phase 1 steps 1 (diff helper, transcript projection)                  | 0          | Pure modules with their own tests; nothing consumes them yet                                                         |
| 1b    | Phase 1 steps 2–3 (resolver items, renderer, D1b, D4 data)            | 1a         | Switches `$previous` to events; the setting still exists but no longer affects prior context                         |
| 1c    | Phase 1 steps 4–7 (remove setting, interim extractor, docs)           | 1b         | Removing the setting is safe only once prior context no longer reads `response`                                      |
| 2a    | Phase 2 steps 1–2 (`StepOutputText`, homes for response-only content) | 1c         | New sources must exist before any consumer moves off `response`                                                      |
| 2b    | Phase 2 step 3 (backend readers)                                      | 2a         | `response` is still written, so every reader can migrate while legacy reads keep working                             |
| 2c    | Phase 2 step 4 (dashboard readers, full-output path)                  | 2a         | Independent of 2b; Copy Output switches to `ASSISTANT` here, in the same chunk as Copy Full Output (decision 7)      |
| 2d    | Phase 2 steps 5–6 (stop writing, drop the fields, timeline v2, docs)  | 2b, 2c     | Last, because deleting the write side and `CliOutput.response`/`prompt` stops compiling until every reader has moved |
| 3a    | Phase 3 steps 1–4 and 9 (grammar, schema, merge, summarizer, tests)   | 2d         | The summarizer filters the Phase 1 transcript and reuses the D4 file data                                            |
| 3b    | Phase 3 steps 5–8 (editor, dashboard, docs, templates)                | 3a         | User-facing surfaces for an already-working grammar                                                                  |

### Phase 0 — condition attempts are not the step's output

1. Add the two failing resolver tests from the bug doc: a skipped step whose pre-condition
   printed output, and an interrupted step attempt that followed a pre-condition.
2. Make `resolveLatestAttempts` skip `TIMELINE_ATTEMPT_KINDS.CONDITION` attempts, as
   `resolveAttemptProjection` already does (`RunOutputResolver.ts:737-740`). Check the other
   `streamAttempts` reducers (`resolveAttempt`, `resolveLatestFinalStepAttempts`) for the same
   gap. `read_output` and `history show` must still show condition output with the attempt it
   belongs to (`docs/cli/ctrlyoke.md:585`); only "the step's own output" excludes it.
3. Move the bug doc to `dev/bugs/implemented/`.

### Phase 1 — full form from events; remove the setting (pre-release)

1. `src/utils/CliEventDiff.ts` (D6), then `src/core/PriorContextTranscript.ts`: project
   `CliEvent[]` → `PriorContextTranscriptEntry[]` with the D1 caps (`PRIOR_CONTEXT_LIMITS`).
   Harness differences to handle:
   - **Normalize first.** Run `normalizeCliEvents` (`CliEventNormalizer.ts:974`) before
     projecting, as the run projection already does (`RunOutputResolver.ts:823`).
     `CLI_OUTPUT_EVENTS_APPENDED` deltas are stored un-normalized, and the normalizer is what
     folds a `TOOL_RESULT` into its bash, tool, or MCP call.
   - **Missing `toolCallId`.** Codex, opencode, and antigravity, plus Claude's completed
     `toolUseResult` events, emit completed `BASH_COMMAND`s with no `toolCallId`. They are linked
     by command text instead (`CliEventNormalizer.ts:363-420`). Qwen's `BashCommandData.output`
     exists only after that merge. The projection must not render a started command and its
     completed twin as two commands.
   - **Claude `bash_progress`.** Claude's live stream maps `bash_progress` to `TEXT` events
     (`ClaudeLogParser.ts:1431-1440`), so command output can arrive as model text. Mark or drop
     these at projection time. Otherwise they bypass the command-output cap in the full form and
     reach the summary's text-only tail.
   - **Uneven event kinds.** Not every harness emits every kind (no `FILE_DELETE` from opencode,
     qwen, or Claude; no `WEB_SEARCH` from codex or opencode), so each element is optional.
     **Chunk 1a complete:** both pure modules, constants, the Claude progress marker, and focused
     tests are in place. The consumer and renderer work remains in chunks 1b–1c.
2. `RunOutputResolver.resolvePriorContextItems`:
   - build `transcript` from `value.output.structured.events` for prompt and `finalStep` items,
     keeping `text` only as the D5 fallback;
   - add the `finalStep` prompt and script branch (D1b);
   - collect `filesChanged` for earlier attempts through the new projection-options argument
     (D4), threaded from `createPriorContextResolver` and `PriorContextPreviewBuilder`.
     **Chunk 1b complete:** structured prior-context projection, final-step prompts/scripts,
     earlier-attempt file changes, and the shared full-form XML renderer are implemented.
3. `buildPriorContextXmlFromItems`: render the transcript entries (D1 table) and
   `<earlierAttempts>`. Queue script rendering is unchanged.
4. Remove `general.includeFullDiffsInPriorContext`: `schemas/settings-schema.json`,
   `CtrlYokeSettings.ts` (type and default), `ConfigurationUtils.ts:162` and
   `shouldIncludeFullDiffsInPriorContext` (`:1428`), `settingsCatalog.ts:235`,
   `GeneralSection.tsx:304`, the v1 settings fixture
   (`src/test/fixtures/formats/settings/v1/representative.json`), then `npm run schema:update`.
   Pre-release, so no `schema:bump` (`CONTRIBUTING.md`, "Changing the schemas"). The settings
   schema has `additionalProperties: false`, so confirm that a `settings.json` still carrying
   the key loads (ignored, editor warning only) rather than failing, and add a test for it.
5. `extractTextFromEvents`: fixed `false` behavior; delete the option (D5).
6. Tests:
   - the transcript projection per event type, including the harness differences above (one
     fixture per harness where they differ);
   - caps and markers at line and code-point boundaries;
   - failed operations, and the legacy fallback;
   - `earlierAttempts`, and `finalStep` prompts and scripts;
   - a step appended to a non-latest run reads only that run (D4);
   - preview = injection.
     Update `CliResponseTextExtractor.test.ts` and the `RunOutputResolver` prior-context tests.
7. Docs:
   - `docs/workflows/context-files.md` ("Prior output references") says what the full form
     contains and that command output is tail-truncated;
   - `src/templates/skills/ctrlyoke-syntax/SKILL.md` (the `$previous` row);
   - `docs/reference/settings.md` regenerates;
   - `CHANGELOG.md`: the setting is removed, and `$previous` now includes commands and tool
     calls.

### Phase 2 — delete `CliOutput.response`; timeline v2 (pre-release)

Steps 3 and 4 move **readers only**. `response` is still written until step 5, so a reader that
moves early keeps working, and a v1 record still reads through the legacy branch. Every deletion
waits for step 5.

1. **Complete (chunk 2a):** `src/utils/StepOutputText.ts` (D8b), with tests that pin today's text exactly: for each harness
   fixture, `getTranscriptText(events)` equals the `false`-mode `extractTextFromEvents` output,
   and `getScriptOutputText` equals the script `response` written today.
2. **Complete (chunk 2a):** Give the four response-only kinds of content their homes (D8a):
   - add `TERMINAL_OUTPUT` to `CLI_EVENT_TYPES`, `CliOutputTypes.ts`, and the dashboard row and
     prior-context renderers;
   - switch the raw-stdout AI path to `TEXT` events;
   - give the script completion payload a typed `scriptOutput`.
3. **Backend readers** (the non-dashboard rows of D8c): prior context, `read_output`,
   `history show`, `CommitMessageGenerator`, history search, `CliTerminalFormatter`, and the
   `onResponseComplete` callers (they stop _using_ the payload). Delete the dead `PromptQueue`
   caches. Move the commit-message bug doc to `dev/bugs/implemented/`. Tests:
   - an interrupted attempt has text;
   - script search finds stdout;
   - the commit-message fallback ignores failure text and diff bodies.
4. **Complete (chunk 2c): Dashboard readers and the full-output path** (the dashboard rows of D8c, plus D9a):
   - fallback rows and Markdown export read `scriptOutput`;
   - every Copy Output site goes through one helper, using `ASSISTANT` text (decision 7);
   - close the Export Output gaps and make its `switch` exhaustive;
   - add Copy Full Output to both context menus on top of `generateMarkdownExport`.
     Tests:
   - copy output is identical from every menu;
   - one export fixture per event kind, including `FILE_WRITE` content, questions, user
     steers, search results, and the terminal tail;
   - Copy Full Output equals the single-step export.
     Docs: the dashboard page that lists the output context menu items (`docs/guide/output.md` and `docs/guide/dashboard.md`).
5. **Complete (chunk 2d): Stop writing, and bump the format** (D8e). Delete `extractTextFromEvents`,
   `CliResponseTextExtractor.ts`, `CliResult.response`, the `onResponseComplete` payload,
   `ResolvedRunAttemptValue.responseText`, the webview's `joinCliTextEvents` and follow-up merge,
   and the `SessionActivityRecorder` text append. Remove `response` and `prompt` from
   `CliOutput`. Add `LegacyCliOutputV1`, the TIMELINE v2 bump, the migration, and fixtures.
   Tests:
   - legacy v1 records (AI, script, PTY tail) render the same in the dashboard, `read_output`,
     `history show`, and prior context;
   - a mixed v1→v2 run reads correctly.
     Update the webview tests that assert on `response` (`outputUtils`, `workflowStore`,
     `useLatestStepOutput`, `useMessageHandler`, `outputProjectionEquivalence`, `outputRows`, and
     the context-menu hooks) and the fixture-only uses.
6. **Complete (chunk 2d):** Docs: `run-files.md` (record shape), `mcp-tools.md` (`responseText` is derived; cursors are
   opaque), `docs/cli/ctrlyoke.md` (`history show` text no longer repeats thinking), and
   `CHANGELOG.md` (format v2; Copy Output vs Copy Full Output; script search).

### Phase 3 — `$summary:` and `priorContextDetail`

1. **Complete:** Parsing (`ReferencePatterns.ts`, `FileReferenceParser.parseInlinePriorContextBody`):
   optional `summary:` prefix, `detail` on every parsed arm; diagnostics replace the reserved
   warning.
2. **Complete:** Schema: `priorContextDetail` in `executionProperties` (`enum: [full, summary]`, default
   `full`); `PROMPT_PROPERTIES.PRIOR_CONTEXT_DETAIL`; `PRIOR_CONTEXT_DETAILS` constant;
   `npm run schema:update`.
3. **Complete:** `mergePriorContextReferences` / `PriorContextMerge.ts`: per-index detail, full wins.
4. **Complete:** `summarizePriorContextItem` + `<filesChanged>` (D2), reusing the projection's file changes.
5. Editor: completions (`PriorContextCompletions.ts`, detail text "deterministic excerpt: head of
   prompt, files changed, tail of text; no AI call"), diagnostics, `StepReferenceRenumbering`,
   `PriorContextPreviewBuilder` (pass the detail through), and the inline-reference chip pattern.
6. Dashboard: a Full / Summary toggle bound to `priorContextDetail` in `PriorContextSelect.tsx`
   and `PropertiesDrawer.tsx`; `formatPriorContextLabel`
   (`src/ui/webview-react/utils/priorContext.ts`) appends the detail ("Previous step · summary").
7. Docs and agent-facing references: `context-files.md`, `src/templates/skills/ctrlyoke-syntax/SKILL.md`,
   `src/templates/agents/ctrlyoke-tech-support.agent.md`.
8. Templates: audit built-in templates' `$previous`/`priorContext` uses and switch hand-off and
   commit-style steps to `$summary:` where the full transcript is noise.
9. **Complete:** Tests: grammar, merge precedence, renumbering, summary caps and markers, `<filesChanged>`
   aggregation (multiple edits, create+edit, create+delete, failed, external path), preview =
   injection for both levels.

### Not in this plan — workflow steps

`WORKFLOW_STEP_PLAN.md` D12a's workflow arm renders its children through this renderer, and its
24 KB summary budget (`PRIOR_CONTEXT_LIMITS.WORKFLOW_BUDGET_BYTES`, defined here but unused until
then) applies to `$summary:` over a workflow step. That work belongs to the workflow step plan,
not to this one.

## Decisions

All decisions are settled (2026-10-13). Items 6–8 were made explicitly by the project owner.
The rest are the plan's recommendations, reviewed with the owner and not challenged; implement
them as written.

1. **Remove the setting outright** rather than keep it as an override. Recommended: a global
   override would bring back exactly the machine-dependence this plan removes.
2. **Command output tail-capped at 2 KB per command** in the full form (D1a). The alternative —
   untruncated — makes `$previous` after any test-running step unpredictable in size.
3. **`DIFF_BYTES` safety cap (64 KB per file)** instead of strictly unbounded diffs.
4. **Summary prompt head 2 KB** (D12b) rather than 4 KB.
5. **File reads render path and range only.** Re-reading is cheap, and the content may be stale
   by the time the next step runs anyway.
6. **Decided 2026-10-13: Phases 1–3 all land before launch.** Prior context should be settled
   and its bugs fixed before the first public install. Phase 2 is also the first time the
   persisted-format bump path (`schema:bump`-style version, migration chain, fixtures, read-only
   older host) is exercised end to end. It's better to do that once before release, while a
   mistake costs nothing.
7. **Decided: Copy Output copies `ASSISTANT` text**, the model's answer only. **Only on
   condition that a full-output path exists** (D9): Export Output, and a new Copy Full Output
   built on it, must carry everything (diffs, commands with their output, thinking, tool calls).
   That is the workaround for using one workflow's output in another (D9c). MCP `read_output`
   and `history show` use `TRANSCRIPT`.
8. **Decided: `read_output.responseText` keeps its name and changes content once** (no embedded
   diffs). The CLI keeps a full view through `history show` (D9b).
9. **`CliOutput.prompt` is dropped in the same bump** (D8d), so the format changes once.
10. **`finalStep` passes render their authored prompt** (D1b), so `$finalStep` reads like
    `$step:N`.
11. **Condition-script output is never a step's own output** (Phase 0). It stays visible with
    its attempt in `history show` and the dashboard.

## Open questions

None. Out of scope, and additive after launch:

- step-level cross-run addressing (`$run:…`, D9c);
- a `read_output` `detail: "full"` argument (D9b);
- the delta/seal and follow-up rewrite optimizations (D8d).
