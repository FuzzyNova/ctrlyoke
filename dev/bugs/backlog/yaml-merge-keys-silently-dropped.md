# YAML merge keys (`<<: *anchor`) are silently dropped from workflow files

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/core/PromptFileParser.ts` (YAML and frontmatter loads use `yaml.CORE_SCHEMA`)
- **Severity:** low (needs a decision: support or reject loudly)

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
