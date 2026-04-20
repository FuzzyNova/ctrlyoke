# FlightPath Hosted Server Security Plan

## Security Priority Order

HTTPS/TLS is **low priority** for most users because:
- WireGuard/Tailscale users already have network-layer encryption — HTTPS adds nothing
- Localhost-only users are never exposed to the network at all
- For direct internet exposure, HTTPS without authentication still leaves the server wide open

The real gap is **authentication**. An unauthenticated server lets anyone who can reach the port read all workflow history, trigger AI execution, enumerate workspace files, and run end-condition scripts (arbitrary code on the host machine).

Priority order:
1. **Token authentication** — closes the access control gap entirely
2. **Configurable bind address** — reduces exposure surface (localhost by default)
3. **WebSocket origin check** — prevents cross-site WebSocket hijacking
4. **HTTPS/TLS** — defer; only needed for direct internet exposure with a real domain

---

## Phase 1 — Token Authentication

### How it works

Use a **persistent token** stored in VS Code's `SecretStorage` (encrypted credential store, per-machine). The token is generated once and reused across VS Code restarts, so phone bookmarks stay valid indefinitely. This is the right model for "start server before leaving, access from phone via WireGuard all day."

```
http://192.168.1.100:4747/?token=a8f3c27d3e1b...
```

- Token generated once with `crypto.randomBytes(32).toString("hex")`, stored in `SecretStorage` under key `"flightpath.server.token"`
- On every subsequent `listen()`, read the stored token (generate and store if missing)
- All HTTP requests without a valid token → `401 Unauthorized`
- WebSocket upgrade requests must include the token in the query string; reject on mismatch
- The `ServerSection` URL display (already has a copy button) shows the full URL including token
- **QR code button** in the running-server row lets users scan the URL onto their phone once → bookmark forever
- **Regenerate token** button in the UI for manual rotation if needed (clears `SecretStorage` entry, new token generated on next listen)

### Why persistent over ephemeral

An ephemeral token (regenerated each `listen()`) forces the user to re-share the URL every time VS Code restarts — requires emailing themselves the new link before leaving the house. A persistent token means the phone bookmark works forever until manually rotated. The primary security layer for remote access is WireGuard; the token is a second factor to prevent any LAN device from accessing the server, not a high-rotation secret.

### Changes

#### `src/extension.ts`

Pass a `SecretStorage` reference into `FlightPathHostedServer` (or read/write the token in extension.ts and pass the resolved token):

```ts
// In enableServer command:
const storedToken = await context.secrets.get("flightpath.server.token");
const token = storedToken ?? randomBytes(32).toString("hex");
if (!storedToken) await context.secrets.store("flightpath.server.token", token);

hostedServer = new FlightPathHostedServer(hub, webviewProvider, port, workspaceRoot, token);
```

Register a `flightpath.regenerateServerToken` command that calls `context.secrets.delete("flightpath.server.token")` and posts `SERVER_TOKEN_REGENERATED` to the webview (so the UI refreshes the displayed URL on next server start). Show an info message telling the user to restart the server.

#### `src/server/FlightPathHostedServer.ts`

Constructor accepts the resolved token:

```ts
constructor(
  private hub: DashboardBroadcastHub,
  private webviewProvider: FlightPathWebviewProvider,
  private port: number,
  private workspaceRoot: string,
  private token: string,
  private bindAddress: string = "127.0.0.1",
  private tlsConfig?: { certPath: string; keyPath: string }
)
```

Add token middleware in `setupRoutes()` (before all other routes):

```ts
this.app.use((req, res, next) => {
  if (req.query["token"] === this.token) return next();
  res.status(401).send("Unauthorized");
});
```

For WebSocket connections in `setupWebSocket()`:

```ts
this.wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://localhost`);
  if (url.searchParams.get("token") !== this.token) {
    ws.close(4401, "Unauthorized");
    return;
  }
  // ... existing connection logic
