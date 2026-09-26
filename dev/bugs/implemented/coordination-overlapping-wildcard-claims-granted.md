# Overlapping wildcard path claims can both be granted

- **Found:** 2026-09-26 by step 2 (codex-cli) of the coordination test workflow; reproduced with the skill CLI
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`pathsOverlap`, `globSamplesOverlap`)
- **Resolution:** fixed in this commit

## Symptom

`claim_paths` grants two wildcard patterns that overlap on a concrete file. In the live coordination run, separate skill CLI calls returned `granted` for both:

```text
coordination-probe/a*/file.txt
coordination-probe/*b/file.txt
```

Both patterns match `coordination-probe/ab/file.txt`. A subsequent claim for that concrete path was denied by the first wildcard owner, confirming that each wildcard matches the same file even though the two wildcard claims were accepted together. The `coordination-probe` paths were virtual test paths; no repository file was changed for this repro.

## Steps to Reproduce

In one execution root, call `claim_paths` from two distinct participants or two separate skill CLI invocations:

1. Claim `coordination-probe/a*/file.txt` — granted.
2. Claim `coordination-probe/*b/file.txt` — also granted, although `ab` satisfies both `a*` and `*b`.
3. Claim `coordination-probe/ab/file.txt` — denied by the first wildcard owner.

## Root Cause

`pathsOverlap()` (`src/core/orchestration/ExecutionRootCoordination.ts:122`) checks whether either pattern directly matches the other pattern's literal text, then asks `globSamplesOverlap()` (`:210`) to compare a few generated sample paths. `globSamples()` (`:175`) replaces every `*` with only `x`. This produces `ax` for `a*` and `xb` for `*b`; neither sample matches the other pattern. The overlap check therefore gives a false negative for the valid shared string `ab`.

## Suggested Fix

Use a conservative intersection check for supported glob syntax. If it cannot prove that two patterns are disjoint, deny the second claim and report the existing owner. Add a regression case for `a*` versus `*b`, including a concrete shared path, and cases for non-overlapping patterns to preserve useful parallel claims.

## Planning Note (2026-09-26)

This bug and `coordination-overlapping-wildcard-claims-granted.md` share one root cause: `pathsOverlap()`
guesses overlap from a few sample strings instead of computing it. Fix both in one change. Replace the
sample heuristic with a real segment-wise glob intersection test. Also treat every claim `P` as covering
`P` itself and everything under `P/`, so a bare directory claim protects its descendants and still
interacts correctly with wildcard claims (for example, `dev/bugs` vs `dev/*/README.md`). Bare
directory claims stay permitted, and `claim_paths` documents that they are recursive.
