# Reply to Step pins another harness's default args and model

- **Found:** 2026-09-30 by bug-backlog final step (claude-cli, code review + scratch vitest)
- **Area:** `src/ui/webview-react/utils/replyToStep.ts`
- **Severity:** medium

## Symptom

**Reply to Step** fills the new-prompt editor with explicit overrides for the step being
replied to. The harness is the one the step actually ran with (`step._runtime.harness`).
Every other harness-dependent value comes from `resolveExecutionProperties()`, which
resolves against whichever harness *today's* step/workflow/settings choose. When those
two harnesses differ, the reply pins values that belong to the other harness:

- `additionalArgs` comes from `defaults.additionalArgsByHarness[<resolved harness>]`
  (`src/types/ExecutionPropertyResolver.ts` `resolveAdditionalArgs`, ~l.293).
- `model`, when `_runtime.model` is absent, falls back to
  `defaults.modelsByHarness[<resolved harness>]`, so it can name a model the replying harness
  does not have.

Example (confirmed with a throwaway vitest): the default harness is `copilot-cli` with
default additional args `--settings`. The step ran under `claude-cli`
(`_runtime: { harness: "claude-cli", model: "opus" }`). The builder returns
`{ harness: "claude-cli", model: "opus", additionalArgs: "--settings", … }`. Copilot's
flags are pinned as an explicit override on a Claude resume, so the CLI may reject them or
behave unexpectedly.

The same thing happens whenever the default harness changes after the run, or when the
step's or workflow's authored harness is edited after the step ran.

## Steps to Reproduce

1. Set the default harness to Copilot CLI, with default additional args for Copilot.
2. Run a step under Claude CLI (a step-level harness override works, as does switching the
   default back and forth).
3. Change the step's harness, or the default, back to Copilot.
4. Right-click the Claude step and choose **Reply to Step**. The drawer shows
   Harness = Claude CLI and Additional Args = the Copilot defaults.

## Root Cause

`buildReplyPropertyValues` (`replyToStep.ts` ~l.42-63) calls `resolveExecutionProperties`
once with the step as authored, then replaces only the `harness` field with
`_runtime.harness`. Every value the resolver chose *because of* the harness is left as it
was.

Related, medium confidence: the session ID comes from `getStepSessionId`
(`utils/stepMetadataClipboard.ts`), which prefers the latest output's
`structured.metadata.sessionId`. The harness always comes from `_runtime.harness`, never
from that output's metadata. `_runtime` is only written when a step completes or is
cancelled. If a step is rerun under a different harness and the user replies while the
rerun is still going, the session ID can belong to one harness and the harness field to
another.

## Suggested Fix

When `_runtime.harness` is known, resolve with that harness forced in: for example, pass
`{ ...toCorePromptStep(step), harness: runtime.harness }` to `resolveExecutionProperties`,
so that per-harness defaults (additional args, default model) match the harness the reply
will run under. Take the harness from the same source as the session ID, so the two always
stay paired. Add `replyToStep.test.ts` cases for a harness that differs between runtime and
the resolved settings.
