# Disabling the hosted server while it is still starting leaves an orphaned server listening with the old token

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/extension.ts`
- **Resolution:** fixed in this commit

## Symptom

This is a security issue. If "Disable Server" runs while "Enable Server" is still waiting on the remote-access entitlement check, the dashboard shows the server as stopped, and the enable command throws `Cannot read properties of undefined (reading 'getAvailableIps')`. The Express HTTP server still binds the configured port, possibly on `0.0.0.0`, and keeps serving token-authenticated HTTP requests until the extension host exits. Nothing references it any more, so disable and deactivate cannot close it. A later enable reports a "sibling server" and falls back to a different port.

## Steps to Reproduce

1. In `.ctrlyoke/settings.json`, set `server.bindAddress` to `0.0.0.0` on a machine where remote access is licensed. The credential-store read in `canUseRemoteAccess` must take noticeable time. This is easier to hit under load, or in a test with a stubbed delay.
2. Run `ctrlyoke: Enable Server`.
3. Before startup finishes (while `listen()` is still awaiting `enforceRemoteBindBeforeListen`), run `ctrlyoke: Disable Server` from the command palette or the dashboard.
4. Observe: the UI shows "Hosted dashboard server stopped." and `SERVER_STOPPED` is posted. The enable command then rejects with a TypeError at `extension.ts:1781`.
5. Run `netstat`, or `curl http://<lan-ip>:<port>/?token=<token>`. The port is still listening and answers HTTP requests. Running Disable Server again does nothing, and Enable Server reports a sibling server and starts on a fallback port.

## Root Cause

`src/extension.ts:1730` assigns the new server to the module-level `hostedServer` before startup completes. `src/extension.ts:1763` then awaits `hostedServer.listen()`. It keeps no local reference to the instance, and there is no in-progress or cancellation token.

`listen()` (`src/server/CtrlYokeHostedServer.ts:2997-3001`) awaits `enforceRemoteBindBeforeListen()` (3061-3079). For non-loopback binds, that call reads the OS credential store and can take seconds. While it waits, `disableServer` (`src/extension.ts:1829-1830`) can call `dispose()` and clear the variable.

`dispose()` (`CtrlYokeHostedServer.ts:3279-3301`) calls `httpServer.close()`, which does nothing on a server that is not listening yet. It also sets no disposed flag for `listen()` to check. So `listen()` carries on to `this.httpServer.listen(port, this.bindAddress)` (line 3055) and binds the port.

Back in `enableServer`, `src/extension.ts:1781-1784` dereference the now-undefined `hostedServer`. The resulting TypeError is not inside any try block, and the bound socket is left orphaned with the token it was created with.

## Suggested Fix

Make the server lifecycle safe to cancel at both layers.

1. **`CtrlYokeHostedServer`:** add a `private disposed = false` flag and set it in `dispose()`. In `listen()`, after `await this.enforceRemoteBindBeforeListen()`, return `undefined` (or reject) if the server has been disposed. In `onListening`, if the server was disposed in the meantime, call `this.httpServer.close()` and resolve `undefined`. That way a server disposed during startup can never stay bound.
2. **`extension.ts` `enableServer`:** hold the instance in a local `const server` and use it for every call after the await. Once `listen()` resolves, check `hostedServer === server`. If it is not (the server was disabled or replaced), dispose `server` and return without posting `SERVER_STARTED`. Another option is to track a `serverStarting` promise so that disable waits for startup or cancels it.

Add a test that stubs `canUseRemoteAccess` with a delayed promise, calls `dispose()` during the delay, and asserts that the HTTP server never ends up listening.

## Decision

Disposal during the entitlement wait makes `listen()` resolve `undefined`; if disposal races with the actual bind, the listening callback closes the socket before reporting startup. The extension checks that it still owns the same server before publishing the started state.
