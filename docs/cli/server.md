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
When the server listens on all interfaces and `server.publicHostname` is set,
the banner also prints a `Public:` link and the QR code uses it; see
[Connect from anywhere](/pro/remote-access#public-hostname).
Use `--open` to open that URL in your default desktop browser:

```sh
ctrlyoke server --open
```

Keep the tokenized URL private. Requests without the token are rejected. The
server token persists so a saved bookmark or scanned QR code remains usable
after restart. Each workspace has its own token, stored in the system credential
store (or the [secret file](#headless-hosts-and-containers) on a machine without
one) and shared with the VS Code extension's server for the same workspace, so
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
LAN address does not bypass that gate. The server checks the Pro license for
remote access, including when generating a certificate for LAN HTTPS, and may
contact Keygen to refresh a cached online Pro license. When push notifications
are enabled, notifications go through browser push services. See the [privacy
guide's network request table](/guide/privacy#other-network-requests). Do not
expose the server to an untrusted network or forward its port to the public
internet.

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

## Headless hosts and containers

The server keeps its secrets (the Pro license, the workspace token and
[managed secrets](/workflows/secrets)) in the operating system's credential
store. A Docker container or a headless Linux server usually has none: there is
no D-Bus session or keyring daemon for `secret-tool` to reach. There, ctrlyoke
stores them in `~/.ctrlyoke/secrets.json`, or `secrets.json` in the folder
`CTRLYOKE_HOME` points to, and prints a warning naming the file.

The file is **not encrypted**. Its protection is its permissions: ctrlyoke
writes it readable and writable only by your user (mode `0600`), re-applies that
mode on every write, and warns when it finds the file readable by others. This
is how `gh`, Docker, git's credential store and the harness CLIs store logins
on a machine without a keyring. Anyone who can read your home directory, and
any agent ctrlyoke runs as your user, can read it. In a container, keep
`CTRLYOKE_HOME` on a volume so the license, token and secrets survive
recreating the container.

`ctrlyoke secret` uses the same store, so a secret set from a shell in the
container is the one the server resolves.

### Activate a license at startup

On Docker's default bridge network every browser is a remote client, and
remote access needs Pro, so a fresh container cannot be activated from its own
dashboard. Give the server the license key instead:

| Variable                    | Effect                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CTRLYOKE_LICENSE_KEY_FILE` | Path to a file that holds the license key, such as a Docker secret under `/run/secrets/`. Preferred.                                        |
| `CTRLYOKE_LICENSE_KEY`      | The license key itself. The server removes it from its environment as soon as it starts, so harnesses and scripts it launches never see it. |

On start, the server activates the key unless it is already the stored one, so
restarting with the same key reuses the existing activation and Keygen machine.
A changed key is activated in its place. If activation fails, for example with
no network at boot, the server warns and starts anyway with whatever license is
already stored. A file is preferred because every process the server launches
inherits its environment until the variable is removed; a file never enters it.

The activation stays stored, so removing the variable later does not deactivate
the license. Losing the volume loses the activation, and the next start
registers a new machine. If that reaches the license's machine limit, deactivate
the old one from the **Activated machines** list on the License tab.

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
Choose a server-wide default with **Browser dashboard theme** on the
dashboard's General settings tab, which writes the `server.theme` setting. A
change applies the next time a browser loads the page, without restarting the
server. `--theme light` or `--theme dark` fixes the theme for that server run
and overrides the setting. A `?theme=light` or `?theme=dark` URL parameter can
choose a theme for one browser.

Dashboard drafts and UI state are stored by the browser, scoped to the
workspace. They survive closing and reopening a tab and can be restored when
that workspace is served again. Different workspaces on the same server
origin keep separate state. Browser storage is local to that browser; it is
not synchronized between your phone and laptop.

Read the [CLI reference](/cli/ctrlyoke#ctrlyoke-server) for the command
summary and the [Pro mobile setup guide](/pro/mobile-setup) for account
activation details.
