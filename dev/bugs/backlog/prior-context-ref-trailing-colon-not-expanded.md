# `$previous:` / `$all:` / `$finalStep:` followed by a colon in prose don't expand

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/FileReferenceParser.ts` (~358-361, prior-context reference regex)
- **Severity:** low

## Symptom

Prose such as "Here is $previous: fix it" expands nothing and shows no chip or
diagnostic, whereas `$step:2:` works. Found by code reading plus a scratch run
of the parser; not verified end to end in the dashboard.

## Steps to Reproduce

1. A prompt step with `Here is $previous: fix the remaining issues`.
2. The prior step's output is not attached.

## Root Cause

The optional `(?::…)*` suffix group swallows the trailing colon, so the body
becomes `previous:`, which matches no known reference kind and is dropped.

## Suggested Fix

Only allow the colon-suffix group for kinds that take arguments (`step`), or
backtrack when the suffix is empty so `$previous` matches and the `:` stays
prose. Add parser tests. Check first that the editor decoration pattern agrees.
