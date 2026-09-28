# `{{vars}}` are not substituted inside a referenced prompt file

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/WorkflowExecutor.ts` (`resolveEffectivePrompt`), `src/core/ExecutionPreviewService.ts` (`substituteStep`), `src/core/ParallelGroupPreflight.ts`
- **Resolution:** fixed in this commit

## Symptom

`prompts/r.prompt.md` contains `Review {{target}} carefully.`, and the workflow is:

```yaml
harness: claude-cli
vars:
  target: lib
steps:
  - prompt: ./prompts/r.prompt.md
```

- `ctrlyoke run pr.ctrlyoke.yaml --dry-run` shows the prompt as `Review {{target}} carefully.`
- A real run (with the harness removed from PATH, so nothing spawned) records the same text in
  `events.jsonl` `attemptStarted.payload.prompt`.

Expected: `Review lib carefully.` The docs describe vars as substituted into the prompt text.
Substituting into the path itself (`./prompts/{{pf}}.prompt.md`) does work. The
unresolved-variable diagnostic never sees the file content either.

## Steps to Reproduce

1. Create the prompt file and workflow above.
2. Run `ctrlyoke run pr.ctrlyoke.yaml --dry-run`.
3. The previewed prompt still contains `{{target}}`.

## Root Cause

`resolveEffectivePrompt` (`WorkflowExecutor.ts:~4552-4595`) runs
`VarSubstitutor.applyToPromptText` on the prompt *value* (the path) and only afterwards loads the
file through `PromptFileResolver.resolvePromptValue`. The preview (`ExecutionPreviewService.ts:~745-760`)
and parallel preflight (`ParallelGroupPreflight.ts:~170-173`) use the same order. Before `084ea4e5`
("resolve prompt files at execution time") the parser inlined the file content first, so
substitution covered it. This is a regression.

## Suggested Fix

Keep substituting the path, then run `VarSubstitutor.applyToPromptText` again on the resolved
content when the value was a file reference. Single-source this "substitute, resolve, substitute
content" sequence in one helper used by the executor, preview and preflight, and run the
unresolved-variable report on the final text. Tests: a var inside a referenced `.prompt.md` is
substituted in both the preview and the executed prompt, and an unknown var in the file is reported.
