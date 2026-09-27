# cmd.exe argument escaping doubles only one backslash of a run before `"` or at the end

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/types/CommandDisplayFormatter.ts` (`escapeCmdArgument`), used by `src/core/harness/shared/WindowsCmdEscaping.ts` (`buildCmdExeVerbatimArgs`)
- **Severity:** medium

## Symptom

When ctrlyoke launches a harness through a `.cmd`/`.bat` shim with cmd.exe verbatim
arguments, any argument with **two or more** backslashes before a `"`, or at the end of
the argument, reaches the child process corrupted. The escaped closing quote swallows the
next argument. Reproduced through a real `cmd.exe /d /s /c` with
`windowsVerbatimArguments: true` and a shim that prints its argv:

| Input args | argv received | Expected |
| --- | --- | --- |
| `a\"b`, `next` (1 backslash + quote) | `a\"b`, `next` | same (OK) |
| `a\\"b`, `next` (2 backslashes + quote) | `a\\b next` (merged, quote lost) | `a\\"b`, `next` |
| `C:\foo\`, `next` (1 trailing) | `C:\foo\`, `next` | same (OK) |
| `C:\foo\\`, `next` (2 trailing) | `C:\foo\" next` (merged) | `C:\foo\\`, `next` |

The regexes on their own: for `a` + 2 backslashes + `"b`, the current code emits 4
backslashes before `"`, where 5 are needed (2×2 + 1 escape). For `C:\foo` + 2
backslashes, it emits 3 trailing backslashes, where 4 are needed.

## Steps to Reproduce

1. On Windows, have a harness resolved through the `cmd-file` launcher fallback
   (`CliLauncherResolver.resolveCliCommand`).
2. Run a step whose prompt or `additionalArgs` contains `\\"` or ends with `\\`, e.g. a
   Windows path with a trailing separator.
3. The harness receives merged or altered arguments. The Dry Run "Command Prompt"
   preview (`renderCommandForDisplay`) shows the same wrong escaping.

## Root Cause

`escapeCmdArgument` uses:

```ts
arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
```

`\\+?` is lazy, and a lookahead never backtracks to lengthen its capture, so `$1` is at
most one backslash. The match then starts at the last backslash of the run, and only
that one is doubled. The comments above the lines say "double up **all** the
backslashes", as does the qntm.org/cmd algorithm the file header cites.
`src/test/unit/WindowsCmdEscaping.test.ts` has no case with 2+ backslashes before a quote
or at the end. This is not the documented KNOWN LIMITATION in `WindowsCmdEscaping.ts`
(caret-escaped `<`/`>` next to a quote).

## Suggested Fix

Double the whole run without a ReDoS-prone pattern, e.g. `/(\\*)"/g` → `'$1$1\\"'` and
`/(\\*)$/` → `'$1$1'`. These are linear because the run is anchored by the following
`"`/end. Alternatively, use a small explicit loop that counts backslashes. Add tests for
`a\\"b`, `a\\\"b`, `C:\foo\\`, `C:\foo\\\` and a lone `\\`. Where the existing
real-`cmd.exe` round-trip style tests run (Windows only), assert that argv survives
intact, next to the existing escaping tests.
