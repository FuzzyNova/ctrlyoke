# Connect from anywhere

The remote dashboard runs on your computer, not in the cloud. Your phone or
another computer opens a page that your computer serves, so it can only connect
while your computer is running ctrlyoke and can be reached over the network.
This page covers keeping it reachable, at home and away from home.

Remote access needs [Pro or the remote-access trial](/pro/). Remote desktop
into your own computer stays free; Pro covers opening the browser dashboard
from another device, including through a tunnel, port forward, or reverse
proxy you set up yourself. Start with
[Browser dashboard](/guide/remote-dashboard) if you haven't started the server
yet, and [Use ctrlyoke on your phone](/pro/mobile-setup) for certificates and
installing the app.

## What has to stay running

- **Your computer is on, awake and online.** A sleeping computer drops every
  connection, and closing a laptop's lid usually puts it to sleep. See
  [Keep your computer awake](#keep-your-computer-awake).
- **The server is running.** The VS Code server stops when that VS Code window
  closes. For a computer that serves the dashboard all day, run
  [`ctrlyoke server`](/cli/server) instead; it needs no VS Code window.
- **The server listens on all interfaces.** Set **Bind address** to **All
  interfaces (0.0.0.0)** on the Server tab, or pass `--bind 0.0.0.0` to
  `ctrlyoke server`.

Workflows and harness CLIs keep running on the computer whether or not a phone
is connected. Losing the connection only loses the view; reconnect and the
dashboard catches up.

## Keep your computer awake

**Windows 11:**

- **Settings → System → Power & battery → Screen, sleep & hibernate
  timeouts**: set **When plugged in, put my device to sleep after** to
  **Never**.
- On a laptop, **Control Panel → Hardware and Sound → Power Options → Choose
  what closing the lid does**: set **When I close the lid** under **Plugged
  in** to **Do nothing**.

**macOS:**

- **System Settings → Battery → Options** (laptops): turn on **Prevent
  automatic sleeping on power adapter when the display is off**. On a desktop
  Mac it's **System Settings → Energy → Prevent automatic sleeping when the
  display is off**.
- Or run `caffeinate -s` in a terminal for as long as you need the computer
  awake on power.
- A closed MacBook sleeps unless it's on power with an external display
  connected.

**Linux:** turn off automatic suspend in your desktop's power settings. To
keep the computer awake only while the server runs, including with the lid
closed, start it through systemd:

```sh
systemd-inhibit --what=sleep:handle-lid-switch ctrlyoke server --bind 0.0.0.0
```

A wired connection is more dependable than Wi-Fi for a computer you'll reach
remotely.

## On your home or office network

This works with no extra setup. Bind to all interfaces, put the phone on the
same network, and scan the QR code. If the computer has more than one address,
pick the one the phone can reach under **Connect via**.

If the phone can't connect:

- **Guest networks** often block devices from reaching each other. Use the main
  network.
- **Windows Firewall** asks the first time the server listens on the network.
  Allow it on private networks, and make sure your network is set to
  **Private** in **Settings → Network & internet**.

## From outside your network

Your router doesn't let the internet reach your computer, which is what you
want. To reach it from somewhere else, connect your phone to your network with
a VPN. Both options below keep ctrlyoke off the public internet.

### Recommended: Tailscale

[Tailscale](https://tailscale.com) is a VPN that needs no router setup. It
works even when your internet provider doesn't give you a public IP address.

1. Install Tailscale on your computer and your phone, and sign in to the same
   account on both.
2. Restart the ctrlyoke server, so it detects the computer's Tailscale address
   (it starts with `100.`). It appears under **Connect via**.
3. Optional but easier to remember: copy the computer's MagicDNS name from the
   Tailscale admin console (for example `my-pc.tail1234.ts.net`) into
   **Public hostname** on the Server tab. See
   [Public hostname](#public-hostname).
4. With HTTPS on, select **Generate self-signed certificate** again, restart
   the server, and install the new certificate on your phone. A certificate
   only covers the addresses and hostname that existed when you generated it.
5. Choose the Tailscale address or hostname under **Connect via**, then scan
   the QR code.

Turn Tailscale on in the phone whenever you're away from home. Tailscale
addresses also work at home while Tailscale is connected, so you can use the
same link everywhere.

### Your own VPN server

If you already run WireGuard or OpenVPN at home (many routers and NAS devices
have one built in), connect your phone to it. Once connected, the phone is on
your home network, so the same LAN address and QR code you use at home work
from anywhere.

Your router forwards only the VPN's port (WireGuard's default is UDP 51820,
OpenVPN's UDP 1194) to the VPN server. Don't forward ctrlyoke's port. If your
internet provider changes your home IP address, point a dynamic DNS name at it
for the VPN to connect to. This doesn't work when your provider puts you behind
carrier-grade NAT (no public IP address); use Tailscale then.

### Not recommended: forwarding ctrlyoke's port

::: danger
Forwarding the server's port puts ctrlyoke on the public internet. Anyone who
gets the link can control your computer: run workflows, use the terminal, and
read and change files in the workspace. The token in the link is the only
protection. Use a VPN instead.
:::

If you do it anyway:

1. Turn on HTTPS.
2. Give the computer a fixed LAN address (a DHCP reservation on your router).
3. Forward the same external port to the computer's server port (4747 by
   default). The link always uses the server's own port, so the external port
   must match.
4. Point a dynamic DNS name at your home IP address and enter it as the
   [public hostname](#public-hostname).
5. Generate the certificate again, restart the server, and install the new
   certificate on your phone.

Select **Regenerate token** on the Server tab if the link is ever exposed.

## Public hostname

**Public hostname** (`server.publicHostname`) on the Server tab is the name
your phone uses to reach your computer from elsewhere: a Tailscale MagicDNS
name, a dynamic DNS name, or a public IPv4 address. Enter just the name, with
no `https://`, port or path. The field appears when **Bind address** is **All
interfaces**. Like that bind address, it needs Pro or the remote-access trial;
without one, a saved name is ignored.

When it's set:

- **Connect via** lists it first and selects it by default, so the link and
  QR code use it. You can still pick a LAN address.
- **Generate self-signed certificate** adds it to the certificate. Generate
  the certificate again after changing it, restart the server, and install the
  new certificate on your phone. The Server tab warns when the certificate
  doesn't cover the address in **Connect via**.
- `ctrlyoke server` prints a `Public:` link and puts it in the terminal QR
  code.

## Install the app with the address you'll use everywhere

A home-screen app belongs to the address it was installed from. An app
installed from a LAN address like `192.168.1.20` can't reach your computer
through Tailscale, which uses a different address. Choose the address you'll
use away from home under **Connect via** before you scan the QR code and
install the app. With your own VPN server, the LAN address is that address.

## Troubleshooting

| Symptom                                                  | Check                                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Works at home, times out away from home                  | The phone's VPN is connected; the computer is awake; the link or app uses the Tailscale address or hostname, not a LAN address.                           |
| Stopped working after a while                            | The computer went to sleep, or the VS Code window closed. Use [`ctrlyoke server`](/cli/server) for a long-running server.                                 |
| Certificate warning on the Tailscale address or hostname | The certificate was generated before Tailscale was running or the hostname was set. Generate it again, restart the server, and reinstall it on the phone. |
| The Tailscale address isn't under Connect via            | Tailscale wasn't connected when the server started. Restart the server.                                                                                   |
| Push notifications arrive, but the app won't open runs   | Notifications travel through your browser's push service and reach the phone anywhere; opening the dashboard still needs the VPN connection.              |
