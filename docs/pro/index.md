# ctrlyoke Pro

ctrlyoke is source-available and the local product is free for individuals and
small businesses. Pro covers the remote-access features that let you use a
running workflow away from your development machine, plus support for
enterprise and air-gapped activation.

## Who needs a license?

Individuals and small businesses can use ctrlyoke's local features for free.

For commercial use, every user at an organization with **USD $10 million or
more in annual revenue or 250 or more employees** needs a Pro license, either a
personal Pro license or an enterprise license that covers them. Either
threshold is enough; the organization does not need to meet both. This applies
even when the team uses only the free local and localhost features. Students
and non-commercial academic research are exempt. The threshold is a
contractual term, not an automatic technical check.

The full [ctrlyoke Commercial License](https://ctrlyoke.dev/terms) is the
authoritative text. This page is a plain-language summary, not legal advice.

## What Pro includes

- Remote and LAN dashboard access, including QR-to-phone connections,
  [installing ctrlyoke as an app on your phone](./mobile-setup.md), and
  [connecting from anywhere](./remote-access.md) over Tailscale or your own
  VPN.
- HTTPS and self-signed certificate generation for remote connections.
- Browser and mobile push notifications.
- Air-gapped activation from a signed license file.
- Custom icon colors.
- Future Pro features included with the same perpetual license.
- Email support at [support@ctrlyoke.dev](mailto:support@ctrlyoke.dev).

Workflow execution, notifications inside the local app, custom hooks, the MCP
manager and integration, the agent and skills manager, AI commit messages, the
CLI, and the complete local/localhost dashboard remain free. All six supported
harnesses are included, with no workflow-step or workflow-count cap.

## Try remote access free

Each new installation includes a one-time 14-day remote-access trial. The 14 days
start when a browser or phone first connects from another device, not when you
install ctrlyoke or open the dashboard. No credit card or account is required. After the trial, the local and `localhost` dashboard keeps
working for free; only remote reach requires Pro.

## Buy Pro

ctrlyoke Pro costs **$59 USD one time**. It is a perpetual license that includes
future Pro features and activates on up to 10 machines. It comes with a 30-day
money-back guarantee: email `billing@ctrlyoke.dev` within 30 days of purchase for
a full refund, and the license is deactivated when the refund is processed.

[**Get ctrlyoke Pro →**](https://ctrlyoke.dev/pricing/)

Lemon Squeezy is the checkout and Merchant of Record. Keygen is the licensing
backend that issues and validates ctrlyoke license keys and signed license
files. After checkout, your license key arrives in a separate email.

## Activate online

This is the normal flow for a connected machine:

1. Purchase Pro, or retrieve the Keygen license key from your purchase email.
2. Open the VS Code Command Palette (`Ctrl/Cmd+Shift+P`).
3. Run **`ctrlyoke: Activate Pro License`**. This opens the **License** tab of
   the dashboard's Settings.
4. Paste the key into **Activate with license key** and click **Activate**.
5. Confirm the success message. Pro unlocks immediately; no restart is
   required.

If the key is already active on its maximum number of machines, the License tab
lists the **Activated machines** so you can deactivate one you no longer use
and retry.

Online activation registers the current machine with Keygen and caches a
cryptographically signed license file for offline verification and short
connectivity gaps.

## Activate on an air-gapped machine

Use this flow when the development machine cannot reach the internet:

1. On a connected device, open the [ctrlyoke offline license file generator](https://ctrlyoke.dev/license/offline/)
   and enter the Keygen license key from your purchase email. For an Enterprise deployment, you can
   instead obtain the signed license file from your organization's Keygen administrator.
2. Transfer the file to the air-gapped machine using your approved removable
   media process.
3. In VS Code, open the Command Palette and run
   **`ctrlyoke: Activate Offline (Air-Gapped) License`**, then choose the
   signed license file in the file picker. Alternatively, open the **License**
   settings tab and paste the complete file text (starting with
   `-----BEGIN LICENSE FILE-----`) under **Import offline license file**, then
   click **Import license file**.
4. Confirm the success notification.

The file's Ed25519 signature is checked locally against the embedded Keygen
public key. The import makes no network call. QR scanning is not part of the
current release; use the file picker or paste the file contents instead.

## Deactivate or manage a license

**`ctrlyoke: Deactivate Pro License`** and **`ctrlyoke: Manage License`** both
open the **License** settings tab, which shows the current Free/Pro status and
any remaining trial days. Click **Deactivate Pro License** there on a machine
you no longer use to release its activation slot, then activate the license on
another machine. For an online license, the **Activated machines** list also
lets you free a slot held by a different machine. The tier is also shown in the
ctrlyoke item in the VS Code status bar.

## Questions

- **Lost your key?** Contact [support@ctrlyoke.dev](mailto:support@ctrlyoke.dev).
- **Need team or enterprise licensing?** Contact
  [sales@ctrlyoke.dev](mailto:sales@ctrlyoke.dev).
