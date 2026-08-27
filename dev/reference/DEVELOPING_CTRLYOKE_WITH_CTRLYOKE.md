# Developing ctrlyoke With ctrlyoke

How to use ctrlyoke to build ctrlyoke without the dev loop killing the very
workflows/tools you're using to build it, and without a debug Extension
Development Host silently corrupting a real, long-running instance pointed at
the same repo. See `dev/implemented/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md`
for the coordination behavior that now makes this safe.

## The core problem this doc solves

Developing directly inside the Extension Development Host (`F5`) means every
code change requires: stop all running workflows → close the Extension Host
window → rebuild → relaunch. Long-running workflows and Playwright-driven
steps can't survive that, because Playwright's own driving process is running
_inside_ the very extension host that's about to be killed.

The fix is to split the two roles:

- **A daily-driver, production-installed ctrlyoke** — runs your actual
  long-lived workflows against the ctrlyoke repo, survives forever, is what
  Playwright automation targets.
- **The Extension Development Host** — used only to build and smoke-test the
  _next_ change. It's expected to restart constantly; nothing important
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
normally (Extensions view → `...` → _Install from VSIX..._, or
`code --install-extension path/to/ctrlyoke-x.y.z.vsix`) into your everyday VS
Code. That installed copy — not any `F5` config — is your daily driver.

## Recommended day-to-day flow

1. Keep a production-installed ctrlyoke in your normal VS Code window, open
   on the `ctrlyoke` repo itself. Run your actual dev-loop workflows there
   (including any that use Playwright to validate a _previous_ change) — this
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

`Log.initialize()` (`src/utils/Log.ts:63-117`) branches on `IS_DEV_MODE`:

- **Dev builds always force `LogLevel.TRACE`** and unconditionally open a log
  file (`Log.ts:77-80`) — this is why the debug host "just works" for
  diagnostics today.
- **Production builds read the ctrlyoke output channel's own log level**
  (`Log.fromVSCodeLogLevel(this.outputChannel.logLevel)`, `Log.ts:87`,
  live-updated via `this.outputChannel.onDidChangeLogLevel`, `Log.ts:88-92`)
  — deliberately *not* `vscode.env.logLevel`, which only reflects VS Code's
  global default and would silently ignore a ctrlyoke-specific override.
  File writes are separately gated by `ctrlyoke.enableDiagnosticLogs`
  (`Log.ts:95-113`; schema at `schemas/settings-schema.json:916-919`).

To get dev-parity trace file logging out of the production install, set
**both**:

