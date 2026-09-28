# An unreadable trust-decision file is silently overwritten, wiping earlier allow/deny decisions

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/config/TrustDecisionFile.ts` (used by `ExternalRootsTrustStore`, `SecretGrantsTrustStore`)
- **Severity:** medium

## Symptom

If `~/.ctrlyoke/secret-grants-trust.json` or the external-roots trust file cannot be parsed, the
loader logs "has invalid JSON and will be treated as empty" and returns `{decisions: {}}`. The
next decision write then saves only the new entry, and every earlier decision is gone:

- Lost denies go back to pending, so the user is prompted again.
- Lost allows silently lose their approval.

The trigger is ordinary. A UTF-8 BOM, as written by Notepad or PowerShell 5
`Set-Content -Encoding UTF8`, or a trailing comma after a hand edit is enough, because the loader
uses plain `JSON.parse` with no BOM stripping and no JSONC tolerance.

## Steps to Reproduce

1. Record a deny for root `a` and an allow for root `b`.
2. Prefix the file with a UTF-8 BOM.
3. Call `setDecisions(ws, ["c"], "allow")`.
4. The file now contains only `c`.

## Root Cause

`loadTrustDecisionFile` (around lines 34-48) swallows the parse error and returns an empty set.
`saveTrustDecisionFile` then writes whatever it is given. This is the same defect class already
fixed for settings in `dev/bugs/implemented/settings-file-unparseable-json-overwritten-on-write.md`,
along with the BOM handling in `workflow-file-utf8-bom-breaks-json-and-frontmatter.md`.

## Suggested Fix

Strip a leading BOM with the existing helper, and parse with `jsonc-parser`
(`allowTrailingComma`), matching `FileConfigBackend`. If the content is still unparseable, mark the
file invalid and make saves refuse to write (surface an error) instead of overwriting it. Add unit
tests for a BOM file, a trailing-comma file, and a garbage file whose decisions must survive a
write attempt.
