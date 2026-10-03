# Template placeholders match the inner braces of `{{var}}` workflow variables

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/core/TemplateManager.ts` (`extractVariables`, `replaceVariables`)
- **Resolution:** fixed in this commit

## Symptom

A template whose prompts contain runtime `{{name}}` workflow variables —
including any template produced by "Save as Template" on a workflow that uses
`vars` — is treated as if it contained a `{name}` template placeholder:

- The template form asks the user for `name`.
- On instantiation `{{branch}}` becomes `{dev}`. The outer braces survive,
  `VarSubstitutor` no longer recognises it, and the workflow's `vars` default
  is never applied. The created workflow is broken.

## Steps to Reproduce

Template content with `vars: {branch: main}` and
`prompt: "Check out {{branch}} and implement {feature}"`:

1. `extractVariables(content)` returns `[{name:"branch"},{name:"feature"}]`
   (expected only `feature`).
2. `replaceVariables(content, {branch:"dev", feature:"login"})` returns
   `Check out {dev} and implement login` (expected
   `Check out {{branch}} and implement login`).

## Root Cause

Both functions use `/\{(?:(file|text):)?([a-z][a-zA-Z0-9]*)\}/g` (lines ~473
and ~498) with no guard against an adjacent `{` / `}`, so the inner `{branch}`
of `{{branch}}` matches. The regex is also duplicated across the two methods.

## Suggested Fix

Single-source one placeholder regex that refuses a match preceded by `{` or
followed by `}` (e.g. `(?<!\{)\{(?:(file|text):)?([a-z][a-zA-Z0-9]*)\}(?!\})`)
and use it in both functions. Add unit tests for `{{var}}` surviving extract
and replace, and a save-as-template round trip of a workflow with `vars`.
