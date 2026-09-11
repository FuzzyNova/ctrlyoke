# Script Interpreter Resolution Follow-ups

> **Status:** Complete — both follow-up items are landed.
>
> **Priority:** P3 — neither item blocks a release. The memoization item is a
> real (small) extension-host stall; the shebang item is a portability gap that
> only affects an uncommon script shape.
>
> **Related:** `dev/implemented/MULTILINE_SCRIPTS_AND_TYPES_PLAN.md` — this
> plan carries the two items that plan deliberately deferred (its B.5) or
> surfaced but did not cover. Extension dispatch itself, `.ps1` cross-platform
> support, `.mjs`/`.cjs`, and the unsupported-extension error all landed there
> and are not revisited here.

---

## 1. Interpreter probes run a synchronous subprocess on every dispatch ✅ Completed

**Completed:** Python and PowerShell executable resolution is memoized per
resolved platform value, with regression coverage for repeated dispatches and
cross-platform cache isolation.

`EndConditionEvaluator.getScriptCommand()` resolves two interpreters by
shelling out, and neither result is cached:

- `resolvePythonExecutable()` — off Windows, runs
  `execSync("python3 --version", { timeout: 5000 })` per `.py` dispatch.
- `resolvePowerShellExecutable()` — on Windows, runs
  `execSync("pwsh -Version", { timeout: 5000 })` per `.ps1` dispatch.

`getScriptCommand` is called once per condition evaluation, so a script step or
end condition that retries N times pays N synchronous probes on the extension
host. Each has a 5-second timeout, so a machine where the probe is slow (or
where `pwsh` resolution hits a stalled PATH entry) stalls the host repeatedly
rather than once.

The fix is the pattern already established one module over:
`PtyProcessManager.resolveWindowsShell()`/`resolveUnixShell()` memoize into
module-level `_windowsShell`/`_unixShell` and log the resolution once. Mirror
that for both interpreter probes.

Two constraints worth stating, because they are why this is not a one-liner:

- `resolvePowerShellExecutable` is `protected`, but no subclass in
  `src/test/endConditionEvaluator.test.ts` actually overrides it — the
  `getScriptCommand - File Dispatch` suite instead fakes `process.platform`
  directly (`setPlatform()`) and lets the real method run against that faked
  value, alternating `"win32"`/`"linux"` across sibling `test()` cases in the
  same process. A naive single-slot module-level cache would leak a value
  resolved under one faked platform into a later test that fakes the other.
  Cache per resolved platform value (not a single slot), or expose a reset
  used in `teardown`.
- `resolveTypeScriptCommand()` performs up to two `require.resolve` calls per
  dispatch. Those are cheap and filesystem-cached by Node, but they are keyed
  on `path.dirname(scriptPath)`, so a naive single-slot cache would be wrong
  across scripts in different directories. Either key the cache by that
  directory or leave this one uncached; do not fold it into the same slot as
  the other two.

## 2. Shebang dispatch for extensionless scripts (deferred B.5) ✅ Completed

**Completed, with one correction found in review:** the first implementation
used `resolveShellKind()`'s return value directly as the spawned executable.
`resolveShellKind()` is a UI-icon discriminant, not an executable resolver —
it collapses `dash`/`ksh` into a generic `"sh"` kind and `nu` into
`"nushell"` (not nu's real binary name), and it doesn't know about the
`pwsh`/`powershell.exe` probe-and-fallback item 1 added. The landed version:
uses `resolveShellKind()` only to detect a PowerShell shebang and route it
through `resolvePowerShellExecutable()`; otherwise runs the literal
interpreter name the shebang gave on POSIX (preserving `dash`/`ksh`/`nu`
identity) and falls back to `"bash"` on Windows, mirroring the `.sh`
extension dispatch immediately above it in the same file.

**What it is.** A Unix script's first line may be `#!/usr/bin/env python3` (or
`#!/bin/bash`, `#!/usr/bin/env node`). On Unix the _kernel_ reads that line and
launches the named interpreter, so an executable file with no extension runs
correctly with no help from us. Windows has no equivalent — nothing reads the
shebang — so the same file is portable in exactly one direction.

**Current behavior after the dispatch rework.** An extensionless file is not in
`SCRIPT_FILE_INTERPRETERS`, so it falls to `isDirectlyExecutable()`: on POSIX
that checks the `+x` mode bit and executes it directly (correct — the kernel
handles the shebang); on Windows it checks against
`DIRECT_EXECUTABLE_EXTENSIONS` (`.exe`/`.com`), fails, and returns `null`, which
`evaluateCondition` reports as "Unsupported script type". That is an honest
error rather than the old silent attempt to execute a data file, so the gap is
now _reported_ rather than _mysterious_ — which is why it was safe to defer.

**The work.** When a file has no mapped extension and is not host-executable,
read its first line; if it starts with `#!`, parse the interpreter and dispatch
on it instead of returning `null`. Notes:

- Parse both `#!/bin/bash` and the `#!/usr/bin/env python3` form (take the
  argument after `env`, not `env` itself). Ignore anything past the first
  argument rather than trying to reproduce full shebang argv semantics.
- Map the parsed interpreter name through the same vocabulary the rest of the
  dispatcher uses rather than spawning the literal POSIX path — `/bin/bash` is
  meaningless on Windows, and the point of the feature is Windows portability.
  Reuse `resolveShellKind()` where the interpreter is a shell.
- Read only the first line, and only for the no-extension/not-executable case
  the code already reaches — do not add a filesystem read to the hot path for
  files whose extension already answered the question.
- An unparseable or unmappable shebang keeps today's "Unsupported script type"
  error. This feature adds a resolution path; it never adds a new failure mode.

## Tests

- [x] Interpreter probes: the underlying `execSync` runs once across repeated
      `getScriptCommand` calls.
- [x] Interpreter probes: faking `process.platform` between cases still
      yields that platform's answer (no stale cross-platform cache).
- [x] Shebang: table-driven over `#!/bin/sh`, `#!/bin/bash`,
      `#!/usr/bin/env python3`, `#!/usr/bin/env node`, a shebang with extra
      arguments, a file with no shebang, and an unreadable file — asserted on both
      platforms.
- [x] Regression: a mapped extension (`.py`, `.ps1`, `.sh`) never reads the file,
      so extension dispatch stays a pure path-string decision.

## Acceptance Criteria

- Python and PowerShell interpreter probes run at most once per process per
  platform, and `resolvePowerShellExecutable` keeps resolving correctly when
  the dispatch test suite fakes `process.platform` between cases.
- An extensionless script with a recognized shebang runs on Windows.
- A file with no mapped extension, no `+x` bit, and no parseable shebang still
  produces "Unsupported script type".

## Non-goals

- Broadening `DIRECT_EXECUTABLE_EXTENSIONS` to the full Windows `PATHEXT` set.
  `.exe`/`.com` covers what a _script_ step realistically points at, and
  `.bat`/`.cmd`/`.ps1` are already handled by extension dispatch.
- Honoring shebang arguments beyond the first (`#!/usr/bin/env -S node --flag`).
- Applying shebang detection to inline script text. This is file dispatch only;
  which shell runs inline text is settled by
  `dev/implemented/SCRIPT_STEP_SHELL_OVERRIDE_PLAN.md`.
