# DataRep Client Questionnaire: Pre-filled Answers

**Purpose:** answers for DataRep's one-page client questionnaire, which starts the GDPR Article 27
(EU/EEA) and UK representative appointment. Reuse them for the annual renewal questionnaire.
**Prepared:** October 16, 2026, before the questionnaire arrived. DataRep's actual questions may be
worded or grouped differently; map these answers onto them.
**Source of truth:** [`GDPR_RECORD_OF_PROCESSING.md`](GDPR_RECORD_OF_PROCESSING.md) (the Article
30 record) and [`PRIVACY.md`](../../PRIVACY.md). If an answer here disagrees with them, they win.
**Tracking:** `dev/active/RELEASE_CHECKLIST.md` Phase 7.

Answer from actual production behavior. If a fact changes before you submit, report the change to
DataRep rather than keeping the cheaper tier: DataRep relies on these declarations, and an
inaccurate one can invalidate the appointment back to its start.

Items marked **[pending]** are still open.

---

## Package

- **Package:** Small Company, No Sensitive Data (€150/year), bought October 16, 2026
- **Coverage requested:** EU/EEA representative **and** UK representative. DataRep's service page
  says the UK appointment is included at no extra cost.
- **Swiss representative:** yes. It came with the package at no extra cost.

## Organization

| Question                     | Answer                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Legal name                   | Fuzzy Nova LLC                                                                                           |
| Entity type and jurisdiction | Limited liability company, Texas, USA (Texas SOS file number 806796772)                                  |
| Trading names                | None. ctrlyoke is a product of Fuzzy Nova LLC, not a trade name or DBA.                                  |
| Registered/business address  | 5518 Roosevelt Ave, Austin, TX 78756, USA                                                                |
| Privacy contact              | `privacy@ctrlyoke.dev`                                                                                   |
| Main contact for DataRep     | Nathan Hickey, `privacy@ctrlyoke.dev`                                                                    |
| Website                      | https://ctrlyoke.dev (privacy policy: https://ctrlyoke.dev/privacy)                                      |
| Employees                    | 1 (the sole member, who builds and runs everything)                                                      |
| Establishment in EU/EEA/UK   | None                                                                                                     |
| Data Protection Officer      | None (not required under Article 37)                                                                     |
| Role                         | Controller for everything below; also a processor for Enterprise customers' licensing data under its DPA |

## Product and activities

> ctrlyoke is a developer tool: a VS Code extension, CLI and MCP server that run on the user's own
> machine and automate AI coding assistants through workflow files. It is local-first: prompts,
> code, file contents and AI output stay on the user's machine and are never sent to us. The free
> tier needs no account. Pro is a one-time $59 license; Enterprise is a $4,499/year company
> subscription. Lemon Squeezy is our merchant of record. We sell worldwide from ctrlyoke.dev.

**Countries targeted:** worldwide, including the EU/EEA and UK. Listed on the VS Code Marketplace and
npm; prices in USD; English only.

## Data subjects

| Question               | Answer                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Categories             | Extension users with telemetry enabled; Pro and Enterprise purchasers and license users; Enterprise signers; support/sales/privacy correspondents; website visitors                                                                                         |
| EU/EEA/UK count        | Not launched yet, so effectively zero today and no usage history to estimate from. We expect fewer than 1,000 in the first year and will track the count from telemetry (see "Monitoring the 1,000 limit" below), upgrading the package before we reach it. |
| Children               | None. Professional tool, not directed at children.                                                                                                                                                                                                          |
| Vulnerable individuals | None                                                                                                                                                                                                                                                        |

## Personal data

| Question                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Categories                      | Name and email; license key and status; random machine fingerprint, machine name and OS platform; IP address during license operations and telemetry ingestion, and approximate location derived from it; order and subscription IDs; Enterprise company name, address, registration number and terms-acceptance record; support email content; website server logs                                                                                                                                                 |
| Telemetry                       | Enabled in released builds through VS Code's telemetry library (respects `telemetry.telemetryLevel`) and Azure Application Insights: usage counts and durations, feature flags, error types, messages and stack traces from unexpected extension errors (file paths and other personal-looking values redacted by VS Code), software and OS metadata, pseudonymous VS Code machine, device and session IDs. IP addresses are masked at ingestion; only the derived country is kept. No code, prompts or file paths. |
| Special-category data (Art. 9)  | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Criminal-offence data (Art. 10) | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Payment card data               | Not received; Lemon Squeezy handles payment                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Profiling / automated decisions | None with legal or similarly significant effects. Telemetry is used in aggregate for product analytics.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Marketing / advertising         | No marketing email lists; no selling or sharing for advertising; no analytics or tracking on the website                                                                                                                                                                                                                                                                                                                                                                                                            |

## Purposes and legal bases

