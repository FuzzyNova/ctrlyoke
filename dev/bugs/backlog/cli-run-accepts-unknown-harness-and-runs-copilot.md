# `ctrlyoke run`/`rerun`/`append` accept an unknown `--harness` and fall back to Copilot CLI

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/cli.ts` (`runCommand`), `src/core/IntegrationFactory.ts`
- **Severity:** medium

## Symptom

A mistyped harness such as `--harness claude` (instead of `claude-cli`) is accepted. The run
reports and persists the bogus harness ID, and any AI step is executed by Copilot CLI, which is a
different and possibly paid harness. `--dry-run` and `validate` reject the same value.

Reproduced with the real CLI on a script-only workflow (so no harness started):

- `ctrlyoke run ok.ctrlyoke.yaml --harness bogus --dry-run`: `Error: Invalid harness: bogus`,
  exit 2. This is correct.
- `ctrlyoke run ok.ctrlyoke.yaml --harness bogus --headless --json`: exit 0, JSON
  `"harness":"bogus"`.
- `ctrlyoke rerun --workflow <key> --harness bogus --json`: exit 0. The new run's
  `workflow.ctrlyoke.json` stores `"harness": "bogus"`, and a later plain `rerun` carries it forward.

## Steps to Reproduce

1. Run `ctrlyoke run <workflow> --harness bogus --headless --json`.
2. It exits 0 and reports `"harness":"bogus"`. With an AI step, Copilot CLI runs it.

## Root Cause

`runCommand` puts `options.harness as HarnessId` straight into the defaults overlay
(`src/cli.ts:~667-668`) and into `explicitHarness` (`~783`) without validating it. Only the
dry-run path (`~1469`) and `validate` (`~1913`) call `assertHarnessId`. For an unknown ID,
`IntegrationFactory.createForHarness` (`IntegrationFactory.ts:~185-187`) and
`createCapabilityProvider` (`~63-65`) both use `case COPILOT_CLI: default:`.

## Suggested Fix

- Call `assertHarnessId(options.harness)` at the top of `runCommand`, before the overlay is built,
  so run, rerun and append all get the usage error (exit 2) that dry-run already gives.
- Make the factory `default:` branches throw on an unknown harness instead of returning Copilot, so
  no other entry point can fall through silently.
- Tests: `run`/`rerun` with `--harness bogus` exit 2 with `Invalid harness`, and the factory
  throws for an unknown ID.
