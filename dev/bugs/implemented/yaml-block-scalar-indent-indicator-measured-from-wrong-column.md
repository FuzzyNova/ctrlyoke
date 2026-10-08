# YAML block scalar indentation indicator is measured from the wrong column

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 2 review of the editor intelligence plans
- **Area:** `src/completions/WorkflowTextDecoding.ts` (`decodeYamlBlockScalar`)
- **Resolution:** fixed in this commit

## Symptom

A prompt block scalar with an explicit indentation indicator inside a sequence item, such as
`  - prompt: |2`, decodes to text that differs from the `yaml` parser's value. `createTextSpan`
then marks the span `exact: false` and maps offsets as `start + index`, which ignores the
block indentation.

The consumers now guard against this:

- `getPromptCodeRanges` falls back to scanning the raw source slice. Inline code stays exact,
  but a fenced block inside such a value is not detected.
- `getWorkflowPromptDiagnostics` skips the span, so that prompt gets no VS Code lint.

Every later consumer of `getWorkflowTextSpans` has to remember the same guard: F5's workspace
lint, and F6's chips and nested markdown.

## Steps to Reproduce

```ts
getWorkflowTextSpans(
  "steps:\n  - prompt: |2\n      see @a.ts `x`\n",
  CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
)[0].exact; // false
```

## Root Cause

YAML 1.2 measures an indentation indicator from the indentation of the **parent node**. For
`  - prompt: |2` that parent is the mapping that starts at `prompt` (column 4), so content is
indented 6.

`decodeYamlBlockScalar` instead adds the indicator to the header line's leading spaces. Those
stop at the `- ` (column 2), which gives 4. A plain `prompt: |2` at the root, or under a
mapping key with no `- `, happens to come out right.

(Fixed alongside: a tab after the indentation was counted as indent, because `trimStart`
strips tabs. YAML indentation is spaces only.)

## Suggested Fix

Base the explicit indent on the column of the key that owns the block: `headerStart` minus
the key and colon, or the key node's position passed in by `WorkflowPromptRanges`. Add
`  - prompt: |2` and a parallel member with `|4` to the "decodes every scalar style exactly as
the parser does" fixtures in `WorkflowPromptRanges.test.ts`.
