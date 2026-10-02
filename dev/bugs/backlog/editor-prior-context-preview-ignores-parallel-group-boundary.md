# Editor prior-context preview, token count, and lint ignore the parallel-group boundary

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/editor/PromptEditor.tsx`, `src/ui/PromptEditorSupportService.ts`, `src/utils/PriorContextPreviewBuilder.ts`
- **Severity:** medium

## Symptom

A step inside a parallel group sees prior context only from steps **before the
group starts** at runtime (siblings are excluded, as documented in
`docs/workflows/context-files.md` under "Context at a parallel boundary"). The
prompt editor does not apply that boundary. It uses the step's own index, so for
a group member the editor:

- shows a Ctrl+click / hover `<priorContext>` preview that includes sibling
  outputs the run never injects;
- counts sibling outputs in the attachment token count;
- has its prior-context lint (`$previous:N` count warning, `$step:N`
  out-of-range check) treat siblings as valid prior steps.

## Steps to Reproduce

1. Workflow: steps 1–2 sequential, then steps 3–5 in one `parallel:` group.
2. Step 5's prompt contains `$previous:3`. Run the workflow to completion.
3. Open the run, select step 5, and Ctrl+click `$previous:3`.
4. The preview shows outputs of steps 2, 3, 4. The run actually injected only
   steps 1 and 2. The lint does not warn that at most 2 outputs are available.
   `$step:4` in step 5 is likewise not flagged, though it resolves to nothing at
   runtime.

## Root Cause

- Runtime: `WorkflowExecutor.getParallelGroupStartBoundary`
  (`src/core/WorkflowExecutor.ts` ~4774) and `ParallelGroupPreflight`
  (`groupStartBoundary: options.group.startIndex`) pass the group's
  `startIndex` to `RunOutputResolver.resolvePriorContextItems`.
  `ExecutionPreviewService.parallelGroupStartBoundary` does the same for the
  dry-run preview.
- Editor: `PromptEditor.tsx` ~289 computes
  `stepCount = selectionTarget.index` for queue steps with no group awareness.
  That value is used as the boundary for the lint in `CodeMirrorEditor.tsx`
  (~2817–2870), for `OPEN_PRIOR_CONTEXT` / `REQUEST_PRIOR_CONTEXT_PREVIEW` →
  `PromptEditorSupportService.buildPriorContextContent` →
  `PriorContextPreviewBuilder.buildPreview`, and for the token-count path
  (`useAttachmentTokenCount` / `encodePriorContextTokenRef`).

## Suggested Fix

Compute the boundary in the webview the same way the runtime does: if the
selected queue step lies inside a `ParallelGroupDefinition` in
`useWorkflowStore.parallelGroups`, use that group's `startIndex`, otherwise the
step index. Single-source the lookup (a helper next to the existing
group-membership helper in `WorkflowStepsPanel.tsx` ~225, or a shared util) and
feed the result to every consumer of `stepCount`. New-prompt and final-step
targets keep using `prompts.length`.
