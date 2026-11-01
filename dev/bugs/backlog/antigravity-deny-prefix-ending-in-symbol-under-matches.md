# Antigravity deny prefix ending in a symbol does not block longer commands

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, reading `7d0b7dba3`/`ba289a8d6`)
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts` (deny branch of `convertToAntigravityRules`)
- **Severity:** medium

## Symptom

`deniedTools: [shell(rm -rf /:*)]` translates for Antigravity to

```
command(regex:(?is)(?:.*[^\w.-])?rm\s+-rf\s+/(?:[^\w.-].*)?)
```

which blocks `rm -rf /` and `rm -rf /*` but **not** `rm -rf /home`. The docs say `:*` means
"any shell command that starts with" the prefix, and the Antigravity permission plan says a
deny should over-match rather than under-match; this under-matches, the unsafe direction.
The same happens for any deny prefix whose last word ends in a non-word character (`/`, `=`,
`:`, `\`, …), e.g. `shell(git push --force=:*)`, and symmetrically for a first word that
starts with one.

## Steps to Reproduce

1. `npm run compile:extension`
2. Convert `["shell(rm -rf /:*)"]` with `convertToAntigravityRules(..., "deny")`.
3. Test the produced regex (whole-line anchored, case-insensitive) against `rm -rf /home`:
   no match.

## Root Cause

The deny regex wraps the words in `(?:.*[^\w.-])?` … `(?:[^\w.-].*)?`. Those boundaries assume
the words begin and end with a word character; after a trailing `/` the next character (`h`)
must be a non-word character, so the longer command is not matched.

## Suggested Fix

Add the trailing `[^\w.-]` boundary only when the last character of the last word is in
`[\w.-]`; otherwise allow anything to follow (`.*`). Apply the same rule to the leading
boundary for a first word that starts with a symbol. Add unit cases (`rm -rf /home` blocked,
`rm -rf /` blocked, and the existing word-boundary cases such as `gitx push` not blocked by
`git push:*` unchanged).
