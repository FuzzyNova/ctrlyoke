# Developing ctrlyoke With ctrlyoke

How to use ctrlyoke to build ctrlyoke without the dev loop killing the very
workflows/tools you're using to build it, and without a debug Extension
Development Host silently corrupting a real, long-running instance pointed at
the same repo. See `dev/backlog/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md`
for the underlying bug this doc works around and the plan to fix it properly.

## The core problem this doc solves

Developing directly inside the Extension Development Host (`F5`) means every
code change requires: stop all running workflows → close the Extension Host
window → rebuild → relaunch. Long-running workflows and Playwright-driven
steps can't survive that, because Playwright's own driving process is running
*inside* the very extension host that's about to be killed.

The fix is to split the two roles:

- **A daily-driver, production-installed ctrlyoke** — runs your actual
  long-lived workflows against the ctrlyoke repo, survives forever, is what
  Playwright automation targets.
- **The Extension Development Host** — used only to build and smoke-test the
  *next* change. It's expected to restart constantly; nothing important
  should be running inside it.

## Fact check: none of the `launch.json` configs give you a real production build

This matters because it changes what "install a production build" has to
mean. `.vscode/launch.json`'s four `extensionHost` configs all use
`preLaunchTask: "npm: compile"` or `"npm: compile:react-debug"` or
`"npm: compile:prod"` — and **every one of those ultimately runs
`compile:extension`, which is `tsc --noEmit && node esbuild.js` with no
`--production` flag** (`package.json:596`). `esbuild.js` only sets
`IS_DEV_MODE=false` when `--production` is passed
(`esbuild.js:5,12`: `production ? "false" : "true"`). Even the config
literally named **"Run Extension (Production)"** only swaps in a production
**webview** build (`compile:prod` = `compile:extension` + `build:webview`,
`package.json:653`) — the extension host code itself is still compiled with
`IS_DEV_MODE=true` no matter which launch config you pick.

**The only path to `IS_DEV_MODE=false` is `npm run package`**
(`vsce package && node scripts/strip-dev-commands.mjs --restore`,
`package.json:621`), which drives `build:extension` → `esbuild.js
--production` (`package.json:619`). That produces a real `.vsix`; install it
normally (Extensions view → `...` → *Install from VSIX...*, or
`code --install-extension path/to/ctrlyoke-x.y.z.vsix`) into your everyday VS
Code. That installed copy — not any `F5` config — is your daily driver.

## Recommended day-to-day flow

1. Keep a production-installed ctrlyoke in your normal VS Code window, open
   on the `ctrlyoke` repo itself. Run your actual dev-loop workflows there
   (including any that use Playwright to validate a *previous* change) — this
   window never needs to restart just because you're editing code.
2. When you're ready to test a change, `F5` into an Extension Development
   Host as before. Use it to smoke-test the change interactively or run a
   short workflow against it. Its restarts are now free — nothing depended on
   it staying alive.
3. Re-`npm run package` + reinstall the VSIX periodically (or whenever you
   want the daily driver to pick up accumulated changes) to roll the fix
   forward into the long-lived instance.

This is the shape the user already proposed; the rest of this doc fills in
the two things that made it feel unsafe: getting trace logs out of a
production install, and stopping the two instances from stepping on each
other over the same `.ctrlyoke` state.

## Getting TRACE-level logs out of a production install

`Log.initialize()` (`src/utils/Log.ts:49-94`) branches on `IS_DEV_MODE`:

- **Dev builds always force `LogLevel.TRACE`** and unconditionally open a log
  file (`Log.ts:58-61`) — this is why the debug host "just works" for
  diagnostics today.
- **Production builds read VS Code's own log level**
  (`Log.fromVSCodeLogLevel(vscode.env.logLevel)`, `Log.ts:63-64`, live-updated
  via `vscode.env.onDidChangeLogLevel`), and only write a log **file** when
  `ctrlyoke.enableDiagnosticLogs` is `true` (`Log.ts:71-90`; schema at
  `schemas/settings-schema.json:916-919`).

To get dev-parity trace file logging out of the production install, set
**both**:

1. Command Palette → **"Developer: Set Log Level..."** → pick the ctrlyoke
   extension specifically (not the global default) → **Trace**. VS Code
   persists this per-extension choice across restarts, so it's a one-time
   setup step, not a per-session toggle.
2. `"ctrlyoke.enableDiagnosticLogs": true` — put this in your **user**
   settings (`~/.ctrlyoke/settings.json` via ctrlyoke's own settings UI, or
   wherever you keep user-scope ctrlyoke settings) so it applies globally
   rather than only to this one workspace.

