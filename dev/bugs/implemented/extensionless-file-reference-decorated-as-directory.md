# An extensionless `@` file reference is shown and linted as its parent directory

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script comparing `parseAtReferences` and `findContextReferenceMatches`)
- **Area:** `src/utils/ReferencePatterns.ts` (`directory` pattern), `src/utils/PromptReferenceScanner.ts`
- **Resolution:** fixed in this commit

## Symptom

`@scripts/build`, `@.github/CODEOWNERS` or `@src/bin/ctrlyoke` attach the
**file** when the prompt runs. The editor, however, decorates only the folder
prefix (`@scripts/`, `@.github/`) as a directory chip and link. Lint then checks
that the directory exists rather than the file. A typo in the file name
(`@scripts/biuld`) passes lint, and the reference is only reported as skipped
at run time. This breaks the "decorated ⇒ expands" rule stated in
`ReferencePatterns.ts`.

## Steps to Reproduce

```
text                       parseAtReferences (runtime)    findContextReferenceMatches (editor)
"Run @scripts/build now"   file  "scripts/build"          directory "@scripts/"
"See @.github/CODEOWNERS"  file  ".github/CODEOWNERS"     directory "@.github/"
"@src/bin/ctrlyoke"        file  "src/bin/ctrlyoke"       directory "@src/bin/"
```

## Root Cause

The `directory` pattern at `src/utils/ReferencePatterns.ts:116-119`
(`@(<path>\/)`) matches the folder prefix of any `@` path, because nothing
requires the token to end after the `/`. The `fullFile` pattern requires a
`.ext` ending, so an extensionless file gets no file match, and the stray
directory match is all that's left. The runtime parser (`parseAtReferences`,
`src/utils/FileReferenceParser.ts`) treats the whole token as a file path.
Consumers of the pattern (`findContextReferenceMatches`,
`PromptLinkProvider.findDirectoryLinks`, the workspace editor decorations)
all inherit the mismatch.

## Suggested Fix

Make the `directory` pattern match only when the token ends at the `/`, e.g.
append a lookahead `(?![^\s:"])`. Allow the same trailing prose punctuation
that `parseAtReferences` strips, so `see @src/.` still decorates `@src/`. Then
make sure extensionless file paths are decorated as files, following the same
"contains `/`, `\` or `.`" rule the runtime parser uses, so editor and runtime
agree token for token.

Tests: `src/test/unit/ReferencePatterns.test.ts`, plus a
`findContextReferenceMatches` case asserting `@scripts/build` yields a file
match, not a directory match.
