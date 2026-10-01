# Settings `set()` pollutes Object.prototype via `__proto__`, and concurrent backends share a temp file

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/config/FileConfigBackend.ts` (`setNestedValue`, `save`)
- **Resolution:** fixed in this commit

## Symptom

1. **Prototype pollution.** `configService.set("__proto__.polluted", "yes", "user")`
   makes `({}).polluted === "yes"` across the whole extension host, and nothing
   is written to disk. It is reachable from any webview or hosted-dashboard
   client through `UPDATE_GLOBAL_SETTING`, or `UPDATE_CONFIG` with key
   `ctrlyoke.__proto__.x`; neither handler validates the path. The impact is low,
   because those clients already hold the access token, but polluting the
   prototype can change behaviour anywhere (e.g. options objects that read
   missing keys).
2. **Lost writes.** `save()` always writes `${configPath}.tmp`, and the write
   queue is per backend instance. When the workspace root is the home directory
   (CLI run from `~`, or VS Code opened on `~`), the user and workspace
   backends are the same `~/.ctrlyoke/settings.json`. Reproduced:
   `Promise.allSettled([set("ui.showCliCommand", false, "user"), set("execution.injectMode", false, "workspace")])`
   both resolve, but the file holds only `execution.injectMode`. Two processes
   (two windows, or the extension plus the CLI) race on the same `.tmp` name too.
   The trust stores had the same bug, fixed in `trust-decision-file-concurrent-writes-share-tmp`.

## Steps to Reproduce

See the calls above. Both reproduced with a scratch script bundling the real
`CtrlYokeConfigService` and `FileConfigBackend`.

## Root Cause

`setNestedValue` walks arbitrary path segments with `obj[key]`, including
`__proto__`, `constructor` and `prototype`. `save()` uses a fixed temp name and
there's no cross-backend serialization for the same path.

## Suggested Fix

- Reject the path segments `__proto__`, `constructor` and `prototype` in
  `set()` (throw a clear error).
- Use a unique temp name (pid plus random suffix, as `TrustDecisionFile.ts`
  does). When the workspace settings path resolves to the user settings path,
  don't create a separate workspace backend (or share one backend per path) so
  writes serialize through one queue.
- Tests for both.
