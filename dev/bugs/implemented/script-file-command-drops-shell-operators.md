# A script command that starts with a workspace file drops `&&`, `|` and redirects, so `check.js && npm test` passes without running `npm test`

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/EndConditionEvaluator.ts`
- **Resolution:** fixed in this commit

## Symptom

A script whose first word names an existing file is run directly (no shell), and every later
token, including shell operators, is passed to it as a literal argument. The schema describes
`script` as "Shell command or path to script", so the obvious reading of
`scripts/lint.sh && scripts/test.sh` is "run both". What actually happens is that only `lint.sh`
runs, with argv `["&&", "scripts/test.sh"]`. If lint passes, the gate passes and the tests never
run: a **false pass**. This affects end conditions, pre-conditions and headless script steps.
Interactive script steps send the whole text through a shell, so the same step behaves
differently depending on `executionMode`.

## Steps to Reproduce

Confirmed by bundling the real `EndConditionEvaluator` with esbuild and running it in a temp
workspace containing `check.js` (`console.log("argv=" + JSON.stringify(process.argv.slice(2)))`):

| `script`                       | Observed                                                                   | Expected |
| ------------------------------ | -------------------------------------------------------------------------- | -------- |
| `check.js && echo SECOND`      | stdout `argv=["&&","echo","SECOND"]`, exit 0, **passed**; `echo` never ran | both run |
| `check.js \| findstr argv`     | argv `["\|","findstr","argv"]`, no pipe                                    | piped    |
| `node check.js && echo SECOND` | both run (correct)                                                         | both run |

The last row is correct only because `node` isn't a workspace file, so the shell fallback is used.

## Root Cause

`evaluateScript` (around lines 203-239) calls `parseScriptCommand`, which splits on whitespace.
If token 0 resolves to a file (`resolveScriptPath`), `getScriptCommand` builds a direct
interpreter invocation and appends the remaining tokens as argv
(`fileCommand.args = [...fileCommand.args, ...additionalArgs]`) with no shell. Shell operators and
`$VAR` expansions are never interpreted.

## Suggested Fix

Use the direct file dispatch only when the remaining tokens contain no shell syntax (`&&`, `||`,
`|`, `;`, `<`, `>`, `$`, backtick, and so on). Otherwise run the untouched command string through
the existing `resolveShellInvocation` fallback, as for a non-file command. Single-source the
metacharacter check in a helper (check whether one exists already, e.g. near
`resolveShellInvocation` / `ShellUtils`). Check the headless script-step path uses the same
evaluator code so it is fixed too.

Regression tests in the `EndConditionEvaluator` unit tests, using a real temp workspace:

- workspace script plus `&& <second command>` runs both;
- a failing second command (`check.js && node -e "process.exit(3)"`) fails the condition;
- `check.js arg1 "a b"` still passes argv directly (`["arg1","a b"]`);
- a pipe case.
