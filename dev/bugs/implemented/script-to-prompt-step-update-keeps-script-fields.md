# Script-to-prompt step update keeps the old script fields

- **Found:** 2026-09-28 by the maxSteps orchestrator review pass (`npm test`)
- **Area:** `src/core/WorkingFileManager.ts` (`updateFinalStepAtRun`, `mergeWorkflowStepUpdate`), dashboard `updatePrompt` routing
- **Resolution:** fixed in 540ffa9a (`mergeWorkflowStepUpdate` infers the step kind from `script`/`prompt` and replaces on a kind change)

## Symptom

Changing a script step (or `finalStep`) into a prompt step merges the new prompt into the old
step instead of replacing it, so `type: "script"`, `script`, `env`, `timeoutSec` and even
`_runtime` survive next to the new `prompt`. The prompt → script direction replaces correctly.

Two tests fail deterministically, and they fail the same way at `8874eec8`, before the maxSteps work:

- `Schema -> dashboard property round trip` › `user-reachable reproduction` › `script to prompt changes replace the previous step wholesale`
- `WorkingFileManager` › `addressed run-head mutation primitives` › `updateFinalStepAtRun replaces across prompt/script type changes`

## Steps to Reproduce

1. `MOCHA_GREP="replace the previous step wholesale|replaces across prompt/script type changes" npm run test:extension`
2. The actual step still carries `type: "script"`, `script: "npm run seeded"` and the other script fields.

## Root Cause

Not yet investigated. The likely cause is a step-kind change handled as a field merge
(`mergeWorkflowStepUpdate`) when the step's kind flips from script to prompt.

## Suggested Fix

When the incoming step's kind differs from the source step's kind, replace the step instead
of merging it, in both directions and on every run-head mutation path.
