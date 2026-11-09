# CLI trust prompts print workspace-supplied control characters raw

- **Found:** 2026-11-09 by bug-hunt final step (pass 26), claude-cli
- **Area:** `src/config/WorkspaceSensitiveSettings.ts`, `src/cli/WorkspaceSettingsTrustCommands.ts`, `src/cli/CliTrustGate.ts`
- **Resolution:** fixed in this commit

## Symptom

The CLI's trust prompts write values that come from the workspace (and so from
whoever authored the repository) to the terminal byte for byte. A value that
contains ANSI escape sequences, a carriage return or other C0/C1 control
characters can rewrite what the user sees, so they approve a program different
from the one shown.

Reproduced against `out/cli.js` on the current branch:

```json
{"terminal":{"shellExecutable":"/tmp/evil.sh\u001b[2K\r/bin/zsh"},
 "defaults":{"hooks":[{"event":"Stop","command":"node","env":{"X":"1\u001b[8m"}}]}}
```

`ctrlyoke trust-workspace-settings` (piped through `cat -v`) prints:

```
  - terminal.shellExecutable: /tmp/evil.sh^[[2K^M/bin/zsh
    /tmp/evil.sh^[[2K^M/bin/zsh
  - defaults.hooks: command: node
    { ... env: X=1^[[8m, ... }
```

In a real terminal, `ESC[2K` erases the line and `\r` returns to column 0, so
the user sees `terminal.shellExecutable: /bin/zsh` and is asked to allow it. If
they approve, `/tmp/evil.sh` becomes the shell for every embedded terminal.
`ESC[8m` (conceal) hides everything printed after it, including later fields
of the same entry. The same applies to the interactive `Allow …? [y/N]`
question and to `ctrlyoke run`'s gate (`ensureCliTrustDecided`), which lists
the pending values before asking.

The full-value detail added in ~58d6c26 shows more of each value, which makes
this matter more, but the summary line had the same problem before.

## Steps to Reproduce

1. In a scratch directory, write the `.ctrlyoke/settings.json` above.
2. Run `node <repo>/out/cli.js trust-workspace-settings` in a terminal (or
   `</dev/null 2>&1 | cat -v` to see the bytes).
3. The `shellExecutable` line shows only `/bin/zsh`.

## Root Cause

- `summarizeValue` in `src/config/WorkspaceSensitiveSettings.ts` returns string
  values unchanged. Objects go through `stableStringify`, which JSON-escapes
  control characters, so only string leaves are affected. The `summarize`
  callbacks such as `summarizeProgramValue` reach the same path through
  `value.command`.
- `formatSensitiveValue` (same file) returns strings unchanged and renders
  `env` values with `String(envValue)`, so the `detail` text is raw too.
- `src/cli/WorkspaceSettingsTrustCommands.ts` and `ensureCliTrustDecided` in
  `src/cli/CliTrustGate.ts` write `summary`/`detail`/`items` straight to
  stdout/stderr. `ctrlyoke run`'s external-roots gate (`src/cli.ts`,
  `items: pendingRoots`) goes through the same function with folder paths taken
  from the workflow file.

The dashboard's `BatchApprovalModal` renders the same text through React, which
can't inject terminal escapes. Bidirectional overrides (U+202E and friends) and
zero-width characters still reorder or hide text there and in the terminal.

## Suggested Fix

Add one shared helper, e.g. `escapeUntrustedDisplayText(text)` in `src/utils/`.
It replaces C0 controls except `\n` (and `\t` if you want to keep it), DEL, C1
controls (U+0080–U+009F), bidi controls (U+202A–U+202E, U+2066–U+2069,
U+200E/U+200F, U+061C) and zero-width characters (U+200B–U+200D, U+2060,
U+FEFF) with a visible escape such as `\u001b`. Apply it:

- when `WorkspaceSensitiveSettings` builds `summary` and `detail`, so every
  surface (CLI, VS Code modal, hosted dashboard) shows the same escaped text.
  Escape `\n` inside string values in `summary`, since a summary is one line
  by contract.
- to each item in `ensureCliTrustDecided`, so the external-roots gate and any
  future gate are covered too.

Don't change `fingerprint`: it must keep hashing the real value, so existing
decisions stay valid. Add tests with an ESC/CR/U+202E value for
`WorkspaceSensitiveSettings` (summary and detail escaped, fingerprint
unchanged) and for `ensureCliTrustDecided`.