With both set, the production install writes the same
`.ctrlyoke/logs/ctrlyoke-<timestamp>.log` / `ctrlyoke-<harness>-hook-debug.log`
files at TRACE level that the dev host writes unconditionally — see the
`<debugging>` section of `.github/copilot-instructions.md` for what's in
each.

## The workspace-collision hazard, and today's mitigation

Running a production instance and a debug Extension Development Host against
the **same** folder at the same time is not yet fully safe: a live workflow
running in one can be force-stopped by the other's own startup routine. The
full mechanism and fix are tracked in
`dev/backlog/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md` — this section is
the practical workaround available today, without waiting on that fix, and it
directly answers "do I need to migrate off `ctrlyoke-test.code-workspace` to
a sibling test repo?" — **no, you don't**, as long as you apply this
mitigation.

### Why this happens

By default `storage.runHistoryLocation` is `"user"`
(`src/types/CtrlYokeSettings.ts:391`), so all run state (lock files, run
definitions, timelines) lives under
`<CTRLYOKE_HOME>/projects/<slug>-<hash-of-workspace-path>/.runs/` — a
location keyed by **workspace path**, not by which process opened it. Two
processes that open the identical folder — production instance and debug
host alike — resolve to the identical run-storage directory and therefore
the identical `runner.json` lock files. On activation, each instance scans
every lineage's lock and force-normalizes anything it doesn't recognize as
`active-cli` to `STOPPED` — including a sibling instance's genuinely live,
actively-heartbeating run (see the backlog plan for the exact code path).
This isn't specific to the debug host; it would happen with *any* two
windows on the same folder.

### The mitigation: give the debug host its own `CTRLYOKE_HOME`

`ctrlyokeStateHome()` (`src/utils/ProjectStatePaths.ts:19-20`) reads the
`CTRLYOKE_HOME` environment variable as an override for the entire state root
that run storage, secrets, and quota cache live under. Point the debug
Extension Development Host at a different one than your production install's
default (`~/.ctrlyoke`), and its run storage — including `runner.json` — lands
in a completely separate directory tree that the production instance's
startup scan never even reads, so the collision can't happen.

Add an `env` block to the debug configs in `.vscode/launch.json`, for
example:

```jsonc
{
  "name": "Run Extension (Debug)",
  "type": "extensionHost",
  "request": "launch",
  "env": {
    "CTRLYOKE_HOME": "${workspaceFolder}/.ctrlyoke-dev-home"
  },
  // ...unchanged...
}
```

(Add the same `env` block to whichever of the four `extensionHost` configs
you actually use day-to-day; `.ctrlyoke-dev-home` should be gitignored like
the rest of your local scratch state.)

### What this does and doesn't isolate

`CTRLYOKE_HOME` only redirects **user-scoped state** (run history when
`runHistoryLocation` is `"user"`, secrets, quota cache) — and even then,
only via `ctrlyokeStateHome()`. It does **not** touch settings resolution at
all, in either scope:

- **User settings are hardcoded to the real home directory, not
  `CTRLYOKE_HOME`.** `createUserConfigBackend()` reads
  `os.homedir()/.ctrlyoke/settings.json` literally
  (`src/config/FileConfigBackend.ts:119-121`) — it does not go through
  `ctrlyokeStateHome()`, so both instances see identical user-scope settings
  no matter what `CTRLYOKE_HOME` is set to.
- **Workspace settings are the same file on disk for both processes** —
  `.ctrlyoke/settings.json` inside the literal folder both windows opened —
  so they're identical for the same reason `CTRLYOKE_HOME` can't split them:
  it isn't in the path at all (`FileConfigBackend.ts:125-129`).

- `.ctrlyoke/logs/*.log` — both instances write their own
  timestamped files here; they don't collide, just interleave as separate
  files.
- `.ctrlyoke/temp/`, workflow source files (`.ctrlyoke/prompts/`, `*.ctrlyoke.yaml`,
  etc.) — shared and fine to share.
- External-root / secret-grant trust prompts — each instance evaluates its
  own trust-store decisions independently (the trust stores themselves are
  user-scoped and would already be split by `CTRLYOKE_HOME`, so you may see
  the prompt twice — once per instance — the first time).
- **If you ever set `storage.runHistoryLocation: "workspace"`**, run storage
  moves back inside `.ctrlyoke/.runs/`, which `CTRLYOKE_HOME` cannot split —
  don't use that setting in a workspace you're deliberately double-opening
  until the backlog plan is implemented.
