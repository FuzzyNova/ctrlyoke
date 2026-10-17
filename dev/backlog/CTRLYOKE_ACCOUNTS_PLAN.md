# ctrlyoke Accounts: License Portal and Workspace Directory

**Created:** October 16, 2026
**Status:** Backlog, north star. Nothing here is scheduled. It extends the "Phase 2 — Accounts &
Sign-In" sketch in [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md), which this plan
supersedes as the place to design accounts. The mobile client half lives in
[`NATIVE_MOBILE_APP.md`](NATIVE_MOBILE_APP.md).

## Problem

Two separate pains have the same missing piece: ctrlyoke has no idea who a user is.

1. **License management is support email.** A Pro user can list and deactivate their own machines
   in the License tab, but only from a machine that holds the key. An Enterprise key is shared
   company-wide, so the License tab shows only the seat count (`getSeatUsage`) and points to
   support@ for everything else. Freeing seats or raising the cap is a manual Keygen-dashboard
   action by us. That doesn't scale past a handful of Enterprise customers.
2. **Reaching several workspaces from a phone is a chore.** Every workspace is its own server with
   its own address, token, certificate, and installed home-screen app. Five projects means five
   identical icons (custom icon colors help, but only so far), each re-added whenever a token
   rotates or an address changes. Away from home it also needs a VPN, set up by hand following
   [`docs/pro/remote-access.md`](../../docs/pro/remote-access.md).

An account fixes both: sign in once, and ctrlyoke knows your licenses, your machines, and your
running workspaces.

## Goals

- **License portal** at `ctrlyoke.dev/account`: see every machine on your license with its last
  check-in, and deactivate the ones you no longer use. Enterprise license admins see their whole
  organization; employees don't.
- **Workspace directory:** every running ctrlyoke server signed in to your account appears on a
  single home page (web and [native app](NATIVE_MOBILE_APP.md)). One tap opens it.
- **No regression for anyone who never signs in.** License keys, offline files, air-gapped
  activation, and the token link all keep working. Accounts are an added convenience, not a gate.
- **ctrlyoke never sees workspace content.** The directory knows _that_ a workspace is online and
  _where_ to reach it, never what is in it.

## Non-goals

- Running workflows in the cloud, or proxying harness traffic through ctrlyoke servers. The relay
  in option D carries dashboard traffic only, still encrypted end to end, and can't read it.
- Hand-rolled auth or passwords (Phase 2 already rules this out: managed auth only).

## Part 1: Identity

Managed auth only; Supabase Auth is recommended (see "Recommended services"). The extension signs in with
the VS Code authentication-provider API and an OAuth device-code flow. `ctrlyoke server` uses the
same device-code flow in the terminal.

**Check Keygen before adding a database.** Keygen has its own Users resource: licenses can be
owned by users, and users can authenticate and list or deactivate their own machines through
Keygen's API. If that covers the license portal, Part 2 needs no database of our own, only a
sign-in that maps to a Keygen user. Verify against the current Keygen docs, including how users
count toward the plan's limits, before choosing a backend.

## Part 2: License portal

- **Pro:** the buyer's account owns the license. The portal lists its machines (name, platform,
  activated, last seen) with Deactivate buttons, which is the License tab's table without needing
  to be on a machine that holds the key.
- **Enterprise:** the billing contact from the order becomes the license admin and can invite
  other admins. Admins see every machine with last-seen dates and can deactivate them in bulk
  ("everything not seen in 6 months"). Employees keep using the shared key and see only the seat
  count, as today.
- **Raising the cap** stays a request to support (ENTERPRISE_TERMS.md §3(b)), but the portal can
  show the request button next to the meter.
- The machine-count alerts in `netlify/functions/keygen-webhook.ts` (RELEASE_CHECKLIST.md §4.4
  item 4) keep working unchanged. The portal would make "free unused seats" self-service, so the
  capacity alert becomes "they're near the cap and have nothing to free".

### Last seen and heartbeats

"Last seen" needs the extension to check in. Today the Enterprise and Pro policies have
**Require Heartbeat: false**, so Keygen keeps every activation forever and the seat count is
"machines ever activated", not "machines in use".

Options, in order of preference:

1. **Report last seen, don't cull.** The extension records a check-in (a Keygen machine heartbeat
   ping, or a `lastSeen` on the machine's metadata) when it refreshes its license file. Nothing is
   deactivated automatically. Admins use the portal's "not seen in N months" filter. This gives
   the useful data with no risk to anyone's working machine.