```

`standalone-shim.js` appends `?token=` to the WebSocket URL on connect:

```js
// In standalone-shim.js, replace bare ws:// connect with:
const token = new URLSearchParams(location.search).get("token") ?? "";
const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
```

#### `src/ui/webview-react/components/settings/ServerSection.tsx`

The running-server row (URL + copy button) gains two new buttons:

**QR code button** — renders the full URL as a QR code in an inline panel beneath the URL row. User scans once with phone → saves as bookmark. Uses the `qrcode` npm package (client-side, ~50KB, renders to `<canvas>`).

```tsx
{serverRunning && serverUrl && (
  <div>
    <div className="flex items-center gap-2 p-2 bg-input-bg border border-input-border rounded">
      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
      <a href={serverUrl} target="_blank" rel="noreferrer"
         className="text-xs text-link truncate flex-1 hover:underline">
        {serverUrl}
      </a>
      <button onClick={() => navigator.clipboard.writeText(serverUrl)}
              title="Copy URL" className="shrink-0 text-description-fg hover:text-foreground">
        <i className="codicon codicon-copy" />
      </button>
      <button onClick={() => setShowQr((v) => !v)}
              title="Show QR code" className="shrink-0 text-description-fg hover:text-foreground">
        <i className="codicon codicon-qr-code" />  {/* or inline SVG */}
      </button>
    </div>

    {showQr && (
      <div className="mt-2 flex flex-col items-center gap-1 p-3 bg-white rounded">
        <canvas ref={qrCanvasRef} />
        <p className="text-xs text-gray-500">Scan to open on your phone</p>
      </div>
    )}
  </div>
)}
```

QR generation in effect:
```ts
useEffect(() => {
  if (showQr && qrCanvasRef.current && serverUrl) {
    import("qrcode").then((QRCode) =>
      QRCode.toCanvas(qrCanvasRef.current, serverUrl, { width: 200 })
    );
  }
}, [showQr, serverUrl]);
```

**Regenerate token button** — shown below the URL row (not inline, since it's destructive):

```tsx
<button
  onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.REGENERATE_SERVER_TOKEN })}
  className="text-xs text-description-fg hover:text-foreground underline"
>
  Regenerate token
</button>
```

After regeneration, the server must be restarted for the new token to take effect. Show a toast or info note to the user.

---

## Phase 2 — Configurable Bind Address

### Settings change

Add `server.bindAddress` to `FlightPathSettings`:

```ts
server: {
  enabled: boolean;
  port: number;
  standalonePort: number;
  theme: "auto" | "light" | "dark";
  bindAddress: string;        // new — default "127.0.0.1"
  tls: { ... };
};
```

Default: `"127.0.0.1"` (localhost only).

Users who want LAN/VPN access set it to `"0.0.0.0"`.

### `FlightPathHostedServer.ts`

Constructor accepts `bindAddress`:

```ts
constructor(
  private hub: DashboardBroadcastHub,
  private webviewProvider: FlightPathWebviewProvider,
  private port: number,
  private workspaceRoot: string,
  private bindAddress: string = "127.0.0.1",
  private tlsConfig?: { certPath: string; keyPath: string }
)
```

`listen()`:

```ts
this.httpServer.listen(this.port, this.bindAddress);
```

### `ServerSection.tsx`

Add a `bindAddress` field below the port fields:

```tsx
<div>
  <label htmlFor="server-bind" className="block text-xs text-description-fg mb-1">
    Bind address
  </label>
  <select
    id="server-bind"
    value={server.bindAddress ?? "127.0.0.1"}
    onChange={(e) => onUpdate("server.bindAddress", e.target.value, s)}
    className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground"
  >
    <option value="127.0.0.1">Localhost only (127.0.0.1)</option>
    <option value="0.0.0.0">All interfaces (0.0.0.0) — LAN / VPN access</option>
  </select>
</div>
```

---

## Phase 3 — WebSocket Origin Check

In `setupWebSocket()`, reject connections whose `Origin` header doesn't match the server's own host. This prevents a malicious webpage from opening a WebSocket to a locally-bound server.

```ts
this.wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "";
  if (!this.isAllowedOrigin(origin)) {
    ws.close(4403, "Forbidden");
    return;
  }
  // ...
});

private isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.port === String(this.port)
    );
  } catch {
    return false;
  }
}
```

---

## Phase 4 — HTTPS / TLS (Deferred)

Only implement when a user needs direct internet exposure with a real cert. At that point the token auth above already handles access control — HTTPS just adds encryption for the wire.

### Prerequisite

`FlightPathSettings.server.tls` stub already exists:

```ts
tls?: {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
};
```

Make non-optional, add defaults (`enabled: false, certPath: "", keyPath: ""`).

### `FlightPathHostedServer.ts`

```ts
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";

// In constructor:
if (tlsConfig?.certPath && tlsConfig?.keyPath) {
  let cert: Buffer, key: Buffer;
  try {
    cert = fs.readFileSync(tlsConfig.certPath);
    key = fs.readFileSync(tlsConfig.keyPath);
  } catch (err) {
    throw new Error(
      `FlightPath: Could not read TLS cert/key — cert="${tlsConfig.certPath}" key="${tlsConfig.keyPath}": ${err}`
    );
  }
  this.httpServer = createHttpsServer({ cert, key }, this.app);
  this.isTls = true;
} else {
  this.httpServer = createHttpServer(this.app);
}
```

`listen()` returns `https://` when TLS is active.