- **The debug host's harness-quota cache
  (`<CTRLYOKE_HOME>/usage/provider-snapshots.json`,
  `HarnessUsageService.providerSnapshotsPath()`) is a real, practical downside
  of this split, not just a theoretical one.** It starts out empty in
  `.ctrlyoke-dev-home/` — a Claude/Antigravity harness card will show "no data
  yet" (see the `UsageCard.tsx` sidecar-pending state) even though your
  production install's `~/.ctrlyoke/usage/provider-snapshots.json` already has
  fresh quota for the same account, because the debug host never reads that
  file. This is a side effect of the *same* generic `CTRLYOKE_HOME` override
  used for run-storage safety above — it isn't given special-case treatment to
  read from the real home, because `HarnessUsageService`'s own tests rely on
  `CTRLYOKE_HOME` to sandbox `provider-snapshots.json` reads/writes into a temp
  dir (`src/test/unit/HarnessUsageService.test.ts`'s `setup()`), so quota
  cache can't bypass it without breaking that isolation. Unlike run storage,
  though, nothing about quota cache actually needs per-instance isolation for
  *correctness* — `HarnessUsageService.persistProviderSnapshots()` already
  writes it under `withFileLock()` with newest-`fetchedAt`-wins merge
  (`selectNewestQuota`) specifically so concurrent writers are safe. So once
  Phase 1 of the backlog plan removes the actual reason `CTRLYOKE_HOME` is
  needed (the `runner.json` collision), dropping the override entirely is the
  right move, not just a run-storage nicety — it also reunites the debug
  host's quota view (and secrets-grant trust store) with your production
  install's, with no downside. Until then, live with a quota-empty debug host
  rather than trying to special-case just this one file.

Note in particular that `server.port`/`server.enabled` fall in the "same
file, same value" bucket above — `CTRLYOKE_HOME` does not give the two
instances different server config. See the next section for what that means
in practice.

### Hosted server, and why Playwright automation still works cleanly

With `server.enabled: true`, **both** instances read the identical
`server.port` (default `3000`) and both auto-start a hosted server on
activation (`src/extension.ts:1294-1297`). This is a **race**, not a
deterministic split: whichever process's `enableServer` command runs first —
in practice almost always your already-running production window, since the
debug host takes longer to compile and launch — binds the literal configured
port. The loser hits `EADDRINUSE` and `CtrlYokeHostedServer.listen()`
silently falls back to an OS-assigned port instead
(`src/server/CtrlYokeHostedServer.ts:2036-2067`) — not an error, just two
independent servers on different ports, each bridging only its own process's
workflow state.

This is actually fine for the Playwright use case already documented in
`.github/copilot-instructions.md`'s `<debugging>` section: **only
`IS_DEV_MODE` builds mirror their live server URL (with token) to
`.ctrlyoke/dev/server-url.txt`.** Since your production install is a real
`--production` build, it never touches that file — only the debug host does.
So reading `.ctrlyoke/dev/server-url.txt` always and unambiguously gets you
the debug host's server, which is exactly the one you're testing against.
Attach the Playwright MCP server to your agent session as usual; no extra
config is needed on top of the `CTRLYOKE_HOME` split above.

## Launching and closing the dev host from a CLI agent (no `F5`, no UI restart)

An agent (e.g. Claude Code) working headlessly has no `F5`/Stop button.
`scripts/dev-host.mjs` wraps the full recipe below — `npm run dev:host:start`,
`npm run dev:host:stop`, `npm run dev:host:restart` (stop, compile, start).
It runs on win32/darwin/linux; the process-discovery and graceful-close
mechanism differ per OS (PowerShell CIM queries + `taskkill` on Windows,
`ps` parsing + `SIGTERM` elsewhere) — see the closing section below for which
half of that is empirically confirmed versus the standard cross-platform
idiom. The rest of this section explains *why* it's built the way it is
(mostly written against the Windows path, where it was developed and
verified), for troubleshooting or extending it.

The `.vscode/launch.json` `extensionHost` configs are just `code` CLI
invocations wrapped in JSON, so they can be reproduced directly:

```sh
CTRLYOKE_HOME="$PWD/.ctrlyoke-dev-home" code \
  --extensionDevelopmentPath="$PWD" \
  --disable-extension=fuzzynova.ctrlyoke \
  "$PWD/ctrlyoke-test.code-workspace"
```

`npm run compile` first (matching the config's `preLaunchTask`). Within a few
seconds `.ctrlyoke/dev/server-url.txt` has the live URL+token to hand to
Playwright — see the `<debugging>` section of `.github/copilot-instructions.md`.

**The problem**: as launched above, `code` finds your already-running daily
driver's IPC socket and asks *it* to open the new window — the `code` process
returns immediately, and the new window is just another renderer inside the
daily driver's existing `Code.exe` process tree. There is no independent PID
to manage: every renderer/utility/gpu process for every open window shares one
top-level `Code.exe`, and that process also owns every window's actual OS
window handle. You cannot safely `taskkill` any single window out of it
(confirmed empirically — the renderer PIDs don't own a closable top-level
window at all, and the top process is shared with windows you must not
touch).

**The fix: give the dev host its own `--user-data-dir`.** This is a second,
independent override from `CTRLYOKE_HOME` above — `CTRLYOKE_HOME` isolates
ctrlyoke's *own* state, `--user-data-dir` isolates *VS Code's* singleton-
instance lock — and both are needed together:

```sh
CTRLYOKE_HOME="$PWD/.ctrlyoke-dev-home" code \
  --user-data-dir="$PWD/.vscode-dev-userdata" \
  --extensionDevelopmentPath="$PWD" \
  --disable-extension=fuzzynova.ctrlyoke \
  "$PWD/ctrlyoke-test.code-workspace"
```

This breaks the singleton-IPC handshake, so `code` spawns a genuinely
independent top-level `Code.exe` (parented under the launching shell, not the
daily driver) with its own crashpad-handler, gpu-process, extension-host
utility process, and renderer — confirmed by inspecting `Win32_Process`
command lines after launch. Don't also override `--extensions-dir`; leaving it
at the default (`~/.vscode/extensions`) keeps your normally-installed
extensions available in the dev host, since only the singleton lock — not the
extensions directory — needs separating.

**Closing it**: find the top-level PID (the one *without* a `--type=` flag in
its command line — that's what distinguishes it from its own gpu/utility/
renderer children) by matching on the unique `--user-data-dir` value, then
request a graceful close. On Windows that's `taskkill /PID <pid>` — **do not
add `/F`**. Without it, this is the same graceful close as clicking the
window's X — confirmed by the session log showing a normal
`ctrlyoke: Extension deactivating...` line and `.ctrlyoke/dev/server-url.txt`
being removed by `CtrlYokeHostedServer.dispose()`, not a crash. It takes up to
~10 seconds to fully unwind (extension deactivate, hosted server teardown,
child process exit) — `dev-host.mjs stop` polls for that rather than assuming
it's instant. The daily driver and any other open windows are untouched
throughout, since they live under a different top-level process entirely.

On macOS/Linux the analogous request is `SIGTERM` (`process.kill(pid,
"SIGTERM")`) — the standard cross-platform idiom for "please quit", which
Electron apps generally hook into their normal quit sequence. **This half is
not empirically verified in this repo** (developed and tested on Windows only
so far) — the Windows behavior above was confirmed by reading the actual
session log; the POSIX path is the documented-idiom default. The first time
you run `dev-host.mjs stop` on macOS/Linux, check the newest
`.ctrlyoke/logs/ctrlyoke-*.log` for the same `Extension deactivating...` line
to confirm it's a clean shutdown rather than an abrupt kill, and update this
note with what you find. (This whole close/relaunch dance is what
`scripts/dev-host.mjs`'s `stop`/`start`/`restart` commands automate.)

This is a strictly better restart path for an agent than the dashboard's own
`Rebuild Extension & Restart` (`DeveloperSection.tsx`'s
`DEV_BUILD_EXTENSION_AND_RELOAD` / `workbench.action.restartExtensionHost`),
which restarts the extension host *from inside itself* and can hang if the
extension host's event loop is already unhealthy — the OS-level close/relaunch
here doesn't depend on the thing being torn down staying responsive.

One caveat: `.ctrlyoke/dev/server-url.txt` lives in the shared workspace
folder, not under `CTRLYOKE_HOME`, so it isn't per-instance — if two dev hosts
are ever activated concurrently, whichever finished activating most recently
wins the file and the other's URL is unrecoverable from it. Keep it to one
CLI-launched dev host at a time.

## Summary checklist

- [ ] Daily driver: `npm run package`, install the `.vsix`, keep it open on
      the repo in your normal VS Code window.
- [ ] Set VS Code's per-extension log level for ctrlyoke to **Trace**
      (persists across restarts).
- [ ] Set `"ctrlyoke.enableDiagnosticLogs": true` in **user**-scope settings.
- [ ] Add `"env": { "CTRLYOKE_HOME": "<some local, gitignored path>" }` to the
      `extensionHost` launch configs you use.
- [ ] Keep using `ctrlyoke-test.code-workspace` as-is — no need to move to a
      sibling test repo.
- [ ] Treat the Extension Development Host as disposable: build, smoke-test,
      close, repeat. Don't run anything in it you'd be upset to lose to a
      restart.
