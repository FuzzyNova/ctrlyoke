# VS Code document links in workflow files are found in the raw JSON/YAML source, not the decoded prompts

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/completions/PromptLinkProvider.ts`
- **Resolution:** fixed in this commit

## Symptom

In `.ctrlyoke.json` and `.ctrlyoke.yaml` files, Ctrl+click links for
`@file`, `@dir/`, secret, git and slash-token references don't match what the
runtime and the diagnostics see:

- JSON `{"prompt": "Review @\"docs/my file.md\" and @src/a.ts\nnext"}`: the
  link target is `src/a.ts\nnext` (a literal backslash and `n`), which doesn't
  exist. The quoted `@"docs/my file.md"` gets no link at all. `\t` behaves the
  same way. A JSON prompt with `@file` right before an escaped newline is very
  common.
- YAML double-quoted `prompt: "Read @\"my dir/a.ts\" now"`: no link.
- YAML plain scalar `prompt: Review @src/a.ts # comment @src/b.ts`: `@src/b.ts`
  is linked, though it sits in a YAML comment and never reaches the prompt.

## Steps to Reproduce

```ts
import { findContextReferenceMatches } from "src/utils/PromptReferenceScanner";
const raw = String.raw`{"steps":[{"prompt":"Review @\"docs/my file.md\" and @src/a.ts\nnext"}]}`;
console.log(findContextReferenceMatches(raw));           // one match: path "src/a.ts\\nnext"
console.log(findContextReferenceMatches(JSON.parse(raw).steps[0].prompt)); // docs/my file.md, src/a.ts
```

In VS Code, open such a workflow file and hover/Ctrl+click the reference.

## Root Cause

`PromptLinkProvider.collectLinks` (`src/completions/PromptLinkProvider.ts:95`)
takes `document.getText()` and runs `findSecretLinks`,
`findContextReferenceMatches(text)` (line 121), the git pattern and the slash
token scan over the whole raw document. Only the code-range filter uses decoded
spans (`getDocumentPromptCodeRanges`). Diagnostics
(`WorkflowPromptDiagnostics.ts:226`) and the runtime both work on the decoded
value. `.github/instructions/completions.instructions.md` states the rule this
breaks: "Run prompt-text rules on decoded spans, never on the raw file."

## Suggested Fix

For ctrlyoke workflow files, iterate `getWorkflowTextSpans(text, kind)`
(`src/completions/WorkflowPromptRanges.ts`) and run each finder on `span.text`,
mapping match offsets back with `span.toSourceOffset`. Skip spans with
`exact: false`, as VS Code lint does. Keep the whole-document scan only for
non-ctrlyoke `markdown`/`prompt` documents and `.prompt.md` bodies, following
`getDocumentPromptCodeRanges`. The standalone prompt-file-path links
(`findPromptFileLinks`) should use the same decoded spans if they don't already.

Add `PromptLinkProvider` tests covering a JSON prompt with `\n` after a
reference, a quoted reference in JSON and in double-quoted YAML, and a reference
inside a YAML comment, which must not be linked.
