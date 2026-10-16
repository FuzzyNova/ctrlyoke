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

- Running workflows in the cloud, or proxying harness traffic through ctrlyoke servers.
- Hand-rolled auth or passwords (Phase 2 already rules this out: managed auth only).

## Part 1: Identity

Managed auth only (Clerk, Supabase Auth, or WorkOS, per Phase 2). The extension signs in with
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

| Option                                    | How it works                                                                                                                                                                                                                                 | Trade-off                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Directory only, user's own network** | The directory lists the addresses the server already detects (LAN, Tailscale `100.x`, public hostname). The phone connects the way it does today: same network, or the user's own Tailscale/VPN.                                             | Smallest build; no traffic through us. Still needs the user to run Tailscale away from home. Solves the "five icons" problem completely, the "set up a VPN" problem not at all.                                                                                                                                                                                             |
| **B. Embedded Tailscale (tsnet)**         | The ctrlyoke server joins the **user's own** tailnet as its own node via Tailscale's `tsnet` library, logging in once through Tailscale's interactive login URL. The native app joins the same tailnet the same way.                         | No VPN setup and no Tailscale app needed, and traffic stays peer-to-peer in the user's own tailnet. But `tsnet` is **Go only**; ctrlyoke is Node, so this means shipping a Go sidecar binary per platform. Tailscale's `tailscale-rs` (with C/Python bindings) is pre-alpha as of August 2026. On mobile there are only unofficial community wrappers (e.g. Dart packages). |
| **C. ctrlyoke-operated tailnets**         | Tailscale's Tailnets API can create a tailnet per customer under our account.                                                                                                                                                                | **Not recommended.** We would own the network that reaches into every customer's machine, pay per device, and become a very attractive target. It contradicts the "never in the cloud" promise in `docs/pro/remote-access.md`.                                                                                                                                              |
| **D. ctrlyoke relay**                     | The server dials out to `relay.ctrlyoke.dev`; clients connect through it (the model VS Code Remote Tunnels uses). End-to-end encrypted, keyed by the certificate fingerprint the directory published, so the relay only forwards ciphertext. | Best UX: works anywhere, with no VPN and no router setup. But we operate always-on infrastructure that carries remote control of users' machines, with bandwidth cost and on-call burden. Only worth it once there is revenue to pay for it.                                                                                                                                |

**Recommendation:** ship **A** first. It needs only the account, a tiny directory table, and the
home page, and it removes the icon clutter on day one. Revisit **B** if VPN setup turns out to be
the main reason people don't use remote access, and **D** only if ctrlyoke grows into a hosted
product with revenue to match.

"Use Tailscale under the hood" means B. Tailscale has no product for running inside a
third-party app on the end user's own tailnet beyond `tsnet` itself. Its August 2026
"build with / build on" post covers `tsnet` (each app joins a tailnet as its own node), the
Tailnets API (create tailnets programmatically, which is option C), and alpha Declarative Node
Sharing. None of them describe a multi-tenant "app developer" program. Re-check before
committing, since this area is moving.

## Backend

A small managed backend: Supabase (Postgres + Auth + row-level security) fits Parts 1–3 in one
service, or Clerk/WorkOS for auth plus a Netlify Function and a small database. The data is small:
accounts, license ownership (or Keygen users, per Part 1), and the directory's workspace rows. It
must be added to `DPA.md` and the privacy policy as a sub-processor before it holds any customer
data.

## Phasing

1. Sign-in (extension, `ctrlyoke server`, website), mapped to an existing license. Keys and files
   keep working.
2. License portal for Pro and Enterprise, with "last seen" from option 1 above.
3. Workspace directory with connectivity option A, on the web home page and in the native app.
4. Optional per-organization heartbeat culling (option 2 above).
5. Re-evaluate connectivity B or D based on how people actually use remote access.

## Open questions

- Keygen Users vs our own account table (see Part 1).
- Which managed auth provider, and its cost at the expected account count.
- Does an Enterprise admin role need SSO (SAML/OIDC) at launch, or later? WorkOS makes SSO
  cheapest to add.
- Directory privacy: workspace names can be sensitive (client project names). Make the listed name
  user-editable and default it to something neutral.
