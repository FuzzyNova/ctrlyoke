# Skill directories that are symlinks or junctions are never discovered

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `src/utils/SkillDiscovery.ts` (~L570)
- **Resolution:** fixed in this commit

## Symptom

A skill installed as a symlink or Windows junction (e.g. `.ctrlyoke/skills/linked -> ../../shared/my-skill`,
which is how many skill installers place skills) doesn't appear in skill discovery or
completions, even though `linked/SKILL.md` exists and is readable.

## Steps to Reproduce

Verified by a helper agent with a real junction: `ws/.ctrlyoke/skills/linked` points to a real skill
directory. `fs.existsSync(ws/.ctrlyoke/skills/linked/SKILL.md)` is `true`, but
`discoverSkills(ws)` returns only the non-linked skill.

## Root Cause

The directory scan does `if (!entry.isDirectory()) continue;`. For a symlink or junction, the
`Dirent` reports `isSymbolicLink()`, not `isDirectory()`. Agent discovery follows links, and no
docs or tests say skills are meant to skip them.

## Suggested Fix

Accept `entry.isDirectory() || entry.isSymbolicLink()`, and let the existing
`existsSync(SKILL.md)` check (which follows links) decide. Keep any trusted-root and path-security
checks on the resolved path. Add a test using a junction on Windows or a symlink elsewhere.
