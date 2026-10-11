# A `.prompt.md` with comment-only frontmatter fails to load, and the editor flags empty frontmatter as an error

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with the built CLI and `out/core/PromptFileParser.js`)
- **Area:** `src/core/PromptFileParser.ts` (`parseMarkdownPromptFile`, `validateWorkflowText`)
- **Resolution:** fixed in this commit

## Symptom

- A file `---\n# just a comment\n---\nBody\n`:
  `node out/cli.js validate x.prompt.md` prints
  `✗ expected a document, but the input is empty` and exits 2. It should load
  (the frontmatter is a YAML null document; the parser's own message accepts
  "mapping or null").
- A file `---\n---\nBody\n` (also with CRLF, a BOM, or whitespace-only
  frontmatter) loads fine, but `validateWorkflowText(text, "promptMarkdown")`
  returns the error `expected a document, but the input is empty` with no
  position. That is what the dashboard workspace editor lint shows (through
  `PromptEditorSupportService.validateWorkflowDocument`).

## Steps to Reproduce

1. Create the two files above.
2. Run `ctrlyoke validate` on each, and call `validateWorkflowText` on each.
3. The comment-only file fails both; the empty one fails only the editor lint.

## Root Cause

The dependency upgrade to js-yaml 5.4.3 changed `yaml.load()` to throw
`expected a document, but the input is empty` for empty, whitespace-only or
comment-only input (v4 returned `undefined`). Call sites were not adjusted:

- `PromptFileParser.ts` ~809-814 guards with `frontmatterText.trim()`, which
  covers whitespace but not a comment-only block.
- `PromptFileParser.ts` ~322 (`validateWorkflowText`, prompt-markdown branch)
  calls `yaml.load(located.frontmatter)` unguarded.

Other `yaml.load` call sites (agent/skill discovery, YAML workflow files,
anything parsing user YAML) may have the same exposure.

## Suggested Fix

Add one shared helper (e.g. `loadYamlDocument(text, options)` next to
`WORKFLOW_YAML_SCHEMA` in `WorkflowYamlSchema.ts`) that returns `null` for
input with no YAML document and otherwise defers to `yaml.load`. Use it at
both `PromptFileParser` call sites, and audit every other `yaml.load` call
(`grep -rn "yaml.load" src`) for the same empty-document case — an empty
`.ctrlyoke.yaml` should keep producing the existing friendly error, not a
js-yaml message. Tests in
`src/test/unit/PromptFileParser.workflowTextValidation.test.ts` and
`src/test/promptFileParser.test.ts`.
