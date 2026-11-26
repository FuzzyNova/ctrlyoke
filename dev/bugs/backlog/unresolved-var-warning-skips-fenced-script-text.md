# No warning for an undefined `{{name}}` inside a fence in script or worktree-setup text

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/VarSubstitutor.ts` (`findUnresolvedVariables`), `src/core/WorkflowExecutor.ts` (`reportUnresolvedVariables`), `src/core/orchestration/WorktreeManager.ts` (`runSetup`)
- **Severity:** low

## Symptom

Script, `env`, condition-script and worktree-setup text is substituted inside
fenced code blocks too (`fencedCodeProtected: false`;
`docs/workflows/variables.md:144` says "Script and environment text is substituted inside
fences too"). The docs also say an undefined placeholder "is left in the text
as-is, and the run shows a warning naming the placeholder" (line 140).

Inside a fence in those fields, a mistyped variable gets no runtime warning.
The defined variables next to it are substituted, and the typo reaches the
shell as literal `{{modul}}` without any message. The editor lint
(`getUndefinedVariableDiagnostics` in `src/utils/PromptDiagnosticRules.ts`)
honours each field's `fencedCodeProtected` and does flag it, so the editor and
the run disagree.

## Steps to Reproduce

Against the compiled `out/utils/VarSubstitutor.js`, with vars `{ module: "src/x" }`
and the script text

````
cat <<'MD' > notes.md
```
module {{modul}} / {{module}}
```
MD
````

- `VarSubstitutor.substitute(script, vars, false)` gives `module {{modul}} / src/x`.
- `VarSubstitutor.findUnresolvedVariables(script, vars)` gives `[]`.

## Root Cause

`findUnresolvedVariables` (`VarSubstitutor.ts:250-259`) calls
`findVariablePlaceholders(text)` with its default `fencedCodeProtected = true`
and skips `inFence` matches. It has no parameter to change that. Its runtime
callers apply it to fields that are substituted without fence protection:
`WorkflowExecutor.ts` around line 5531 (script, env, pre/end-condition
scripts) and `WorktreeManager.runSetup` (`WorktreeManager.ts:2962-2969`). In
`runSetup` the detection and the substitution two lines apart disagree.

## Suggested Fix

Add a `fencedCodeProtected` parameter to `findUnresolvedVariables` that
matches `substitute`'s. Pass the field's `VAR_SUBSTITUTION_POLICY` value from
`WorkflowExecutor`, and `false` from `runSetup`. A cleaner option is to report
unresolved names from the same scan that substitutes, so the two cannot drift
apart. Add unit tests for a fenced undefined placeholder in a script step and
in worktree setup, and a test that a fenced placeholder in prompt text (where
fences are protected) still gets no warning.
