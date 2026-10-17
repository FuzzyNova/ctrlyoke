# Record of Processing Activities (GDPR / UK GDPR Article 30)

**Controller:** Fuzzy Nova LLC
**Started:** October 16, 2026
**Status:** Draft, to send to DataRep within 30 days of the Article 27 appointment starting (see
`dev/active/RELEASE_CHECKLIST.md` Phase 7).

This is the Article 30 record DataRep asks for, and it has to be available to a supervisory
authority on request. It is built from [`PRIVACY.md`](../../PRIVACY.md), [`DPA.md`](../../DPA.md)
and the code that runs in production (`src/utils/TelemetryReporter.ts`, `netlify/functions/`).
**Keep it in step with them:** when one of them changes what is collected, who receives it, or how
long it is kept, update this record in the same commit. Everything here is already public in those
documents, so nothing in it must be kept out of the repository.

Items marked **[pending]** or **[fill in]** are still open: actions only Nathan can take in a
vendor console, and details that come from DataRep's appointment documents.

---

## Part A — Controller record (Article 30(1))

### A.1 Controller, representative, DPO

| Field                      | Value                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller                 | Fuzzy Nova LLC, a Texas limited liability company (Texas SOS file number 806796772)                                                                                                                       |
| Address                    | 5518 Roosevelt Ave, Austin, TX 78756, USA                                                                                                                                                                 |
| Contact                    | `privacy@ctrlyoke.dev` (also `hello@fuzzno.com`)                                                                                                                                                          |
| Product                    | ctrlyoke: a VS Code extension, CLI and MCP server that run on the user's own machine, plus the `ctrlyoke.dev` website. ctrlyoke is a product of Fuzzy Nova LLC, not a separate entity or trade name.      |
| EU/EEA representative      | DataRep (Article 27). Package purchased October 16, 2026; appointment starts once the client questionnaire is accepted. **[fill in from DataRep's appointment documents: entity name, address, contact]** |
| UK representative          | DataRep UK, included in the same appointment. **[fill in from DataRep's appointment documents]**. Swiss representative cover is included too.                                                             |
| Data Protection Officer    | None appointed. Article 37 does not require one: no large-scale regular and systematic monitoring and no large-scale special-category processing.                                                         |
| Establishment in EU/EEA/UK | None                                                                                                                                                                                                      |

### A.2 What is out of scope

ctrlyoke is local-first. These run entirely on the user's machine or between the user and a third
party, so Fuzzy Nova LLC does not receive or process them:

- prompts, workflow files, source code, file contents and paths, workspace names, and AI output
- the harness CLIs (Claude Code, Copilot CLI, Codex, OpenCode, Qwen Code, Antigravity) and the AI
  services they call, which the user contracts with directly
- run history, logs, settings and secrets, all stored locally
- the hosted dashboard server and mobile push notifications, which run on the user's own computer
  and are sent from it
- the 14-day remote-access trial, tracked by a local timestamp only
- offline (air-gapped) license verification

### A.3 Processing activities

#### 1. Product telemetry

| Field                | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Purpose              | Product analytics, reliability, debugging, and feature planning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Legal basis          | Legitimate interests (Art. 6(1)(f)). Users can switch it off with VS Code's `telemetry.telemetryLevel`, which the extension respects.                                                                                                                                                                                                                                                                                                                                                                        |
| Data subjects        | Users of the VS Code extension who have telemetry enabled in VS Code                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Personal data        | Pseudonymous VS Code machine ID and per-launch session ID (added by `@vscode/extension-telemetry`); source IP address during ingestion and approximate location derived from it; extension, VS Code and OS versions; platform and architecture; remote-environment type. Event payloads (for example `workflow/started`, `workflow/completed`, `prompt/completed`, `endcondition/evaluated`, `extension/activationFailed`) hold harness IDs, counts, durations, feature flags, and outcome/error type names. |
| Not collected        | Prompts, code, file paths, workspace content                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Recipients           | Microsoft Azure Application Insights (processor), resource `ctrlyoke-telemetry`, East US                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Transfers            | Collected directly from users into the US. Microsoft's DPA (SCCs, and the EU-US Data Privacy Framework) covers the processor relationship. It applies to the Azure subscription automatically through the Product Terms.                                                                                                                                                                                                                                                                                     |
| Retention            | 90 days: Application Insights tables keep 90 days by default (free) in the linked Log Analytics workspace. **[pending: Nathan to confirm on the workspace's Tables blade that `AppEvents`/`AppExceptions` show 90 days]**                                                                                                                                                                                                                                                                                    |
| Volume and frequency | Continuous while the extension runs with telemetry on                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### 2. Pro license issuance, activation and verification

| Field         | Value                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Issue, deliver, activate, validate, refresh, deactivate, suspend (on refund) and support Pro licenses                                                                                                                                                                                                |
| Legal basis   | Performance of a contract (Art. 6(1)(b))                                                                                                                                                                                                                                                             |
| Data subjects | Pro purchasers and the people who activate their license                                                                                                                                                                                                                                             |
| Personal data | Name and email (license metadata); Lemon Squeezy order ID; license key and status; random machine fingerprint and machine name/platform; IP address and request metadata during online license operations                                                                                            |
| Recipients    | Keygen LLC (processor, US); Netlify, Inc. (processor, US, runs `ls-webhook`); Plus Five Five, Inc. / Resend (processor, US, license-key and refund emails)                                                                                                                                           |
| Transfers     | US processors under their DPAs: Keygen's Terms of Service are its DPA and rely on SCCs (copy on request from `legal@keygen.sh`); Netlify's DPA is incorporated in its Self-Serve Subscription Agreement; Resend's DPA, with SCCs, is incorporated in its Terms of Service. Checked October 16, 2026. |
| Retention     | Life of the license and as needed for enforcement, fraud prevention and support. Resend message data about 30 days.                                                                                                                                                                                  |

#### 3. Purchases, orders and Enterprise terms acceptance

| Field         | Value                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Fulfil purchases, issue receipts, keep tax and accounting records, and keep evidence of which Enterprise terms the customer accepted                                                                                                                                                                  |
| Legal basis   | Performance of a contract (Art. 6(1)(b)); legal obligation (Art. 6(1)(c)) for tax and accounting records                                                                                                                                                                                              |
| Data subjects | Purchasers; Enterprise signers acting for their company                                                                                                                                                                                                                                               |
| Personal data | Email, name, product, order and subscription IDs, billing country. Enterprise also: the legal entity's name, business address and registration number, signer name and email, accepted document versions, acceptance timestamp and method (held as Lemon Squeezy order custom data). No card numbers. |
| Recipients    | Lemon Squeezy (merchant of record, **independent controller** under its own buyer terms); Netlify (processor, webhook)                                                                                                                                                                                |
| Retention     | As required for tax, accounting and legal obligations; Enterprise acceptance records for the life of the agreement and afterwards as evidence                                                                                                                                                         |

#### 4. Enterprise renewal notices and abuse detection

| Field         | Value                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Email Enterprise buyers 30 days before renewal (`enterprise-renewal-reminder`); alert Fuzzy Nova when an Enterprise license's machine count passes a milestone, to detect a leaked or resold key (`keygen-webhook`)               |
| Legal basis   | Performance of a contract (renewal notice the Enterprise Terms promise); legitimate interests in preventing license abuse (alerts)                                                                                                |
| Data subjects | Enterprise buyers; indirectly the Authorized Users whose machines are counted                                                                                                                                                     |
| Personal data | Buyer name and email; subscription ID, status and renewal date; license machine count and the highest milestone alerted. The alert email to `support@ctrlyoke.dev` holds the order ID and time since purchase, not per-user data. |
| Recipients    | Keygen, Netlify, Resend (processors, US); Google Workspace for the alert email                                                                                                                                                    |
| Retention     | Life of the license                                                                                                                                                                                                               |

#### 5. Support, sales, billing, security and privacy correspondence

| Field         | Value                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Answer support, sales, billing, security and privacy requests, including data-subject requests                                                                                                                                   |
| Legal basis   | Legitimate interests; performance of a contract for customer support; legal obligation for data-subject requests                                                                                                                 |
| Data subjects | Anyone who emails a `@ctrlyoke.dev` address or `hello@fuzzno.com`                                                                                                                                                                |
| Personal data | Email address, name, message content, and whatever the sender includes                                                                                                                                                           |
| Recipients    | Google Workspace (processor, US, under its Cloud Data Processing Addendum, accepted October 16, 2026, with the EU Data Protection Law certification so the SCCs apply). DataRep forwards requests it receives as representative. |
| Retention     | As needed to resolve the inquiry and keep a record of correspondence                                                                                                                                                             |

#### 6. Website hosting

| Field         | Value                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Serve and secure `ctrlyoke.dev` and its docs                                                                                                                                                      |
| Legal basis   | Legitimate interests                                                                                                                                                                              |
| Data subjects | Website visitors                                                                                                                                                                                  |
| Personal data | IP address and request metadata in Netlify's server and security logs. The site has no analytics or tracking scripts.                                                                             |
| Recipients    | Netlify, Inc. (processor, US). DNS by Cloudflare.                                                                                                                                                 |
| Retention     | Function logs (the webhooks): 24 hours on the Netlify Free plan, with no setting to change it. Netlify's own security and request logs follow Netlify's retention, which isn't configurable here. |

### A.4 Special-category and criminal-offence data

None. No activity processes Article 9 or Article 10 data, and the DPA prohibits Enterprise customers
from submitting it.

### A.5 Technical and organizational security measures (Article 32)

Same as [`DPA.md`](../../DPA.md) Annex IV, applied to all activities above:

- data minimization: no workspace content leaves the user's machine
- a random machine fingerprint rather than hardware serials or hostnames
- TLS for every web, webhook, licensing and email API call
- Ed25519-signed license files verified locally; credentials kept in host secret storage
- vendor admin credentials and webhook secrets only in server-side environment configuration
- HMAC-SHA256 signature checks on Lemon Squeezy webhooks and Ed25519 checks on Keygen webhooks
- non-SMS MFA or passkeys on every vendor, hosting, email, source-control and deployment account
- vulnerability reports via `security@ctrlyoke.dev` (`SECURITY.md`); incident handling as in DPA
  Section 6

---

## Part B — Processor record (Article 30(2))

Fuzzy Nova LLC is a **processor** only for Enterprise licensing under [`DPA.md`](../../DPA.md).

| Field                    | Value                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Processor                | Fuzzy Nova LLC (details in A.1)                                                                             |
| Controllers              | Each Enterprise customer, as named in its Lemon Squeezy order. Current customers: **[list, or "none yet"]** |
| Categories of processing | Enterprise license issuance, delivery, activation, verification, renewal and administration (DPA Annex I)   |
| Sub-processors           | Keygen LLC, Netlify, Inc., Plus Five Five, Inc. (Resend): all US (DPA Annex II)                             |
| Transfers                | EU SCCs Module 2/3, UK Addendum and Swiss adaptations, as in DPA Section 12                                 |
| Security measures        | DPA Annex IV (A.5 above)                                                                                    |

---

## Change log

| Date       | Change                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | First draft, from `PRIVACY.md` v1.4, `DPA.md`, and the telemetry and Netlify function code. Telemetry enabled in CI builds. |
