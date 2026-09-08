# ctrlyoke Data Processing Agreement

**DRAFT — for attorney review. Not yet effective or published.**

**Processor:** Fuzzy Nova ("**Licensor**", "**Processor**")
**Version:** 0.1 (draft)

This Data Processing Agreement ("**DPA**") is incorporated into and forms part of the [ctrlyoke Enterprise Subscription Terms](https://ctrlyoke.dev/enterprise-terms) and the [ctrlyoke Commercial License](https://ctrlyoke.dev/terms) (together, the "**Agreement**") between Fuzzy Nova and the customer identified at checkout or in an applicable order form ("**Customer**", "**Controller**"). It applies to the extent Fuzzy Nova processes Personal Data on Customer's behalf in connection with the Software, as described in Annex I.

## 1. Definitions

**"Applicable Data Protection Law"** means all data protection and privacy laws applicable to the processing of Personal Data under this DPA, including, where applicable, the EU General Data Protection Regulation 2016/679 ("**GDPR**"), the UK GDPR and Data Protection Act 2018, the Swiss Federal Act on Data Protection, and U.S. state privacy laws including the California Consumer Privacy Act as amended by the California Privacy Rights Act ("**CCPA**").

**"Personal Data"**, "**Processing**", "**Controller**", "**Processor**", "**Data Subject**", and "**Sub-processor**" have the meanings given in Applicable Data Protection Law, or, where Applicable Data Protection Law does not define a term, the meaning given under the GDPR.

**"Standard Contractual Clauses"** or **"SCCs"** means the standard contractual clauses for the transfer of personal data to third countries pursuant to the GDPR, adopted by the European Commission (Commission Implementing Decision (EU) 2021/914), as amended or replaced from time to time, and, where applicable, the UK International Data Transfer Addendum.

**"Security Incident"** means a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to, Personal Data processed by Processor in connection with the Software.

## 2. Roles of the Parties

Customer is the Controller of Personal Data described in Annex I. Fuzzy Nova is the Processor (or, under CCPA, "Service Provider") processing that Personal Data solely on Customer's behalf and documented instructions, as described in this DPA and the Agreement. Customer's use of the Software to place its own instructions, prompts, or workspace content is not Processing by Fuzzy Nova as Processor — see Section 3.

## 3. Scope of Processing

Because ctrlyoke runs primarily on Customer's own infrastructure and does not transmit workspace content, prompts, source code, or AI output to Fuzzy Nova (see the [Privacy Policy](https://ctrlyoke.dev/privacy) Section 2), the Processing subject to this DPA is limited to the categories described in Annex I — principally license administration, activation, and support data for Customer's authorized users. Fuzzy Nova will process Personal Data only:

(a) to perform its obligations under the Agreement;
(b) on Customer's documented instructions, including those reflected in the Agreement itself; and
(c) as required by applicable law, in which case Fuzzy Nova will inform Customer of that legal requirement before processing, unless the law prohibits such notice.

## 4. Fuzzy Nova's Obligations

Fuzzy Nova will:

(a) ensure personnel authorized to process Personal Data are bound by confidentiality obligations;
(b) implement appropriate technical and organizational security measures as described in Annex III;
(c) engage Sub-processors only as permitted under Section 5;
(d) taking into account the nature of the Processing, assist Customer by appropriate technical and organizational measures, insofar as reasonably possible, in responding to requests from Data Subjects seeking to exercise their rights under Applicable Data Protection Law;
(e) assist Customer in ensuring compliance with its obligations regarding security, breach notification, and data protection impact assessments, taking into account the nature of Processing and the information available to Fuzzy Nova;
(f) notify Customer without undue delay after becoming aware of a Security Incident affecting Customer's Personal Data, and provide information reasonably available to Fuzzy Nova to help Customer meet its own breach-notification obligations; and
(g) at Customer's choice, delete or return all Personal Data to Customer after the end of the provision of services, and delete existing copies, except where applicable law requires retention (e.g., purchase/tax records).

## 5. Sub-processors

### (a) General authorization

Customer authorizes Fuzzy Nova to engage the Sub-processors listed in Annex II to process Personal Data in connection with the Software. Fuzzy Nova remains responsible for each Sub-processor's compliance with the data protection obligations of this DPA.

### (b) New sub-processors

Fuzzy Nova will provide notice (by updating Annex II and, where reasonably practicable, by direct notice such as email) before engaging a new Sub-processor. Customer may object on reasonable data-protection grounds within fourteen (14) days of notice; the parties will work in good faith to resolve the objection, and if unresolved, Customer's exclusive remedy is to terminate the affected Enterprise subscription without penalty for the then-current term.

## 6. International Transfers

Where Fuzzy Nova or a Sub-processor processes Personal Data originating from the European Economic Area, the United Kingdom, or Switzerland in a country not recognized as providing an adequate level of data protection, the transfer is governed by the Standard Contractual Clauses (Module Two: Controller to Processor), which are incorporated into this DPA by reference, with Customer as "data exporter" and Fuzzy Nova as "data importer." The parties will complete the applicable annexes using the information in this DPA. For a UK transfer, the UK International Data Transfer Addendum applies in place of, or alongside, the SCCs as required by UK law.

## 7. Audit Rights

On reasonable prior written notice, and not more than once per twelve (12) months absent a Security Incident or regulatory requirement, Fuzzy Nova will make available information reasonably necessary to demonstrate compliance with this DPA, which may take the form of written responses to a security questionnaire, existing audit reports or certifications (if any), or a call with Fuzzy Nova personnel, at Fuzzy Nova's reasonable discretion, in lieu of an on-site audit.

## 8. Liability

Each party's liability arising out of or related to this DPA is subject to the limitations of liability set out in EULA Section 13, which apply in aggregate across the Agreement and this DPA and not separately for each.

## 9. Term and Termination

This DPA takes effect on the date Customer accepts the Enterprise Terms and remains in effect for as long as Fuzzy Nova processes Personal Data on Customer's behalf under the Agreement.

## 10. Order of Precedence

In the event of a conflict between this DPA and the Agreement regarding the Processing of Personal Data, this DPA controls.

---

## Annex I — Details of Processing

| | |
| --- | --- |
| **Subject matter** | Provision of the ctrlyoke Software, including Enterprise license issuance, activation, verification, support, and billing. |
| **Duration** | For the term of the Agreement, plus any period required for legal or accounting retention. |
| **Nature and purpose** | License key/file issuance and validation; machine activation tracking for abuse prevention; purchase and billing record-keeping; support-ticket handling; aggregate, non-content operational telemetry. |
| **Categories of Data Subjects** | Customer's authorized users (employees, officers, contractors) who activate or use ctrlyoke; Customer's billing/administrative contacts. |
| **Categories of Personal Data** | Name; email address; billing country; license key/status; machine fingerprint/identifier; IP address during online license activation, refresh, or deactivation; support-email contents; aggregate telemetry tied to a VS Code machine identifier (see Privacy Policy Section 3.1 — no prompts, code, file paths, or workspace content). |
| **Special categories of data** | None processed or intended to be processed. |

## Annex II — Sub-processors

| Sub-processor | Purpose | Location | Data categories |
| --- | --- | --- | --- |
| Keygen | License issuance and verification | United States | License key, license status, machine identifier, IP address during online activation |
| Lemon Squeezy | Payments and merchant of record | United States (global processing) | Name, email address, billing country, payment metadata |
| Resend | Delivery of license-key and transactional email | United States | Recipient name, email address, license key, email content |
| Netlify | Website and infrastructure hosting | United States (global CDN) | Server logs, IP addresses, request metadata |
| Google Workspace | Business and support email | United States | Email addresses and message content |
| Microsoft Azure Application Insights | Telemetry processing | United States | Telemetry events, machine/version/OS metadata (no workspace content) |

> **Note for attorney review:** Resend is not currently listed in the published `PRIVACY.md` Section 6 sub-processor table — it was added to `ls-webhook.ts` on 2026-08-25 to deliver license-key emails but the privacy policy's sub-processor table wasn't updated to match at the time. This DPA draft includes it since it is a real sub-processor. `PRIVACY.md` should be corrected to match before or alongside publishing this DPA, so the two documents stay consistent.

## Annex III — Technical and Organizational Measures

- **Data minimization by design:** the Software is architected to avoid transmitting workspace content, prompts, source code, or AI output off Customer's machine; Processing under this DPA is limited to license administration and operational telemetry (see Annex I).
- **Encryption in transit:** license activation, verification, and telemetry traffic use TLS.
- **Offline verification path:** Customer may use signed offline license files, which verify locally via Ed25519 signature without any network call to Fuzzy Nova or Keygen.
- **Access controls:** administrative access to Sub-processor systems (Keygen, Lemon Squeezy, hosting, email) is limited to authorized Fuzzy Nova personnel.
- **Vendor due diligence:** Sub-processors are selected based on their own security and compliance posture; each processes data under its own terms of service and, where applicable, its own data processing agreement with Fuzzy Nova.
- **Incident response:** Fuzzy Nova monitors for and responds to Security Incidents and will notify Customer per Section 4(f).

---

Copyright © 2026 Fuzzy Nova. All rights reserved.
