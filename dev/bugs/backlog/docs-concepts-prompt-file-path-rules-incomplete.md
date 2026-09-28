# Concepts guide misstates when a `prompt:` value is read as a prompt-file path and where it is looked up

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `docs/guide/concepts.md`, `docs/workflows/context-files.md`
- **Severity:** low

## Symptom

`docs/guide/concepts.md` (around lines 118-121) says a `prompt:` value that is only a path "must
start with `./`, and ctrlyoke looks for the file next to the workflow file first, then relative to
the workspace root." That is incomplete in two ways and contradicts
`docs/workflows/yaml-format.md` (around lines 83-89), which is correct:

- `../`, absolute paths (`/…`, `C:\…`) and, in a multi-root workspace, a workspace-folder-name
  prefix are also accepted (`src/utils/promptPathUtils.ts`, around lines 44-56).
- There is a third lookup location, `.ctrlyoke/` (`src/core/PromptFileResolver.ts`, around lines
  326-352).

Also, `docs/workflows/context-files.md` (around line 16) says an unquoted `@` path must contain
`/`, `\` or `.`, "so `@workspace` or an email address is not treated as a reference". The result
is right but the reason isn't for emails: `nathan@gmail.com` contains `.`. Emails are excluded by
the word-boundary lookbehind (`src/utils/ReferenceBoundary.ts`, used in
`FileReferenceParser.ts` around line 161).

## Suggested Fix

In `concepts.md`, say the value must be the whole prompt and start with `./`, `../` or an absolute
path (or a workspace-folder name in a multi-root workspace), and list the three lookup locations
in order (next to the workflow file, workspace root, `.ctrlyoke/`), or link to the
`yaml-format.md` section instead of restating it. In `context-files.md`, attribute the email
exclusion to the rule that an `@` in the middle of a word is never a trigger.
