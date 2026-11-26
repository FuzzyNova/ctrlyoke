# The parallel-group sibling check rejects `$step:N` written inside code, so valid workflows fail to load

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/core/PromptFileParser.js`)
- **Area:** `src/core/ParallelGroupTopology.ts` (`getParallelSiblingReferenceErrors` ~60-95)
- **Resolution:** fixed in this commit

## Symptom

A parallel member whose prompt mentions a sibling's `$step:N` inside inline code or a
fenced code block makes the whole workflow fail to load:

```
Failed to parse t.ctrlyoke.yaml: Error: Step 1: Inline priorContext reference 2 cannot target a sibling in parallel group (steps 1, 2)
```

The same check rejects append, insert, replace, reorder and run-continuation mutations
for such a member.

## Steps to Reproduce

1. Save `t.ctrlyoke.yaml`:

   ```yaml
   name: t
   steps:
     - parallel:
         - prompt: "Explain what `$step:2` means in ctrlyoke"
         - prompt: "Do something else"
   ```

2. Load it (`PromptFileParser.parsePromptFile`, the dashboard, or `ctrlyoke run --dry-run`).
3. It fails with the error above. Putting `$step:2` inside a ``` fence fails the same way.

At run time the token really is literal text: `parseInlinePriorContextRefs` finds no
references in either prompt, so nothing would have been expanded.

## Expected

`docs/workflows/context-files.md` ("Writing references literally", ~184): "References
inside inline code (single backticks) or a fenced code block are not expanded. Wrap a token
in backticks to write about it". The validator should agree with the runtime about what
counts as a reference, and accept the file.

## Root Cause

`getParallelSiblingReferenceErrors` (`src/core/ParallelGroupTopology.ts` ~83) calls
`scanInlinePriorContextRefs(step.prompt)`, which deliberately does no code masking
(`src/utils/FileReferenceParser.ts` ~1004). The runtime uses the masked
`parseInlinePriorContextRefs` (`FileReferenceParser.ts` ~1047; used by
`src/core/harness/shared/CliPromptPreparer.ts` and `src/core/StepReferenceShifts.ts`).
The check runs at load time (`PromptFileParser.ts` `throwOnParallelReferenceErrors`) and
through `assertNoParallelSiblingReferences` in `PromptQueue`, `WorkingFileManager` and
`RunContinuationService`.

Related gap in the same function: it only scans `step.prompt`. `StepReferenceShifts`
treats `endCondition.retryPrompt` and `passRetryPrompt` as positional-reference text too,
and retry prompts are expanded by the same `CliPromptPreparer`. A real sibling reference
in a retry prompt is therefore never flagged, and `PriorContextMerge.ts` (~146) drops it
silently at run time.

## Suggested Fix

- The retry-prompt gap was deliberately left open and needs a compatibility decision (a warning instead of an error, or a schema bump).
- Use the code-masked `parseInlinePriorContextRefs` in `getParallelSiblingReferenceErrors`.
- Single-source "which step texts carry inline `$step` references" with
  `StepReferenceShifts` (prompt, `endCondition.retryPrompt`, `passRetryPrompt`), so the
  sibling check also covers retry prompts.
- Tests (`src/test/unit/ParallelGroupTopology.test.ts`, plus a `PromptFileParser` case):
  inline-code and fenced `$step:2` in member 1 produce no error; an unmasked `$step:2` in
  member 1's `endCondition.retryPrompt` produces the sibling error; the YAML above parses.
