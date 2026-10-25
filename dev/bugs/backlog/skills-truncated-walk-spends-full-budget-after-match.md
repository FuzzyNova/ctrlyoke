# Truncated skill tree walks spend their whole budget after the skill is found

- **Found:** 2026-10-25 by bug-drain review of 34eff11a4
- **Area:** `src/utils/SkillsRegistryClient.ts` (`fetchTree`, `walkTruncatedTreeBudget`, `findSkillAtCommit`)
- **Severity:** medium

## Symptom

34eff11a4 (dev/bugs/implemented/skills-truncated-walk-exceeds-anonymous-rate-limit.md)
bounds one resolve + download to about 23 GitHub API calls. Two common flows still blow the
60-request anonymous limit for repos whose recursive tree is truncated:

1. **Batch update checks.** A truncated repo with 30 root directories and installed skills
   `skills/a`…`skills/h`: `checkSkillUpdatesBatch` checks each. The first walk prioritises
   `a`; the shallow root directories sort ahead of `skills/b..h`, so each later check starts
   another walk, finds `skills/<slug>` within ~2 requests, then keeps going to 20. ~22
   requests per skill, so 3 skills from that repo exceed 60.
2. **Update after an update check.** The check costs ~23. Clicking update re-resolves
   (`openReview(entry, update)` in `src/ui/webview-react/store/useSkillsRegistryStore.ts`
   around line 249); `resolveSkill` → `findSkillAtCommit` calls `fetchTree` without
   `knownSkillMdPath`, so another full 20-request walk runs even though the skill's
   `SKILL.md` is already in the cached entries: ~44 for one update.

## Root Cause

- `walkTruncatedTreeBudget` loops `while (state.pending.length > 0 && requests <
  MAX_TRUNCATED_TREE_REQUESTS)` (around line 1141) with no early exit once the requested
  slug's `SKILL.md` is in `cache.entries`.
- `findSkillAtCommit` (around line 877) calls `fetchTree(source, commitSha, slug)` with no
  `knownSkillMdPath`, so `fetchTree`'s skip condition (around lines 978–987) never applies to
  resolves on an already-cached incomplete tree.

## Suggested Fix

- Pass a target (the known `SKILL.md` path, or a predicate matching a ranked candidate for
  the slug) into the walk and stop as soon as it is in `cache.entries`.
- In `findSkillAtCommit`, rank and probe the cached entries of an incomplete tree first and
  only continue the walk when no candidate matches.
- Tests in `src/test/unit/SkillsRegistryClient.test.ts` counting API requests: a batch check
  of several skills in one truncated repo stays under the limit, and update-check followed by
  resolve + download of the same skill does not start a second walk.

Related low-severity items seen in the same review (fix if cheap, otherwise leave):
`downloadSkill` (around line 757) says "`<path>` is not in `<source>`" when the tree is merely
incomplete (should use the "could not confirm" wording when `!cache.complete`); and a lookup
waiting on another lookup's in-flight walk (`continueTruncatedTreeWalk`, around line 1052)
never walks for its own slug, so a concurrent update check can report FAILED.
