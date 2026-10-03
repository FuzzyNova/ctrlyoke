# `/mcp:` and `/skill:` tokens backtrack into the three-segment form when the name contains `-` or `.`

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/CtrlYokeSlashTokens.ts`
- **Resolution:** fixed in this commit

## Symptom

The three-segment `/mcp:<server>:<tool>` form is meant to be left entirely
alone (see the comment on `TOKEN_BOUNDARY_PATTERN`), but
`scanCtrlYokeSlashTokens` returns a truncated token whenever the name contains
a hyphen or dot:

| Input                    | Result            | Expected |
| ------------------------ | ----------------- | -------- |
| `/mcp:my-server:tool`    | `["/mcp:my"]`     | `[]`     |
| `/mcp:github.com:search` | `["/mcp:github"]` | `[]`     |
| `/skill:foo.bar:baz`     | `["/skill:foo"]`  | `[]`     |
| `/mcp:server:tool`       | `[]`              | `[]`     |

A bogus server/skill (`my`) is then force-attached or warned about, and
`rewriteCtrlYokeSlashTokens` rewrites the prompt text.

## Steps to Reproduce

Call `scanCtrlYokeSlashTokens` on any input from the table.

## Root Cause

`TOKEN_NAME_PATTERN` allows `[._-]` inside a name, but the negative lookahead
`TOKEN_BOUNDARY_PATTERN = "[a-zA-Z0-9:]"` does not account for them, so the
regex backtracks to the last `-`/`.` and succeeds there.

## Suggested Fix

Make the lookahead also reject a `[._-]` that is itself followed by a name
character or colon, e.g. `(?![a-zA-Z0-9:]|[._-][a-zA-Z0-9:])`, so trailing
sentence punctuation (`/skill:commit.`) still ends a token. Check
`COMPLETE_TOKEN_PATTERN` and any editor-side copy of the pattern for the same
issue. Add the table rows to the existing slash-token tests.
