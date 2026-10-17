# Native Mobile App (iOS + Android)

**Created:** 2026-05-01
**Status:** Backlog. Rejected on 2026-07-28 and revived on 2026-10-16 with a narrower scope.
Depends on accounts and the workspace directory in
[`CTRLYOKE_ACCOUNTS_PLAN.md`](CTRLYOKE_ACCOUNTS_PLAN.md).
**Effort:** Large (separate project, App Store and Play Store distribution)

## Why it was rejected, and why it's back

The July rejection said: _"The responsive hosted dashboard already supplies the mobile control
surface. Native apps would duplicate the client and distribution stack without improving workflow
orchestration."_ That is still right about the **client**: a second, native dashboard UI would be
a large duplicate to keep in sync with the React dashboard.

What it missed is everything around the dashboard. Using several workspaces from a phone today
means:

- one home-screen app per workspace, all opened from separately saved links;
- installing a self-signed certificate profile on the phone for each server
  (`docs/pro/mobile-setup.md`), and installing it again whenever the certificate is regenerated;
- an app that belongs to the one address it was installed from, so a LAN install can't reach the
  same workspace through Tailscale (`docs/pro/remote-access.md`, "Install the app with the address
  you'll use everywhere");
- push notifications that depend on each browser's web-push support.

The PWA can't fix those, because they come from the browser's rules, not from ctrlyoke. A native
app can.

## Scope: a thin shell, not a second client

The app is a **launcher plus a WebView** around the existing React dashboard:

- **Workspace list:** after sign-in, the app shows every online workspace from the account's
  workspace directory (`CTRLYOKE_ACCOUNTS_PLAN.md` Part 3), using each workspace's icon colors
  (already shipped: [Custom Icon Colors](../implemented/CUSTOM_ICON_COLORS_PLAN.md)). Signed-out
  users can still add a server by scanning its QR code, as today.
- **Dashboard in a WebView:** opening a workspace loads the same hosted dashboard the browser
  gets. No dashboard UI is rebuilt natively, so the duplication concern in the rejection doesn't
  apply.
- **Certificate pinning instead of profile installs:** the directory (or the QR code) carries the
  server's certificate fingerprint, and the app trusts exactly that certificate for that server.
  No certificate profile and no OS-wide trust change.
- **Any address, one app:** the app tries the addresses the directory lists (LAN, Tailscale,
  public hostname) and uses whichever answers, so the same entry works at home and away.
- **Native push:** APNs/FCM for "awaiting input" and run-finished notifications, replacing web push
  for app users.
- **Reachability:** tell "server offline" apart from "idle" using the directory's online
  check-ins.

Out of scope: a native dashboard UI, offline workflow editing, or running anything on the phone.

## Connectivity

Connectivity is decided in `CTRLYOKE_ACCOUNTS_PLAN.md` ("Connectivity options"), not here. Short
version: a phone can't connect to a public IP and port the server reports, because of NAT and
carrier-grade NAT. Reaching a machine with no setup needs a relay we run. The recommended target
there is option D: a **blind relay** that forwards TLS by SNI, plus a publicly trusted certificate
for each machine's `<machine-id>.ctrlyoke.net` hostname (the `plex.direct` model).

The app's job:

- **First version:** use option A. Try the addresses the directory lists (LAN, Tailscale), so it
  only reaches servers the phone can already reach.
- **Once D ships:** try the LAN hostname first, then fall back to the relay hostname. Nothing is
  app-specific here; the browser does the same.
- **Optional later step:** use option E (WebRTC hole punching with the directory as signaling) to
  take traffic off the relay. Only the native app can do this, because it can run a local proxy
  that carries the dashboard's HTTP/WebSocket over a data channel.

Embedding Tailscale (option B) is still blocked on mobile: `tsnet` is Go only and the mobile
wrappers are community projects.

**Effect on the case for the app:** D with real certificates also fixes certificate profiles and
"one app per address" for the **PWA**. That leaves native push, the workspace list, and E as the
app's own value. Check that this is still enough for guideline 4.2 (see Open questions) before
committing to the app.

## Services

The backend, relay, and DNS are chosen in `CTRLYOKE_ACCOUNTS_PLAN.md` ("Recommended services"):
Supabase, Fly.io, and Cloudflare. The app adds two accounts of its own:

- **Apple Developer Program** ($99/yr): App Store distribution and APNs.
- **Firebase project** (free): FCM for Android push. If keeping vendor count down ever matters
  more than the Postgres data model, this same project could also take over sign-in (see the
  Firebase row in that plan's alternatives table).

Push messages are sent by the backend, never by the user's machine, so a machine's credentials
never include push keys. The machine reports "awaiting input" or "run finished" to the backend
(event type and workspace only, no content), and the backend sends the push.

## Stack

Prefer **Capacitor** or **React Native with a WebView**: the shell is small, the team already
writes TypeScript/React, and the dashboard itself is web. Flutter or fully native Swift/Kotlin buy
nothing for a launcher plus WebView. Certificate pinning and push both need small native modules
in either stack.

## Open questions

- Pro-only, or free with remote access gated as it is today? The app is mostly a remote-access
  feature, so it naturally follows the existing remote-access entitlement.
- App Store review: an app that is mostly a WebView onto user-run servers needs enough native
  value (the list, pinning, push) to pass guideline 4.2 (minimum functionality).
- Does the signed-out QR-code path need its own local server list, or is sign-in required?
