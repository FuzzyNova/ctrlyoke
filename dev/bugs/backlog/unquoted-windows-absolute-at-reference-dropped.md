# Unquoted Windows absolute `@C:/…` reference is decorated but silently not expanded

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/FileReferenceParser.ts` (`parseAtReferences`), `src/ui/.../ContextMenuReferenceCommands` (`quoteReferencePath`)
- **Severity:** medium

## Symptom

`parseAtReferences("Review @C:/dev/ext/a.ts please")` returns `[]`. The
unquoted body regex `[^\s:]+` stops at the drive colon, so the path parses as
`"C"`, which is then discarded. The editor's decoration pattern
(`createReferencePatterns().fullFile`) does match `C:/dev/ext/a.ts` and shows
it as a chip. This breaks the invariant in `ReferencePatterns.ts` that anything
decorated must also expand: no attachment is made and no diagnostic is shown.

The editor produces this form itself. For files in trusted external roots,
`resolveReferencePath` returns `uri.fsPath`, and `quoteReferencePath` only quotes
values containing spaces, so "Add to prompt" inserts `@C:/dev/ext/a.ts`.
`@"C:/dev/ext/a.ts"` works.

## Steps to Reproduce

1. Trust an external root on another drive or directory, e.g. `C:/dev/ext`.
2. Use the context-menu reference command on a file there, or type
   `@C:/dev/ext/a.ts` in a prompt.
3. Run the step: the file is not attached and nothing is reported.

## Root Cause

The unquoted `@` body excludes `:` (to stop at `:line` suffixes), so it can't
contain a drive prefix.

## Suggested Fix

Allow an optional leading drive prefix in the unquoted body, e.g.
`(?:[A-Za-z]:)?[^\s:]+`. This also covers hand-typed references. Make sure
`:line`/`:range` suffixes still parse after a drive-prefixed path, and keep
the runtime parser and the editor decoration pattern in agreement (share the
fragment if practical). Alternatively, or additionally, make `quoteReferencePath`
quote any path containing `:`. Add parser tests for `@C:/x/a.ts`,
`@C:\x\a.ts` and `@C:/x/a.ts:10`.
