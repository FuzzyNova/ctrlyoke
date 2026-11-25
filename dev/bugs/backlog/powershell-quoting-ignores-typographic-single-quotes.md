# PowerShell quoting doesn't escape typographic single quotes (U+2018–U+201B)

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, probe against `out/`)
- **Area:** `src/types/CommandDisplayFormatter.ts`, `src/core/harness/shared/CliLauncherResolver.ts`
- **Severity:** medium (script steps under pwsh/powershell break when a path or argument contains `’`)

## Symptom

The PowerShell language spec treats `'`, `‘` (U+2018), `’` (U+2019), `‚`
(U+201A) and `‛` (U+201B) all as `single-quote-character`: any of them closes a
single-quoted string, and each is escaped by doubling it. ctrlyoke doubles only
the ASCII `'`, so `escapePowerShellArgument("Don’t")` returns `'Don’t'`, which
PowerShell reads as `'Don’` followed by a stray `t'`.

Where it matters:

- `EndConditionEvaluator.buildResolvedScriptShellCommand`
  (`src/core/EndConditionEvaluator.ts` ~784-808) uses it to build the command
  a script step actually runs under `pwsh`/`powershell`. A script path such as
  `C:\Users\me\Nathan’s Projects\check.ps1` (macOS/Office autocorrect produces
  `’`) breaks the step.
- Dry Run's PowerShell rendering (`renderCommandForDisplay`, the default
  display shell on Windows) is not pasteable for text containing `’`.
- `CliLauncherResolver` (`escapePowerShellSingleQuoted`, ~530, used at ~485)
  builds a `Get-Command` script; a command name with `’` makes Windows
  launcher resolution fail quietly.

## Steps to Reproduce

```js
const { escapePowerShellArgument } = require("./out/types/CommandDisplayFormatter");
escapePowerShellArgument("Don\u2019t"); // "'Don’t'" — expected "'Don’’t'"
```

## Root Cause

`escapePowerShellArgument` (`src/types/CommandDisplayFormatter.ts` ~66-69) and
the duplicate `escapePowerShellSingleQuoted` in `CliLauncherResolver.ts` both
use `value.replace(/'/g, "''")`.

## Suggested Fix

Double every PowerShell single-quote character:
`value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")`. Delete the
`CliLauncherResolver` copy and use one shared helper (the body without the
surrounding quotes can be exported alongside `escapePowerShellArgument`). Add
unit tests with each of the four characters.
