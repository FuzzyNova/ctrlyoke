# Qwen turns a path-scoped write allow into permission for every write

- **Found:** 2026-11-11 while probing single-file write rules for commit message generation (Qwen Code 0.27.1)
- **Area:** `src/core/harness/qwen/QwenToolPermissionMapper.ts` (`convertCtrlYokePatternsToQwenTools`)
- **Resolution:** fixed in this commit. A path-scoped `write`/`edit` allow is skipped and reported as a lossy translation, so the write stays denied; a path-scoped deny still denies the whole tool.

## Symptom

A workflow with `toolPermissions.mode: custom` and `allowedTools: ["write(/repo/out.txt)"]`
lets a Qwen run write any file. In the probe, the model wrote both the allowed file and a
second file next to it.

## Steps to Reproduce

1. Run a headless Qwen workflow whose `allowedTools` holds only `write(<absolute path>)`.
2. Ask the model to write that file and then another one. Both are written.

## Root Cause

The mapper drops the path and emits a bare `WriteFile` in `--allowed-tools`, which allows the
whole tool. Qwen does understand path rules (`Edit(//<abs>)`, matched with picomatch), but in
headless `--approval-mode default` it removes `write_file` from the session entirely unless
the tool is allowed by name, so a path-only rule leaves the model with no write tool. The
probe saw both: `Edit(//<abs>)` and `WriteFile(<path>)` through `--allowed-tools`, and
`permissions.allow` in a workspace `.qwen/settings.json`, all left `write_file` unavailable.

## Suggested Fix

Stop widening the rule. Either emit nothing for a path-scoped write allow and report it as
lossy (a write then stays denied, which is the safe direction), or find a Qwen setting that
keeps `write_file` registered headless while still honoring path rules, then emit
`Edit(//<abs>)`. Commit message generation does not depend on this: Qwen has no
`allowsSingleFileWrite` and uses the skill command instead.
