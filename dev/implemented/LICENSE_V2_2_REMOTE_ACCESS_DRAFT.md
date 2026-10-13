# LICENSE v2.2 draft — remote desktop vs. remote dashboard access

**Status:** Draft for attorney review. Not in effect; `LICENSE.md` v2.1 governs until counsel
approves a replacement.

## Goal

Draw the Free/Pro line by **where the dashboard is rendered**, not by whether the user is
physically at the computer:

- **Free:** operating the one computer running ctrlyoke from somewhere else, through remote
  desktop, screen sharing, or a remote shell. The Software and any dashboard it shows run and
  render on that computer; only its screen and input travel over the network.
- **Pro (or trial):** opening the browser dashboard that ctrlyoke's built-in server hosts from
  a browser or other client on **any other device**, however the connection is made — ctrlyoke's
  own all-interfaces binding, a VPN, port forwarding, a reverse proxy, or a tunnel.

## Why v2.1 needs changing

1. **Remote desktop is ambiguous today.** §1 lists "remote and LAN dashboard access" as Pro and
   "the local and `localhost` dashboard" as Free. A user who remote-desktops into their PC and
   opens `localhost` in that PC's browser is arguably doing "remote dashboard access". We want that
   to be clearly Free.
2. **Proxies and tunnels are ambiguous today.** ctrlyoke refuses to bind to all interfaces without
   a license, so the practical workaround is an outside tool that relays the localhost server to
   another device (`tailscale serve`, SSH port forwarding, a reverse proxy, `netsh portproxy`,
   ngrok). A user could argue that is their tool, not a ctrlyoke "capability", and §4(d) already
   says "LAN-accessible setups for Your own internal access" are permitted. We want that to be
   clearly Pro.

The single test that resolves both: **does a client on another device send network requests to
the Software's built-in server?** If yes, it is Remote Dashboard Access (Pro). If the only thing
leaving the Host Machine is its screen, it is a Remote Session (Free).

## Proposed changes

### Header

> **Effective Date:** [DATE]
> **Version:** 2.2

### §1 Definitions — add four definitions

> **"Host Machine"** means the single physical or virtual computer on which a given installation
> of the Software is running.
>
> **"Hosted Dashboard"** means the browser-based dashboard served by the Software's built-in web
> server, whether started from the VS Code extension or the companion CLI (for example, through
> `ctrlyoke server`). It does not include the dashboard panel displayed inside Visual Studio Code
> itself.
>
> **"Remote Dashboard Access"** means loading or interacting with the Hosted Dashboard from a
> browser, application, or other client running on any device other than the Host Machine, by any
> means, including binding the Software's server to a network interface, a virtual private
> network, port forwarding, a reverse proxy, or a tunnel or other mechanism that relays the Hosted
> Dashboard's network traffic to another device.
>
> **"Remote Session"** means operating the Host Machine from another device through a remote
> desktop, screen-sharing, or remote command-line session (for example, Windows Remote Desktop,
> VNC, macOS Screen Sharing, or SSH), in which the Software, and any browser displaying the Hosted
> Dashboard, run on the Host Machine, and only that machine's display, input, or terminal output
> is transmitted to the other device. A Remote Session is not Remote Dashboard Access.

### §1 "Pro Tier" — replace the capability sentences

Current:

> Pro Tier capabilities currently include remote and LAN dashboard access, HTTPS and self-signed
> certificate generation for remote connections, browser and mobile push notifications, air-gapped
> activation from a signed license file, and custom icon colors, together with any future
> capabilities designated as Pro by Licensor. Capabilities not designated as Pro remain available
> under the Free Tier, including workflow execution, custom execution hooks, the MCP and agent
> managers, the companion CLI and MCP server binaries, and the local and `localhost` dashboard.

Proposed:

> Pro Tier capabilities currently include Remote Dashboard Access, HTTPS and self-signed
> certificate generation for remote connections, browser and mobile push notifications, air-gapped
> activation from a signed license file, and custom icon colors, together with any future
> capabilities designated as Pro by Licensor. Capabilities not designated as Pro remain available
> under the Free Tier, including workflow execution, custom execution hooks, the MCP and agent
> managers, the companion CLI and MCP server binaries, and the dashboard and Hosted Dashboard when
> viewed on the Host Machine, including on the Host Machine during a Remote Session.

### §2(d) Evaluation Trial — use the defined term

Current: "a one-time, fourteen (14) day evaluation trial of remote dashboard access"

Proposed: "a one-time, fourteen (14) day evaluation trial of Remote Dashboard Access"

(The code already starts the trial clock on the first remote client, which matches this.)

### §4(c) Circumvent licensing — name relaying explicitly

Proposed (new second sentence; the rest unchanged):

> Circumvent, disable, or defeat the Software's license verification mechanisms, or use Pro Tier
> capabilities without either a valid, unrevoked Pro License or an active Evaluation Trial. **For
> clarity, Remote Dashboard Access obtained by relaying the Hosted Dashboard to another device
> through a proxy, tunnel, port forward, or similar mechanism, rather than through the Software's
> own settings, is use of a Pro Tier capability.** You may not restart, extend, or obtain more than
> one Evaluation Trial for the same installation, user, or machine.

### §4(d) Hosted service — stop the "LAN-accessible" carve-out from implying a Free right

Current:

> For clarity, using the Software locally, or on Your own private devices or private network, to
> automate Your own development workflows is permitted, including use in LAN-accessible setups for
> Your own internal access, so long as it is not offered to third parties as a service.

Proposed:

> For clarity, using the Software locally, or on Your own private devices or private network, to
> automate Your own development workflows is permitted, including Remote Sessions and, subject to
> Section 2(c) or 2(d), Remote Dashboard Access for Your own internal access, so long as it is not
> offered to third parties as a service.

