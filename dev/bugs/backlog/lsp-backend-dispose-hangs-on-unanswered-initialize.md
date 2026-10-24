# Language server backend dispose waits without limit for an in-flight initialize before stopping any server

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/lsp/ManagedLanguageServerBackend.ts`
- **Severity:** low

## Symptom

If a managed language server is alive but never answers `initialize`, the backend's
`dispose()` never finishes. Causes include a misconfigured command that is not an LSP
server, a server stuck downloading or prompting on stderr, or a heavy server such as
jdtls indexing a big project. While dispose waits, the backend shuts down none of its
servers: not the stuck child, and not any of the other running servers. They keep
running after the hosted server is disposed (for example when `ctrlyoke.enableServer`
is toggled off, or when the hosted server is restarted), and are left behind until the
extension host itself exits. The stuck server also stays in "starting" forever, because
`initialize` has no timeout.

## Steps to Reproduce

1. Configure a language server whose command is a process that reads stdin and never
   replies. For example, a `node -e "process.stdin.resume()"` entry in the language
   server settings.
2. Open a file of that language in the hosted workspace viewer so the server starts.
3. Start a second, working language server by opening a file it handles.
4. Disable the hosted server, which disposes `LanguageIntelligenceHost`.
5. Both child processes keep running, and the backend's `dispose()` promise never
   settles.

## Root Cause

- `src/server/lsp/ManagedLanguageServerBackend.ts:549-551`: `dispose()` sets `disposed`
  and then `await Promise.allSettled([...this.starting.values()])` before the loop that
  sends shutdown and exit and kills running servers (lines 555-576).
- `starting` entries (lines 406-408) settle only when the start finishes. The start
  awaits `connection.sendRequest(LSP_METHODS.INITIALIZE, ...)` (lines 984-996) with no
  `withTimeout`. Only `SHUTDOWN` is bounded (`withTimeout(..., 1_000)`, lines 561 and
  1168).
- `src/server/CtrlYokeHostedServer.ts:3435` disposes the intelligence host
  fire-and-forget, so the hang causes no visible error. It only leaks the processes.

## Suggested Fix

- In `dispose()`, do not wait for pending starts before stopping servers. Servers are
  added to `this.servers` before `initialize` (around line 940), so stop everything in
  `this.servers` straight away (shutdown with its 1 s bound, then exit, then kill). The
  pending starts will then reject as their connections close. Await
  `Promise.allSettled(starting)` only after that, if at all.
- Give `initialize` its own timeout, generous enough for slow servers (for example
  60 s), or one that resets while the server is producing progress or log output.
  Report "failed to initialize" instead of leaving the server in "starting" forever.
