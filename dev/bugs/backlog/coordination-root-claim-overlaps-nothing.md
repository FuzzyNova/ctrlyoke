# Claiming the execution root (`.`) is granted but conflicts with nothing

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`pathsOverlap`), `src/mcp-server.ts` (`normalizeCoordinationPaths`)
- **Severity:** medium

## Symptom

The `claim_paths` tool says "Each claim covers its path and everything beneath it". An agent that
claims the whole execution root with `.` (or `./`, or `src/..`) is granted the claim, but the claim
covers nothing. Another participant can then claim `src/a.ts` (or any other path) and is also
granted, so two agents edit the same tree while each believes it has exclusive advisory ownership.
The reverse order behaves the same way: an existing `src/a.ts` claim doesn't block a later `.` claim.

## Steps to Reproduce

Verified with a throwaway tsx probe against the real `CoordinationParticipantRegistry`:

1. `normalizeCoordinationPaths(["."], root)` in `mcp-server.ts` resolves `.` to the root, passes
   the containment check, and returns `path.relative(root, root)`, which is `""`.
2. Participant A: `claim([""])` → granted `[""]`.
3. Participant B: `claim(["src/a.ts"])` → **granted**, 0 denied. Expected: denied, owner A.
4. Participant B: `claim(["**"])` → denied, which shows the empty claim is stored but only
   overlaps a pattern that begins with a globstar.

## Root Cause

`pathsOverlap` splits `claimPathForCompare("")` into `[""]` and appends `**`, which gives
`["", "**"]`. The empty literal segment has to match a real first segment such as `src`, and
`segmentsOverlap("", "src")` is false. So the root claim never overlaps any concrete path.

## Suggested Fix

Treat the root as covering everything:

- In `pathsOverlap`, drop empty segments after splitting, so `""` becomes `["**"]` and overlaps
  every path. Or map an empty or `.` comparison path to the globstar in `claimPathForCompare`.
- Make sure `release_paths` with `.` still releases the stored root claim.
- Add regression cases to the "detects path and glob intersections conservatively" test
  (`src/test/unit/ExecutionRootCoordination.test.ts`): `""` vs `src/a.ts`, and `""` vs `**/*.md`.
  Add an MCP-level test showing that claiming `.` blocks a later concrete claim.
