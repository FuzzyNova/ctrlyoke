# Skill resolution probes only 20 SKILL.md candidates and reports "Could not find" for skills that exist in larger repositories

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/utils/SkillsRegistryClient.ts`
- **Severity:** low

## Symptom

`findSkillAtCommit` ranks every `SKILL.md` in the repository tree, then fetches
frontmatter only for the first `MAX_FRONTMATTER_PROBES = 20` of them. Ranking
puts a path first only when its folder name slugs to the requested slug.
Everything else is ordered by depth and then alphabetically.

When a skill's frontmatter `name` differs from its folder name (a case the code
supports on purpose: see the test "resolves the folder whose frontmatter name
slugs to the slug"), the correct candidate gets no priority. In an aggregator
repository with more than 20 skills at the same depth, it often ranks past
position 20 and is never fetched. `resolveSkill` then throws
`Could not find the "<slug>" skill in github.com/<source>`, and
`checkForUpdate` reports the installed skill as not found. Both read as
definitive answers, but the skill exists and was never checked. The probes also
run one after another, each with a 10 s request timeout.

Separately, `parseGitTreeResponse` throws when GitHub marks the recursive tree
as `truncated` (over 100k entries or 7 MB), so no skill in a very large
repository can ever be installed.

## Steps to Reproduce

1. Use a repository with 30+ skill folders at the same depth (for example
   `skills/<folder>/SKILL.md`). In one whose folder sorts late (for example
   `skills/zz-tool/`), set the frontmatter `name: Data Wrangler`.
2. Install the `data-wrangler` skill from that repository through the skills
   registry.
3. Installation fails with `Could not find the "data-wrangler" skill in github.com/<owner>/<repo>`.

## Root Cause

- `src/utils/SkillsRegistryClient.ts:55`: `const MAX_FRONTMATTER_PROBES = 20;`
- `:794-798`: `rankSkillMdCandidates(tree, source, slug).slice(0, MAX_FRONTMATTER_PROBES)`
  silently drops every candidate after the 20th.
- `:399-408`: the ranking score is 0 only when
  `toSkillSlug(getFolderName(...)) === slug`. Otherwise candidates are ordered
  only by depth and `localeCompare`, so the order is unrelated to the requested
  name.
- `:799-805`: one sequential `fetchRawText` per candidate.
- `:621-628`: `resolveSkill` converts `undefined` (cap reached) into the same
  "Could not find" error as a real absence.
- `:355-358`: `truncated: true` is always a hard error.

## Suggested Fix

- Tell "not found" apart from "stopped searching". When the cap cuts off
  candidates, say so in the error (for example "searched 20 of 143 SKILL.md
  files"), or keep probing the rest with bounded concurrency (as
  `DOWNLOAD_CONCURRENCY` does), since `raw.githubusercontent.com` fetches do
  not count against the API quota.
- Rank better before probing: try any location skills.sh reports for the
  skill, and match the slug against the folder path as well as the folder name.
- For truncated trees, fall back to walking only the likely subtrees (for
  example `skills/`) with non-recursive tree requests instead of failing
  outright.
