# Unknown-property "Did you mean" suggests keys that are invalid on that step kind

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/PromptFileParser.ts` (`createUnknownPropertyWarning`, `getValidKeysAtPointer`)
- **Severity:** low

## Symptom

The `unknown-property` warning suggests the nearest valid key. For a step, the
candidate keys are the union of prompt-step and script-step properties, so a
typo is "corrected" to a key that is not valid on that step either. Following
the advice produces another `unknown-property` warning, and at run time the
field is silently ignored.

```text
⚠ Unknown property 'harnes' at /steps/1/harnes. Did you mean 'harness'?        (script step: harness is not a script-step field)
⚠ Unknown property 'modle' at /steps/1/modle. Did you mean 'model'?            (script step)
⚠ Unknown property 'endCondition' at /steps/0/endCondition. Did you mean 'preCondition'?   (script step: neither is valid)
⚠ Unknown property 'preCondition' at /steps/1/preCondition. Did you mean 'endCondition'?   (script step: neither is valid)
⚠ Unknown property 'shel' at /steps/0/shel. Did you mean 'shell'?              (prompt step: shell is script-only)
⚠ Unknown property 'timeoutSecs' at /steps/0/timeoutSecs. Did you mean 'timeoutSec'?   (prompt step: timeoutSec is script-only)
```

The `endCondition`/`preCondition` pair is the worst case: a user who puts a
condition on a script step is sent back and forth between two fields, neither
of which a script step accepts.

## Steps to Reproduce

```sh
cat > f.ctrlyoke.yaml <<'EOF'
name: f
steps:
  - prompt: hi
    shel: bash
    timeoutSecs: 5
  - type: script
    script: echo x
    harnes: claude-cli
    modle: opus
    preCondition:
      script: exit 1
EOF
ctrlyoke validate f.ctrlyoke.yaml
```

Every warning above carries a suggestion that is invalid at that location.
(`harness`, `model`, `preCondition` and `endCondition` exist only on
`$defs/promptStep`; `shell` and `timeoutSec` exist only on `$defs/scriptStep`.)

## Root Cause

`getValidKeysAtPointer` (`src/core/PromptFileParser.ts`, around line 739)
picks `defs.workflowStep` for any step pointer. `workflowStep` is
`allOf: [{ oneOf: [promptStep, scriptStep] }, …]`, and the visitor walks every
`oneOf` alternative, so the collected property names are the union of both
step kinds. The comment there ("Its oneOf intentionally supplies both step
kinds") is correct for the validation closure but wrong for suggestions.
`createUnknownPropertyWarning` passes that union to `nearestKey`.

The step kind is already known from the authored object: script steps must
carry `type: "script"` (the schema discriminator); everything else is a prompt
step.

## Suggested Fix

In `getValidKeysAtPointer`, when `suggestionCandidatesOnly` is true and the
target is a step object (the `workflowStep` branch), pick
`defs.scriptStep` when `target.type === "script"` and `defs.promptStep`
otherwise. Keep the union for the non-suggestion call (`validRootKeys` at the
root is unaffected because it uses the `""` branch). Check the root
single-step branch (`defs.singleStepRoot`) for the same union and apply the
same discrimination if it has one. Add `src/test/promptFileParser.test.ts`
cases: a script step with `harnes` gets no `harness` suggestion, a script step
with `preCondition` gets no `endCondition` suggestion, a prompt step with
`shel` gets no `shell` suggestion, and an ordinary prompt-step typo
(`harnes` → `harness`) still gets its suggestion. Add a **Fixed** entry to
`CHANGELOG.md`.
