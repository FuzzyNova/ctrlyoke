# `ctrlyoke run --var` calls a variable "unused" when only a referenced prompt file uses it

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/cli.ts` (`warnUnusedCliVariables`)

**Resolution:** fixed in this commit

## Symptom

`docs/workflows/variables.md:151-152` says the CLI warns on stderr when a
`--var` name appears in no workflow field. A variable used only inside a
referenced `.prompt.md` file still triggers the warning, even though the run
then substitutes it there (`vars-not-substituted-in-referenced-prompt-file.md`,
fixed earlier):

```
$ ctrlyoke run pr.ctrlyoke.yaml --var target=lib --dry-run
Warning: --var target=... is unused; no workflow field references {{target}}.
...
    Review lib carefully. ...
```

The warning tells the user their variable is unused, and the same output shows
that it was used.

## Steps to Reproduce

1. `prompts/r.prompt.md` contains `Review {{target}} carefully.`
2. `pr.ctrlyoke.yaml` has `harness: claude-cli` and a single step
   `- prompt: ./prompts/r.prompt.md`.
3. `node out/cli.js run pr.ctrlyoke.yaml --var target=lib --dry-run` prints the
   warning above and then a payload with `lib` substituted.

## Root Cause

`warnUnusedCliVariables` (`src/cli.ts:1880-1893`) runs `JSON.stringify(workflow)`
and searches the result for `{{name}}`. The workflow object holds only the
prompt file's path, not its text. It also ignores placeholders that come from
merged settings defaults (`defaults.endCondition.script`, `defaults.worktree`,
…), which are substituted as well. It is called from both the run path
(~line 1638) and the dry-run path (~line 2064).

## Suggested Fix

Decide whether a variable is used with the scanner that substitution uses
(`findVariablePlaceholders` in `src/utils/VariablePlaceholders.ts`). Scan the
resolved text that would be substituted: the workflow's fields, the text of
each referenced prompt file (resolved the same way the executor resolves it),
and the merged settings defaults. Add a CLI test showing that a variable used
only in a referenced `.prompt.md` produces no warning, while one that is truly
unused still does.
