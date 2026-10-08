# Workflow completion core mis-inserts in JSON arrays, YAML flow mappings and JSON objects

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 2 review of F3 (`bf20ebfca`)
- **Area:** `src/completions/WorkflowFileCompletionCore.ts`, the JSON half of `src/completions/WorkflowDocumentLocation.ts`
- **Severity:** medium (no consumer yet; F4 and F7 consume the core)

## Symptom

`getWorkflowFileCompletions` promises a replace range and insert text that need no
adapter-side logic. Three places still produce invalid documents, or no items:

1. **JSON array without a typed quote.**
   - `"skills": [§]` and `"skills": ["alpha", §]` offer nothing.
   - `"priorContext": [§]` offers `[1]`, giving `[[1]]`, and `"all"`, giving `["all"]`.

   YAML `[§]` works.

2. **Multi-line key snippets inside a YAML flow mapping.** `steps:\n  - { prompt: hi, §}`,
   then choosing `endCondition`, inserts a block mapping inside the flow. The `yaml` parser
   rejects that with `BLOCK_IN_FLOW`. `hooks`, `preCondition` and `prompt: |` do the same.
3. **No separating comma for a JSON key.** `{"prompt":"a"\n  §\n}` inserts `"harness": `
   with no comma before it. VS Code's JSON service may mask this, but the CodeMirror adapter
   in F4 won't.

## Steps to Reproduce

Use the `complete()` helper in `src/test/unit/WorkflowFileCompletionCore.test.ts` with each
fixture above, then apply the item to the replace range and parse the result.

## Root Cause

1. For a cursor between brackets, the JSON location's `path` is the array itself, not
   `[..., key, index]`. `getValueItems` therefore computes `isElement` as false
   (`const isElement = ...` in `getValueItems`) and offers whole-value candidates.
2. `keyInsertText` re-indents snippet text for block context only. It doesn't know when the
   key sits inside a flow collection.
3. `keyInsertText` returns `"key": ` for JSON and never looks at the character before the
   replace range.

## Suggested Fix

1. Have the JSON location return an element path inside an array (matching YAML), or have the
   core treat an array-valued `path` as an element slot.
2. Expose "inside a flow collection" on `WorkflowLocation` (the YAML CST knows it), and insert
   the single-line `key: ` form there.
3. When the previous non-space, non-comment character ends a value (`"`, `}`, `]`, a digit, or
   `true`/`false`/`null`), prefix the JSON insert with `, `.

Fix this before F4 wires the core into the workspace editor.
