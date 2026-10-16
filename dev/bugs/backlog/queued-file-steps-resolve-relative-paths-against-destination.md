# Steps queued from another workflow file resolve relative paths against the wrong folder

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (reproduced against the compiled `out/` build)
- **Area:** `src/core/WorkflowInstance.ts` (`appendFromFile`), `src/core/PromptFileParser.ts`, `src/core/WorkflowExecutor.ts`, `src/core/PromptFileResolver.ts`
- **Severity:** medium

## Symptom

"Queue from File..." (and the "Queue Steps with ctrlyoke" command) validates
the queued file's relative prompt-file paths against **that file's** folder,
but at run time resolves them against the **destination** workflow's folder.
The step either fails with
`Prompt file reference "./task.prompt.md" could not be found`, or — if a file
of the same name exists next to the destination workflow — silently runs that
other file's prompt. `docs/workflows/index.md` says relative paths resolve from
the workflow file's own folder.

## Steps to Reproduce

1. `ws/main.ctrlyoke.yaml`: `steps: [{prompt: hello}]`.
2. `ws/sub/extra.ctrlyoke.yaml`: `steps: [{prompt: ./task.prompt.md}]`, with
   `ws/sub/task.prompt.md` present.
3. Load `main`, then Queue from File `sub/extra`. Validation passes.
4. Run: the step fails to find `./task.prompt.md`. With `ws/task.prompt.md`
   also present, the step runs the root file's text instead.

The same applies to `./`/`../` inline `@` references inside the queued steps'
prompt text.

## Root Cause

- `PromptFileParser.validatePromptReference` (around lines 938-954) validates
  against the source file's folder but keeps the authored string.
- `WorkflowInstance.appendFromFile` (around lines 2526-2600) appends the steps
  through `appendSteps` without recording where they came from.
- At run time the run has a single `sourceDefinitionPath` (the destination's),
  which `WorkflowExecutor.getPromptFileResolutionOptions` (around line 4919)
  and `PromptFileResolver.getCandidates` (around line 311) use as the base.

## Suggested Fix

Before `appendSteps`, rebase relative prompt-file paths (and `./`/`../` inline
references, plus any other step-level relative paths such as script paths) in
the appended steps so they resolve identically from the destination — e.g. to
workspace-relative paths. Keep this in one helper. Add a test that queues a
file from a subfolder and resolves its prompt file correctly. (Workflow-level
`vars` from the source file are also dropped on append; note it in the fix
commit if left out of scope.)