2. **Opt-in culling per organization.** Keygen's heartbeat settings are per policy, so an
   organization that wants automatic cleanup is moved to a second Enterprise policy with
   `requireHeartbeat: true`, a long `heartbeatDuration` (6–12 months), and the `DEACTIVATE_DEAD`
   cull strategy. Everyone else stays on the no-heartbeat policy.
3. **Culling for everyone.** Not recommended: an online-activated machine that is offline for a
   long stretch (a spare laptop, a long leave) would lose its seat without warning.

**Air-gapped machines are unaffected by any of these.** An offline license file is a check-out,
not an activation: it never creates a Keygen machine and never consumes a seat
(`CHECKOUT_ELIGIBLE_VALIDATION_CODES` in `src/license/KeygenConstants.ts`). Heartbeats and
culling only ever touch online activations.

**Open question:** if culling deactivates a machine whose cached license file is still valid,
what does the next license refresh do? `LicenseService` should re-activate silently while seats
are available, never drop Pro features mid-session. Check this before option 2 ships.

## Part 3: Workspace directory

Each signed-in ctrlyoke server (the VS Code-hosted server and `ctrlyoke server`) registers with
the directory: workspace name, icon colors, the addresses it can be reached at (LAN, Tailscale,
public hostname), its certificate fingerprint, and a periodic "still online" check-in. The
directory stores no workflow data, file names, or prompts.

The home page (web at `ctrlyoke.dev/workspaces`, and the native app) lists your online workspaces
and opens one. Opening hands the client a short-lived token to that server, so the long-lived
token link no longer has to be saved anywhere.

The hard part is **reaching** the server, not listing it.

### Connectivity options

