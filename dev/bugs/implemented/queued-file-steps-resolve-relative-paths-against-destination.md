# Steps queued from another workflow file resolve relative paths against the wrong folder

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (reproduced against the compiled `out/` build)
- **Area:** `src/core/WorkflowInstance.ts` (`appendFromFile`), `src/core/PromptFileParser.ts`, `src/core/WorkflowExecutor.ts`, `src/core/PromptFileResolver.ts`
- **Resolution:** fixed in this commit

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

File append paths now pass through one rebasing helper before queueing. It
rewrites standalone prompt-file references (including end-condition retry
prompt templates) and workflow-relative inline file references to resolve
from the destination workflow. Script paths do not use the workflow file's
folder as their base, so they are unchanged.

Workflow-level `vars` from the source file are still dropped on append; this
remains a follow-up outside this fix.
