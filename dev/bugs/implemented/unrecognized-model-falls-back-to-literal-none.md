# An unrecognized step model falls back to passing `--model none` to the harness

- **Found:** 2026-11-09 by deferred code-smell review, claude-cli
- **Area:** `src/core/harness/{claude,copilot,codex}/*CliProvider.ts` (`validateAndGetModel`)
- **Resolution:** fixed in this commit

## Symptom

If a harness's default model is `None`, which the settings model picker
offers, a step whose model isn't recognized makes the harness start with
`--model none`. The CLI then rejects the model, so the step fails. The user
asked for no model flag at all.

Second issue, Claude only: the standalone `ctrlyoke` CLI never loads Claude's
model list. A model that Claude Code itself reports (the `default` entry, or a
new alias) is accepted in the VS Code extension but quietly replaced by the
default model in the CLI.

## Steps to Reproduce

1. Set the Claude (or Copilot or Codex) default model to `None`.
2. Run a step with `model: some-unlisted-model`.
3. The log warns "Using default: none", and the harness receives
   `--model none`.

## Root Cause

`ClaudeCliProvider.validateAndGetModel` (`ClaudeCliProvider.ts:483-516`)
handles `MODEL_NONE` only for the requested model. The unrecognized-model
fallback returns `getClaudeModelName(defaultModel) || defaultModel`, which is
the literal `"none"` when the default is `none`. `:371` then pushes it as
`--model`. Copilot (`CopilotCliProvider.ts:523`) and Codex
(`CodexCliProvider.ts:805`) share this fallback shape.

On the second issue: Codex got a "pass through while the model registry isn't
loaded" rule in 23183bfeb, "as Copilot already did". Claude never got it, so
an unloaded registry means checking against only the four built-in aliases.

## Suggested Fix

Add a shared `resolveCliModel(requested, { default, isKnown?, normalize?,
passThroughWhenUnloaded })` in `src/core/harness/shared/`. Its fallback must
never return `none` (it should return `undefined`, meaning no flag). Claude
gets the unloaded-registry pass-through. Antigravity, Qwen and OpenCode
deliberately pass models through (documented on each harness's
model-selection page), and they keep that rule as configuration. Extend
`CliProviderArgumentCharacterization.test.ts`.

Open question, not part of this fix: Claude's substring matching quietly turns
any ID containing `sonnet`/`opus`/`fable`/`haiku` (for example a Bedrock
`us.anthropic.claude-sonnet-…` ID) into the bare alias, losing the pinned
version.
