# CLI `run`/`rerun` with invalid override flags leaves an empty lineage or a never-run run

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with `node out/cli.js` and an isolated `CTRLYOKE_HOME`)
- **Area:** `src/cli.ts` (run path ~1524-1575, rerun path ~2249-2270), `src/cli/CliPropertyOverrides.ts`
- **Resolution:** fixed in this commit

## Symptom

A usage error (exit 2) from `--force` or the sandbox flags still persists state:

- `ctrlyoke run <file>` creates a new lineage with 0 runs (`draft/` plus
  `workflow.json`). The `--json` error envelope even returns its `workflowKey`
  with `runRef: null`.
- `ctrlyoke rerun --workflow <key>` creates a new run that stays `idle` and never
  executed.

`run --prompt x --force bogus` already refuses without persisting anything.

## Steps to Reproduce

In a scratch workspace with `CTRLYOKE_HOME` pointed at a scratch dir, and
`scr.ctrlyoke.yaml` holding two `type: script` steps:

```sh
node out/cli.js run scr.ctrlyoke.yaml --force bogus </dev/null              # exit 2
node out/cli.js run scr.ctrlyoke.yaml --force model </dev/null              # exit 2 "--force model requires --model"
node out/cli.js run scr.ctrlyoke.yaml --sandbox --sandbox-none </dev/null   # exit 2
node out/cli.js history list        # one new 0-run lineage per command above
node out/cli.js rerun --workflow <key> --force bogus </dev/null             # exit 2
node out/cli.js history runs --workflow <key>                               # new idle run, never executed
```

Expected: a usage error leaves no persisted state.

## Root Cause

- Run path: the preflight block in `src/cli.ts` (~1526-1555) runs the trust
  checks before `instance.loadPromptFile(...)` (~1560) allocates the lineage, but
  `buildCliPropertyOverrides(options, harness)` (~1569) and
  `applyCliPropertyOverrides` run after it and throw (throw sites in
  `CliPropertyOverrides.ts` ~60, ~202, ~318, ~351).
- Rerun path: `WorkingFileManager.seedNewRun` (~2249) seeds the run first, then
  the overrides throw inside the `executeSeededRun` callback (~2262).

The earlier fix (38e36eb62) moved only the `--var` case clash and the trust
gates ahead of lineage creation.

## Suggested Fix

Validate the override flags before anything is persisted: call
`buildCliPropertyOverrides` (and the multi-harness `--force model` check) against
the preflight-parsed workflow, ahead of `loadPromptFile` for `run` and ahead of
`seedNewRun` for `rerun`. Keep the code single-sourced, e.g. by building the
overrides once up front and passing them down. Extend
`cli-dry-run.integration.test.ts` (or the CLI run tests) to assert that `.runs/`
gains nothing for these flags on both `run` and `rerun`.
