# One unknown root key makes validation report valid root keys (`harness`, `model`) as unknown

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, two helper agents independently)
- **Area:** `src/core/PromptFileParser.ts` (`validateSchemaAndGetWarnings`)
- **Resolution:** fixed in this commit

## Symptom

```yaml
name: k
harness: claude-cli
steps:
  - type: script
    script: "echo 1"
```

`node out/cli.js validate k.ctrlyoke.yaml --strict` prints:

- `⚠ Unknown property 'harness' at /harness. Did you mean 'harness'?`
- the same warning for `/name`
- `Unknown workflow fields are errors in strict mode: /harness, /name`

Only `name` is unknown at the root (it's a step field). With `color: "#ff0000"` at the root instead,
`harness` and `model` are flagged too. `harness` + `steps` on their own validate cleanly. The
landing page's sample workflow triggers this (see
`landing-sample-workflow-has-invalid-root-name.md`).

## Steps to Reproduce

1. Save the YAML above.
2. Run `ctrlyoke validate k.ctrlyoke.yaml` (warnings) or add `--strict` (rejected).

## Root Cause

One real unknown key makes the root `oneOf` fail, so Ajv drops both branches' annotations and the
root `unevaluatedProperties` also reports valid siblings. The removal loop
(`PromptFileParser.ts:~333-378`) accepts any candidate whose deletion keeps the relaxed validator
passing. Deleting a valid optional key always does, so valid keys are "removed" and warned about one
by one. The suggestion is drawn from keys valid on any branch, so it echoes the key back.

## Suggested Fix

Never treat a key as unknown if it's in the valid key set for its location
(`getValidKeysAtPointer(parsed, parentPointer)`, taking the applicable root branch: `steps` means the
workflow branch). Alternatively, ignore root-level `unevaluatedProperties` errors while a
branch-level one exists. Drop a "Did you mean" suggestion equal to the key itself. Tests: the
example above warns only about `/name`, `color` at the root warns only about `/color`, and
`--strict` lists only the truly unknown keys.