## Questions for counsel

1. **The "where it renders" test.** Is "a client on another device sends requests to the built-in
   server" a clear, enforceable line? Any better wording for the Remote Session definition so it
   doesn't read as a list of brand names?

   **answer:** Use the location of the _client that accesses the built-in server_ as the
   operative distinction, rather than the location of the human or the server's apparent socket
   peer. The draft's device-based definition covers a local browser operated through remote
   desktop (Free) and an off-device browser using a tunnel (Pro). It should expressly cover an
   indirect request where a relay on the Host Machine makes the final request to `localhost`.
   "Where it renders" is a useful shorthand, but it is not the legal test for the VS Code panel
   discussed below. Shorten Remote Session to: "operating the Host Machine through
   a remote display, input, or command-line connection, while any client of the Hosted Dashboard
   runs on the Host Machine and no client on another device accesses the Hosted Dashboard, directly
   or through a relay." This avoids product-name examples. Please check the meaning of "Host
   Machine" for WSL, containers, and VMs that share physical hardware with a browser.

   **Implementation fact for counsel:** the current server allows a request with a loopback socket
   address without checking Pro (`src/server/CtrlYokeHostedServer.ts`, `isClientAllowed`). An
   external relay terminating on localhost can therefore look local to the server. The contract
   can describe such use as Pro, but the current gate may neither block it nor start the trial.
   The statement above that "the code already starts the trial clock on the first remote client"
   applies to clients the server sees as non-loopback; it does not cover every proxied client.

2. **VS Code remote development.** With VS Code Remote-SSH, WSL, or Dev Containers, the extension
   runs on the remote machine and its panel renders on the local one through VS Code's own channel.
   The draft treats that panel as outside "Hosted Dashboard", so it stays Free. VS Code can also
   auto-forward the remote machine's localhost ports, which would carry the Hosted Dashboard to the
   local browser; the draft treats that as Remote Dashboard Access. Is that distinction sound, and
   should the license say it explicitly?

   **answer:** Yes, this matches the intended product boundary. The VS Code panel uses
   VS Code's webview channel and is expressly excluded from "Hosted Dashboard"; a separate browser
   opening a forwarded ctrlyoke server port is a client of the Hosted Dashboard on another device.
   VS Code's [remote-extension documentation](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
   says webviews run in the local UI even when the workspace extension runs remotely, and its
   [Remote-SSH tutorial](https://code.visualstudio.com/docs/remote/ssh-tutorial) describes opening
   a forwarded remote port in a local browser. Consider adding one sentence to the
   Hosted Dashboard definition saying the VS Code panel remains excluded when displayed through
   VS Code remote development. That would make this common case easier to explain without changing
   the proposed Pro boundary. The same-machine WSL/container case still needs the Host Machine
   clarification raised in answer 1.

3. **Shared Host Machines.** Several people in their own Remote Sessions on one shared server
   (for example, a Windows terminal server) — each is a separate user under §3 eligibility; is
   anything more needed?

   **answer:** The current text already applies the organization threshold to each
   individual user and requires a Pro License for each authorized user using Pro capabilities
   under §2(c). A shared machine and multiple remote desktop sessions should not change either
   rule. If the organization meets the §3(b) threshold, each affiliated user still needs Pro even
   for Free Tier capabilities. Counsel should confirm whether a sentence is needed to prevent
   "one installation" or "one Host Machine" from being misread as one license covering all users,
   especially for personal license activations and the one-trial-per-installation rule.

4. **Tightening vs. §16(e).** v2.2 is broader than v2.1 for remote desktop but narrower for
   proxies and tunnels. §16(e) says the version in effect when a user obtained their copy governs.
   Since nothing has been publicly released under v2.1 yet, can we simply replace it before launch,
   or does the change need notice to existing private/trial installs?

   **answer:** Treat v2.2 as governing new copies only once it is approved and published.
   Section 16(e) itself says an earlier version governs an earlier copy unless its user adopts a
   later version. A public launch date alone does not establish that no one obtained a copy under
   v2.1: first inventory private builds, trial installs, VSIX deliveries, repository access, and
   any acceptance or purchase records, then ask counsel how to handle those users. If no v2.1 copy
   was ever supplied or accepted, there may be no existing v2.1 licensee to notify. If any were,
   do not assume a silent file replacement binds them to the tighter proxy/tunnel term. An
   [appellate opinion on changed online terms](https://cdn.ca9.uscourts.gov/datastore/opinions/2007/07/18/0675424.pdf)
   illustrates why notice and assent may matter

5. **Consumer-protection angle.** Are the Pro marketing claims ("code from anywhere") consistent
   with Free users legitimately reaching their machine by remote desktop, or does the pricing page
   need wording that Pro is about the browser and mobile dashboard specifically?

   **answer:** Change the pricing copy before the new license is published. "Code from
   anywhere" is literally compatible with remote desktop, but it can imply that remote access of
   _any_ kind is Pro; the current pricing FAQ also calls the trial a trial of "remote access."
   Suggested nearby copy: "Browser dashboard on your phone or another device, over LAN or VPN" for
   Pro, and "Remote desktop into your own computer remains Free for eligible users" in the FAQ.
   Explain that third-party port forwarding or tunneling of the Hosted Dashboard is still Pro.
   The [FTC's advertising guidance](https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business)
   advises clear, unambiguous qualifications close to the claim.

## Follow-ups once approved (not before)

- Update `LICENSE.md` (the landing `/terms` page imports it directly, so it follows).
- Add a short "Remote desktop is free" note to `docs/pro/remote-access.md` and the pricing FAQ.
- Check `LICENSE_UI` upsell strings and `docs/guide/remote-dashboard.md` use "browser dashboard
  on another device" rather than "remote access" where the distinction matters.
