# Dry Run's PowerShell command line can't be pasted into PowerShell

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/types/CommandDisplayFormatter.ts`
- **Resolution:** fixed in this commit

## Symptom

In PowerShell mode, `renderCommandForDisplay` single-quotes the executable along with every
argument. PowerShell parses a line that starts with a quoted string as an expression, not a
command, so pasting the Dry Run command fails with a parser error. PowerShell is the default
display shell on Windows (`defaultCommandDisplayShell("win32")`). The text feeds
`ExecutionPreviewService` (harness and script-step previews, around lines 989 and 1337) and the
PowerShell toggle in `DryRunModal.tsx` (around line 940). `dev/implemented/DRY_RUN_PREVIEW_PLAN.md`
says this text is meant to be pasted into the chosen shell.

## Steps to Reproduce

1. `renderCommandForDisplay("node", ["-e", "console.log('hi')"], "powershell")` returns
   `'node' '-e' 'console.log(''hi'')'`.
2. Running that in pwsh gives `ParserError: Unexpected token ''-e'' in expression or statement.`
3. `& 'node' '-e' 'console.log(''hi'')'` prints `hi`.

## Root Cause

`renderCommandForDisplay` (around lines 86-102) maps `escapePowerShellArgument` over
`[executable, ...args]` and joins the results without PowerShell's call operator `&`. The existing
test (`src/test/unit/ExecutionPreviewService.test.ts` around line 772) only checks substrings.

## Suggested Fix

In the PowerShell dialect, prefix the joined command with `& `. Leave the
`requiresShellVerbatimArgs` path alone: it is a cmd.exe payload. Add tests that the PowerShell
rendering starts with `& '<exe>'`, and that the POSIX and cmd renderings are unchanged. Update
any fixtures that pin the old output, including UI tests for `DryRunModal`.
