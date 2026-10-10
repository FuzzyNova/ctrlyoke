# Reference tokens directly after a non-ASCII letter are still treated as references

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against the real parsers)
- **Area:** `src/utils/ReferenceBoundary.ts` (`REFERENCE_BOUNDARY_CHARS`, `NOT_AFTER_BOUNDARY`)
- **Resolution:** fixed in this commit

## Symptom

The documented rule (ctrlyoke-syntax skill,
`src/templates/skills/ctrlyoke-syntax/SKILL.md`) says "A token directly after a
letter, digit, or filename character is not a reference". `price$previous` is
correctly ignored, but the same token glued to a non-ASCII letter triggers:

```
parseInlinePriorContextRefs("café$previous")  -> ["$previous"]
parseAtReferences("café@src/a.ts")            -> ["src/a.ts"]
parseSecretReferences("café!API_TOKEN")       -> ["API_TOKEN"]
parseSecretReferences("東京!API_TOKEN")        -> ["API_TOKEN"]
parseGitChangeReferences("café~diff")         -> ["~diff"]
scanCtrlYokeSlashTokens("café/skill:commit")  -> ["/skill:commit"]
```

The secret case matters most. Prose such as `naïve!TOKEN` creates a real secret
grant, and a grant that isn't approved for the workspace stops the workflow at
that step.

## Steps to Reproduce

Call any of the parsers above with a token placed right after an accented or
CJK letter. All of them return a reference; the ASCII equivalents return none.

## Root Cause

`REFERENCE_BOUNDARY_CHARS = "A-Za-z0-9_+=@#$%^&!~-"` at
`src/utils/ReferenceBoundary.ts:21` is ASCII-only. `NOT_AFTER_BOUNDARY` is built
from it and shared by every trigger (`@ # ~ $ ! /`), and the editor-side word
start helpers use the same class.

## Suggested Fix

Make the boundary Unicode-aware: `(?<![\p{L}\p{N}_+=@#$%^&!~-])`. Add the `u`
flag to every `RegExp` built from `NOT_AFTER_BOUNDARY`. Several builders use
only `g`/`gi`, and `\p{…}` needs `u`. Check that each pattern stays valid under
`u`, since it rejects some escapes that non-`u` mode allows. Keep the
editor-side helpers (the CodeMirror trigger and word-start detection) on the
same shared definition. The trailing-strip fix in
`dev/bugs/implemented/file-reference-trailing-strip-drops-non-ascii-letters.md`
made the same move to `\p{L}`.

Tests: `src/test/unit/SecretReferenceParser.test.ts` (`café!API_TOKEN` yields no
grant) and a boundary case in the `FileReferenceParser` /
`ReferencePatterns` tests.
