# Condition Output Prompt References — `$preCondition:*` / `$endCondition:*`

## Status

Design plan, not yet implemented. **Revised 2026-08-19** after tracing the code: substitution
collapsed from three call sites to one (`CliPromptPreparer`), the
`createConditionEvaluationSummary` third parameter changed from `ScriptVerdict` to a details
bag, fenced-code masking added as a requirement, and the `{...}` migration surface expanded
with the shipped templates/schemas the original draft missed. Supersedes the `{stdout}`/`{stderr}`/... retry-prompt
placeholder syntax added in `dev/implemented/RETRY_PROMPT_CODEMIRROR_PLAN.md`. That plan
remains as historical record of the work it describes; this plan replaces the mechanism it
built.

## Problem

`preCondition` scripts (e.g. `npm test` gating a "fix the failing tests" prompt) already run
and produce output before the prompt is sent, but that output is invisible to the prompt
itself. The author has to write the prompt as if the failure state is unknown, instead of
being able to say "here's what actually failed: ...". The only existing precedent —
`{stdout}`/`{stderr}`/`{expected}`/`{actual}`/`{exitCode}`/`{compareSource}` — only exists in
the end-condition retry-prompt field (`RETRY_PROMPT_PLACEHOLDERS`,
`DashboardConstants.ts:1722-1729`), substituted by
`EndConditionEvaluator.buildRetryPrompt()` (`EndConditionEvaluator.ts:846-868`) and offered by
`CodeMirrorEditor`'s `getRetryPlaceholderCompletions` only when `mode === "endCondition"`
(`CodeMirrorEditor.tsx:239-269`).

`PRE_CONDITION_PLAN.md` explicitly scoped "pre-condition output injected into the prompt
text" as **Not In Scope** when pre-conditions shipped. This plan reverses that call.

### The data already exists at the right moment

`WorkflowExecutor.ts:545-634` evaluates a step's `preCondition` and produces a
`ConditionEvaluationSummary` (`passed`, `script`, `actual`, `actualSource`, `stdout`,
`stderr`, `exitCode`, `durationMs`, `error` — `CtrlYokeTypes.ts:792-803`) **before** the
prompt is dispatched. Today `recordPreConditionSummary`/`recordFinalStepPreConditionSummary`
(`PromptQueue.ts:647-683`) only stash it for UI display (step status panel, skip reason).
This plan threads that struct one hop further, into the outgoing prompt text — it does not
add a new evaluation pipeline.

## Decision: a `$`-family token, not a broadened `{...}`

Reject reusing brace syntax (`{stdout}`) in the main prompt editor. The retry-prompt field is
a small, single-purpose box where "any `{word}` is a placeholder" is a safe assumption; the
main prompt (and, per the discussion below, the retry prompt too) is freeform prose where
users paste JSON/code/regex — `{` is common there for reasons that have nothing to do with
condition output, and a literal `{stdout}` a user actually meant is indistinguishable from a
placeholder under blind substitution.

ctrlyoke already has a purpose-built namespace for "a runtime-resolved handle to output from
something that already ran": the `$` trigger — `$previous`, `$all`, `$finalStep`,
`$allFinalStep`, `$step:1,3-5` (`FileReferenceParser.ts:279-341`,
`atomicReferences.ts:711-741`). Unknown `$word` tokens are deliberately left unexpanded today
specifically so this namespace can grow. Reusing it gets condition-output refs the existing
autocomplete (`PromptCompletionProvider.getDollarCompletions` →
`CompletionHelpers.getPriorContextCompletions`, `CompletionHelpers.ts:1136-1157`), atomic
chip rendering, and lint-warning infrastructure (`createPriorContextLintExtension`,
`CodeMirrorEditor.tsx:2615-2678`) essentially for free.

### Grammar

```
$preCondition:<field>
$endCondition:<field>

field ::= stdout | stderr | expected | actual | exitCode | compareSource
```

Phase names (`preCondition`, `endCondition`) are taken verbatim from
`SCRIPT_OUTPUT_SOURCES.PRE_CONDITION` / `.END_CONDITION` (`DashboardConstants.ts:1574-1579`)
— already the canonical camelCase spelling used everywhere else (schema field names, verdict
labels). Field names are taken verbatim from the existing `RETRY_PROMPT_PLACEHOLDERS` values
(`DashboardConstants.ts:1722-1729`) — the vocabulary doesn't change, only the wrapping syntax
does (`{field}` → `$phase:field`).

