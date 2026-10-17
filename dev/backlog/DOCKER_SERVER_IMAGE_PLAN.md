# Docker Server Image Plan

**Status:** backlog, not started. Proposed 2026-10-15. Its prerequisite,
[`headless-linux-has-no-persistent-secret-store.md`](../bugs/implemented/headless-linux-has-no-persistent-secret-store.md),
is fixed.

## Goal

Publish an official container image that runs `ctrlyoke server` always-on, for example on a
home server, NAS or small VPS. It is for making hotfixes from a phone or laptop while the main
dev machine is off. The container is also the sandbox: harness agents can change only the repos
mounted into it, not the rest of the host.

Updating should be one command: `docker compose pull && docker compose up -d`.

## Why

- `ctrlyoke server` already exists, and remote access is the Pro feature people pay for. An
  always-on box is where that feature is most useful.
- A home server usually hosts other things too (media, home automation, file shares). Running
  agents in a container keeps them away from all of that by default.
- Installing six harness CLIs, Node 22.12+, git and a PTY-capable environment by hand on a
  server is the friction this removes.

## Non-goals

- A dev-container / Codespaces image for working _on_ a project interactively. This is a
  server, not an IDE. (The hosted workspace viewer already covers light editing.)
- Kubernetes manifests or Helm charts.
- Windows containers.

## Design

### Image contents: ctrlyoke only, CLIs installed at runtime

**Don't bake the harness CLIs into the published image.** Two reasons:

1. **Redistribution.** Claude Code, Copilot CLI and Antigravity are proprietary. Publishing an
   image whose layers contain their binaries is redistribution, which their terms may not
   allow. Check each vendor's terms before changing this decision. Installing from the vendor's
   own installer at runtime, on the user's machine, avoids the question.
2. **Release cadence.** Claude Code and Codex ship several times a week. An image rebuilt only
   on ctrlyoke releases would almost always have stale CLIs, and ctrlyoke's
   `versionPolicy.minimum` checks would start failing between releases.

