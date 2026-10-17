# Trust & Security

**Last updated:** October 16, 2026

ctrlyoke is built by **Fuzzy Nova LLC**, a Texas limited liability company, and is designed local-first. This page explains what that means in practice, what data we do and don't handle, who we rely on to run the business, and how to reach us. It's meant to let your security or legal team review ctrlyoke without a call — if you need something this page doesn't answer, email `security@ctrlyoke.dev` or `privacy@ctrlyoke.dev`.

## Architecture: local-first by design

ctrlyoke runs your AI coding workflows on your own machine, against your own workspace, using the AI harnesses you already have installed (GitHub Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Antigravity CLI). The extension, its optional local dashboard, and the workflow engine all execute locally.

Except for the limited telemetry and license data described below, ctrlyoke does not intentionally transmit to Fuzzy Nova:

- prompt text or workflow content
- source code or file contents
- file paths or workspace/repository names
- AI model output or response text
- session IDs, run IDs, or workflow identifiers
- agent names, skill names, MCP server IDs, or end-condition script names
- other user-generated workspace content

The optional remote/LAN dashboard, when enabled, is served from your own machine to devices you authorize (e.g., your phone) — it does not route through ctrlyoke's infrastructure.

The companion CLI and MCP server binaries send no telemetry at all; the operational telemetry described below comes only from the VS Code extension, and only when VS Code's own telemetry setting permits it.

## What we do handle

A small, deliberately limited set of operational data keeps licensing, billing, and support working:

- **License administration** — a license key or signed license file, license status, a random pseudonymous machine fingerprint, operating-system platform, and (for online activation) the IP address and request metadata associated with activation, refresh, or deactivation. An offline signed-license-file path verifies the license locally without contacting Fuzzy Nova or Keygen. The 14-day remote-access trial included with each new installation is tracked by a local timestamp only — it needs no account and sends us nothing.
- **Purchase and billing** — your name, email, billing country, and order metadata, handled by our merchant of record, Lemon Squeezy. For Enterprise purchases, this also includes the Customer's legal entity name and business address and a record of the terms accepted at checkout. We never see or store full card numbers.
- **Transactional license email** — your name, email address, license key, activation instructions, and delivery metadata, processed by Resend to deliver the license credential after purchase.
- **Support and sales email** — whatever you send us at `support@`, `sales@`, `billing@`, `security@`, or `privacy@ctrlyoke.dev`.
- **Operational telemetry** — counts, durations, feature flags, and error/outcome types; messages and stack traces from unexpected extension errors, with file paths and other personal-looking values redacted by VS Code; pseudonymous VS Code machine, device, and per-launch session identifiers; and standard software, OS, architecture, UI, and remote-environment metadata. Azure also processes the source IP during ingestion and derives approximate location. This data is sent only if VS Code's own telemetry setting allows it. No workspace content ever flows through this channel.
- **Website and provisioning logs** — Netlify may process standard request, security, and serverless-function logs to host the website and the purchase-to-license provisioning webhook.

Full detail, including legal bases and retention periods, is in our [Privacy Policy](https://ctrlyoke.dev/privacy).

## Who we rely on

| Vendor                               | Role                                       |
| ------------------------------------ | ------------------------------------------ |
| Keygen                               | License issuance and verification          |
| Lemon Squeezy                        | Payments, merchant of record, tax handling |
| Resend                               | Transactional email (license-key delivery) |
| Netlify                              | Website and serverless-function hosting    |
| Google Workspace                     | Business and support email                 |
| Microsoft Azure Application Insights | Telemetry processing                       |

Each provider is disclosed in our [Privacy Policy](https://ctrlyoke.dev/privacy). The [Data Processing Agreement](https://ctrlyoke.dev/dpa) separately identifies the Sub-processors used when we process Customer Personal Data on an Enterprise customer's behalf, and commits us to giving Enterprise customers at least 30 days' notice before a new or replacement Sub-processor starts processing, with a right to object. Other providers, such as Lemon Squeezy in its merchant-of-record role, may act as independent controllers under their own terms.

## Licensing security

- **Offline-verifiable licenses.** License files are signed with Ed25519 and verified entirely on your machine — checking the signed file does not contact Fuzzy Nova or Keygen.
- **Bounded blast radius.** Every license, including Enterprise's unlimited-Authorized-User site license, carries a finite machine-activation ceiling. Keygen records online machine activations, so a leaked key produces a bounded event that we can investigate and address. An individual Pro license activates on up to 10 machines. The standard Enterprise ceiling is 3,000 active machines; legitimate deployments can request a reasonable increase under the Enterprise Subscription Terms, with no additional per-seat fee.
- **Fast revocation and reissue.** If a license needs to be suspended (fraud, chargeback, sharing outside your organization), we can suspend and reissue through our licensing dashboard without any code deploy.

## Distribution and code review

ctrlyoke ships through the official VS Code Marketplace. The Marketplace signs published extensions, and VS Code verifies the package signature at installation to check package integrity and source. The source code is available at our [canonical GitHub repository](https://github.com/FuzzyNova/ctrlyoke) under a source-available commercial license (see [Terms](https://ctrlyoke.dev/terms)); you may inspect it, use GitHub's built-in fork functionality, and make an internal, non-redistributed copy as permitted by that license to verify our data-handling claims. ctrlyoke is source-available, not open source. Third-party open-source components shipped with the extension, and their licenses, are listed in `THIRD_PARTY_NOTICES.md` in that repository.

## Reporting a vulnerability

Please don't file a public GitHub issue for a security vulnerability. Email `security@ctrlyoke.dev` with a description, reproduction steps, and the ctrlyoke/VS Code version you tested. We'll acknowledge promptly and keep you updated as we investigate. See our [Security Policy](https://github.com/FuzzyNova/ctrlyoke/security/policy) for full detail.

## Compliance posture

ctrlyoke is a small, focused business — we don't yet hold formal certifications like SOC 2 or ISO 27001. What we do instead is design for minimal data exposure in the first place: most of what a compliance audit would scrutinize (workspace content, prompts, source code) never reaches us at all, because the architecture doesn't send it. For enterprise reviews, we offer a standard [Data Processing Agreement](https://ctrlyoke.dev/dpa) and can complete reasonable security questionnaires — email `security@ctrlyoke.dev`.

## Legal documents

- [Terms / Commercial License](https://ctrlyoke.dev/terms)
- [Enterprise Subscription Terms](https://ctrlyoke.dev/enterprise-terms)
- [Privacy Policy](https://ctrlyoke.dev/privacy)
- [Data Processing Agreement](https://ctrlyoke.dev/dpa)

## Contact

**Security:** `security@ctrlyoke.dev`
**Privacy:** `privacy@ctrlyoke.dev`
**Sales / procurement:** `sales@ctrlyoke.dev`
**Postal:** Fuzzy Nova LLC, 5518 Roosevelt Ave, Austin, TX 78756, USA

---

Copyright © 2026 Fuzzy Nova LLC. All rights reserved.
