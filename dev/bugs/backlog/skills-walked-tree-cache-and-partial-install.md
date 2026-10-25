# Walked skill trees are cached for the wrong slug and can install incomplete skills

- **Found:** 2026-10-25 by bug-drain review of 67d5135c1
- **Area:** `src/utils/SkillsRegistryClient.ts`
- **Severity:** medium

## Symptom

1. With two installed skills A and B from one large (truncated-tree) GitHub repo, the
   update check reports B as `NOT_FOUND` ("removed from its repository") even though it
   exists. The same happens when resolving or installing a second skill from that repo
   in the same session.
2. A skill folder with many nested subdirectories, or one whose folder name does not
   slugify to the slug, installs "successfully" with files missing. Its update check
   counts fewer files and reports `UPDATE_AVAILABLE` when nothing changed.
3. Concurrent update checks of the same truncated repo each do their own walk of up to
   21 GitHub calls, which adds rate-limit pressure.

## Root Cause

1. `fetchTree` caches under `source@commitSha` (around line 916) whether the tree came
   from a complete recursive response or from `walkTruncatedTree` (around lines
   938-1009). The walk is biased toward `preferredSlug` (priority 1) and stops at 20
   requests, so the cached partial tree is the first slug's view. `checkForUpdate`
   (around line 666), then `findSkillAtCommit`, searches it for another slug, and
   with `searchedCount === candidateCount` returns `NOT_FOUND` (around line 690).
2. After the 20-request cap (around line 999), nothing records that the walk was
   incomplete. `downloadSkill` (around lines 711-725) passes the partial list to
   `selectSkillFiles` without error.
3. `fetchTree` has no in-flight de-duplication; `checkSkillUpdatesBatch` (around
   line 1100) runs checks concurrently. The `checkForUpdate` doc comment ("at most two
   GitHub API calls per repository", around lines 651-655) is now false.

## Suggested Fix

- Cache a walked tree together with the state it was walked in: which subtrees were
  expanded and which are still pending. A lookup for a different slug continues the
  walk from that state (within its own request budget), rather than trusting the cache.
  A complete recursive tree stays cached as-is.
- Track completeness per subtree. Before `downloadSkill`/`checkForUpdate` use a skill's
  files, ensure the skill folder's subtree was fully expanded (fetch the folder's own
  tree with `?recursive=1` if needed). If that's impossible within the budget, raise a
  clear error, never install a partial file list. `NOT_FOUND` must only be reported
  when the search was exhaustive.
- De-duplicate concurrent `fetchTree` calls for the same `source@sha` with an
  in-flight promise map. Update the stale doc comment.
- Tests (must fail on current code): two slugs at one cached truncated commit both
  resolve; a skill whose subfolders lie beyond the request cap is either completed or
  rejected, not partially installed; concurrent checks share one walk.
