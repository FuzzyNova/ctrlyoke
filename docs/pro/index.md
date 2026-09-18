# ctrlyoke Pro

ctrlyoke is source-available and the local product is free for individuals and
small businesses. Pro covers the remote-access features that let you use a
running workflow away from your development machine, plus support for
enterprise and air-gapped activation.

## Who needs a license?

Individuals and small businesses can use ctrlyoke's local features for free.

For commercial use, an organization needs Pro if it has **USD $10 million or
more in annual revenue or 250 or more employees**. Either threshold is enough;
the organization does not need to meet both. This applies even when the team
uses only the free local and localhost features. The threshold is a
contractual term, not an automatic technical check.

The full [ctrlyoke Commercial License](https://ctrlyoke.dev/terms) is the
authoritative text. This page is a plain-language summary, not legal advice.

## What Pro includes

- Remote and LAN dashboard access, including QR-to-phone connections.
- HTTPS and self-signed certificate generation for remote connections.
- Mobile push notifications.
- Air-gapped activation from a signed license file.
- Custom icon colors.
- Future Pro features included with the same perpetual license.
- Email support at [support@ctrlyoke.dev](mailto:support@ctrlyoke.dev).

Workflow execution, notifications inside the local app, custom hooks, the MCP
manager and integration, the agent and skills manager, AI commit messages, the
CLI, and the complete local/localhost dashboard remain free. All six supported
harnesses are included, with no workflow-step or workflow-count cap.

## Try remote access free

Each new installation includes a 14-day remote-access trial. No credit card or
account is required. After the trial, the local and `localhost` dashboard keeps
working for free; only remote reach requires Pro.

## Buy Pro

ctrlyoke Pro costs **$59 USD one time**. It is a perpetual license that includes
future Pro features and activates on up to 10 machines.

[**Get ctrlyoke Pro →**](https://ctrlyoke.dev/pricing/)

Lemon Squeezy is the checkout and Merchant of Record. Keygen is the licensing
backend that issues and validates ctrlyoke license keys and signed license
files. After checkout, the Netlify purchase webhook creates the Keygen license
and the key is delivered in a separate email.

## Activate online

This is the normal flow for a connected machine:

1. Purchase Pro, or retrieve the Keygen license key from your purchase email.
2. Open the VS Code Command Palette (`Ctrl/Cmd+Shift+P`).
3. Run **`ctrlyoke: Activate Pro License`**.
4. Paste the Keygen license key when prompted.
5. Confirm the success notification. Pro unlocks immediately; no restart is
   required.

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
   **`ctrlyoke: Activate Offline (Air-Gapped) License`**.
4. Choose the signed license file in the file picker. If you do not select a
   file, paste the complete signed license-file text when prompted.
5. Confirm the success notification.

The file's Ed25519 signature is checked locally against the embedded Keygen
public key. The import makes no network call. QR scanning is not part of the
current release; use the file picker or paste the file contents instead.

## Deactivate or manage a license

Run **`ctrlyoke: Deactivate Pro License`** on a machine you no longer use to
release its Keygen activation slot, then activate the license on another
machine. Run **`ctrlyoke: Manage License`** to see the current Free/Pro status;
the status is also visible in the VS Code status bar.

## Questions

- **Lost your key?** Contact [support@ctrlyoke.dev](mailto:support@ctrlyoke.dev).
- **Need team or enterprise licensing?** Contact
  [sales@ctrlyoke.dev](mailto:sales@ctrlyoke.dev).
