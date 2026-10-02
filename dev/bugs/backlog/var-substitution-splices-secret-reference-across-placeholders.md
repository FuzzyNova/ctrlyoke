# Variable substitution can splice a managed secret reference across placeholders

- **Found:** 2026-10-02 by bug-hunt final step (source review + esbuild repro)
- **Area:** `src/utils/VarSubstitutor.ts`
- **Severity:** low (security defense-in-depth)

## Symptom

`VarSubstitutor.substitute` rejects a variable value that itself contains
`${secret:`. It does not stop the *combined* output from forming one:

- `substitute("X={{a}}{{b}}", { a: "${", b: "secret:GITHUB_TOKEN}" })` returns
  `X=${secret:GITHUB_TOKEN}` with no error.
- `substitute("X=${{{b}}", { b: "secret:GITHUB_TOKEN}" })` also returns
  `X=${secret:GITHUB_TOKEN}`.

## Steps to Reproduce

Call `VarSubstitutor.substitute` with either input above (or run a workflow
with `--var a='${' --var b='secret:NAME}'` against a script `env` value of
`{{a}}{{b}}`). No error is raised.

## Root Cause

The guard at `src/utils/VarSubstitutor.ts` (in the `substitute` replace
callback) only checks each value on its own. The fix for
`dev/bugs/implemented/workflow-vars-inject-secret-grants-past-trust-gate.md`
requires that substitution "must not turn ordinary workflow data into an
executable managed-secret interpolation". Splicing defeats that. The runtime
trust gate (`assertSecretGrantTrust`) still blocks names nobody approved, so
this bypasses a defense-in-depth layer; it does not leak secrets by itself.

## Suggested Fix

After substitution, compare the managed-secret references in the output with
those already present in the authored text: count occurrences of `${secret:`
before and after. If substitution created any new reference, throw the
existing `Variable "<key>" cannot contain a managed secret reference` error,
naming one of the substituted keys that contributed. Add unit tests for both
splicing shapes and confirm a pre-existing authored `${secret:X}` still passes.
