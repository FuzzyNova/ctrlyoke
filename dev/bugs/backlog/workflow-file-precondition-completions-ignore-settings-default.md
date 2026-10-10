# `$preCondition:` completions are hidden in workflow files when only the settings default pre-condition applies

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script)
- **Area:** `src/completions/WorkflowPromptDiagnostics.ts` (`getWorkflowPromptCompletionContext`), workflow-file completion extension in the workspace editor
- **Severity:** low

## Symptom

In the hosted workspace editor, open a `.ctrlyoke.yaml`/`.json` file whose step
has no step-level or workflow-level `preCondition` and relies on the
`defaults.preCondition` setting. Typing `$preC` in that step's prompt offers no
completions. The prompt lint for the same text correctly reports no "no
pre-condition configured" warning, so lint and completions disagree. The
dashboard prompt editor gets this right because it folds in
`globalSettings.defaultPreCondition` (`PromptEditor.tsx`).

## Steps to Reproduce

```ts
const yaml = `steps:\n  - prompt: "Check $preCondition:stdout now"\n`;
await getWorkflowPromptDiagnostics(yaml, "workflowYaml", async () => [], {
  script: "echo hi",
}); // [] — no warning
const ctx = getWorkflowPromptCompletionContext(
  yaml,
  "workflowYaml",
  yaml.indexOf("now")
);
ctx.hasPreCondition; // false
getContextualPriorCompletions("preC", ctx); // [] (with hasPreCondition: true → 6 preCondition:* items)
```

## Root Cause

`getWorkflowPromptCompletionContext` calls `getSpanContext(span, root)` without
a `settingsPreCondition` argument, so `hasPreCondition` is false for any step
without its own or a workflow-level `preCondition`, and
`getContextualPriorCompletions` (`src/completions/PromptContextCompletions.ts`)
filters out every `preCondition:*` item. The lint path passes the setting
(`getWorkflowPromptDiagnostics(..., settingsPreCondition)`, fed by
`options.getSettingsPreCondition` in `workflowPromptLintExtension.ts` and
`WorkspaceFileEditor.tsx`), but the completion extension
(`workflowFileCompletionExtension.ts`) has no way to supply it. The doc comment
above `getSpanContext` also describes `hasPreCondition` behaviour the code does
not implement.

## Suggested Fix

Add an optional `settingsPreCondition` parameter to
`getWorkflowPromptCompletionContext` and forward it to `getSpanContext`; add a
`getSettingsPreCondition` option to the workflow-file completion extension,
wired from the same `defaultPreCondition` source `WorkspaceFileEditor.tsx`
already gives the lint extension. Correct the stale `getSpanContext` comment.

Tests: a case in `src/test/unit/WorkflowPromptDiagnostics.test.ts` asserting
`hasPreCondition` is true when a settings pre-condition is passed, and a webview
test for the workflow-file completion extension option.
