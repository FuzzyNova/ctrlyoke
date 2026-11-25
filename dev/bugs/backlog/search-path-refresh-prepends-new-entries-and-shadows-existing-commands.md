# PATH refresh prepends new directories and can change which existing command resolves

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, code review of 1a02f8d4f)
- **Area:** `src/utils/SearchPathRefresh.ts`
- **Severity:** low

## Symptom

After a harness detection retry, commands that already resolved before can resolve to a
different binary for the rest of the extension host's life. For example, `node` (used to
start the MCP server and by every `#!/usr/bin/env node` harness CLI), `git`, `python` or a
harness CLI that is already installed can switch to a copy in a directory the user added to
their shell profile after VS Code launched. That change is silent and lasts until VS Code
restarts.

## Steps to Reproduce

1. Launch VS Code with `node` on PATH at `/usr/local/bin/node` (v22).
2. Without restarting VS Code, install a version manager (fnm, volta, nvm) that adds
   `~/.local/share/fnm/...` (containing `node` v18) to the front of PATH in `~/.zshrc`.
3. Click **Retry** in the harness dropdown.
4. `refreshProcessSearchPath()` puts the new directory ahead of the existing PATH, so the
   next MCP server start and every node-shebang CLI spawn now use v18.

## Root Cause

`refreshProcessSearchPath()` (`src/utils/SearchPathRefresh.ts`, near the end) writes
`env[pathKey] = [...added, ...currentPath]`, i.e. it **prepends** the new entries. The
module header claims the opposite guarantee: "Entries already present keep their order,
so nothing that resolved before resolves differently now." Keeping relative order is not
enough. A prepended directory takes precedence over every existing entry for any command
name it also contains.

Prepending buys nothing for the feature's purpose either. The refresh exists for a CLI
that failed with ENOENT, which means no existing entry contains it, so it resolves just as
well from the end of PATH.

## Suggested Fix

Append the new entries (`[...currentPath, ...added]`) so every command that resolved
before keeps resolving to the same file, and a newly installed CLI is still found. Update
the test `prepends a directory created after launch so a newly installed CLI resolves` in
`src/test/unit/SearchPathRefresh.test.ts` to assert appending, and add a case where a
fresh entry contains a command name already resolvable from the current PATH. Update the
`refreshProcessSearchPath` doc comment ("Prepend PATH directories…") to match.
