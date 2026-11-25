# Workspace-scope secret keys depend on how the workspace path is spelled

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/platform/SecretKey.ts`
- **Severity:** medium (a secret set for a project can read back as missing for the same project)

## Symptom

A workspace-scope secret stored through one spelling of a project path is not
found through another spelling of the same directory. For example,
`ctrlyoke secret set TOKEN --scope workspace --cwd /tmp/proj` followed by
`cd /tmp/proj && ctrlyoke secret check wf.yaml` (or `run`) reports `TOKEN`
missing on macOS, because `process.cwd()` there returns `/private/tmp/proj`. A
repository opened in VS Code through a symlinked folder disagrees with the CLI
run from inside it the same way.

## Steps to Reproduce

1. `node -e` against `out/platform/SecretKey.js` (no keychain write needed):
   `workspaceSecretHash('/tmp/x')` and `workspaceSecretHash('/private/tmp/x')`
   give different hashes (`e4a50acbf430` vs `08e8f892ea6a` in the
   reproduction).
2. The `/private/...` hash is the one that matches the project's history
   folder hash, because history keys resolve symlinks.

## Root Cause

`workspaceSecretHash` (`src/platform/SecretKey.ts:34-40`) hashes
`foldPathForCompare(path.resolve(workspaceRoot))` and never calls `realpath`.
Project history keys do canonicalize (`src/utils/ProjectStatePaths.ts:67`,
`fs.realpathSync.native`). The CLI's default root is `process.cwd()` (physical
path), while `--cwd` and the VS Code workspace folder pass the path as typed.
All of these feed the same key: `secret set --scope workspace`
(`src/cli/SecretCommands.ts`), the dashboard (`src/ui/SecretRegistryService.ts`)
and run preflight (`src/utils/SecretResolver.ts`).

## Suggested Fix

Canonicalize the root with the same realpath rule `ProjectStatePaths` uses
(realpath of the longest existing prefix, falling back when nothing exists)
before hashing. That changes the stored key for symlinked roots, so per the
persisted-state rule keep a compatibility read: when the canonical key is
absent, look up the legacy `path.resolve`-only key and migrate it to the
canonical key (and have `secret rm` remove both). Add tests with a symlinked
directory.
