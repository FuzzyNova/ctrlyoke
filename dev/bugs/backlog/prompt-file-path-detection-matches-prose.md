# Prompts starting with `/` or `./` and ending in a filename are treated as prompt-file paths

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/promptPathUtils.ts` (`looksLikeFilePath`)
- **Severity:** medium

## Symptom

A slash-command prompt with arguments is rejected when the workflow loads:

```yaml
steps:
  - prompt: /review Please look at the failing test in src/app.ts
```

`ctrlyoke validate` prints
`✗ Prompt file reference "/review Please look at the failing test in src/app.ts" could not be found`
and exits 2. `run` fails the same way. Other ordinary prose is affected too:
`./fix the bug, then update README.md`, or a multi-line prompt such as
`/init\nThen summarise package.json`. The docs (`docs/workflows/yaml-format.md`)
say a value is a prompt-file path "only when the whole value is a path", and
`CliPromptPreparer` supports slash commands with arguments.

## Steps to Reproduce

1. Save the YAML above.
2. `ctrlyoke validate t.ctrlyoke.yaml`.
3. Observe the prompt-file-reference error (exit 2).

## Root Cause

`looksLikeFilePath` only checks for a path-like start (`/`, `./`, `../`, a
drive letter) and an extension-like end (`/\.\w+$/`). It never rejects
whitespace or newlines in the middle. `PromptFileParser.validatePromptReference`
and `PromptFileResolver` both use it.

## Suggested Fix

Return false when the trimmed value contains a newline, and when it contains
whitespace. If paths with spaces must stay supported, only accept whitespace
when the entire value, including the spaces, is plausibly a single path. For
example, reject when whitespace appears before the last `/`, or when the first
whitespace-delimited token is a slash command (`/word`) followed by more text.
Keep this single-sourced in `looksLikeFilePath`. Add unit tests for the
examples above, and check that existing path-with-spaces tests (if any) still
pass.
