# CLI commands resolve a relative workflow file against different bases when `--cwd` is set

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/cli/SecretCommands.ts`, `src/cli.ts` (`trustWorkflowExternalRootsCommand`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run`, `validate`, `append` and `step edit` resolve a relative file
argument against the process cwd. `secret check`, `trust-secret-grants` and
`trust-workflow-external-roots` resolve it against `--cwd`. When `run` refuses
to start (exit 2), it tells the user to run `ctrlyoke trust-secret-grants <file>`
or `trust-workflow-external-roots <file>`. Retyping that with the same file and
`--cwd` reads a different file, or a missing one. `secret check` is documented
as "the same preflight as `run`" but checks a different file.

## Steps to Reproduce

From directory `a/` (containing `wf.ctrlyoke.yaml`) with an empty sibling `b/`:

1. `ctrlyoke run wf.ctrlyoke.yaml --cwd ../b --dry-run` loads `a/wf.ctrlyoke.yaml` and exits 0.
2. `ctrlyoke secret check wf.ctrlyoke.yaml --cwd ../b` fails on `b\wf.ctrlyoke.yaml` and exits 2.
3. `trust-secret-grants` / `trust-workflow-external-roots` with the same arguments also exit 2 on `b\wf.ctrlyoke.yaml`.

## Root Cause

`src/cli/SecretCommands.ts` (`secret check` and `trust-secret-grants`) use
`path.resolve(workspaceRoot, file)`, and `trustWorkflowExternalRootsCommand`
in `src/cli.ts` uses `path.resolve(workingDir, file)`. `run`/`validate`/
`append` in `src/cli.ts` and `src/cli/StepCommands.ts` use `path.resolve(file)`.

## Suggested Fix

Add one shared helper (e.g. `resolveCliFileArgument(file)` in an existing
`src/cli/` module) that resolves against the process cwd, matching the
majority and normal shell semantics. Use it in every command that takes a
workflow file. Add tests that run the affected commands with `--cwd` pointing
elsewhere.
