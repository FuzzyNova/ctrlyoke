# Prompt file paths with multi-word names become inline text, and `@` paths containing `#` are truncated

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/promptPathUtils.ts` (`looksLikeFilePath`), `src/utils/ReferencePatterns.ts` (`UNQUOTED_AT_REFERENCE_PATH`), `src/completions/ContextReferenceBuilder.ts` (`quoteReferencePath`)
- **Severity:** medium

Both are regressions from 0e7477717 (`fix: correct prompt reference parsing`).

## Symptom

1. **Multi-word prompt file names are treated as prompt text.** `looksLikeFilePath` now returns
   `false` for any value that has a whole word between two runs of whitespace:
   - `./My Documents/Fix It Now.prompt.md`
   - `prompts/fix the bug.prompt.md` (with `allowWorkspaceFolderPrefix`)
   - `C:\Users\Jane Doe\My Prompts\a b c.md`

   Each returned `true` before the commit. `PromptFileResolver`, `PromptEditor` and
   `CodeMirrorEditor` then send the path string to the AI as the prompt, and don't load the file.
   Names with one space (`./fix bug.md`) still work. The comment "Spaces within one path segment
   remain supported" only holds for a single space.
2. **Unquoted `@` paths containing `#` are cut at the `#`.** `UNQUOTED_AT_REFERENCE_PATH` is
   `(?:[A-Za-z]:)?[^\s:#"]+`. The runtime parser used to accept `[^\s:]+`, so it has now picked up
   the decorator's `#` exclusion:
   - `parseAtReferences("@src/C#/a.cs")` returns `src/C`, which is wrong and unresolvable.
     It used to return `src/C#/a.cs`.
   - `@notes#1.md` becomes `notes`, which has no `/`, `\` or `.`, so it is silently dropped.

   `quoteReferencePath` only quotes on `/[\s:]/`, so completions and "Add to prompt" still insert
   the unquoted `@src/C#/a.cs` that no longer expands.

## Steps to Reproduce

Call the pure functions directly (e.g. from a unit test):

```ts
looksLikeFilePath("./My Documents/Fix It Now.prompt.md"); // false, expected true
parseAtReferences("see @src/C#/a.cs");                    // path "src/C", expected "src/C#/a.cs"
quoteReferencePath("src/C#/a.cs");                        // unquoted
```

## Root Cause

- `promptPathUtils.ts:37`: the prose check `/\s+[^/\\\s]+\s+/` is too broad. It was meant to
  reject `/review Please look at src/app.ts` and `./fix the bug, then update README.md`
  (`prompt-file-path-detection-matches-prose.md`), but it matches any file or folder name with
  three or more words.
- `ReferencePatterns.ts:4`: the shared fragment excludes `#` and `"`, and quoting was not widened
  to match.

## Suggested Fix

1. Narrow the prose rule so it targets the shapes the original bug listed, keeping it
   single-sourced in `looksLikeFilePath`:
   - a leading `/word` slash command followed by whitespace and more text;
   - sentence punctuation followed by a space (`, `, `; `, `. ` that isn't part of an extension);
   - newlines.

   Keep every example from both bug docs as a test, including the new multi-word path cases.
2. Keep the `#` exclusion in the shared fragment, since the decoration relies on it. Make
   `quoteReferencePath` and `quoteReferenceField` quote any path containing a character the
   unquoted form can't carry (`/[\s:#"]/`, or better, derived from the same fragment).
   Alternatively, allow `#` mid-body in the fragment and check that the decoration still agrees
   (`ReferencePatterns.ts` invariant). Add parser, decoration and quoting tests for `@src/C#/a.cs`.
