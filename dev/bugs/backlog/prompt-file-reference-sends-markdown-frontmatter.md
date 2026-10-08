# A step prompt that names a `.prompt.md` file may send its frontmatter

- **Found:** 2026-10-08 by Claude (claude-cli), while fixing `vscode-prompt-diagnostics-symbol-lookups-and-trust-refresh`
- **Area:** `src/core/PromptFileResolver.ts` (`resolvePromptValue`), `src/core/WorkflowExecutor.ts` (`resolveEffectivePrompt`)
- **Severity:** low (unconfirmed whether intended)

## Symptom

A step whose `prompt` (or `finalStep`/`retryPrompt`) names a `.prompt.md` file is replaced
by the file's raw content. If that file has YAML frontmatter, the `---` block appears to be
sent to the harness as part of the prompt.

## Steps to Reproduce

1. Create `a.prompt.md` with a frontmatter block (`---\nharness: claude-cli\n---\nDo X.`).
2. Reference it from a workflow step: `prompt: ./a.prompt.md`.
3. Run the step and inspect the sent prompt in `events.jsonl`.

Not run end to end yet. This comes from reading the code.

## Root Cause

`PromptFileResolver.resolve` reads the file with `fsp.readFile` and returns the content
untouched. `resolvePromptValue` passes that through. Only `PromptFileParser.parseMarkdownPromptFile`
strips frontmatter, and it runs only when the `.prompt.md` is opened as a workflow.

## Suggested Fix

Confirm by running a step as described above. If the frontmatter is sent, strip it in
`resolvePromptValue` for `.prompt.md` targets, using the same frontmatter splitter the parser
uses. Then the VS Code lint span (the trimmed body) and the runtime text agree.
