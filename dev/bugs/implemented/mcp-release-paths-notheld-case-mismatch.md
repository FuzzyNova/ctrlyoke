# MCP `release_paths` reports a released path as "not held" when the case differs (Windows)

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/mcp-server.ts` (`release_paths` handler)
- **Resolution:** fixed in this commit

## Symptom

`claim_paths {paths: ["src/Foo.ts"]}` followed by `release_paths {paths: ["src/foo.ts"]}`
on Windows returns `released: ["src/Foo.ts"]`, and the claim count drops to 0.
But the response also contains `notHeld: ["src/foo.ts"]` with the note "You held
no claim on src/foo.ts, so it was not released." The two statements contradict
each other, and an agent following the note may think the claim is still held.
Reproduced with a temporary test.

## Steps to Reproduce

See above (Windows, or any platform where claim paths compare
case-insensitively).

## Root Cause

`registry.releasePaths` matches case-insensitively on Windows
(`claimPathForCompare` → `foldPathForCompare`) and returns the claim's stored
spelling. The handler computes `notHeld` with an exact
`released.includes(value)`.

## Suggested Fix

Compare with the same fold on both sides:
`notHeld = paths.filter(p => !released.some(r => claimPathForCompare(r) === claimPathForCompare(p)))`.
Add a test.
