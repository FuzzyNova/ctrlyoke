# Trust & Security

**DRAFT — for review before publishing at ctrlyoke.dev/trust.**

ctrlyoke is built local-first. This page explains what that means in practice, what data we do and don't handle, who we rely on to run the business, and how to reach us. It's meant to let your security or legal team review ctrlyoke without a call — if you need something this page doesn't answer, email `security@ctrlyoke.dev` or `privacy@ctrlyoke.dev`.

## Architecture: local-first by design

ctrlyoke runs your AI coding workflows on your own machine, against your own workspace, using the AI harnesses you already have installed (GitHub Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Antigravity CLI). The extension, its optional local dashboard, and the workflow engine all execute locally.

We do not intentionally collect, transmit, or store:

- prompt text or workflow content
- source code or file contents
- file paths or workspace/repository names
- AI model output or response text
- session IDs, run IDs, or workflow identifiers
- agent, skill, or MCP server names
- any other user-generated string content

The optional remote/LAN dashboard, when enabled, is served from your own machine to devices you authorize (e.g., your phone) — it does not route through ctrlyoke's infrastructure.

## What we do handle

A small, deliberately limited set of operational data keeps licensing, billing, and support working:

- **License administration** — a license key or signed license file, license status, a machine fingerprint, and (for online activation) the IP address used during activation, refresh, or deactivation. An offline signed-license-file path exists for air-gapped verification with zero network calls.
- **Purchase and billing** — your name, email, billing country, and order metadata, handled by our merchant of record, Lemon Squeezy. We never see or store full card numbers.
- **Support and sales email** — whatever you send us at `support@`, `sales@`, `billing@`, `security@`, or `privacy@ctrlyoke.dev`.
- **Operational telemetry** — counts, durations, feature flags, and error/outcome types, tied to a VS Code machine identifier, sent only if VS Code's own `telemetry.telemetryLevel` setting allows it. No workspace content ever flows through this channel.

Full detail, including legal bases and retention periods, is in our [Privacy Policy](https://ctrlyoke.dev/privacy).

## Who we rely on

| Vendor | Role |
| --- | --- |
| Keygen | License issuance and verification |
| Lemon Squeezy | Payments, merchant of record, tax handling |
| Resend | Transactional email (license-key delivery) |
| Netlify | Website hosting |
| Google Workspace | Business and support email |
| Microsoft Azure Application Insights | Telemetry processing |

Each is a named sub-processor in our [Privacy Policy](https://ctrlyoke.dev/privacy) and [Data Processing Agreement](https://ctrlyoke.dev/dpa).

## Licensing security

- **Offline-verifiable licenses.** License files are signed with Ed25519 and verified entirely on your machine — no network call required to check validity.
- **Bounded blast radius.** Every license, including Enterprise's "unlimited seats" site license, carries a real, finite machine-activation ceiling. A leaked key produces a bounded, detectable event, not unlimited unauthorized use — we can see and act on it.
- **Fast revocation and reissue.** If a license needs to be suspended (fraud, chargeback, sharing outside your organization), we can suspend and reissue through our licensing dashboard without any code deploy.

## Distribution and code review

ctrlyoke ships through the official VS Code Marketplace, which signs and verifies every published version. The source code is available at our [canonical GitHub repository](https://github.com/FuzzyNova/ctrlyoke) under a source-available commercial license (see [Terms](https://ctrlyoke.dev/terms)) — you're welcome to read it, fork it for internal review, and verify our data-handling claims yourself.

## Reporting a vulnerability

Please don't file a public GitHub issue for a security vulnerability. Email `security@ctrlyoke.dev` with a description, reproduction steps, and the ctrlyoke/VS Code version you tested. We'll acknowledge promptly and keep you updated as we investigate. See our [Security Policy](https://github.com/FuzzyNova/ctrlyoke/security/policy) for full detail.

## Compliance posture

ctrlyoke is a small, focused company — we don't yet hold formal certifications like SOC 2 or ISO 27001. What we do instead is design for minimal data exposure in the first place: most of what a compliance audit would scrutinize (workspace content, prompts, source code) never reaches us at all, because the architecture doesn't send it. For enterprise reviews, we offer a standard [Data Processing Agreement](https://ctrlyoke.dev/dpa) and can complete reasonable security questionnaires — email `security@ctrlyoke.dev`.

## Legal documents

- [Terms / Commercial License](https://ctrlyoke.dev/terms)
- [Enterprise Subscription Terms](https://ctrlyoke.dev/enterprise-terms)
- [Privacy Policy](https://ctrlyoke.dev/privacy)
- [Data Processing Agreement](https://ctrlyoke.dev/dpa)

## Contact

**Security:** `security@ctrlyoke.dev`
**Privacy:** `privacy@ctrlyoke.dev`
**Sales / procurement:** `sales@ctrlyoke.dev`
