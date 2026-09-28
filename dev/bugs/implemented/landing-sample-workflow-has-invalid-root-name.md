# The landing page's sample workflow uses a top-level `name:`, which isn't a workflow field

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `landing/src/pages/index.astro` (the "This is the file underneath" example)
- **Resolution:** fixed in this commit

## Symptom

Copied verbatim into a file, the landing page sample (`landing/src/pages/index.astro:~165`)
produces an "Unknown property 'name' at /name" warning from `ctrlyoke validate`, and `--strict`
rejects it. `name` is a step field, not a workflow field. It also triggers
`parser-unknown-property-flags-valid-root-keys.md`, so `/harness` is falsely flagged as well.

## Steps to Reproduce

1. Copy the landing page's sample workflow into `sample.ctrlyoke.yaml`.
2. Run `ctrlyoke validate sample.ctrlyoke.yaml --strict`.

## Root Cause

The sample was written with a workflow-level `name:` that the schema doesn't define.

## Suggested Fix

Remove the top-level `name:` from the sample (or move it onto a step), keeping the rendered example
otherwise the same. Check that it validates cleanly with `--strict`.
