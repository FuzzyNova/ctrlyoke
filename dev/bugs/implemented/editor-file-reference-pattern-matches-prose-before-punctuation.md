# Editors decorate `@team.` and `@Makefile).` as file references the runtime ignores

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ReferencePatterns.ts` (`fullFile`), `src/utils/PromptReferenceScanner.ts`
- **Resolution:** fixed in this commit

## Symptom

Ordinary prose that mentions a person or bot at the end of a sentence is
treated as a file reference by the editors, but not by the runtime:

| Prompt text          | Editor scan (`findContextReferenceMatches`) | Runtime (`parseAtReferences`) |
| -------------------- | ------------------------------------------- | ----------------------------- |
| `Thanks @team.`      | file `team`                                 | none                          |
| `Ask @copilot... ok` | file `copilot`                              | none                          |
| `see @Makefile).`    | file `Makefile`                             | none                          |
| `Ping @alice, then`  | none                                        | none                          |

As a result:

- `getReferenceDiagnostics` on `"Thanks @team. Ask @copilot... then run @Makefile."`
  returns three "file not found" diagnostics, so ordinary prose gets false
  squiggles in both the VS Code editor and the dashboard prompt editor, plus
  links and chips.
- If such a file exists (`Run @Makefile.` in a repo with a `Makefile`), the
  editor shows it as an attached file, but the runtime sends the text as-is and
  attaches nothing.

This breaks the invariant stated in `ReferencePatterns.ts` that the path marker
and final boundary mirror the runtime's rules.

## Steps to Reproduce

```ts
import { findContextReferenceMatches } from "src/utils/PromptReferenceScanner";
import { parseAtReferences } from "src/utils/FileReferenceParser";
for (const t of ["Thanks @team.", "Ask @copilot... ok", "see @Makefile)."]) {
  console.log(t, findContextReferenceMatches(t), parseAtReferences(t));
}
```

Run it with `npx tsx`. Each line shows one `file` match from the scanner and
`[]` from the runtime.

## Root Cause

- `fullFile` in `src/utils/ReferencePatterns.ts:128-131` checks for a path
  marker with the lookahead `(?=(?:[A-Za-z]:)?[^\s:"]*[/.\\])`. The lookahead
  runs over the raw token _before_ trailing prose punctuation is excluded, so
  the sentence-ending `.` satisfies it. The lazy body then stops before the
  `.`, and the match is `team`.
- The runtime (`parseAtReferences`, `src/utils/FileReferenceParser.ts:747-759`)
  first strips `[^\p{L}\p{N}/\\]+$`, then requires `/`, `\` or `.` in what is
  left. `team` has none, so it is plain text.

## Suggested Fix

Make the editor apply the marker test to the same stripped path as the runtime.
Either:

- constrain the lookahead so the marker must fall inside the captured body
  (before the final `[\p{L}\p{N}]`), or
- post-filter `fullFile` matches in `findContextReferenceMatches` with the same
  "contains `/`, `\` or `.`" check that `parseAtReferences` uses. Ideally share
  one helper between the two so they cannot drift again.

Keep `@src/a.ts.` → `src/a.ts`, `@a.b`, `@foo-.x` and quoted `@"Makefile"`
working. Add cases for `@team.`, `@copilot...` and `@Makefile).` to the
existing `ReferencePatterns`/`PromptReferenceScanner` tests, and a parity test
that compares the scanner with `parseAtReferences` across a list of inputs.
