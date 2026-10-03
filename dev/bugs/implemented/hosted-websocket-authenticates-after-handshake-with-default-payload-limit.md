# Hosted WebSocket authenticates after the handshake and accepts 100 MiB frames from unauthenticated clients

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`new WebSocketServer` ~line 311, `setupWebSocket` ~line 2170)
- **Resolution:** fixed in this commit

## Symptom

Any client that can reach the hosted server port can open `/ws` without a
token. The handshake completes, and only then does the server call
`ws.close(4401, "Unauthorized")`. Until the close handshake times out (about
30 s), the `ws` library keeps reading frames and fully buffers each message
up to its default `maxPayload` of 100 MiB.

A reproduction with ws 8.21.3 and this connect-then-close pattern showed:

- the server received a 94,371,840-byte message after sending the 4401 close;
- the server received three 90 MiB messages from Node 22's built-in WHATWG
  `WebSocket` client, which sends no token and no Origin, and RSS rose to
  430-530 MB.

Running several such connections in parallel can drive the extension host to
an out-of-memory crash. The clients that can do this:

- any local process;
- any LAN device when the server is bound to `0.0.0.0`;
- possibly a web page, since the upgrade has no Origin check.

## Steps to Reproduce

1. Enable the hosted server.
2. Connect `new WebSocket("ws://127.0.0.1:4747/ws")` with no token.
3. In `onopen`, send a 90 MiB binary frame. The server allocates it.

## Root Cause

`new WebSocketServer({ server: this.httpServer, path: "/ws" })` has no
`verifyClient` (or `noServer` + `handleUpgrade`) gate and no `maxPayload`. The
token is compared inside the `connection` handler, which runs after the
upgrade.

## Suggested Fix

- Check the token with `timingSafeStringEqual` during the HTTP upgrade,
  through `verifyClient` or a `noServer` server plus an `upgrade` listener
  that calls `handleUpgrade` only after the check passes. A rejected upgrade
  answers `401` and never becomes a socket.
- Keep the in-`connection` check as defense in depth, or drop it if it would
  be duplicate code.
- Set an explicit `maxPayload` constant, sized from the largest legitimate
  client-to-server message. Audit the webview message types that carry file
  content or pasted images, so a normal message is not rejected.

`src/server/standalone-shim.js` does not special-case close code 4401: it
reconnects on any close, so a refused upgrade (close 1006) behaves the same
for the browser client. Add `CtrlYokeHostedServer` tests for both a
token-less upgrade being refused and an oversized frame being rejected.
