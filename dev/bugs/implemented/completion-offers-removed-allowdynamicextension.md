# Workflow key completion offers `allowDynamicExtension`, which the schema rejects

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/completions/PromptPropertyCompletionProvider.ts` (step property completions)
- **Resolution:** fixed in this commit

## Symptom

In a `.ctrlyoke.yaml` step, typing `allow` as a key offers `allowDynamicExtension`, and
accepting it inserts `allowDynamicExtension: true`. The workflow then fails schema
validation:

```
OFFERED: [ 'allowDynamicExtension' ]
SCHEMA VALID: false [... ["/steps/0","unevaluatedProperties",{"unevaluatedProperty":"allowDynamicExtension"}] ...]
BASELINE VALID: true      // same step without the key
```

(Reproduced in vitest with the real provider, a minimal `vscode` mock, and Ajv 2020
compiled against `schemas/workflow-schema.json`.)

The same hand-maintained lists also fail to offer several keys the schema accepts:

- **Prompt steps:** `enabled`, `color`, `executionMode`, `priorContext`, `additionalArgs`,
  `toolPermissions`, `secrets`.
- **Script steps:** `env`, `shell`, `errorBehavior`, `secrets`, `enabled`, `color`,
  `executionMode`, `returns`.

## Steps to Reproduce

1. Open a `.ctrlyoke.yaml` workflow.
2. Inside a step, type `allow` on a new key line and trigger completion.
3. Accept `allowDynamicExtension`. The file now shows a schema error for it.

## Root Cause

Commit `9ddd06c0` replaced `allowDynamicExtension` with `mcpServers` in the schema and
docs. The entry at `PromptPropertyCompletionProvider.ts:~206-212` was never removed,
because the property lists are maintained by hand.

## Suggested Fix

Remove the stale entry. To stop the drift, derive the offered keys from the schema:
the `promptStep`, `scriptStep` and shared execution-property definitions in
`schemas/workflow-schema.json`, with per-key snippets or descriptions kept as optional
overrides. At minimum, add a unit test asserting that every key the provider offers
exists in the schema for that step type, and that every schema key is offered. If you
change how the lists are maintained, update `.github/instructions/completions.instructions.md`
to match.
