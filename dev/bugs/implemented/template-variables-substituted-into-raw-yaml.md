# Template variables are pasted into raw YAML text, breaking on newlines, backslashes, quotes and `$`

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/TemplateManager.ts` (`replaceVariables`, `createWorkflow`)
- **Resolution:** fixed in this commit

## Symptom

Creating a workflow from a built-in template (the Template modal) fails, or silently
produces the wrong workflow, for ordinary input. Each case was reproduced by running the
real `TemplateManager.createWorkflow` via `tsx` with a small `vscode` stub:

| Template, variable = value | Result | Expected |
| --- | --- | --- |
| `simple-feature`, `featureDescription` = `"Add login page.\nIt should support OAuth."` | throws `can not read a block mapping entry; a multiline key may not be an implicit key` | a two-line prompt |
| `fix-tests`, `testCommand` = `.\tools\run.cmd` | the script becomes `.<TAB>ools\run.cmd` (no error) | `.\tools\run.cmd` |
| `fix-tests`, `testCommand` = `.\scripts\test.ps1` | throws `unknown escape sequence` | runs the script |
| `fix-tests`, `testCommand` = `npm test -- --grep "auth"` | throws `bad indentation of a mapping entry` | runs the command |
| `fix-tests`, `testCommand` = `echo $& done` | the prompt and script become `echo {testCommand} done` | the literal `$&` |
| `simple-feature`, `featureDescription` = `Price is $$5 total` | `Price is $5 total` | `$$5` |

`featureDescription` is declared `multiline: true`, and `TemplateModal.tsx` shows a
multi-line text box for it, so multi-line input is explicitly invited. Backslash paths
are normal on Windows, the primary platform.

## Steps to Reproduce

1. In the dashboard, create a workflow from the "Simple feature" template.
2. Enter a two-line feature description and create it.
3. Creation fails with a YAML parse error. With the Fix Tests template and
   `.\tools\run.cmd` as the test command, the end-condition script contains a tab
   instead of `\t`.

## Root Cause

`createWorkflow` runs `replaceVariables` on the **raw template text** and only then calls
`jsYaml.load`. `replaceVariables` (`TemplateManager.ts:~502`) does
`result.replace(new RegExp(\`\\{(?:file:|text:)?${key}\\}\`, "g"), value)`, so:

- the value is not YAML-encoded. A newline ends a `|` block scalar. Inside a
  double-quoted scalar (`script: "{testCommand}"`), `\` and `"` are read as YAML escapes
  and quotes.
- the value is used as a `String.replace` replacement string, so `$&`, `$$`, `` $` ``
  and `$'` are expanded.
- the key is interpolated into a regex unescaped. Declared variable names are
  identifiers today, so this last point is latent.

## Suggested Fix

Parse first, then substitute. Load the template with `jsYaml.load`, then walk the
resulting object and replace placeholders only inside string values, using a replacer
function (`(_m) => value`) so `$` patterns are literal. Escape the key when building the
regex, or match `\{(?:file:|text:)?([A-Za-z0-9_]+)\}` once and look up the name. Keep
`_templateMeta` stripping and `validateAndNormalize` as they are. Check that
`extractVariables`/`parseTemplateMeta` still work on the unsubstituted text, and that
custom JSON templates go through the same path.

Add `TemplateManager` tests covering each row in the table above: multi-line
`featureDescription`, Windows backslash paths and double quotes in `testCommand`, and
`$&`/`$$` preserved literally. Assert the resulting step prompt and end-condition script
equal the input exactly.
