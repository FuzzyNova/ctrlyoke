# Script verdict Expected/Actual lines ignore the rule that actually ran

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli/CliTerminalFormatter.ts` (`renderScriptVerdict`), `src/ui/webview-react/components/output/ScriptVerdict.tsx` (`getExpectedLabel`, expanded rows), `src/ui/webview-react/utils/outputFind.ts` (`SCRIPT_VERDICT` search segments), `src/core/HarnessIntegration.ts` (`buildScriptVerdictXml`)
- **Severity:** low

## Symptom

The verdict for a script step (or a pre/end-condition) prints a **Compare:** line
built by `formatComparison`, which correctly states the rule that ran. The
**Expected:** and **Actual:** lines don't follow that rule. They contradict it in
two cases:

1. **Valueless operators (`isEmpty` / `isNotEmpty`).** These operators take no
   `expected`, yet **Expected:** reads `exit code 0 (no `expected` set)`.
   That's wrong: the check is on stdout or stderr emptiness, and the exit code
   plays no part.

   ```
   │ ✖ Failed — Script step failed (stdout is empty, got "x") → continue
   │   Expected: exit code 0 (no `expected` set)
   │   Actual: x
   ```

2. **Exit-code fallback (a `compareSource`/`operator` with no `expected`).**
   The comparison falls back to "exit code == 0", and **Compare:** says so.
   But **Actual:** still shows the configured stream (stdout) instead of the
   exit code that was compared:

   ```
   │ ✔ Passed — Script step passed (exit code == 0) → continue
   │   Compare: exit code == 0
   │   Expected: exit code 0 (no `expected` set)
   │   Actual: hello
   ```

The dashboard's expanded verdict row (`ScriptVerdict.tsx`, Expected/Actual
lines) and find-in-output (`outputFind.ts`) show the same values. The collapsed
row already special-cases valueless operators (`collapsedExpected`). The
`<verdict/>` element sent to later prompts (`buildScriptVerdictXml`) is already
correct for both cases. It is the only consumer that resolves the effective
rule.

## Steps to Reproduce

1. Save this as `c.ctrlyoke.yaml`:

   ```yaml
   name: c
   steps:
     - type: script
       script: echo x
       compareSource: stdout
       operator: isEmpty
       onFail: continue
     - type: script
       script: echo hello
       compareSource: stdout
       operator: contains
   ```

2. `ctrlyoke run c.ctrlyoke.yaml`
3. Step 1's **Expected:** names an exit-code rule. Step 2's **Actual:** shows
   `hello` under a `Compare: exit code == 0` line.

## Root Cause

`ScriptVerdict` stores the authored `compareSource`/`operator`/`expected` and
the configured stream's `actual` (`ScriptExecutionReporter.ts` around line 186).
The display layers render `verdict.expected ?? DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT`
and `verdict.actual` without the valueless/fallback resolution that
`formatComparison` (`src/utils/ScriptComparison.ts`) and `buildScriptVerdictXml`
(`src/core/HarnessIntegration.ts` around lines 182–213) each apply. The rule is
duplicated in those two places and missing from the other three.

## Suggested Fix

Add one shared helper to `src/utils/ScriptComparison.ts`, for example
`resolveVerdictDisplay(verdict)`. It returns the effective
`{ compareSource, operator, expected, actual }`:

- For a valueless operator, `expected` is undefined (or a "none" label) and
  `actual` is the configured stream.
- For the exit-code fallback, the source is `exitCode`, the operator is the
  default, `expected` is `"0"`, and `actual` is `String(verdict.exitCode ?? "")`.
- Otherwise it returns the authored values.

Use that helper in `buildScriptVerdictXml`, `CliTerminalFormatter.renderScriptVerdict`,
`ScriptVerdict.tsx` (Expected/Actual lines and the collapsed summary) and the
`outputFind.ts` segments. For valueless operators, either omit the Expected line
or render a clear label such as `— (isEmpty takes no value)`. Keep
`DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT` only for the true fallback case.
