# Claude subagent log-parser tests fail on Windows and write into the real ~/.claude

- **Found:** 2026-10-23 by a Claude Code session running `npm test` after the Qwen background-work fix
- **Area:** `src/test/suite/harness/LogParsers.test.ts`
- **Severity:** medium

## Symptom

Two `ClaudeLogParser` tests added in 9ca86eb6e (`feat(claude): follow interactive subagents`)
fail on every Windows `npm test` run, so the extension suite is red whatever else changed:

- `follows interactive foreground transcripts once and keeps parent context`
- `follows interactive background-shaped transcripts without run_in_background input`

Both fail in setup, before reaching the parser:

```
Error: ENOENT: no such file or directory, mkdir 'C:\Users\<user>\.claude\projects\C:-Users-<user>-AppData-Local-Temp-claude-subagent-K20MPY\claude-…\subagents'
```

They also create, and then `rmSync`, directories inside the developer's real
`~/.claude/projects`. On macOS and Linux the setup succeeds, so the tests pass there while they
still write into the real home directory.

## Steps to Reproduce

1. On Windows, run `MOCHA_GREP="follows interactive" npm run test:extension`.
2. Both tests fail with the `ENOENT` above.

## Root Cause

Each test builds the Claude project directory name itself instead of using the parser's rule
(LogParsers.test.ts:305, and again in the second test at line 487):

```ts
const normalizedWorkspace = workspace.replace(/[\\/.]/g, "-");
```

That leaves the drive-letter colon in place (`C:-Users-…`), and a colon is invalid in a Windows
directory name. `ClaudeLogParser.normalizeWorkspacePath` (ClaudeLogParser.ts:1848) first replaces
`^([A-Z]):[\\/]` with `$1--` (`C:\dev\ctrlyoke` → `C--dev-ctrlyoke`), so even on a filesystem
that accepted the name, the test would write to a different directory from the one the parser
polls.

The directory is rooted at `os.homedir()` (lines 308 and 492, cleanup at 478 and 553) with
`HOME`/`USERPROFILE` not redirected. This breaks the `<stateIsolation>` rule in
`.github/instructions/test.instructions.md`.

## Suggested Fix

- Point `HOME` and `USERPROFILE` at a `makeTempDir` home for the test and restore them in
  `teardown`, as `src/test/unit/QwenLogParser.test.ts` ("discovers a resumed session…") does, so
  nothing touches the real `~/.claude`.
- Derive the project directory name from the parser's own rule, not a copy: expose
  `normalizeWorkspacePath` as a shared exported helper (like `sanitizeQwenProjectPath` in
  `QwenLogParser.ts`) and call it from both the parser and the tests, so the drive-letter case is
  covered by construction.
