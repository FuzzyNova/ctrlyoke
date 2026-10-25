# An unmatched skill lookup walks a truncated tree without a request bound

- **Found:** 2026-10-25 by bug-drain review of d864277d7
- **Area:** `src/utils/SkillsRegistryClient.ts` (`findSkillAtCommit`, `continueTruncatedTreeWalk`, `walkTruncatedTreeBudget`)
- **Resolution:** fixed in this commit

## Symptom

d864277d7 (dev/bugs/implemented/skills-truncated-walk-spends-full-budget-after-match.md)
stops a truncated-tree walk once the target skill is found. But it also added, at the end of
`findSkillAtCommit`:

```ts
if (!this.isTreeComplete(source, commitSha)) {
  await this.continueTruncatedTreeWalk(source, commitSha, key, cache, undefined);
  return this.findSkillAtCommit(source, slug, commitSha, tree);
}
```

`walkTruncatedTreeBudget` caps one round at 20 requests, but this recursion starts another
round until the tree is complete, so the per-lookup bound that 34eff11a4 introduced
(dev/bugs/implemented/skills-truncated-walk-exceeds-anonymous-rate-limit.md) is gone. Each
round also re-fetches up to `MAX_FRONTMATTER_PROBES` raw `SKILL.md` files it already rejected
(`fetchRawText` is uncached).

Failure: a truncated repo (thousands of directories) plus a slug that doesn't exist, a skill
whose frontmatter `name` differs from its folder, or a folder matching the slug whose `name`
belongs to another skill. `resolveSkill` (and `checkForUpdate` when the installed
`skillMdPath` moved) keeps walking until GitHub's 60-request anonymous limit is exhausted and
fails with a rate-limit error, instead of the bounded "the truncated repository tree still has
unsearched directories" error. In a batch update check, one such skill burns the hourly budget
for every later check. The `!result.searchComplete` branches in `resolveSkill` and
`checkForUpdate` become effectively unreachable.

The existing "reports not found after a bounded walk of a truncated tree" test passes only
because its mock tree fits in one round.

## Suggested Fix

Remove the unbounded recursion. Allow at most one continuation round per lookup (or track a
total-request cap per lookup across rounds); when the cap is hit return
`searchComplete: false` so the existing "could not confirm" errors fire. Skip `SKILL.md`
candidates already probed in an earlier round (remember rejected paths per
`source@commit` in the tree cache). Keep d864277d7's early exit and its two request-counting
tests passing.

Tests: a truncated tree with more than 40 directories and no match makes ≤ 25 API requests
and rejects with the "unsearched directories" error; a second round never re-fetches a
`SKILL.md` it already rejected.
