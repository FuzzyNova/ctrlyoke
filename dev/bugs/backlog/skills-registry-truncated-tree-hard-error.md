# Skills registry: a truncated GitHub tree still makes every skill in a large repository uninstallable

- **Found:** 2026-10-24 by bug-drain review of eceb789de
- **Area:** `src/utils/SkillsRegistryClient.ts`
- **Severity:** medium

## Symptom

No skill in a repository whose git tree is over GitHub's recursive-tree limit (about
100k entries or 7 MB) can be installed or update-checked. ctrlyoke reports a
truncated-tree error. This was one of the root causes listed in
`dev/bugs/implemented/skills-registry-frontmatter-probe-cap-misses-skills.md`, but
eceb789de only tightened the test's regex for it.

## Root Cause

`SkillsRegistryClient.ts` (around lines 356-359) treats a `truncated: true`
recursive tree response as a hard error.

## Suggested Fix

When the recursive tree is truncated, fall back to non-recursive tree requests:
walk the likely skill locations (`skills/`, `.claude/skills/`, the folder path from
the registry entry, then the root's top-level directories), with a request cap.
Look for `SKILL.md` files there, and rank them with the same folder-path ranking
the probe already uses. Report a clear error only if that bounded walk also finds
nothing. Add tests with a mocked truncated tree response.
