# Qwen 0.27 silently runs its default model for an unconfigured `--model`

- **Found:** 2026-11-10 by the 0.6.0 `npm run test:harness` run (Qwen Code 0.27.1)
- **Area:** `src/core/harness/qwen/`
- **Resolution:** fixed in this commit

## Symptom

The capability case `qwen-cli: unknown model fails the step with the CLI's error` fails on
Qwen Code 0.27.1: a step on `--model cy-no-such-model` completes successfully. It passed on 0.26.9.

Qwen 0.27.1 honors `--model` only for a model listed under `modelProviders` in
`~/.qwen/settings.json`. Any other id runs the configured default (`model.name`, here
`qwen3.6-plus`) with exit 0 and no warning. That includes real models that simply aren't
configured: the harness suite's default `qwen3.5-plus` ran as `qwen3.6-plus`.

A ctrlyoke user who picks a Qwen model that isn't in their provider list gets a different
model, and the dashboard, run history and cost estimate all report the one they picked.

## Steps to Reproduce

1. With Qwen Code 0.27.1 and `qwen3.6-plus` as the configured default, run
   `qwen -p "Reply ok." --model cy-no-such-model --output-format json`.
2. It exits 0. The result's `stats.models` names `qwen3.6-plus`, not the requested id.
3. `--model qwen3.7-plus` (listed under `modelProviders`) runs as `qwen3.7-plus`.

## Root Cause

Upstream behavior change in Qwen Code 0.27: an unresolved model id falls back to the default
instead of failing. ctrlyoke trusts `--model` and never compares it with the model Qwen reports.

## Suggested Fix

Qwen's headless JSON result (`stats.models`) and its session log name the model that actually
ran. When it differs from the requested model, fail the step with an error naming both (matching
how 0.26 behaved), or at least record a visible warning and attribute usage to the real model.
Interactive mode needs the same check from the session log.

Implemented instead as a check before launch: the requested `--model` (the last one in the argv,
so an `additionalArgs` one counts) is compared with the `modelProviders` lists in Qwen's system,
user and workspace settings, and the step fails before Qwen starts when any list exists and the
model is missing. Failing after the turn would discard work that already ran, so when no list
exists and Qwen still answers on another model, the step only gets a warning
(`OutputMetadata.warnings`). Usage is already attributed to the model Qwen reports.
