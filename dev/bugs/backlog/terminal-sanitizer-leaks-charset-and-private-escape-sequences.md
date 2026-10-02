# Terminal sanitizer leaks `(B`, `7`, `8`, `=` and `c` from common escape sequences

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with the CLI
- **Area:** `src/utils/TerminalOutputSanitizer.ts` (`ANSI_ESCAPE_SEQUENCE_PATTERN`, `isIncompleteEscape`)
- **Severity:** medium

## Symptom

Script output that contains standard non-CSI escape sequences keeps printable
fragments of them after sanitizing:

| Input                         | Emitted by                                 | Sanitized result |
| ----------------------------- | ------------------------------------------ | ---------------- |
| `ESC ( B` (designate G0 ASCII) | `tput sgr0` on xterm terminfo (`\e(B\e[m`) | `(B`             |
| `ESC 7` / `ESC 8` (DECSC/RC)  | progress bars, `tput sc`/`tput rc`         | `7` / `8`        |
| `ESC =` / `ESC >` (keypad)    | `tput smkx`/`rmkx`, curses programs        | `=` / `>`        |
| `ESC c` (RIS, full reset)     | `reset`, some `clear` implementations      | `c`              |

The leftovers show in every surface that sanitizes: the dashboard's Bash/script
rows and output find (`BashOutput.tsx`, `outputRows.ts`, `outputFind.ts`), the
streamed script output (`ScriptExecutionReporter.ts`), script output injected
into prompts (`HarnessIntegration.ts`), and the **script condition comparison**
(`EndConditionEvaluator.ts:376`). In that last case it changes the verdict: a
script that colours its output with `tput` fails an `eq` check that should pass.

## Steps to Reproduce

1. Create `tput.ctrlyoke.yaml`:

   ```yaml
   name: tput
   steps:
     - name: colored ok
       type: script
       script: node -e "process.stdout.write('\x1b[32mOK\x1b(B\x1b[m\n')"
       compareSource: stdout
       operator: eq
       expected: OK
       onFail: stopWorkflow
   ```

2. `ctrlyoke run tput.ctrlyoke.yaml --headless`
3. Output: `✖ Failed — Script step failed (stdout == OK, got "OK(B")`.
   Expected: the step passes with `Actual: OK`.

Directly: `sanitizeTerminalOutput('\x1b[1mbold\x1b(B\x1b[m done')` returns
`"bold(B done"`, and `sanitizeTerminalOutput('a\x1b7b\x1b8c \x1b=x')` returns
`"a7b8c =x"`.

## Root Cause

`ANSI_ESCAPE_SEQUENCE_PATTERN` only recognizes CSI (`ESC [`), OSC (`ESC ]`) and
the 2-byte Fe escapes `ESC [@-Z\\-_]` (0x40–0x5F). ECMA-48 / ECMA-35 also define:

- **nF** escapes: `ESC`, then one or more intermediate bytes 0x20–0x2F, then a
  final byte 0x30–0x7E (`ESC ( B`, `ESC ) 0`, `ESC # 8`, `ESC % G`).
- **Fp** private escapes: `ESC` plus a byte 0x30–0x3F (`ESC 7`, `ESC 8`, `ESC =`, `ESC >`).
- **Fs** escapes: `ESC` plus a byte 0x60–0x7E (`ESC c`).

None of these match, so `CRLF_CR_OR_CONTROL_PATTERN` later removes only the
bare `ESC` byte and leaves the rest as text. `isIncompleteEscape` has the same
gap for streaming: a chunk ending in `ESC (` is not held back, so the sequence
splits across chunks even after the pattern is fixed.

## Suggested Fix

Make the non-CSI/OSC alternative cover every escape form ECMA-48 defines:
`\x1B[ -/]*[0-~]`, meaning optional intermediates followed by any final byte
0x30–0x7E. This includes the existing `[@-Z\\-_]` range. Keep CSI and OSC as
the earlier alternatives so `ESC [` and `ESC ]` still match their longer forms.
Update `isIncompleteEscape` to hold back a suffix of `ESC` followed only by
intermediate bytes (`/^\x1B[ -\/]+$/`). Add tests to the existing
`TerminalOutputSanitizer` tests for each row of the table above, including a
streaming case where `ESC (` ends one chunk and `B` starts the next. Also add an
end-condition/script-step test showing that `eq` passes on `tput`-style output.
