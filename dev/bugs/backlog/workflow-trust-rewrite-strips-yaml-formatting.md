# "Trust for this workflow" rewrites the workflow YAML and strips comments and formatting

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/permissions.md`
- **Area:** `src/ui/ExternalRootsApproval.ts`
- **Severity:** medium

## Symptom

When ctrlyoke blocks a file outside the trusted roots, the **Trust Parent Folder** prompt offers
**Trust for this workflow**. Choosing it adds the folder to the workflow file's
`trustedExternalRoots` by re-serializing the user's whole source file with `yaml.dump`. The
rewrite:

- deletes every comment;
- re-wraps long strings at js-yaml's default 80-column `lineWidth` and changes quoting and block
  scalar style, so multi-line `prompt: |` blocks can come back in a different form;
- expands anchors, aliases and `<<:` merge keys (the load schema includes `mergeTag`) into
  copies;
- re-indents the whole file to js-yaml's defaults.

The user's hand-written workflow is changed far beyond the one key they approved, with no
warning. In a git repo it shows up as a whole-file diff.

## Steps to Reproduce

1. Create `demo.ctrlyoke.yaml` with comments, a long `prompt: |` block and an anchor/alias.
   Reference `@C:/elsewhere/notes.md` from a step.
2. Run the workflow. In the Trust Parent Folder prompt, choose **Trust for this workflow**.
3. `git diff demo.ctrlyoke.yaml`: the comments are gone, the aliases are expanded, and the
   whole file is reformatted, in addition to the new `trustedExternalRoots` entry.

## Root Cause

`writeWorkflowTrustState` (`src/ui/ExternalRootsApproval.ts:297-318`) parses the file into a
plain object with js-yaml (`loadYamlDocument`, `:306`), sets `trustedExternalRoots`, and writes
`yaml.dump(parsed)` back over the source (`:316-317`). js-yaml has no document model, so
anything that isn't data is lost. It is called from the `WORKFLOW` choice at `:119`. The JSON
branch has the same problem in a milder form (custom indentation is replaced by
`JSON.stringify(..., 2)`).

## Suggested Fix

Edit the one key in place. The `yaml` package is already a dependency and is used through
`parseDocument` in `src/completions/WorkflowLocationYaml.ts:63`. Use
`parseDocument(raw)`, then `doc.setIn(["trustedExternalRoots"], roots)`, then
`String(doc)`. That keeps comments, anchors and scalar styles. For JSON/JSONC, use
`jsonc-parser`'s `modify`/`applyEdits` (already used by `src/utils/HarnessMcpExporter.ts:361-362`) instead of
re-stringifying. Factor this into a small shared "set top-level key in a workflow source file"
helper so other in-place writers can reuse it. Add a test that a commented YAML file keeps its
comments after a workflow-scoped trust.
