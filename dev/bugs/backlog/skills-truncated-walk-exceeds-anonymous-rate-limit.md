# Installing a skill from a truncated repo exceeds GitHub's anonymous rate limit

- **Found:** 2026-10-25 by bug-drain review of 4df794676
- **Area:** `src/utils/SkillsRegistryClient.ts` (`fetchTree`, `loadTree`, `continueTruncatedTreeWalk`, `downloadSkill`, `checkForUpdate`)
- **Severity:** high

## Symptom

Installing one skill from a repo whose recursive tree GitHub truncates now needs more
GitHub API requests than the anonymous limit (60 per hour) allows. The skill is found,
then the download fails with a rate-limit error. Before 4df794676 the same install took
about 23 requests. Update checks for such a repo now cost 42–63 requests each, against
the 21 the earlier bug doc already called too many.

## Steps to Reproduce

Count `/git/trees/` requests for `resolveSkill` + `downloadSkill` of one skill in a repo
whose recursive tree is truncated and has more directories than one walk budget (20
requests) covers. Requests carry no auth header.

- `resolveSkill`: HEAD 1 + recursive tree 1 + walk budget 20 in `loadTree` (no
  `preferredSlug`) + another budget 20 in `fetchTree` (with the slug) = 42.
- `downloadSkill` → `fetchTree` walks another 20 → 62, then `ensureSkillFolderComplete`
  +1 → 63. Request 61 hits the limit.

## Root Cause

`fetchTree` (around lines 964–972) calls `continueTruncatedTreeWalk` on every call while
the cached tree is incomplete, so each caller spends a fresh 20-request budget even when
it already has what it needs. `loadTree` (around line 997) spends its first budget without
`preferredSlug`, so the first lookup spends two budgets.

### Related (low)

- Around lines 660–662: when `searchComplete` is true for a truncated tree, the
  "exhaustively searching" message replaces the "searched X of Y" summary even though
  frontmatter probing still stops at `MAX_FRONTMATTER_PROBES` (200). Say "exhaustive"
  only when `searchComplete && searchedCount === candidateCount`.
- Around lines 700–706: `checkForUpdate`'s error says "(searched N of N SKILL.md files)"
  when the walk is incomplete, which reads as a complete search. Use a separate message
  for `!searchComplete`, like `resolveSkill`.
- A skill at the repo root (`folderPath === ""`) of a truncated repo now always throws on
  install and reports FAILED on every update check (around lines 1144–1148). That is loud
  rather than partial, which is acceptable, but it needs a test and a CHANGELOG mention.

## Suggested Fix

1. Spend at most one walk budget per lookup: pass `preferredSlug` into `loadTree`'s first
   walk and skip the second walk in `fetchTree` when the first one ran in this call.
2. `downloadSkill`, and `checkForUpdate` once `installed.skillMdPath` is in the cached
   entries, must not continue the repo-wide walk at all. Go straight to
   `ensureSkillFolderComplete` (the folder's own `?recursive=1` tree), and only walk
   further when the target path is not already in the entries.
3. Fix the two messages above and document the root-skill behaviour.
4. Tests in `src/test/unit/SkillsRegistryClient.test.ts`:
   - Count `/git/trees/` requests for resolve + download of one skill in a truncated repo
     and assert a bound well under 60 (for example ≤ 25).
   - Make "continues a cached truncated-tree walk for another slug" use more filler
     directories than a single lookup's budget covers, so the resume across calls is
     actually exercised (today the first lookup's two budgets already finish the walk).
   - Cover the reject branch of folder completion (folder recursive tree truncated) and
     the root-folder throw.
