# `ctrlyoke server`

`ctrlyoke server` opens the ctrlyoke dashboard for a workspace in a browser,
without requiring VS Code. The server process must stay running while you use
the dashboard. It starts on the loopback address by default, so only the same
computer can connect until you explicitly choose a network bind address.

Install the [standalone CLI](/cli/) or use `npx ctrlyoke`, then start it from
the directory containing your workspace:

```sh
ctrlyoke server
```

The launch banner prints the local URL, a terminal QR code, and a clickable
OSC 8 link in terminals that support it. The URL includes an access token.
Use `--open` to open that URL in your default desktop browser:

```sh
ctrlyoke server --open
```

Keep the tokenized URL private. Requests without the token are rejected. The
server token persists so a saved bookmark or scanned QR code remains usable
after restart. Each workspace has its own token, stored in the system credential
store and shared with the VS Code extension's server for the same workspace, so
the link stays the same whichever one serves it. `--regenerate-token` rotates
only this workspace's token. For scripted use, `CTRLYOKE_SERVER_TOKEN` supplies
the token without putting it in visible process arguments; while it is set the
persisted token is not used.

## Work from a phone and laptop

With ctrlyoke Pro remote access enabled, you can keep a workflow visible on a
phone while continuing to edit files and run harness CLIs on a laptop:

1. Start the server in the workspace on the laptop, binding to an address
   reachable over your trusted local network. For example:

   ```sh
   ctrlyoke server --bind 0.0.0.0 --https
   ```

2. Scan the QR code with the phone while it is on the same network. The QR
   contains the tokenized URL. You can also open the printed URL on the laptop.
3. Keep the terminal process running. The browser dashboard can start and
   monitor workflows while the harness CLIs and workspace files remain on the
   laptop.

Non-loopback binds are protected by the ctrlyoke Pro remote-access gate. A
LAN address does not bypass that gate. Do not expose the server to an
untrusted network or forward its port to the public internet.

## HTTPS and certificates

Use `--https` to serve the dashboard over HTTPS. If you do not provide a
certificate and key pair, ctrlyoke can create a local certificate for the
server. A phone or other client may not trust that certificate automatically.
Install and trust the certificate on the device before connecting, following
the device's certificate-management instructions. Browsers may continue to
show a warning until the certificate is trusted. Restart the server after
changing certificate settings; connected clients will need to reconnect.

Provide an existing certificate pair with `--cert` and `--key`, or configure
the paths in `server.tls` in `.ctrlyoke/settings.json`.

## Options

| Option                  | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `-d, --cwd <path>`      | Workspace root; defaults to the current directory.                                       |
| `-p, --port <n>`        | Port to use; defaults to `server.port` (4747).                                           |
| `--strict-port`         | Exit if the requested port is occupied instead of trying fallback ports.                 |
| `--bind <addr>`         | Bind address; defaults to `127.0.0.1`. Non-loopback addresses require Pro remote access. |
| `--https`, `--no-https` | Enable or disable HTTPS, overriding `server.tls.enabled`.                                |
| `--cert <path>`         | TLS certificate path, overriding `server.tls.certPath`.                                  |
| `--key <path>`          | TLS private key path, overriding `server.tls.keyPath`.                                   |
| `--theme <mode>`        | Select `auto`, `light`, or `dark`.                                                       |
| `--open`                | Open the tokenized URL in the default browser.                                           |
| `--regenerate-token`    | Rotate this workspace's persisted server token before starting.                          |
| `--verbose`             | Write diagnostic file logging.                                                           |

Options override the matching `server.*` settings in
`.ctrlyoke/settings.json`. See the [settings reference](/reference/settings)
for the full configuration shape.

## Themes and browser storage

By default, each browser follows its own light or dark system preference.
Choose a server-wide default with `--theme light`, `--theme dark`, or the
`server.theme` setting. A `?theme=light` or `?theme=dark` URL parameter can
choose a theme for one browser.

Dashboard drafts and UI state are stored by the browser, scoped to the
workspace. They survive closing and reopening a tab and can be restored when
that workspace is served again. Different workspaces on the same server
origin keep separate state. Browser storage is local to that browser; it is
not synchronized between your phone and laptop.

Read the [CLI reference](/cli/ctrlyoke#ctrlyoke-server) for the command
summary and the [Pro mobile setup guide](/pro/mobile-setup) for account
activation details.
