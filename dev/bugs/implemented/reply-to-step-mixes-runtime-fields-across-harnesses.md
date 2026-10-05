# Reply to Step pins the previous run's model/agent/skills onto a different session harness

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent, scratch vitest)
- **Area:** `src/ui/webview-react/utils/replyToStep.ts` (`buildReplyPropertyValues`, ~l.37-85)
- **Resolution:** fixed in this commit

Follow-up to `reply-to-step-resolves-defaults-under-wrong-harness.md` (c17a679ed). That fix pairs
the harness with the session ID from the latest output metadata. It still overlays every other
runtime-derived value from `step._runtime`, which that doc notes can describe the previous run.

## Symptom

During or after a rerun under a different harness, the reply draft mixes harnesses. Example:

- step `_runtime = { harness: "claude-cli", model: "opus", agent: "claude-agent", sessionId: "old-claude" }`
- latest output metadata `{ sessionId: "new-codex", harness: "codex-cli" }`

`getStepSessionDetails` + `buildReplyPropertyValues` return
`{ harness: "codex-cli", model: "opus", agent: "claude-agent", sessionId: "new-codex", … }`.
Claude's model and agent are pinned as explicit overrides on a Codex resume.

## Steps to Reproduce

Add a `replyToStep.test.ts` case with the inputs above (runtime harness differs from
`sessionHarness`) and assert `model`/`agent`/`skills`/`secrets`/`executionMode`.

## Root Cause

`model`, `agent`, `skills`, `secrets` and `executionMode` are taken from `runtime` whenever
they're defined (`runtime?.model !== undefined ? runtime.model : properties.model`, etc.). This
happens regardless of whether `runtime.harness` equals the harness the reply resolves to.

## Suggested Fix

Only overlay `_runtime` fields when `runtime.harness` equals the resolved `harness`. Otherwise use
the resolver's values for the forced harness. When `OutputMetadata` carries a model alongside the
session ID, prefer that as the paired model. Cover both the matching and the mismatched cases in
`replyToStep.test.ts`.