This is a straightforward extension of the existing `$word:args` grammar already parsed by
`parseInlinePriorContextRefs` / `findInlinePriorContextRefs` — same regex shape
(`` `${NOT_AFTER_BOUNDARY}\\$([A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9,\\-]*)?)` ``), same
word-boundary rejection rules, same "unknown body → ignored" forward compatibility.

## Where each namespace is valid

Confirmed with the user: a pre-condition's output should be referenceable from **both** the
main prompt and the retry prompt — e.g. `"Your original fix to the test issues referenced in
$preCondition:stdout didn't fix all the tests, there's still failures shown here
$endCondition:stdout"` in a retry prompt. `$endCondition:*`, by contrast, can only ever be
meaningful in a retry prompt: the end-condition evaluates _after_ the prompt runs (to decide
pass/retry/stop), so there is no end-condition result yet when the original prompt is being
built.

| Ref               | Main prompt (`mode="prompt"`)                                           | Retry / pass-retry prompt (`mode="endCondition"`)                                        |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `$preCondition:*` | Valid. Warn if the step's effective `preCondition` is not configured.   | Valid. Same warning rule (the step's `preCondition`, not the retry itself).              |
| `$endCondition:*` | Warn — "not available until the retry prompt" (structural, not config). | Valid. No warning needed — a retry prompt only exists under a configured `endCondition`. |

This maps directly onto the `CodeMirrorEditorMode` the editor already threads down
(`"prompt"` vs `"endCondition"`, `CodeMirrorEditor.tsx:96`) — no new mode concept needed, just
one more lint rule keyed off the existing `mode` prop plus one new ref/config signal
(`hasPreCondition`).

## Data model change: `ConditionEvaluationSummary` needs `expected` + `compareSource`

Neither existing struct carries all six fields substitution needs:

- `ConditionEvaluationSummary` (`CtrlYokeTypes.ts:792-803`) has `stdout`/`stderr`/`exitCode`/`actual`/`actualSource`, but not `expected` or `compareSource`.
- `ScriptVerdict` (`CtrlYokeTypes.ts:~770-786`) has `expected`/`compareSource`/`actual`, but not raw `stdout`/`stderr`.

Today `EndConditionEvaluator.buildRetryPrompt()` papers over this by taking `expected` and
`compareSource` as separate parameters pulled from `prompt.endCondition` at the call site
(`EndConditionHandler.ts:493-498`). Both call sites that build a `ConditionEvaluationSummary`
already have a full `ScriptVerdict` in hand at construction time (e.g. `preReport.verdict` at
`WorkflowExecutor.ts:601-608`) but only extract `.action` from it today
(`createConditionEvaluationSummary`, `ScriptExecutionReporter.ts:122-146`).

**Change:** add `expected?: string` and `compareSource?: CompareSource` to
`ConditionEvaluationSummary`, and change `createConditionEvaluationSummary(script, result,
action?)` to `createConditionEvaluationSummary(script, result, details?: { action?:
ConditionAction; expected?: string; compareSource?: CompareSource })`.

**Verified — do _not_ make the third parameter a `ScriptVerdict`.** A verdict is not universally
available. `EndConditionHandler.recordEndConditionEvaluation` (`EndConditionHandler.ts:460-474`)
receives only an `EvaluationResult`, and the missing-script error path
(`WorkflowExecutor.ts:2112`) has no verdict at all. All four call sites do, however, have
`expected`/`compareSource` in reach, so a plain details bag serves every one of them:

- `WorkflowExecutor.ts:604` (pre-condition) → `{ action: preReport.verdict.action, expected:
preReport.verdict.expected, compareSource: preReport.verdict.compareSource }`.
- `WorkflowExecutor.ts:2112`, `:2179` (end-condition error paths) → `{ expected:
endCondition.returns, compareSource: endCondition.compareSource }`.
- `EndConditionHandler.ts:465` → `{ expected: prompt.endCondition?.returns, compareSource:
prompt.endCondition?.compareSource }`.

This makes `ConditionEvaluationSummary` the single struct condition-output substitution needs,
and is a small, additive change to a type already used only for display today.

