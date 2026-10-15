# LSP WebSockets are never closed on server dispose, so open browser editors stay attached to a dead proxy and never reconnect

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/server/CtrlYokeHostedServer.ts`
- **Severity:** low

## Symptom

If the hosted server is stopped or restarted inside a running VS Code window, every workspace-viewer editor tab with a `/ws/lsp` socket keeps that socket OPEN against the disposed server instance. On the server side, every message is dropped because the proxy is disposed. The browser transport never gets a close event, so it doesn't reconnect and doesn't show that the session ended. Completions, hover, diagnostics and rename stop working in that tab with no error until the page is reloaded. The old socket and its closures also leak in the extension host until the browser closes the socket.

## Steps to Reproduce

1. Enable the hosted server (`ctrlyoke.enableServer`) and open the hosted dashboard in a browser.
2. In the workspace viewer, open a source file whose language server is configured and approved. Check that completions or hover work, which means a `/ws/lsp` WebSocket is connected (visible in devtools under Network > WS).
3. Restart the hosted server from VS Code. For example, run the disable-server command and then the enable-server command, or change a server setting that triggers a restart. That path calls `hostedServer.dispose()` (`src/extension.ts:1765` / `:1829`).
4. In devtools, the `/ws` socket closes and reconnects, but the `/ws/lsp` socket stays OPEN and receives no close frame.
5. Type in the editor and request completions or hover. Nothing comes back, and diagnostics stop updating. The tab doesn't recover until the page is reloaded.

## Root Cause

`CtrlYokeHostedServer.dispose()` (`src/server/CtrlYokeHostedServer.ts:3279-3301`) closes only the tracked dashboard sockets (`this.connections`, lines 3296-3297). For LSP it only calls `this.lspWss.close()` (line 3299). In ws 8.22.0, that call does not terminate existing clients. `httpServer.close()` (line 3300) only stops new connections and leaves upgraded sockets alive.

Nothing tracks the LSP sockets created in the `lspWss` connection handler (lines 491-591), and they are not part of the heartbeat loop. The only server-side code that closes them is the `invalidateClient` callback (lines 559-563). That callback runs only from `LspSessionProxy.invalidateSession()` (`src/server/lsp/LspSessionProxy.ts:75-81`). `LanguageIntelligenceHost.dispose()` (`src/server/lsp/LanguageIntelligenceHost.ts:356-377`) calls `proxy.dispose()` instead (line 365). That marks the proxy disposed without notifying the client, and later messages are silently dropped (`LspSessionProxy.ts:84`).

The browser `LanguageIntelligenceTransport` (`src/ui/webview-react/utils/languageIntelligenceTransport.ts:90-99`) reconnects or ends the session only from `onclose`, so it stays attached to the dead socket.

## Suggested Fix

- Close LSP sockets on dispose. Either iterate `this.lspWss.clients` (`clientTracking` defaults to on, even with `noServer`) or keep a `Set<WebSocket>` that the `lspWss` connection handler fills. Before `this.lspWss.close()`, close each socket with `LSP_SESSION_INVALIDATION_CLOSE.CODE`/`.REASON`, or with 1001 "going away" if the client should reconnect to the restarted server.
- Make `LanguageIntelligenceHost.dispose()` call `proxy.invalidateSession()` instead of `proxy.dispose()`, either as an alternative or as well. Each proxy's invalidation callback then closes its socket with the invalidation code, and the browser runs its session-ended path.
- Add a hosted-server test that opens a `/ws/lsp` socket, disposes the server, and asserts that the client receives a close event.
