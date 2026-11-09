# `claim_paths` accepts backslash paths that escape the execution root on macOS/Linux

- **Found:** 2026-11-08 by bug-hunt final step (claude-cli)
- **Area:** `src/mcp-server.ts` (`normalizeCoordinationPaths`)
- **Resolution:** fixed in this commit

## Symptom

The docs say "Absolute paths and paths outside the checkout are rejected"
(`docs/reference/mcp-tools.md`, `docs/workflows/coordination.md`). On POSIX, a
path written with backslashes gets past that check and is then stored as an
escaping forward-slash path:

- `claim_paths({ paths: ["..\\..\\outside.txt"] })` is granted and stored as
  `../../outside.txt`. The same path written with `/` is rejected with
  `Coordination path escapes the execution root`.
- `src\\..\\docs` is stored as `src/../docs`. `claimPathForCompare` doesn't
  collapse `..`, so this claim never overlaps another participant's claim on
  `docs`. It is granted despite the conflict.

Claims are advisory, so this can't reach files. But it breaks the documented
containment rule and lets two agents both "own" the same directory.

## Steps to Reproduce

Through the MCP server on macOS or Linux (e.g. `invokeTool("claim_paths", …)`
in `src/test/unit/McpServer.test.ts`):

1. `claim_paths` with `["../outside.txt"]` is rejected (expected).
2. `claim_paths` with `["..\\..\\outside.txt"]` is granted, with
   `["../../outside.txt"]` stored.

## Root Cause

`normalizeCoordinationPaths` (`src/mcp-server.ts`, around lines 944-972) runs
`path.resolve(root, value)` and `isPathWithinDirectory` on the raw value. On
POSIX a backslash is an ordinary filename character, so `..\\..\\outside.txt`
resolves to one file inside the root. Only afterwards does the function run
`.replace(/\\/g, "/")`, which turns the stored value into `../../outside.txt`.

## Suggested Fix

Convert backslashes to `/` _before_ resolving and checking containment, so
the check sees the same path that will be stored. Then reject any value that
still escapes the root after `path.posix.normalize`. Comparison already folds
backslashes (`claimPathForCompare`), so a backslash in a claim never meant a
literal character anyway. Add `McpServer.test.ts` cases: `..\\..\\x` is
rejected; `src\\..\\docs` is stored as `docs` and conflicts with an existing
`docs` claim; `src\\a.ts` is stored as `src/a.ts`.