| Purpose                                                | Legal basis                    |
| ------------------------------------------------------ | ------------------------------ |
| Issue, activate, verify and support licenses           | Contract                       |
| Process purchases; tax and accounting records          | Contract; legal obligation     |
| Product telemetry (analytics, reliability, debugging)  | Legitimate interests           |
| Detect license abuse (Enterprise machine-count alerts) | Legitimate interests           |
| Support, sales and privacy correspondence              | Legitimate interests; contract |
| Website hosting and security                           | Legitimate interests           |

## Retention

- Telemetry: about 90 days (Azure Application Insights)
- License and activation records: life of the license, plus as needed for enforcement and support
- Purchase records: as required for tax and accounting
- Transactional email (Resend): about 30 days
- Support email: as needed to resolve the inquiry
- Enterprise terms-acceptance records: life of the agreement, then as needed as evidence
- Webhook function logs (Netlify): 24 hours on the Free plan. Netlify's own security and request logs
  follow Netlify's retention.

## Vendors and transfers

All processing happens in the United States. Data is collected directly from users by a US
controller. Each processor's DPA, and how it applies (checked October 16, 2026):

- **Microsoft Azure:** the Microsoft Products and Services DPA is part of the Product Terms for Azure
  services, so it applies to the subscription automatically.
- **Netlify:** its DPA is incorporated by reference in the Self-Serve Subscription Agreement.
- **Resend:** its DPA (with SCCs) is incorporated into its Terms of Service.
- **Keygen:** its Terms of Service are its DPA, it relies on SCCs, and it won't sign customer DPAs.
  A copy can be requested from `legal@keygen.sh`.
- **Google Workspace:** the Cloud Data Processing Addendum is opt-in. It was accepted by the super
  admin on October 16, 2026, and the "EU Data Protection Law applies" certification was made so the
  Standard Contractual Clauses apply.
- **Lemon Squeezy:** an independent controller, so no DPA is needed.

| Vendor                               | Role                                        | Purpose                             |
| ------------------------------------ | ------------------------------------------- | ----------------------------------- |
| Microsoft Azure Application Insights | Processor                                   | Telemetry (East US)                 |
| Keygen LLC                           | Processor                                   | License issuance and verification   |
| Lemon Squeezy                        | Independent controller (merchant of record) | Payments, tax, receipts             |
| Plus Five Five, Inc. (Resend)        | Processor                                   | License-key and transactional email |
| Netlify, Inc.                        | Processor                                   | Website and webhook hosting         |
| Google Workspace                     | Processor                                   | Business email                      |

## Security and incidents

- **Security measures:** the measures in [`DPA.md`](../../DPA.md) Annex IV, published at https://ctrlyoke.dev/dpa
  and summarized at https://ctrlyoke.dev/trust
- **Personal data breaches to date:** none. ctrlyoke hasn't launched publicly yet: the VS Code
  extension isn't public and the npm CLI was published ahead of launch.
- **Complaints or regulator contact to date:** none

## Monitoring the 1,000 limit

The package covers at most 1,000 EU/EEA/UK people. Telemetry users are the largest group, so count
distinct VS Code machine IDs by country in the Log Analytics workspace behind `ctrlyoke-telemetry`
(Logs blade). Buyers are a small subset of these.

```kusto
let europe = dynamic(["Austria","Belgium","Bulgaria","Croatia","Cyprus","Czechia","Denmark",
  "Estonia","Finland","France","Germany","Greece","Hungary","Ireland","Italy","Latvia",
  "Lithuania","Luxembourg","Malta","Netherlands","Poland","Portugal","Romania","Slovakia",
  "Slovenia","Spain","Sweden","Iceland","Liechtenstein","Norway","United Kingdom"]);
AppEvents
| where TimeGenerated > ago(90d)
| where ClientCountryOrRegion in (europe)
| summarize people = dcount(tostring(Properties["common.vscodemachineid"])) by ClientCountryOrRegion
| order by people desc
```

This only looks back as far as the telemetry retention (about 90 days), so run it quarterly and
note the totals here. Upgrade the DataRep package before the total nears 1,000. If the query
returns nothing, check the machine ID's property name on a sample `AppEvents` row.

## Article 30 record

Available: [`GDPR_RECORD_OF_PROCESSING.md`](GDPR_RECORD_OF_PROCESSING.md). Send it with the
questionnaire, or within 30 days of the appointment starting as DataRep's FAQ asks.

## What to ask DataRep for

When submitting, ask them to send back:

1. Written confirmation that the appointment covers **both** EU/EEA and UK, and its start date.
2. The executed appointment documents for each.
3. The exact wording and contact details (entity names, addresses, email or web-form route) to
   publish in the privacy policy, and the EU contact country they assigned.
4. How they forward requests to us, and their response times.
