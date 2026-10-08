# VS Code links and completes prompt references inside code spans

- **Found:** 2026-10-08 by Claude (claude-cli), while reviewing the prompt editor markdown highlighting plan
- **Area:** `src/completions/PromptLinkProvider.ts`, `src/completions/PromptCompletionProvider.ts`
- **Severity:** medium

## Symptom

A context reference inside inline code or a fenced block is sent literally and never expanded.
See "Writing references literally" in `docs/workflows/context-files.md`. The dashboard prompt
editor reflects that:

- no chip and no link inside code
- no completions inside code
- a warning when a reference that resolves sits inside code: "Context expansion suppressed —
  this reference won't be expanded inside code"

VS Code's native editor does none of this. In a `.prompt.md` file, or in a `prompt: |` value of
a `.ctrlyoke.yaml` file, a reference inside backticks:

- is still turned into a clickable document link
- still gets `@ # ~ $ !` completions while typing
- gets no warning

So the file looks attached but is sent as text. The mismatch gets worse once
`PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md` Phase 4 colours those backticks as code in VS Code.

## Steps to Reproduce

1. In VS Code with ctrlyoke installed, create `demo.prompt.md` containing
   `` Review `@src/extension.ts` `` and a fenced block with `@src/extension.ts` on its own line.
2. Hover or Ctrl-click either reference: both open the file.
3. Inside the backticks, type `@src/ext`: file completions appear.
4. Run the prompt. Neither reference is expanded, and nothing in the editor warned that it
   wouldn't be.

## Root Cause

Nothing on the VS Code side consults the shared literal-range rule.

- `findCodeRanges` (`src/utils/FileReferenceParser.ts:73`) is the single source of truth for
  what is literal. Its only consumers are `FileReferenceParser.ts` itself (host expansion) and
  the shared prompt scanners (`src/utils/PromptReferenceScanner.ts` `getCodeRanges`, used by
  `PromptDiagnosticRules.ts` and throughout `CodeMirrorEditor.tsx`).
- `PromptLinkProvider.provideDocumentLinks` (`PromptLinkProvider.ts:59`) emits a link for every
  reference match.
- `PromptCompletionProvider.shouldProvideCompletions` (`PromptCompletionProvider.ts:252`)
  checks only whether the cursor is in prompt text. It doesn't check whether that text is code.
- VS Code has no diagnostic collection for prompt files at all, so the warning has nowhere to
  go.

## Suggested Fix

- **Links:** in `PromptLinkProvider`, compute `findCodeRanges` over the prompt text and drop any
  link fully inside a range. Use the same containment test as `isInCodeRange`.
- **Completions:** in `PromptCompletionProvider`, return no prompt-token completions when the
  trigger position is inside a code range. This matches the dashboard editor.
- **Run code ranges on the decoded prompt value, not the raw file.**
  - A `prompt: |` body is indented by YAML indentation, and `findCodeRanges` follows the
    CommonMark rule that a fence has at most three spaces of indent. So the body must be
    dedented first, as the host's parser does, and offsets mapped back per line.
  - JSON prompt strings need decoding with an escape-aware offset map.
  - `.prompt.md` can be scanned after its frontmatter.
  - All of this exists: `getWorkflowTextSpans(text, kind)`
    (`src/completions/WorkflowPromptRanges.ts`) returns every prompt value, `.prompt.md` body
    included, as decoded `text` with `toSourceOffset()` back to the document. Run
    `findCodeRanges` on `span.text` and map the ranges back. For completions, find the span
    whose `sourceRange` holds the cursor. D2 uses the same spans. Don't write a private
    extractor.
- **Warning (follow-up):** the dashboard's warning reaches VS Code through
  [`PROMPT_DIAGNOSTICS_PLAN.md`](../../backlog/PROMPT_DIAGNOSTICS_PLAN.md) Phase 2, a
  prompt-file diagnostics provider fed by the shared rules. That provider is new
  infrastructure, so it lands separately from the links and completions fix.
- **Tests:** in `PromptLinkProvider.test.ts` and `PromptCompletionProvider.test.ts`, cover:
  - inline code
  - a fenced block
  - an indented fence inside a YAML block scalar
  - an escaped backtick
  - a JSON prompt string
  - a reference just outside a span, which must still link and complete

Tracked as part of `dev/backlog/PROMPT_EDITOR_MARKDOWN_HIGHLIGHTING_PLAN.md` Phase 4. It can
also be fixed on its own before that phase.
