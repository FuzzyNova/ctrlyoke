# Unreadable or invalid global ~/.gemini/config/hooks.json is silently replaced, deleting every other hook group

**Resolution:** fixed in this commit

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/antigravity/AntigravityCliProvider.ts`
- **Severity:** medium

## Symptom

If `~/.gemini/config/hooks.json` cannot be read or parsed when an Antigravity workflow starts, ctrlyoke rewrites the file so it contains only `{"ctrlyoke-<hash>": {...}}`. Two things are lost:

- every hook group the user configured for agy
- the hook groups of other ctrlyoke workflows running at the same time. Those workflows stop receiving Stop/SessionStart notifications and hang waiting for completion.

Nothing is logged and no error appears.

## Steps to Reproduce

1. Put a valid user hook group and a second group in `~/.gemini/config/hooks.json`. Then make the file invalid as strict JSON, for example with a trailing comma or a `//` comment. On Windows you can instead hold an exclusive lock on the file so `fs.readFile` fails with `EBUSY`/`EPERM`.
2. Start a ctrlyoke workflow on the `antigravity-cli` harness with notification hooks enabled (`planNotificationHookArgs`) or with user hooks (`planHeadlessUserHookArgs`).
3. The mutation's `apply()` runs `writeGlobalHooksConfig()`. `readHooksFile()` swallows the error and returns `{}`.
4. Open `~/.gemini/config/hooks.json`. It now holds only the single `ctrlyoke-<hash>` group. The user's groups and any other workflow's group are permanently gone.

## Root Cause

`readHooksFile()` (`AntigravityCliProvider.ts:954-966`) catches every error from `fs.readFile` and `JSON.parse` in the bare `catch {}` at line 962 and returns `{}`. It also returns `{}` when the parsed value is not a plain object.

`writeGlobalHooksConfig()` (lines 936-952) treats that `{}` as the true current state. It adds this workflow's group (line 949) and calls `writeHooksFile()` (line 950). `writeHooksFile()` (lines 968-974) then overwrites the whole machine-global file with `fs.writeFile`.

This code cannot tell "file absent", which is safe to create, from "file present but unreadable or invalid", which is not safe to overwrite. `SettingsJsonMcpTracker.readProjectConfig` (`src/core/harness/shared/SettingsJsonMcpTracker.ts:687-705`) does make that distinction: it returns `{}` only on `ENOENT` and throws `Cannot safely update ...` for anything else.

## Suggested Fix

- Change `readHooksFile()` to return `{}` only when the error code is `ENOENT`. For any other read error, a JSON parse failure, or a non-object top-level value, throw `Cannot safely update ${hooksPath}: ...` to match `readProjectConfig`. The workflow start then fails loudly instead of destroying data.
- Ideally, move that ENOENT-only reader into a shared helper and use it in both places.
- In `cleanupWorkspaceArtifacts`, which calls `readHooksFile()` at line 654, catch and log the error so teardown is never blocked.
- Optionally, write to a temp file and then rename it, so a crash mid-write cannot truncate `hooks.json`.
- Add a test that seeds an invalid `hooks.json` and asserts the file is left untouched and the error is surfaced.
