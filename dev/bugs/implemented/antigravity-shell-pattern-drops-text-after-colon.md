# Antigravity drops everything after the first `:` in a shell permission pattern

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, reading `7d0b7dba3`/`ba289a8d6`)
- **Area:** `src/core/harness/antigravity/AntigravityToolPermissionMapper.ts` (`commandWords`, `convertToAntigravityRules`)
- **Resolution:** fixed in this commit

## Symptom

A workflow `allowedTools`/`deniedTools` shell pattern whose arguments contain a colon anywhere
other than a trailing `:*` is silently truncated at the first colon for Antigravity, with no
lossy diagnostic:

| Pattern (list)                        | Antigravity rule produced         | Effect                                                            |
| ------------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `shell(npm run test:unit)` (allow)    | `command(regex:npm\s+run\s+test)` | allows `npm run test` (never listed), refuses `npm run test:unit` |
| `shell(npm run test:unit)` (deny)     | deny regex on `npm\s+run\s+test`  | also blocks plain `npm run test`                                  |
| `shell(git checkout:-b *)` (allow)    | `command(regex:git\s+checkout)`   | allows bare `git checkout`, refuses `git checkout -b feat`        |
| `shell(C:\tools\deploy.exe:*)` (deny) | deny regex on just `C`            | blocks `cd C:\repo`, `dir c:` — nearly any drive-path command     |

`docs/workflows/permissions.md` says only `:*` _at the end_ is the prefix marker and
`shell(npm test)` means exactly that command. Claude and Copilot pass the arguments through
verbatim, and the Qwen and OpenCode mappers keep the text after the colon; only Antigravity
discards it.

## Steps to Reproduce

1. `npm run compile:extension`
2. In node: `new (require("./out/core/harness/antigravity/AntigravityToolPermissionMapper.js").AntigravityToolPermissionMapper)().convertToAntigravityRules(["shell(npm run test:unit)"], "allow")`
3. Output: `{"rules":["command(regex:npm\\s+run\\s+test)"],"lossy":[]}`

## Root Cause

`commandWords()` takes `inner.slice(0, inner.indexOf(":"))` as the command, and the allow
branch of `convertToAntigravityRules()` checks only whether the text after that first colon is
`*`. Any other text after the colon is thrown away.

## Suggested Fix

Treat only a trailing `:*` (e.g. `/^(.*?)\s*:\s*\*\s*$/`) as the prefix marker. Otherwise use
the whole of `inner` as the command words (escaped), so `test:unit` and `C:\tools\deploy.exe`
survive intact. Add unit cases to the Antigravity mapper tests for each row above.
