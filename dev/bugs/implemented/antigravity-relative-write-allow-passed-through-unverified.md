# Antigravity passes relative and glob `write(<path>)` allow targets through unverified

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading; not reproduced against agy
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts` (`convertToAntigravityRules`)
- **Resolution:** fixed in this commit without an agy probe. Only an absolute target is kept; a relative path or glob falls back to `write_file(*)`, the behavior before 0.7.0. A future probe could restore pass-through if agy turns out to honor relative or glob targets.

## Symptom

Commit d18d6e40b changed how a path-targeted `write`/`edit` allow rule maps to
Antigravity. Its CHANGELOG entry says only rules **with an absolute path** changed ("now
limits writes to that path … on Antigravity (as `write_file(<path>)`)"), and the code
comment says only the absolute form was probed (agy 1.5.6). The mapper, however, passes
**any** target other than `*` through: a relative path or glob such as `write(src/**)`
becomes `write_file(src/**)`. Before d18d6e40b it became `write_file(*)`.

The Claude and OpenCode mappers gate the same change on `path.isAbsolute`; this one
doesn't. `dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md` ("Path-scoped file
rules") records that agy's in-path globs are undocumented and relative targets were
never checked. If agy reads `src/**` as a literal path, every write in a headless
`custom` run is now refused, which changes behavior for released workflows.

## Steps to Reproduce

1. Workflow on `antigravity-cli` with
   `toolPermissions: { mode: custom, allowedTools: ["read", "write(src/**)"] }`.
2. Inspect the per-run settings file ctrlyoke writes under `.ctrlyoke/temp/`: its allow
   list holds `write_file(src/**)`.
3. Unverified: whether agy then allows a write to `src/a.ts`.

## Root Cause

#selection:src/core/harness/antigravity/AntigravityToolPermissionMapper.ts:205-216 keeps
the target whenever it is non-empty and not `*`, without checking that it is absolute.

## Suggested Fix

Probe agy (1.5.7) with a relative and a glob `write_file(...)` allow rule. If either is
not honored, keep the target only when `path.isAbsolute(target)` (as the Claude mapper
does) and fall back to `write_file(*)` otherwise, with a unit case in
`HarnessToolPermissionMappers.test.ts`.