## Runtime substitution

New shared helper, e.g. `src/core/ConditionOutputRefs.ts`:

```typescript
export interface ConditionOutputContext {
  preCondition?: ConditionEvaluationSummary;
  endCondition?: ConditionEvaluationSummary;
}

export interface ConditionOutputSubstitutionResult {
  text: string;
  /** $phase:field tokens found with no summary for that phase — feeds a diagnostic/warning. */
  unresolved: Array<{
    phase: "preCondition" | "endCondition";
    field: string;
    token: string;
  }>;
}

export function substituteConditionOutputRefs(
  text: string,
  context: ConditionOutputContext
): ConditionOutputSubstitutionResult;
```

Field lookup per phase: `stdout`/`stderr`/`exitCode` come straight off the summary;
`expected` off `summary.expected` (absent → `""`, matching today's `buildRetryPrompt`
behavior for an unset `returns`); `actual`/`compareSource` off `summary.actual` /
`summary.compareSource ?? "auto"`. Unknown `field` after a recognized phase prefix is left
untouched (forward-compat, matches the `$step:` precedent) but SHOULD be surfaced as an
"unrecognized placeholder" lint on the editor side (nice-to-have, not required for v1).

Substitution MUST mask fenced code blocks the way every other prompt-reference trigger does —
reuse `maskFencedCodeBlocks` from `FileReferenceParser.ts` (commit `7ece66af`, "mask all
prompt-reference triggers inside fenced code blocks"). A `$preCondition:stdout` inside a
`fence` is documentation, not a reference, and must survive verbatim.

### One substitution site, not three (revised)

The original draft put substitution in three places: `CliPromptPreparer` for the main prompt,
`EndConditionHandler` for the retry prompt, and possibly a third for preview. Tracing the code
shows that is both unnecessary and subtly wrong:

- **The retry prompt already goes through `CliPromptPreparer.planPrompt`.** `WorkflowExecutor`
  dispatches retries via the same `executeWithStreaming` path as the first attempt
  (`WorkflowExecutor.ts:2626-2650`), so a retry prompt substituted in `EndConditionHandler`
  would be substituted _again_ in `CliPromptPreparer`. That double pass is a live bug: if a
  script's stdout happens to contain the literal text `$preCondition:stdout`, the second pass
  expands the _substituted content_.
- **`EndConditionHandler` has no diagnostic channel.** Unresolved-reference reporting already
  exists in `CliPromptPreparer` (`PROMPT_DIAGNOSTIC_CODES` — note it is a _module-local_ const
  at `CliPromptPreparer.ts:57`, not in `DashboardConstants.ts` — consumed at `:244-251`).
  Substituting there gets diagnostics for free on both first attempt and retry.
- **Preview falls out for free.** `ExecutionPreviewService.ts:460-481` builds a `WorkflowContext`
  and calls `planPrompt` directly. With no summaries on that context, `$preCondition:*` resolves
  empty and reports an unresolved-token diagnostic — exactly the "no data yet" behavior the
  third call site was going to hand-roll. No changes needed in `ExecutionPreviewService` or
  `CliJsonResultBuilder`.

**So: substitute in exactly one place — `CliPromptPreparer.planPrompt`** — driven by data carried
on `WorkflowContext`. `EndConditionHandler.buildRetryPrompt`/`buildPassRetryPrompt` stop
substituting and return the raw template; `EndConditionEvaluator.buildRetryPrompt()` is deleted.

#### Wiring

1. **`WorkflowContext` gains two value fields** (`WorkflowContextTypes.ts`):
   `preConditionResult?: ConditionEvaluationSummary` and
   `endConditionResult?: ConditionEvaluationSummary`. These are _values_, not resolver callbacks —
   unlike `resolvePriorContextItems` there is no async work; the data is already computed.

2. **`WorkflowExecutor` populates them at its two dispatch sites.** Verified: `WorkflowExecutor`
   already constructs a **fresh `WorkflowContext` object literal per dispatch** — at
   `WorkflowExecutor.ts:787-800` (first attempt) and `:2634-2650` (retry). `WorkflowInstance`
   builds the longer-lived _`WorkflowExecutionContext`_ (`WorkflowInstance.ts:4165`), which is a
   different type; nothing changes there, and no shared object is mutated.
   - First-attempt literal (`:787`): set `preConditionResult` only. Deliberately leave
     `endConditionResult` undefined so the main prompt can never pick up a stale end-condition
     summary from a previous whole-step retry attempt. This matches the documented rule that
     `$endCondition:*` is retry-prompt-only, and keeps first-attempt text deterministic.
   - Retry literal (`:2634`): set both.

3. **Read the summaries through new `PromptQueue` accessors**, symmetric with the four existing
   writers (`PromptQueue.ts:647-698`):

   ```typescript
   public getPreConditionSummary(target: WorkflowAttemptTarget): ConditionEvaluationSummary | undefined
   public getEndConditionSummary(target: WorkflowAttemptTarget): ConditionEvaluationSummary | undefined
   ```

   (read `this.state.results[stepIndex].preCondition`/`.endCondition` or
   `this.finalStepRuntime?.preCondition`/`.endCondition` depending on `target.kind`, mirroring
   `WorkflowExecutor.recordPreConditionSummary` at `WorkflowExecutor.ts:1841-1850`). Using the
   already-recorded value — rather than re-threading a fresh copy — guarantees the prompt sees
   exactly what the step status panel shows for the same run, and works from the retry dispatch
   site even though it lives in a different method than the evaluation.

4. **`CliPromptPreparer.planPrompt` substitutes first.** Call
   `substituteConditionOutputRefs(originalPromptText, { preCondition: workflowContext?.preConditionResult,
endCondition: workflowContext?.endConditionResult })` as the very first step, before
   slash-command detection (`CliPromptPreparer.ts:130-140`). This is a pure text swap with no
   size/attachment implications (unlike `$previous`, which pulls in a whole XML block via
   `resolvePriorContextItems`), so doing it unconditionally up front is safe. Each `unresolved`
   entry becomes a `CompatibilityDiagnostic` under a new code (e.g.
   `prompt.reference.condition-output-unavailable`) added to the existing module-local
   `PROMPT_DIAGNOSTIC_CODES` — no new diagnostic plumbing.

## Editor changes

### Parser duplication (pre-existing, not fixed by this plan)

The webview does **not** import the core `FileReferenceParser.ts` — `atomicReferences.ts`
carries its own independent reimplementation of the `$word:args` regex and dispatch
(`atomicReferences.ts:711-741` vs `FileReferenceParser.ts:294-341`). This plan follows the
existing (duplicative) pattern rather than fixing it: both parsers gain the two new
`preCondition`/`endCondition` kinds in lockstep. Merging the two parsers is a separate,
unrelated cleanup — out of scope here.

Recommended shape in both files: extend the `kind` union (`InlinePriorContextRef` /
its core counterpart) with `"conditionOutput"`, carrying `{ phase: "preCondition" |
"endCondition"; field: string }`, OR add a sibling type/parser
(`ConditionOutputRef`/`parseConditionOutputRefs`) reusing the same tokenizer regex but kept
structurally separate from prior-context refs — these are semantically different (a scalar
field from a script run vs. another step's full response) and must never be handed to
`resolvePriorContextItems`/`buildPriorContextXmlFromItems`. Prefer the sibling-type approach:
it keeps `PriorContextItem`/`refToPriorContext` (`HarnessIntegration.ts`) untouched and avoids
a `kind`-based runtime branch silently missing a case.

### Decoration / chips

New CSS class parallel to `.cm-prior-context-ref` (`CodeMirrorEditor.tsx:1856-1858`), e.g.
`.cm-condition-output-ref`. In atomic mode, extend `findAtomicReferences`
(`atomicReferences.ts`) to emit a chip for the two new kinds — reuse the icons already chosen
for these phases in `SCRIPT_OUTPUT_UNIFICATION_PLAN.md`'s CLI header
(`codicon-shield` for pre-condition, `codicon-checklist` for end-condition) so the chip in the
prompt editor visually matches the verdict block the user sees after the script runs. Chip
label: `preCondition:stdout` / `endCondition:stdout` (short field name, not the full script
text).

### Completions

Add the 12 entries (2 phases × 6 fields) to `CompletionHelpers.getPriorContextCompletions`
(`CompletionHelpers.ts:1136-1157`) — always offered, same as `$finalStep` is offered whether
or not a final step is actually configured; the lint extension (below) is what warns, not the
completion list. Consider a two-level completion (typing `$preCondition:` first, then a
second completion pass for the field) to mirror `$step:` — or keep it flat like today's
`{stdout}` list for simplicity. Either is fine; flat is less code.

### Lint

New `createConditionOutputLintExtension(hasPreConditionRef, modeRef)`, structurally identical
to `createPriorContextLintExtension` (`CodeMirrorEditor.tsx:2615-2678`):

- `preCondition` ref, `hasPreConditionRef.current === false` → warning: `"$preCondition:<field> has no effect — this step has no pre-condition configured"`.
- `endCondition` ref, `mode !== "endCondition"` → warning: `"$endCondition:<field> is only available in the retry prompt, not the initial prompt"`.

`hasPreConditionRef` is a new prop threaded down the same way `stepCountRef`/`hasFinalStepRef`
already are (`CodeMirrorEditor.tsx:119-121`, `772-785`). `PromptEditor.tsx:460-463` already
resolves `properties.preCondition` for the drawer (including workflow-level inheritance and
the `null`-disables-inheritance override) — reuse that same resolved boolean, don't
re-derive it.

## Migration: remove the `{...}` retry-placeholder system

Because this is pre-release with no back-compat obligation, and per the user's decision, this
is a full replacement, not an addition:

- Delete `getRetryPlaceholderCompletions`, `RETRY_PROMPT_PLACEHOLDER_METADATA`, and the
  `{`-triggered `override` branch (`retryPlaceholderCompletions` in the `autocompletion()`
  call) from `CodeMirrorEditor.tsx` (`:169-197`, `:239-269`, `:1403-1411`).
- Delete `EndConditionEvaluator.buildRetryPrompt()` (`EndConditionEvaluator.ts:846-868`);
  callers move to `substituteConditionOutputRefs`.
- `RETRY_PROMPT_PLACEHOLDERS` (`DashboardConstants.ts:1722-1729`) survives as the shared
  6-field vocabulary constant (still useful for the completion list and the substitution
  lookup table) — it just stops being paired with brace syntax.
- `RETRY_PROMPT_PLACEHOLDER_METADATA` is deleted along with the `{`-trigger machinery.

### Full `{...}` migration surface (verified by repo-wide grep)

The original draft listed only two schema files and four docs. The real surface is larger, and
two entries are **functional, not documentation** — shipped templates that would silently stop
substituting:

**Functional (must change or the feature regresses):**

- `src/templates/workflows/fix-tests.ctrlyoke.yaml:22` — `{stdout}` inside a live `retryPrompt`.
- `src/templates/workflows/full-feature.ctrlyoke.yaml:77` — same.
- `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx:598-601` — the user-facing
  hint "Type { for retry placeholders like {stderr} and {stdout}".

**Schema / settings:**

- `schemas/workflow-schema.json:843, :847` and the mirrored `schemas/workflow-schema.yaml`.
- `schemas/settings-schema.json:223, :227` — `retryPrompt`/`passRetryPrompt` descriptions
  (**missed by the original draft**).

**Prose that teaches the syntax to users and to AI agents:**

- `src/templates/agents/ctrlyoke-workflow-composer.agent.md:38, :46, :122`,
  `src/templates/agents/ctrlyoke-tech-support.agent.md:148-149, :221`,
  `src/templates/agents/test-repair.agent.md:7` — shipped agent instructions; leaving them stale
  actively teaches the removed syntax to the composer agent.
- `docs/workflows/end-conditions.md`, `docs/workflows/templates.md`,
  `docs/guide/quick-start.md`, `docs/guide/your-first-workflow.md`, `QUICK_START.md`
  (the `.vitepress/.temp` files are generated — do not hand-edit).
- `.github/instructions/templates.instructions.md`.
- `manual-test/README.md`, `manual-test/retry-max-exhaustion-test.ctrlyoke.json`,
  `manual-test/retry-multi-step-test.ctrlyoke.json`, `manual-test/test-property-sync.ctrlyoke.yaml`,
  `manual-test/examples/workflow-properties/shared-end-condition.ctrlyoke.yaml`.

**Leave alone:** `dev/implemented/**`, `dev/rejected/**`, `dev/reference/**` — historical record.

## File change summary

| File                                                                                                                                | Change                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/CtrlYokeTypes.ts`                                                                                                        | `ConditionEvaluationSummary` gains `expected?`, `compareSource?`                                                                                                                                                                   |
| `src/core/orchestration/ScriptExecutionReporter.ts`                                                                                 | `createConditionEvaluationSummary` takes `verdict?: ScriptVerdict` instead of `action?`, copies `expected`/`compareSource`                                                                                                         |
| `src/core/ConditionOutputRefs.ts`                                                                                                   | NEW — `substituteConditionOutputRefs`, `ConditionOutputContext`                                                                                                                                                                    |
| `src/core/WorkflowExecutor.ts`                                                                                                      | Populate `preConditionResult` on the first-attempt context literal (`:787-800`) and both fields on the retry literal (`:2634-2650`); pass the details bag into `createConditionEvaluationSummary` calls (`:604`, `:2112`, `:2179`) |
| `src/core/EndConditionHandler.ts`                                                                                                   | `buildRetryPrompt`/`buildPassRetryPrompt` stop substituting — return the raw template; `recordEndConditionEvaluation` passes `expected`/`compareSource` from `prompt.endCondition`                                                 |
| `src/core/PromptQueue.ts`                                                                                                           | NEW `getPreConditionSummary(target)` / `getEndConditionSummary(target)` accessors                                                                                                                                                  |
| `src/core/EndConditionEvaluator.ts`                                                                                                 | Delete `buildRetryPrompt`                                                                                                                                                                                                          |
| `src/types/WorkflowContextTypes.ts`                                                                                                 | `WorkflowContext` gains `preConditionResult?` and `endConditionResult?: ConditionEvaluationSummary`                                                                                                                                |
| `src/core/harness/shared/CliPromptPreparer.ts`                                                                                      | `planPrompt` calls `substituteConditionOutputRefs` first (both phases); unresolved refs → new diagnostic code                                                                                                                      |
| `src/utils/FileReferenceParser.ts`                                                                                                  | New `parseConditionOutputRefs` (or extended kind), core-side                                                                                                                                                                       |
| `src/ui/webview-react/utils/atomicReferences.ts`                                                                                    | Same, webview-side; `findAtomicReferences` emits chips for the two new kinds                                                                                                                                                       |
| `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`                                                                       | Remove `{`-placeholder machinery; add `hasPreConditionRef` prop, `createConditionOutputLintExtension`, decoration class                                                                                                            |
| `src/completions/CompletionHelpers.ts`                                                                                              | `getPriorContextCompletions` gains the 12 new entries                                                                                                                                                                              |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`, `PromptEditor.tsx`                                                   | Thread resolved `hasPreCondition` down to `CodeMirrorEditor` alongside `stepCount`/`hasFinalStep`                                                                                                                                  |
| `schemas/workflow-schema.json`, `schemas/workflow-schema.yaml`                                                                      | Update `retryPrompt`/`passRetryPrompt` description strings                                                                                                                                                                         |
| `docs/workflows/end-conditions.md`, `docs/workflows/templates.md`, `docs/guide/quick-start.md`, `docs/guide/your-first-workflow.md` | Replace `{stdout}`-style examples                                                                                                                                                                                                  |
| `src/templates/workflows/fix-tests.ctrlyoke.yaml`, `full-feature.ctrlyoke.yaml`                                                     | Live `retryPrompt` templates using `{stdout}` — must migrate or the feature regresses                                                                                                                                              |
| `src/templates/agents/*.agent.md` (3 files)                                                                                         | Shipped agent prose teaching the removed `{...}` syntax                                                                                                                                                                            |
| `schemas/settings-schema.json`                                                                                                      | `retryPrompt`/`passRetryPrompt` description strings                                                                                                                                                                                |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`                                                                  | `{`-trigger hint text → `$` trigger                                                                                                                                                                                                |
| `src/core/ExecutionPreviewService.ts`, `src/cli/CliJsonResultBuilder.ts`                                                            | **No change needed** — preview already routes through `planPrompt` (`ExecutionPreviewService.ts:460-481`) and correctly reports unresolved refs when no summaries are available                                                    |

## Testing

- `src/test/endConditionEvaluator.test.ts` — remove/replace `buildRetryPrompt` template
  substitution suite (`suite("buildRetryPrompt - Template Substitution"...)`, lines ~104-260)
  with coverage of the new helper.
- New `src/test/unit/conditionOutputRefs.test.ts` — all 12 tokens resolve; unresolved
  `endCondition` ref in a main-prompt context reports `unresolved`; missing field on a
  configured phase falls back correctly (absent `expected` → `""`, matching today's
  behavior).
- `src/test/unit/EndConditionHandler.test.ts` — retry/pass-retry prompts resolve both
  `$preCondition:*` and `$endCondition:*` together; a step with no `preCondition` configured
  still builds a valid retry prompt (no crash, `$preCondition:*` tokens just don't resolve).
- `src/test/integration/preConditionFlow.integration.test.ts` — extend to assert the main
  prompt's outgoing text has `$preCondition:stdout` substituted before dispatch.
- `src/ui/webview-react/test/components/editor/CodeMirrorEditor.test.tsx` — replace the
  `RETRY_PROMPT_PLACEHOLDERS` completion assertions (`:47-59`) with `$preCondition:`/
  `$endCondition:` completion + lint assertions for both `mode` values.
- `src/ui/webview-react/test/utils/atomicReferences.test.ts` — chip rendering for the two new
  ref kinds.
- Schema validation tests — confirm removing the old description text doesn't break any
  snapshot assuming the old wording. Verified to include `src/test/unit/PromptFileLoader.test.ts`,
  `src/test/unit/TemplateManager.test.ts`, and `src/test/validationUtils.test.ts`, all of which
  currently assert `{stdout}`-bearing fixtures.
- `src/test/harness/hooks.harness.test.ts` also contains `{stdout}` — update the text, but
  **do not run `npm run test:harness`** (real harnesses, real cost, 30+ minutes).
- Fenced-code masking: a `$preCondition:stdout` inside a fenced block is left verbatim, matching
  the invariant established in commit `7ece66af`.
- Double-substitution guard: a retry prompt whose resolved stdout itself contains the literal
  text `$preCondition:stdout` must not be expanded a second time — this is the reason
  substitution happens only in `CliPromptPreparer`.

## Edge cases

| Scenario                                                                            | Handling                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step has `preCondition` but it was skipped this run (e.g. workflow resumed mid-run) | `preConditionResult` is `undefined` → `$preCondition:*` resolves empty + unresolved-token diagnostic, same as "not configured"                                                                       |
| `preCondition.returns` unset                                                        | `$preCondition:expected` → `""`, matching today's `buildRetryPrompt` behavior for unset `returns`                                                                                                    |
| `$preCondition:unknownField`                                                        | Left as literal text (forward-compat with `$step:` precedent); worth a follow-up lint for unrecognized field names, not required for v1                                                              |
| Same step has both `preCondition` and `endCondition`, retry prompt references both  | Both resolve independently — `ConditionOutputContext` carries both summaries simultaneously                                                                                                          |
| `$endCondition:*` typed in the main prompt of a step that also has a retry prompt   | Lint warns in the main-prompt editor instance (`mode="prompt"`); at runtime, resolves to empty + diagnostic, exactly like the "not configured" case                                                  |
| Workflow-level `preCondition` inherited (not set directly on the step)              | `hasPreConditionRef` reflects the _resolved_ value (inheritance + `null` override), matching how `PropertiesDrawer` already resolves it for display                                                  |
| `finalStep` loop, `preCondition` re-evaluated each iteration                        | `PromptQueue.finalStepRuntime.preCondition` is overwritten each iteration (existing behavior); `$preCondition:*` in the finalStep's prompt/retry prompt always sees the _current_ iteration's result |

## Non-goals

- Fixing the core/webview `$`-token parser duplication — tracked as separate cleanup.
- A generalized `$scriptStep:*` namespace for `type: script` output — script steps have no AI
  prompt to inject into; out of scope until/unless that changes.
- Validating/erroring (as opposed to warning) on an unresolved condition-output ref — stays
  advisory, matching how unresolved `@file` references are diagnostics, not hard failures.
- Two-level (`$preCondition:` then a second completion pass for the field) vs. flat
  completion list — implementation detail, not a design fork worth blocking on.
