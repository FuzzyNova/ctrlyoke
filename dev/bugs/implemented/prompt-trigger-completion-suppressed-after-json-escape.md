# Prompt-token completion never opens right after a `\n`/`\t` escape in JSON or double-quoted YAML

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/completions/PromptTriggerContext.ts`, `src/completions/PromptCompletionProvider.ts`
- **Resolution:** fixed in this commit

## Symptom

In a `.ctrlyoke.json` workflow (where a multi-line prompt must be written with
`\n`) or a double-quoted YAML prompt, typing `@`, `#`, `~`, `$`, `!` or
`/skill:` immediately after an escape such as `\n` or `\t` opens no completion
list, in both the VS Code editor and the dashboard workspace editor. The same
token typed after a space completes normally. The runtime disagrees with the
editor: the loader decodes `\n` to a real newline, so `"Fix this.\n@src/foo.ts"`
_is_ attached as a reference at run time, and `PromptLinkProvider` (which scans
decoded spans) links it once it is typed out by hand.

## Steps to Reproduce

Against compiled `out/completions/PromptTriggerContext.js`:

```js
const {
  findPromptTriggerContext,
} = require("./out/completions/PromptTriggerContext.js");
findPromptTriggerContext('  "prompt": "Fix this.\\n@src'); // null  (expected { trigger: "@", query: "src" })
findPromptTriggerContext('  "prompt": "Fix this.\\t#sym:'); // null  (expected # / "sym:")
findPromptTriggerContext('  - prompt: "Fix this.\\n@src'); // null  (YAML double-quoted)
findPromptTriggerContext('  "prompt": "x \\n/skill:'); // null
findPromptTriggerContext('  "prompt": "Fix this. @src'); // { trigger: "@", query: "src", index: 23 }
```

`parseAtReferences` on the decoded value `"Fix this.\n@src/foo.ts"` returns
`["src/foo.ts"]`.

## Root Cause

`findPromptTriggerContext` (`src/completions/PromptTriggerContext.ts:71-104`)
runs `findPartialSlashTokenStart` and `findWordStartTriggerIndex` on the **raw
source line**. In `…\n@src` the character before `@` is the letter `n` of the
escape, so the trigger is treated as mid-word and rejected. Both VS Code
(`PromptCompletionProvider.ts` around lines 61 and 70, including its cheap
pre-check) and the dashboard's `findCustomCompletionContext` go through this
function, so both editors are affected.

## Suggested Fix

When the string being edited uses JSON-style escapes (a JSON string value or a
YAML double-quoted scalar), treat a character escape (`\n`, `\t`, `\r`, …)
directly before the trigger as a word boundary. Count preceding backslashes:
`\\n` is a literal backslash followed by `n` and must stay mid-word. A simple
approach is to replace each recognised escape with same-length whitespace before
the boundary search so indices are unchanged. This must **not** apply to
single-quoted YAML or block scalars, where `\n` is literal text. `InsertTextEscape`
is an opaque function, so the callers need to pass an explicit flag (or the
string style) rather than inferring it from the escape callback; apply the same
rule in the pre-check in `PromptCompletionProvider.ts`. Keep the VS Code and
dashboard paths on the single shared function.

Tests: the five cases above for `@`, `#`, `/skill:` in JSON and double-quoted
YAML; `\\n@src` (escaped backslash) stays `null`; a single-quoted YAML
`'Fix this.\n@src'` stays `null`.
