# YAML merge keys (`<<: *anchor`) are silently dropped from workflow files

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/core/PromptFileParser.ts` (YAML and frontmatter loads use `yaml.CORE_SCHEMA`)
- **Resolution:** fixed in this commit

## Symptom

`x-defaults: &d {model: gpt-5}` plus `steps: [{<<: *d, prompt: hello}]`
parses to `{prompt: "hello"}` with no `model`. The only feedback is the
warning "Unknown property '<<' … Did you mean 'env'?". A step built only from
`<<: *s1` plus `name` fails validation with a confusing `oneOf` error.
`TemplateManager.createWorkflow` loads YAML with js-yaml's default schema,
which does expand merge keys, so the same YAML behaves differently as a
template and as a workflow file.

## Steps to Reproduce

Validate or run a YAML workflow that uses `<<: *anchor` in a step.

## Root Cause

js-yaml's `CORE_SCHEMA` omits the `merge` type, so `<<` stays a literal key
and the unknown-property pass deletes it.

## Suggested Fix

Either extend the schema used for workflow YAML with js-yaml's merge type
everywhere workflow YAML is loaded, or reject `<<` with a specific error. Not
queued: product decision.

## Decision

Decided 2026-10-03 (obvious, no input needed): support merge keys. Define one shared js-yaml schema (`CORE_SCHEMA` extended with the `merge` type) and use it for every workflow YAML load: `.ctrlyoke.yaml/.yml`, `.prompt.md` frontmatter, and `TemplateManager.createWorkflow`. A template and a workflow file then parse the same way. Merge keys are standard YAML 1.1, commonly used for DRY step defaults, and safe (they only copy already-parsed mappings). Add parser tests for a step built from `<<: *anchor` plus overrides.