No changes to `standalone-shim.js` — it already selects `wss:` when `location.protocol === "https:"`.

CSP `connect-src` already includes both `ws://` and `wss://` for all localhost variants. ✅

### `ServerSection.tsx`

Replace the "reserved for future update" placeholder with:

```tsx
<label className="flex items-center gap-2 cursor-pointer select-none mb-3">
  <input
    type="checkbox"
    checked={server.tls?.enabled ?? false}
    onChange={(e) => onUpdate("server.tls.enabled", e.target.checked, s)}
    className="accent-btn-primary-bg"
  />
  <span className="text-sm text-foreground">Enable HTTPS</span>
</label>

{server.tls?.enabled && (
  <div className="space-y-3">
    <div>
      <label htmlFor="tls-cert-path" className="block text-xs text-description-fg mb-1">
        Certificate file (.pem)
      </label>
      <input
        id="tls-cert-path"
        type="text"
        value={server.tls?.certPath ?? ""}
        placeholder="/path/to/cert.pem"
        onChange={(e) => onUpdate("server.tls.certPath", e.target.value, s)}
        className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono"
      />
    </div>
    <div>
      <label htmlFor="tls-key-path" className="block text-xs text-description-fg mb-1">
        Private key file (.pem)
      </label>
      <input
        id="tls-key-path"
        type="text"
        value={server.tls?.keyPath ?? ""}
        placeholder="/path/to/key.pem"
        onChange={(e) => onUpdate("server.tls.keyPath", e.target.value, s)}
        className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono"
      />
    </div>
    <p className="text-xs text-description-fg italic">
      Generate a self-signed cert: <code>openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 365 -nodes -subj "/CN=localhost"</code>
    </p>
    <p className="text-xs text-description-fg italic">
      Changes take effect the next time the server is restarted.
    </p>
  </div>
)}
```

### Note on Let's Encrypt

Let's Encrypt is **not applicable** for localhost/LAN use — it requires a publicly routable domain and HTTP-01 or DNS-01 challenge. The correct tool for developer localhost certs is **mkcert** (installs a local CA, generates trusted certs, no browser warning). Could be a Phase 5 "one-click" button in the UI.

---

## Summary of Files to Touch

| Phase | File | Change |
|---|---|---|
| 1 | `src/extension.ts` | Read/generate persistent token from `SecretStorage`; pass to constructor; register `regenerateServerToken` command |
| 1 | `src/server/FlightPathHostedServer.ts` | Accept token in constructor, HTTP middleware, WS token check |
| 1 | `src/server/standalone-shim.js` | Forward token from page URL query string to WebSocket URL |
| 1 | `src/ui/webview-react/components/settings/ServerSection.tsx` | QR code button + inline canvas, Regenerate token button |
| 1 | `src/types/DashboardConstants.ts` | Add `REGENERATE_SERVER_TOKEN` message type |
| 1 | `src/ui/WebviewSettingsSync.ts` | Handle `REGENERATE_SERVER_TOKEN` message |
| 1 | `package.json` (webview) | Add `qrcode` dependency |
| 2 | `src/types/FlightPathSettings.ts` | Add `bindAddress` field + default `"127.0.0.1"` |
| 2 | `src/server/FlightPathHostedServer.ts` | Accept `bindAddress`, use in `listen()` |
| 2 | `src/extension.ts` | Read `bindAddress` from config, pass to constructor |
| 2 | `src/ui/webview-react/components/settings/ServerSection.tsx` | Add bind address select dropdown |
| 3 | `src/server/FlightPathHostedServer.ts` | `isAllowedOrigin()` check in `setupWebSocket()` |
| 4 | `src/types/FlightPathSettings.ts` | Make `tls` required, add defaults |
| 4 | `src/server/FlightPathHostedServer.ts` | HTTPS branch, `isTls` field, scheme in `listen()` |
| 4 | `src/extension.ts` | Read TLS config, pass to constructor, try/catch with `showErrorMessage` |
| 4 | `src/ui/webview-react/components/settings/ServerSection.tsx` | Replace TLS placeholder with real fields |
| 4 | `src/ui/WebviewSettingsSync.ts` | Verify 3-segment dot-path support for `server.tls.*` |