| Option                                    | How it works                                                                                                                                                                                                                                 | Trade-off                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Directory only, user's own network** | The directory lists the addresses the server already detects (LAN, Tailscale `100.x`, public hostname). The phone connects the way it does today: same network, or the user's own Tailscale/VPN.                                             | Smallest build; no traffic through us. Still needs the user to run Tailscale away from home. Solves the "five icons" problem completely, the "set up a VPN" problem not at all.                                                                                                                                                                                                               |
| **B. Embedded Tailscale (tsnet)**         | The ctrlyoke server joins the **user's own** tailnet as its own node via Tailscale's `tsnet` library, logging in once through Tailscale's interactive login URL. The native app joins the same tailnet the same way.                         | No VPN setup and no Tailscale app needed, and traffic stays peer-to-peer in the user's own tailnet. But `tsnet` is **Go only**; ctrlyoke is Node, so this means shipping a Go sidecar binary per platform. Tailscale's `tailscale-rs` (with C/Python bindings) is pre-alpha as of August 2026. On mobile there are only unofficial community wrappers (e.g. Dart packages).                   |
| **C. ctrlyoke-operated tailnets**         | Tailscale's Tailnets API can create a tailnet per customer under our account.                                                                                                                                                                | **Not recommended.** We would own the network that reaches into every customer's machine, pay per device, and become a very attractive target. It contradicts the "never in the cloud" promise in `docs/pro/remote-access.md`.                                                                                                                                                                |
| **D. ctrlyoke relay**                     | The server dials out to `relay.ctrlyoke.dev`; clients connect through it (the model VS Code Remote Tunnels uses). End-to-end encrypted, keyed by the certificate fingerprint the directory published, so the relay only forwards ciphertext. | Best UX: works anywhere, with no VPN and no router setup. But we operate always-on infrastructure that carries remote control of users' machines, with bandwidth cost and on-call burden. Only worth it once there is revenue to pay for it.                                                                                                                                                  |
| **E. Direct, with hole punching**         | The directory acts as a signaling channel: both ends learn their public UDP endpoint (STUN), swap them through the directory, and send packets at each other at the same time so both NATs open (ICE, as in WebRTC).                         | Traffic is peer-to-peer and costs us nothing. But it fails between some NAT types, so it **always needs a relay fallback** (TURN, or Tailscale's DERP), and it carries UDP, not HTTP. The dashboard speaks HTTP and WebSocket, so this only works inside the native app, which would run a local proxy over the data channel. A plain browser can't use it without a new dashboard transport. |

#### Why "publish the public IP and port" doesn't work

The tempting shortcut is for the server to report the public IP and port its outbound connection
to the directory came from, and have the phone connect there. It fails in almost every network:

- That port belongs to **one** connection, between the server and the directory. Home routers
  drop packets arriving on it from any other address (address- or port-restricted filtering),
  and nothing on the machine is listening for new TCP connections there anyway.
- The mapping disappears after a short idle time unless something keeps sending traffic.
- Many ISPs and every mobile carrier put customers behind **carrier-grade NAT**, so the public
  address is shared with other customers and no router setting on the user's side can open it.
- IPv6 often makes the machine globally addressable, but home routers block unsolicited inbound
  IPv6 by default, so it doesn't help either.

The public-IP-and-port idea only works in the coordinated form: both ends punching at the same
time with the directory as go-between. That is option E, and even that needs a relay fallback.

#### How apps normally do this

Apps that reach a machine at home with no router setup all have the machine **dial out** to a
service the vendor runs. Then they either relay the traffic through that service or use it to
set up a direct path, and relay whenever the direct path fails:

- **Relay only:** VS Code Remote Tunnels, ngrok, Cloudflare Tunnel, Home Assistant Cloud.
- **Direct first, relay fallback:** Tailscale (DERP relays), Plex (relay when direct fails),
  Chrome Remote Desktop and Parsec (WebRTC with TURN).

Because hole punching sometimes fails, and mobile networks are where it fails most, any design
that works with no setup **has to run a relay**. Direct connections only lower how much traffic
the relay carries. So the real question is whether the relay can read the traffic, not whether
we carry it.

#### Making the relay blind and the certificate real

D can carry only ciphertext and also do away with self-signed certificates, using the approach
Plex uses with `plex.direct`:

1. At sign-in each server gets a stable hostname under a domain we own, for example
   `<machine-id>.ctrlyoke.net`.
2. The server creates its own key pair and gets a publicly trusted certificate for that hostname
   from Let's Encrypt with a DNS-01 challenge. Our backend writes only the challenge TXT record.
   The private key never leaves the machine.
3. The server holds an outbound WebSocket (or HTTP/2) connection to the relay. A client connecting
   to `https://<machine-id>.ctrlyoke.net` reaches the relay, which reads the hostname from the TLS
   SNI and forwards the raw TLS stream down that connection without decrypting it. TLS ends on the
   user's machine.
4. A LAN address can be published as a hostname under the same domain (Plex uses
   `192-168-1-5.<hash>.plex.direct`), so local connections skip the relay and keep a valid
   certificate.

Results: an ordinary browser gets a padlock with **no certificate profile**, one address works at
home and away, and the relay sees only hostnames, timing, and byte counts. Points to check before
building:

- Let's Encrypt allows 50 new certificates per registered domain per week. Getting the domain onto
  the Public Suffix List makes each subdomain count as its own registered domain. Plex went with a
  commercial CA deal instead.
- Some routers' DNS-rebinding protection refuses public DNS answers that point to private
  addresses, which breaks step 4. That is a known Plex support issue, and in that case the client
  just goes through the relay.
- Access control comes in layers. The relay pairs a client only when it presents a short-lived
  connect token the backend issued for that machine to that account. The server still checks its
  own access token. A compromised relay can therefore deny service and see metadata, but it can't
  read or drive a session.
- The dashboard is mostly JSON and terminal text, so bandwidth is small. The real cost is running
  an always-on service: uptime, abuse handling, and on-call.

Off-the-shelf alternatives cost less to build but give up the blind relay. Cloudflare Tunnel is
free and needs no relay of our own, but Cloudflare ends TLS and sees the plaintext. Self-hosted
`frp` or `rathole` can do SNI passthrough, but we still operate them.

#### What Supabase does and doesn't cover

Supabase covers accounts, the directory table with row-level security, online presence (Realtime
presence instead of polled check-ins), minting connect tokens (an Edge Function), and signaling for
option E (Realtime broadcast). It **can't** be the relay: Edge Functions are short-lived requests,
and a relay holds thousands of long-lived connections. The relay is a separate small service, such
as a Go or Node process on Fly.io or a VPS, that checks tokens signed by the backend.

**Recommendation:** **A** is still the cheapest first step. It needs only the account, a tiny
directory table, and the home page, and it removes the icon clutter on day one. But A doesn't
meet the goal of "connect from anywhere with nothing to set up". Only **D** (blind relay plus a
real certificate, as above) meets that goal, and it works in an ordinary browser as well as the
native app. Build A so its directory rows and connect tokens are the ones D will use. **E** can be
added later in the native app to cut relay traffic. **B** is only worth it if users would rather
keep everything in their own tailnet than trust a blind relay. **C** stays rejected.

"Use Tailscale under the hood" means B. Tailscale has no product for running inside a
third-party app on the end user's own tailnet beyond `tsnet` itself. Its August 2026
"build with / build on" post covers `tsnet` (each app joins a tailnet as its own node), the
Tailnets API (create tailnets programmatically, which is option C), and alpha Declarative Node
Sharing. None of them describe a multi-tenant "app developer" program. Re-check before
committing, since this area is moving.

## Recommended services

Researched October 17, 2026. The accounts we already run are Cloudflare (DNS for `ctrlyoke.dev`),
Netlify (site and webhook functions), Azure (Application Insights in resource group `ctrlyoke`),
Google Workspace (email only), Keygen, Lemon Squeezy, Resend, GitHub, and 1Password
(`dev/active/RELEASE_CHECKLIST.md`). The question was whether those could cover the backend and
relay, so we don't open new accounts. The answer is partly: they cover DNS, email, and telemetry,
but neither the backend nor the relay.

### Summary

| Need                                             | Recommendation                                            | Existing account? | Rough cost at launch                      |
| ------------------------------------------------ | --------------------------------------------------------- | ----------------- | ----------------------------------------- |
| Sign-in, directory database, presence            | **Supabase** (Auth + Postgres + Realtime)                 | New               | Free in development; Pro $25/mo at launch |
| Relay (blind SNI passthrough, option D)          | **Fly.io**, one region, dedicated IPv4                    | New               | About $5/mo plus $0.02/GB egress          |
| Machine hostnames and DNS-01 challenges          | **Cloudflare**, in a separate zone for a new domain       | Yes               | Domain registration only                  |
| Sign-in and notification email                   | **Resend**, as Supabase's custom SMTP                     | Yes               | Within the current plan                   |
| Relay and backend telemetry                      | **Azure Application Insights**                            | Yes               | Within the 5 GB/month free ingestion      |
| Webhooks (Lemon Squeezy, Keygen)                 | **Netlify Functions**, unchanged                          | Yes               | Unchanged                                 |
| Mobile push ([native app](NATIVE_MOBILE_APP.md)) | APNs (Apple Developer account) and FCM (Firebase project) | New (both)        | Free apart from Apple's $99/yr            |

So the plan adds two accounts, Supabase and Fly.io, and two more only if the native app ships.

### Backend: Supabase

Supabase does sign-in, the relational data (accounts, license ownership, organizations, machines,
directory rows) with row-level security, and online presence in one service. It also has GitHub
sign-in built in, which a developer tool needs.

- **Free tier is for development only.** Free projects pause after a week of inactivity and have
  no backups. Move to Pro ($25/mo, 100k MAU included) before the directory carries real users.
- **Use Resend as the SMTP provider**, so sign-in emails come from `ctrlyoke.dev` with the SPF and
  DKIM setup that already exists.
- **Device-code sign-in for the CLI and extension (Part 1):** check whether Supabase Auth supports
  the OAuth device authorization grant by now. If it doesn't, build it as a small table and an
  Edge Function: the CLI shows a code and polls, and the browser page on `ctrlyoke.dev` approves
  it after sign-in. The extension can use a `vscode://` URI-handler redirect instead.
- The relay should verify Supabase-issued (or Edge-Function-minted) connect tokens itself against
  a public signing key, so a Supabase outage doesn't break sessions that are already connected.

Alternatives considered:

| Option                                  | Why not first choice                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Microsoft Entra External ID** (Azure) | Uses the Azure subscription we already have, and its core tier is free up to 50,000 MAU. But it needs a separate external tenant, it has no built-in GitHub sign-in (GitHub isn't standard OIDC), and it brings no database or presence, so we'd still add Postgres or Cosmos DB and a realtime layer. Reconsider it if Enterprise SAML/OIDC SSO becomes a launch requirement.                                                                                 |
| **Firebase** (Auth + Firestore)         | The strongest fewer-accounts option. Auth is free up to 50,000 MAU, presence is a well-known Realtime Database pattern, and the native app needs a Firebase project for FCM anyway. Against it: the data is relational (organizations → licenses → machines → workspaces), Firestore is not, and access rules are harder to audit than Postgres row-level security. If keeping vendor count down matters more than the data model, this is the switch to make. |
| **Clerk or WorkOS** plus a database     | Good auth, but it's still two new accounts (auth plus a database) instead of one.                                                                                                                                                                                                                                                                                                                                                                              |
| **Keygen Users only** (Part 1)          | May cover the license portal, but not the directory, presence, or relay tokens.                                                                                                                                                                                                                                                                                                                                                                                |

### Relay: Fly.io

The relay is one long-running process holding thousands of idle WebSocket connections. It accepts
TLS on port 443 and routes on SNI **without terminating TLS**. That second requirement rules out
most managed platforms:

| Option                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fly.io**                            | **Recommended.** Supports raw TCP services, so the relay sees the TLS stream untouched. A dedicated IPv4 costs $2/mo. A 256 MB shared-CPU machine costs about $2/mo, and egress in North America and Europe is $0.02/GB. Deploy from a Dockerfile in this repo through GitHub Actions. Stay in one region at first, since a relay spread over several regions needs instances to forward pairings to each other. |
| **Hetzner Cloud**                     | Cheapest (about €4–5/mo after the April 2026 price increase, 20 TB of traffic included in EU locations but only about 1 TB in the US). But it's a bare VM, so OS patching, TLS for the control endpoints, and restarts are ours. A good fallback if Fly's egress ever matters.                                                                                                                                   |
| **Azure VM**                          | Existing account, but a bare VM like Hetzner at a higher price, and egress beyond 100 GB/month is about $0.087/GB. Container Apps TCP ingress is possible, but it adds networking setup for no gain over a VM.                                                                                                                                                                                                   |
| **Cloudflare Workers / Spectrum**     | Would be ideal, since we're already on Cloudflare and it's global. But Workers terminate TLS (not blind), arbitrary-port TCP on Spectrum needs an Enterprise plan, and inbound TCP to Workers (August 2026) was a private beta that runs through Spectrum. **Re-check before building**, since this could become the cheapest global option.                                                                     |
| **Google Cloud Run**                  | WebSocket connections are capped at 60 minutes and session affinity is best effort, which doesn't suit a relay holding long-lived connections.                                                                                                                                                                                                                                                                   |
| **Cloudflare Tunnel** (off the shelf) | Free and needs no relay of our own, but Cloudflare ends TLS and sees plaintext, which is what the blind relay exists to avoid.                                                                                                                                                                                                                                                                                   |

Expected cost is about $5–10/month until traffic grows. The dashboard sends JSON and terminal text,
so 100 GB of egress is about $2. Send the relay's metrics (connections, pairings, bytes) to
Application Insights through its OpenTelemetry exporter, so it shows up next to the extension's
telemetry.

### DNS and certificates: Cloudflare

- Register a **separate domain** for machine hostnames (for example `ctrlyoke.net`) and keep it as
  its own Cloudflare zone. Any site under it shares nothing (cookies, reputation) with
  `ctrlyoke.dev`, and it can be added to the Public Suffix List so that Let's Encrypt's limit of 50
  certificates per registered domain per 7 days applies to each machine, not to the whole domain.
  Put only this domain on the list, never `ctrlyoke.dev`. An override request to Let's Encrypt is
  the alternative if the list entry takes too long.
- The backend writes DNS-01 TXT records with a Cloudflare API token that is **scoped to that one
  zone** and kept in the backend's environment, never on users' machines. A machine asks the
  backend, "publish this challenge for my hostname", and the backend checks the machine's
  credential first.
- The relay hostname record points at the Fly.io IPv4, in DNS-only mode (grey cloud), the same way
  the Netlify apex record is configured today.

### Compliance

Supabase and Fly.io both handle account and connection metadata (emails, IP addresses, machine
names, hostnames), so each must be added to `DPA.md` Annex II and `PRIVACY.md` before it holds
customer data. Because the relay is blind, its entry can say it carries encrypted traffic it can't
read.

Sources: [Supabase pricing](https://supabase.com/pricing),
[Fly.io resource pricing](https://fly.io/docs/pricing/),
[Entra External ID pricing](https://azure.microsoft.com/en-us/pricing/details/microsoft-entra-external-id/),
[Firebase pricing](https://firebase.google.com/pricing),
[Azure bandwidth pricing](https://azure.microsoft.com/en-us/pricing/details/bandwidth/),
[Cloudflare Workers inbound TCP](https://blog.cloudflare.com/grpc-workers/),
[Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets),
[Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/). Prices come from a mix of
official and third-party pages and should be checked again before signing up.

## Phasing

1. Sign-in (extension, `ctrlyoke server`, website), mapped to an existing license. Keys and files
   keep working.
2. License portal for Pro and Enterprise, with "last seen" from option 1 above.
3. Workspace directory with connectivity option A, on the web home page and in the native app.
4. Optional per-organization heartbeat culling (option 2 above).
5. Connectivity D (blind relay with per-machine certificates), then optionally E in the native app
   to cut relay traffic.

## Open questions

- Keygen Users vs our own account table (see Part 1).
- Which managed auth provider, and its cost at the expected account count.
- Does an Enterprise admin role need SSO (SAML/OIDC) at launch, or later? WorkOS makes SSO
  cheapest to add.
- Directory privacy: workspace names can be sensitive (client project names). Make the listed name
  user-editable and default it to something neutral.