The image contains: `node:22-bookworm-slim` base, `git`, `openssh-client`, `curl`,
`ca-certificates`, `tini`, the `ctrlyoke` npm package at the release version, and a non-root
`ctrlyoke` user (uid 1000 by default, overridable through `PUID`/`PGID` so files written to
bind-mounted repos have the host user's ownership).

### Entrypoint installs and updates the chosen harnesses

```yaml
environment:
  CTRLYOKE_HARNESSES: claude,codex # any of: copilot, claude, codex, opencode, qwen, agy
  CTRLYOKE_UPDATE_HARNESSES: "on-start" # on-start | never
```

At startup the entrypoint installs each listed CLI with its vendor installer: the same
macOS/Linux commands as each `docs/harnesses/<harness>.md` `## Install` section. It installs into
the persistent `/home/ctrlyoke` volume, so the CLI and its login survive container recreation.
With `on-start`, it runs each CLI's own update command (or re-runs the installer) on every start,
so a container restart updates the CLIs. An install that fails is logged and skipped. The
dashboard's harness preflight then shows that harness as missing, which is the right UI for it.

Single-source the binary names and installer commands: generate the entrypoint's table from
the providers' `CLI_COMMAND` constants and the docs install blocks, or move both into one data
file that the docs and the entrypoint both read. Don't hand-maintain a seventh copy.

### Volumes and ports

```yaml
services:
  ctrlyoke:
    image: ghcr.io/<org>/ctrlyoke:latest
    restart: unless-stopped
    ports: ["4747:4747"]
    environment:
      CTRLYOKE_HARNESSES: claude,codex
    volumes:
      - ctrlyoke-home:/home/ctrlyoke # CLIs, harness logins, ~/.ctrlyoke state, certs, secret store
      - /srv/repos/my-app:/work/my-app # only the repos agents may touch
    command:
      ["ctrlyoke", "server", "--cwd", "/work/my-app", "--bind", "0.0.0.0"]
volumes:
  ctrlyoke-home:
```

### Networking gotcha: inside a container, nothing is loopback

The hosted server lets loopback clients in for free and requires Pro or a trial for everything
else (`CtrlYokeHostedServer.isClientAllowed`). With Docker's default bridge network, a browser
on the host reaches the container through the published port, so the connection comes from the
bridge gateway (e.g. `172.17.0.1`), not loopback. The server then has to bind `0.0.0.0` inside
the container, and **even a browser on the same machine counts as remote.** So:

- On the bridge network, the image is effectively Pro-only (or trial-only, once the CLI
  server has a persisted trial; today its `LicenseService` has no `trialState`, so the trial
  reads as unavailable).
- `network_mode: host` makes host-loopback clients real loopback again (free tier works
  on the host itself), at the cost of the network isolation.

Document both modes clearly. Decide whether a free-tier user running the official image on the
bridge network should get a clearer message than the generic remote-access block.

### Secrets, license and machine identity

Done by the linked bug. Without a keyring, the server and `ctrlyoke secret` store secrets in
`<CTRLYOKE_HOME>/secrets.json` (plaintext, `0600`), which is on the `ctrlyoke-home` volume. The
license can come from `CTRLYOKE_LICENSE_KEY_FILE` (a Docker secret) or `CTRLYOKE_LICENSE_KEY`,
activated at start only when it differs from the stored key. The machine fingerprint is in the
same file, so a rebuild reuses its Keygen machine. The image should set `CTRLYOKE_HOME` on the
volume and document `CTRLYOKE_LICENSE_KEY_FILE` with a compose `secrets:` example.

### Harness login

Each CLI needs a headless login flow inside the container (`docker exec -it ctrlyoke claude`,
device-code flows for Copilot/Codex, API keys via env for those that support it). Verify each
of the six works without a browser in the container, and document the exact command per
harness. Harness credentials live on the `ctrlyoke-home` volume. Treat that volume as
sensitive: anyone who can read it can use the user's harness accounts.

### Security posture to document

- The container limits what files agents can change: only the bind-mounted repos and the home
  volume. It does **not** limit network access. Agents can reach the LAN, the internet, and
  anything the harness credentials and any mounted git credentials allow.
- Recommend a deploy key or fine-grained token scoped to the mounted repos, not the user's main
  SSH key.
- Never mount the Docker socket or the host home directory. Mounting the home directory would
  also expose host-installed CLIs, e.g. a native Claude install in `~/.local/bin`.

## Release process

- CI builds and pushes a multi-arch image (`linux/amd64`, `linux/arm64`; arm64 matters for
  Raspberry Pi and many NAS boxes) to GHCR on each release tag: `:<version>` and `:latest`.
- Since CLIs install at runtime, the per-release work is just the `npm install -g
ctrlyoke@<version>` layer plus base-image security updates. A scheduled weekly rebuild picks
  up `node:22` patches without a ctrlyoke release.
- Add the image to `RELEASE_CHECKLIST.md` only once it ships.

## Open questions

- **`node-pty` on slim images.** Confirm the npm package's prebuilt binary loads on
  `bookworm-slim` for both architectures; otherwise the build stage needs `python3`, `make`,
  `g++`.
- **Harness hooks and statusline writes.** ctrlyoke writes harness config under the home
  directory (see `docs/harnesses/files-ctrlyoke-writes.md`). Confirm all of it lands on the
  persistent volume.
- **The Windows-PC update notice.** The npm CLI warns when it is older than the extension that
  shares its state. The container has its own state home, so this shouldn't trigger, but
  confirm.
- **Multiple repos.** One server per repo (one service per repo in compose), or one server with
  named workspace roots? Pick whichever the hosted workspace picker supports best.

## Phases

1. ~~Fix the headless secret-store bug (prerequisite).~~ Done.
2. Dockerfile + entrypoint + compose example, tested by hand on a Linux home server with
   two harnesses. This includes capturing the no-harness preflight state for D6 in
   `DOCUMENTATION_GAPS_PLAN.md`, by starting with `CTRLYOKE_HARNESSES` empty.
3. Verify headless login for all six harnesses; write `docs/guide/docker.md` (setup, networking
   modes, security posture, updating).
4. CI multi-arch publish on release tags plus a weekly rebuild.
