# Docs misstate the YAML `!=` behavior, the omitted-`maxRetries` default, the dynamic-queue example, and script lookup

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), verified against code and `ctrlyoke validate`
- **Area:** `docs/workflows/end-conditions.md`, `docs/workflows/dynamic-queue.md`, `schemas/workflow-schema.json` (feeds the generated `docs/reference/workflow-schema.md`)
- **Resolution:** fixed in this commit

## Symptom

1. **`operator: !=`.** `docs/workflows/end-conditions.md` (~133-136) and the
   `operator` description in `schemas/workflow-schema.json` say `operator: !=`
   "parses as a YAML tag and silently becomes an empty string". In fact
   `PromptFileParser` loads YAML with `js-yaml` and `CORE_SCHEMA`, which throws
   `unknown scalar tag !<!=>`. The file fails to load, and `ctrlyoke validate`
   exits 2. Both `>=` and `!=` are parse errors.
2. **Omitted `maxRetries`.** `docs/workflows/end-conditions.md` (~82) says
   "Unset: `1` when `onPass`/`onFail` is `retry`, else the
   `defaults.endCondition.maxRetries` setting (`0`)". The code
   (`PromptQueue.ts` ~140-146) applies the setting only when the condition has
   its own `retryPrompt`. Otherwise the limit is `0`.
3. **Dynamic-queue example.** `docs/workflows/dynamic-queue.md` (~41-47) shows a
   root workflow with `maxSteps` and `finalStep` but no `steps`. It fails
   validation with "must have required property 'steps'". It needs `steps: []`,
   which the next sentence on the page already implies.
4. **Script lookup.** The schema's `script` description says "Resolved relative
   to workspace root or .ctrlyoke/". `resolveScriptPath`
   (`EndConditionEvaluator.ts`) checks four places in order: the execution
   directory, the workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/`. The
   guide page `end-conditions.md` (~160-162) already lists all four, so the
   generated reference page contradicts it.

## Suggested Fix

- Correct the prose in `end-conditions.md` (items 1 and 2) and `dynamic-queue.md` (item 3).
- Fix the `operator` and `script` descriptions in `schemas/workflow-schema.json`
  (every occurrence), then run `npm run schema:update` to regenerate the
  reference docs and `SchemaDescriptions.ts`.
- Never hand-edit `docs/reference/*`. `npm run check:docs` must pass.