1. Command Palette → **"Developer: Set Log Level..."** → pick the ctrlyoke
   extension specifically (not the global default) → **Trace**.

   **This does not reliably persist across restarts on current VS Code
   Stable (confirmed Aug 2026).** There's an open upstream race condition
   where a `LogOutputChannel`'s `logLevel` can reset to `Info` at startup
   before the persisted per-extension override is reapplied
   ([microsoft/vscode#232862](https://github.com/microsoft/vscode/issues/232862),
   fixed by #284488 but not yet in Stable) — in practice this can mean the
   Trace choice doesn't stick at all, forcing you to re-pick it every
   session. **This is not a ctrlyoke bug**: `Log.ts` already reads the
   correct per-extension-aware value (see above); the state that isn't
   surviving belongs to VS Code itself, and there is no `.vscode/settings.json`
   (or any settings.json) equivalent to set instead — this preference isn't
   a regular configuration key at all.

   **Reliable, restart-proof alternative**: Command Palette →
   **"Preferences: Configure Runtime Arguments"** (opens your user-level
   `argv.json`) and add:
   ```jsonc
   {
     "log-level": "fuzzynova.ctrlyoke:trace"
   }
   ```
   VS Code re-applies this as `--log fuzzynova.ctrlyoke:trace` on every
   launch — its own CLI syntax for a per-extension level,
   `${publisher}.${name}:${logLevel}` — so it's immune to the session-state
   bug above. Requires a full VS Code restart to take effect, like any
   `argv.json` change, but from then on it's a genuine one-time setup step.
2. `"ctrlyoke.enableDiagnosticLogs": true` — put this in your **user**
   settings (`~/.ctrlyoke/settings.json` via ctrlyoke's own settings UI, or
   wherever you keep user-scope ctrlyoke settings) so it applies globally
   rather than only to this one workspace.

With both set, the production install writes the same
`.ctrlyoke/logs/ctrlyoke-<timestamp>.log` / `ctrlyoke-<harness>-hook-debug.log`
files at TRACE level that the dev host writes unconditionally — see the
`<debugging>` section of `.github/copilot-instructions.md` for what's in
each.

## The workspace-collision hazard, and today's coordination

Running a production instance and a debug Extension Development Host against
the **same** folder at the same time is now coordinated. Phase 1 fixed the
startup scan that could force-stop a live workflow owned by a sibling VS Code
instance; Phase 2 keeps that sibling-owned workflow read-only and watches its
state. Phase 3 also prevents two hosted servers from bridging the same
workspace. The full implementation is tracked in
`dev/implemented/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md`.

You can keep using `ctrlyoke-test.code-workspace`; moving to a sibling test
repo is not required for safety. `CTRLYOKE_HOME` remains an optional way to
separate user-scoped scratch state, quota snapshots, and trust-store state
when that is useful, but it is no longer required to prevent the old
run-storage collision from killing a sibling workflow.

### Why this happens

By default `storage.runHistoryLocation` is `"user"`
(`src/types/CtrlYokeSettings.ts:391`), so all run state (lock files, run
definitions, timelines) lives under
`<CTRLYOKE_HOME>/projects/<slug>-<hash-of-workspace-path>/.runs/` — a
location keyed by **workspace path**, not by which process opened it. Two
processes that open the identical folder therefore still see the same run
history and `runner.json` files. That shared storage is intentional and can
make two dashboards show the same activity, but the coordination changes
now preserve a live sibling lock and expose the run as read-only/watch-only
instead of treating it as stale local state.

### Optional isolation: give the debug host its own `CTRLYOKE_HOME`

`ctrlyokeStateHome()` (`src/utils/ProjectStatePaths.ts:19-20`) reads the
`CTRLYOKE_HOME` environment variable as an override for the entire state root
that run storage, secrets, and quota cache live under. Point the debug
Extension Development Host at a different one than your production install's
default (`~/.ctrlyoke`) if you want separate user-scoped scratch state. This
keeps each instance's run-history files, secrets, quota cache, and trust-store
state in separate trees, but it is a convenience choice now rather than a
safety workaround: shared live workflow ownership is handled by the
coordination layer.

Add an `env` block to the debug configs in `.vscode/launch.json`, for
example:

```jsonc
{
  "name": "Run Extension (Debug)",
  "type": "extensionHost",
  "request": "launch",
  "env": {
    "CTRLYOKE_HOME": "${workspaceFolder}/.ctrlyoke-dev-home",
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
  moves back inside `.ctrlyoke/.runs/`, which `CTRLYOKE_HOME` cannot split.
  The two instances still share that workspace history, and the same live-lock
  coordination applies; the override simply cannot isolate this particular
  storage location.
- **The debug host's harness-quota cache
  (`<CTRLYOKE_HOME>/usage/provider-snapshots.json`,
  `HarnessUsageService.providerSnapshotsPath()`) is a real, practical downside
  of this split, not just a theoretical one.** It starts out empty in
  `.ctrlyoke-dev-home/` — a Claude/Antigravity harness card will show "no data
  yet" (see the `UsageCard.tsx` sidecar-pending state) even though your
  production install's `~/.ctrlyoke/usage/provider-snapshots.json` already has
  fresh quota for the same account, because the debug host never reads that
  file. This is a side effect of the _same_ generic `CTRLYOKE_HOME` override
  used for run-storage safety above — it isn't given special-case treatment to
  read from the real home, because `HarnessUsageService`'s own tests rely on
  `CTRLYOKE_HOME` to sandbox `provider-snapshots.json` reads/writes into a temp
  dir (`src/test/unit/HarnessUsageService.test.ts`'s `setup()`), so quota
  cache can't bypass it without breaking that isolation. Unlike run storage,
  though, nothing about quota cache actually needs per-instance isolation for
  _correctness_ — `HarnessUsageService.persistProviderSnapshots()` already
  writes it under `withFileLock()` with newest-`fetchedAt`-wins merge
  (`selectNewestQuota`) specifically so concurrent writers are safe. There is
  no longer a safety reason to accept that empty cache: Phase 1 and Phase 2
  handle live run ownership without splitting run storage. The simplest
  default is therefore to omit `CTRLYOKE_HOME`, so the debug host shares the
  production install's quota view and trust-store decisions. Keep the
  override only when deliberately isolated user-scoped state is more important
  than that shared convenience.

Note in particular that `server.port`/`server.enabled` fall in the "same
file, same value" bucket above — `CTRLYOKE_HOME` does not give the two
instances different server config. See the next section for what that means
in practice.

### Hosted server, and why Playwright automation still works cleanly

With `server.enabled: true`, both instances read the identical
`server.port` (default `3000`) and attempt to auto-start a hosted server on
activation (`src/extension.ts:1294-1297`). The first instance to bind wins.
When the other receives `EADDRINUSE`, `CtrlYokeHostedServer.listen()` probes
the occupied port with the configured token and workspace identity. If it is
a sibling ctrlyoke server, the second instance surfaces a warning naming the
existing URL — and then **still falls back to an OS-assigned port and starts
its own server**, exactly as it would for an unrelated process squatting on
the port. Both hosted servers stay up, each bridging its own process's
`WorkflowOrchestrator` to whichever browser clients connect to it; this is
safe for the same reason two VS Code windows on one workspace are safe (see
`dev/implemented/MULTI_INSTANCE_WORKSPACE_COORDINATION_PLAN.md`'s Phase
1–2) — each process independently arbitrates the shared lock files, and the
dashboard's externally-managed read-only banner renders the same way in
either instance's browser dashboard as it would in a VS Code webview.

**Only `IS_DEV_MODE` builds mirror a URL (including its token) to
`.ctrlyoke/dev/server-url.txt`.** Whichever instance actually bound a
listening server — production or debug host — writes _its own_ URL there.
In the normal daily-driver + `F5` debug-host flow this means the debug
host's fallback port ends up in the file, so a headless agent or Playwright
reading it lands on the debug build under test, not on the production
daily driver. Attach the Playwright MCP server to your agent session as
usual; no port-splitting configuration is needed.

## Launching and closing the dev host from a CLI agent (no `F5`, no UI restart)

An agent (e.g. Claude Code) working headlessly has no `F5`/Stop button.
`scripts/dev-host.mjs` wraps the full recipe below — `npm run dev:host:start`,
`npm run dev:host:stop`, `npm run dev:host:restart` (stop, compile, start).
It runs on win32/darwin/linux; the process-discovery and graceful-close
mechanism differ per OS (PowerShell CIM queries + `taskkill` on Windows,
`ps` parsing + `SIGTERM` elsewhere) — see the closing section below for which
half of that is empirically confirmed versus the standard cross-platform
idiom. The rest of this section explains _why_ it's built the way it is
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
driver's IPC socket and asks _it_ to open the new window — the `code` process
returns immediately, and the new window is just another renderer inside the
daily driver's existing `Code.exe` process tree. There is no independent PID
to manage: every renderer/utility/gpu process for every open window shares one
top-level `Code.exe`, and that process also owns every window's actual OS
window handle. You cannot safely `taskkill` any single window out of it
(confirmed empirically — the renderer PIDs don't own a closable top-level
window at all, and the top process is shared with windows you must not
touch).

**The fix: give the dev host its own `--user-data-dir`.** This is independent
of the optional `CTRLYOKE_HOME` override above — `CTRLYOKE_HOME` isolates
ctrlyoke's _own_ user-scoped state, while `--user-data-dir` isolates _VS
Code's_ singleton-instance lock. Only the latter is required for an
independent, safely closable VS Code process:

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

**Closing it**: find the top-level PID (the one _without_ a `--type=` flag in
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
which restarts the extension host _from inside itself_ and can hang if the
extension host's event loop is already unhealthy — the OS-level close/relaunch
here doesn't depend on the thing being torn down staying responsive.

One caveat: `.ctrlyoke/dev/server-url.txt` lives in the shared workspace
folder, not under `CTRLYOKE_HOME`, so it isn't per-instance — and now that a
sibling detection no longer stops an instance from binding its own server,
both the production daily driver and the debug host may be writing to that
same file. Whichever one (re)starts most recently overwrites it with its own
URL, which is exactly what you want after a `dev-host.mjs restart` — the
freshly-restarted debug build's URL wins. The flip side: each instance's
`dispose()` clears the file unconditionally when it stops, even if a sibling
server is still running, so a `dev-host.mjs stop` (with no immediate restart)
removes the file even though the production daily driver's server is still up
and reachable on its own port. Treat the file as a discovery hint for
whichever server most recently started, not a durable pointer to "any server
that's currently running"; reconciling that gap is intentionally out of
scope.

## Summary checklist

- [ ] Daily driver: `npm run package`, install the `.vsix`, keep it open on
      the repo in your normal VS Code window.
- [ ] Set ctrlyoke's log level to **Trace** via `argv.json`'s `log-level` key
      (`"fuzzynova.ctrlyoke:trace"`) rather than "Developer: Set Log
      Level..." — the latter doesn't reliably survive restarts on current
      VS Code Stable; see "Getting TRACE-level logs" above.
- [ ] Set `"ctrlyoke.enableDiagnosticLogs": true` in **user**-scope settings.
- [ ] Optionally add `"env": { "CTRLYOKE_HOME": "<some local, gitignored path>" }`
      to the `extensionHost` launch configs when separate user-scoped state is
      useful; it is not required for workspace safety.
- [ ] Keep using `ctrlyoke-test.code-workspace` as-is — no need to move to a
      sibling test repo.
- [ ] Treat the Extension Development Host as disposable: build, smoke-test,
      close, repeat. Don't run anything in it you'd be upset to lose to a
      restart.
