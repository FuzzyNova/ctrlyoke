# OpenCode MCP tool filtering is still listed as a known-broken claim after its fix

- **Found:** 2026-11-18 by the bug-drain final step, while reading `KNOWN_BROKEN_CLAIMS`
- **Area:** `src/test/harness/capabilityEvidence.ts` (`KNOWN_BROKEN_CLAIMS`), `src/core/harness/opencode/OpenCodeHarnessAdapter.ts` (`OPENCODE_MCP_FILTERING_CAPABILITY`)
- **Severity:** low

## Symptom

`KNOWN_BROKEN_CLAIMS["opencode-cli"]["mcp.perServerToolFiltering"]` points at
`dev/bugs/backlog/opencode-mcp-tool-deny-rules-never-match.md`, and the comment above
`OPENCODE_MCP_FILTERING_CAPABILITY` cites the same backlog path. That bug was fixed in 3049de1eb
(2026-10-22) and its doc now lives in `dev/bugs/implemented/`. The capability declaration still
has `verification.kind: "manual"`, so the compatibility docs under-report a claim the live suite
should now prove, and the stale entry hides a real regression if the case breaks again.

## Root Cause

c55214b64 added the capability suite and the known-broken entry the same morning; the fix commit
landed afterwards and did not remove the entry or restore the declaration's verification.

## Suggested Fix

Run the OpenCode per-server tool-filtering case in the harness suite
(`npx mocha … --grep "opencode-cli"` limited to the MCP deny/filtering case). If it passes, delete
the `KNOWN_BROKEN_CLAIMS` entry, point the declaration's verification at the live suite the way
the other proven claims do, drop the stale comment, and regenerate the compatibility docs
(`npm run check:docs`). If it fails, reopen the original bug instead. Consider a unit test that
fails when a `KNOWN_BROKEN_CLAIMS` value names a file that is not in `dev/bugs/backlog/`.
