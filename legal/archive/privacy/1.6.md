# Privacy Policy

**Controller:** Fuzzy Nova LLC
**Product:** ctrlyoke VS Code extension and companion CLI / MCP server binaries
**Effective Date:** October 16, 2026
**Last Updated:** October 20, 2026
**Version:** 1.6

## 1. Scope

This Privacy Policy explains how Fuzzy Nova LLC (**Fuzzy Nova**, **we**, **us**, or **our**) collects, uses, discloses, and protects information when you use the ctrlyoke VS Code extension and companion binaries (the **Software**), visit [ctrlyoke.dev](https://ctrlyoke.dev), or contact us for support, sales, billing, or security matters.

This Privacy Policy does not cover the third-party AI coding assistants, services, or model providers that you connect to through the Software, including GitHub Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI. Those tools run on your machine under your own accounts and credentials and send your prompts and code to their own providers. They are governed by their own privacy policies and terms, which you should review before using the Software with a given harness.

## 2. What We Do Not Collect

The Software is designed to run locally on your machine. Except for the telemetry and license data described in Section 3, the Software does **not** intentionally collect or transmit to us:

- prompt text or workflow content
- source code or file contents
- file paths or workspace/repository names
- AI model output or response text
- ctrlyoke workflow session IDs, run IDs, or workflow identifiers
- agent names, skill names, MCP server IDs, or end-condition script names
- other user-generated workspace content

The Software's optional remote and LAN dashboard is served directly from your own machine to devices you authorize. Dashboard traffic and workflow content do not route through Fuzzy Nova's infrastructure.

The companion CLI and MCP server binaries do not send telemetry to us. The telemetry described in Section 3.1 is sent only by the VS Code extension.

## 3. Information We Collect

### 3.1 Usage telemetry

We collect limited operational telemetry to understand how the Software is used, improve the product, and troubleshoot problems. Telemetry is sent through Microsoft's `@vscode/extension-telemetry` library and respects the VS Code `telemetry.telemetryLevel` setting. If telemetry is disabled in VS Code, the Software does not send telemetry to us through that library.

Telemetry may include:

- harness identifier or execution mode
- counts and durations
- boolean feature flags
- outcome and error type names
- for unexpected errors in the extension, the error message and stack trace, after VS Code's telemetry redaction removes file paths and other values that look like personal data or secrets
- extension name and version
- VS Code version, commit, product, and UI kind
- operating system, platform version, and processor architecture
- remote-environment type, such as local, SSH, container, or WSL
- pseudonymous VS Code machine and device identifiers and a per-launch VS Code session identifier, attached by the telemetry library
- source IP address processed by Azure during ingestion and approximate geographic location derived from it

We use this information for product analytics, reliability, debugging, and feature planning. Telemetry is processed through **Microsoft Azure Application Insights**.

**Important:** We do not use telemetry to collect prompts, code, file paths, or other content from your editor or workspace.

### 3.2 License and activation data

If you purchase or activate a Pro License, we collect and process the minimum information needed to issue, validate, and support that license, including:

- license key or signed license file information
- license status
- machine fingerprint or identifier
- operating system platform associated with an online machine activation
- IP address used during online activation, refresh, or deactivation

License verification is provided through **Keygen**. If you use the offline signed-license file path, activation can be verified locally on your machine without sending activation data to us or Keygen.

The fourteen-day remote-access evaluation trial included with each new installation is tracked by a timestamp stored locally on your machine. Starting or using the trial does not require an account and does not send license or activation data to us or Keygen.

### 3.3 Purchase and billing data

Purchases are processed by our merchant of record, **Lemon Squeezy**. Depending on your purchase and location, Lemon Squeezy may collect and process your name, email address, billing country, and payment details under its own privacy policy and terms.

We receive order metadata such as your email address, product information, order ID, and license-related purchase records so we can issue and support your license. We do not receive or store full payment card numbers.

For an Enterprise purchase, we also collect the Customer's legal entity name, business address, and official registration number where provided or required for international-transfer documentation. We maintain a record of the legal terms accepted at checkout, including the accepted document versions, acceptance method and timestamp, order identifier, and purchaser email address. We use this information to identify the contracting Customer and maintain evidence of the transaction and acceptance.

We use **Resend** to deliver license keys and other transactional service email. We provide Resend with the recipient's name and email address and the message content, which includes the license key and activation instructions. Resend also processes delivery metadata needed to transmit and troubleshoot the message.

### 3.4 Support and communications

If you contact us by email at `privacy@ctrlyoke.dev`, `support@ctrlyoke.dev`, `billing@ctrlyoke.dev`, `security@ctrlyoke.dev`, `sales@ctrlyoke.dev`, `licensing@ctrlyoke.dev`, or `hello@fuzzno.com`, we receive your email address and the contents of your message.

Email is hosted on **Google Workspace**. Public bug reports or discussions on GitHub are governed by GitHub's privacy policy and are visible to others.

### 3.5 Website data

Our website, [ctrlyoke.dev](https://ctrlyoke.dev), is hosted on **Netlify**. Netlify may process standard server and security logs, including IP addresses and request metadata, to operate and secure the site.

Netlify also hosts the serverless provisioning function that receives authenticated purchase and subscription events from Lemon Squeezy. That function processes the purchaser's name and email address, product, order, and subscription identifiers, and related license data to issue, deliver, renew, suspend, and support licenses through Keygen and Resend.

## 4. How We Use Information

We use the information we collect to:

- provide, activate, and verify Pro Licenses
- process purchases and issue receipts
- deliver license keys and other transactional service messages
- deliver support, billing, security, and sales communications
- understand aggregate usage and improve the Software
- detect and prevent fraud, abuse, and license violations
- comply with legal obligations

We do **not** sell personal data, and we do not use personal data for third-party advertising.

## 5. Legal Bases for Processing

Where applicable law requires a legal basis for processing, we rely on one or more of the following:

- **Performance of a contract** — to provide the Software, activate licenses, and fulfill purchases
- **Legitimate interests** — to secure and improve the Software, prevent abuse, and respond to support requests
- **Legal obligation** — to maintain records and comply with tax, accounting, or other legal requirements
- **Consent** — where applicable law requires it and we have requested it; your VS Code telemetry setting separately controls whether the Software sends telemetry

## 6. Service Providers and Other Recipients

We use trusted vendors to help operate ctrlyoke. Depending on the service and processing purpose, a provider may act as our processor or as an independent controller under its own terms:

| Provider                             | Purpose                                           | Data categories                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Azure Application Insights | Telemetry processing                              | Telemetry events and redacted error reports; pseudonymous machine, device, and per-launch session identifiers; software, OS, device, and remote-environment metadata; source IP during ingestion and derived location |
| Keygen LLC                           | License issuance and verification                 | Name and email in license metadata; license key/status; machine identifier and operating system platform; IP address and request metadata during online license operations                                            |
| Lemon Squeezy                        | Payments, authorized reseller, merchant of record | Name, email address, billing country, payment and order metadata; Enterprise legal-entity and terms-acceptance data where supported                                                                                   |
| Plus Five Five, Inc. (Resend)        | Transactional email and license-key delivery      | Recipient name and email address, license key, message content, delivery metadata                                                                                                                                     |
| Netlify, Inc.                        | Website and serverless-function hosting           | Purchase/license provisioning data processed by the webhook; server logs, IP addresses, request metadata                                                                                                              |
| Google Workspace                     | Business and support email                        | Email addresses and message content                                                                                                                                                                                   |

We may also disclose information:

- to comply with legal obligations;
- to respond to lawful requests and legal process;
- to protect our rights, users, and the security of the Software;
- in connection with a merger, acquisition, financing, or sale of assets, subject to appropriate protections.

If you are an Enterprise customer, the [ctrlyoke Data Processing Agreement](https://ctrlyoke.dev/dpa) governs our processing of Customer Personal Data on your behalf and separately identifies the Sub-processors engaged for that processing. We give Enterprise customers at least thirty (30) days' notice before a new or replacement Sub-processor begins processing Customer Personal Data, as described in that agreement.

## 7. Telemetry Choices

You can disable telemetry by setting `telemetry.telemetryLevel` to `off` in VS Code. If telemetry is disabled, the Software will not send telemetry through the VS Code telemetry library.

You may also limit the information we receive by using the Free Tier or by avoiding Pro activation, if that fits your use case.

## 8. Data Retention

We retain information only as long as reasonably necessary for the purposes described in this Privacy Policy, unless a longer retention period is required by law.

Typical retention periods include:

- **Telemetry:** retained according to Azure Application Insights settings, currently approximately 90 days
- **License and activation records:** retained for the life of the license and as needed to support enforcement, fraud prevention, and customer support
- **Purchase records:** retained by us and our payment provider as required for tax, accounting, and legal obligations
- **Transactional license email:** message and delivery data is retained by Resend under our account settings and its applicable retention practices, currently approximately 30 days
- **Support email:** retained as needed to resolve inquiries and maintain records of correspondence
- **Enterprise terms-acceptance and arbitration-opt-out records:** retained for the life of the applicable agreement and afterwards as needed for tax, accounting, and evidentiary purposes

Retention periods used by our vendors may differ from our own and may be subject to their policies and configurations. For Enterprise customers, the [ctrlyoke Data Processing Agreement](https://ctrlyoke.dev/dpa) additionally governs return and deletion of Customer Personal Data.

## 9. International Transfers

We and our vendors may process information in the United States and other countries that may not have the same data protection laws as your jurisdiction.

Where required by law, cross-border transfers rely on appropriate safeguards such as Standard Contractual Clauses or comparable legal mechanisms. Additional region-specific transfer terms may apply where required.

## 10. Your Rights and Choices

Depending on where you live, you may have rights to:

- access your personal data
- correct inaccurate data
- delete personal data
- object to or restrict certain processing
- withdraw consent where processing is based on consent
- receive a copy of certain data in a portable format
- appeal our refusal of a request, where applicable
- lodge a complaint with your local data protection authority

To exercise these rights, contact us at `privacy@ctrlyoke.dev`. If you are in the EU/EEA, the UK, or Switzerland, you may instead contact our data protection representative, DataRep (see Section 14). We may need to verify your identity before acting on your request.

Because some information is held by our vendors, we may need to coordinate with them to fulfill your request.

### California notice

We do not sell personal information and do not share personal information for cross-context behavioral advertising as those terms are used under the California Consumer Privacy Act, as amended by the CPRA.

## 11. Children

ctrlyoke is a professional developer tool and is not directed to children. We do not knowingly collect personal data from children under the age of thirteen (13), or under the higher minimum age set by local law where one applies, such as the age of digital consent under the EU or UK GDPR (between thirteen (13) and sixteen (16), depending on the jurisdiction). If you believe a child has provided us personal data, please contact us at `privacy@ctrlyoke.dev` and we will delete it.

## 12. Security

We use reasonable administrative, technical, and organizational safeguards designed to protect information. However, no method of transmission or storage is completely secure, and we cannot guarantee absolute security.

## 13. Changes to This Policy

We may update this Privacy Policy from time to time. If we make material changes, we will increment the Version number and update the Last Updated date above and, where appropriate, the Effective Date, and may provide additional notice on [ctrlyoke.dev](https://ctrlyoke.dev) or within the Software. The version number lets us record which version of this policy applied to a given Enterprise purchase, as described in Section 3.3.

## 14. Contact

**Privacy inquiries:** `privacy@ctrlyoke.dev`
**Data controller:** Fuzzy Nova LLC, a Texas limited liability company — `hello@fuzzno.com`
**Postal address:** 5518 Roosevelt Ave, Austin, TX 78756, USA

### EU/EEA, UK and Swiss representative

Fuzzy Nova LLC (trading as ctrlyoke) has appointed **Data Protection Representative Limited (trading as DataRep)** as its data protection representative in the European Union and European Economic Area (under Article 27 of the EU GDPR), in the United Kingdom (under Article 27 of the UK GDPR), and in Switzerland (under the Swiss Federal Act on Data Protection).

DataRep's contact details are only for individuals in the EU/EEA, the UK, or Switzerland, and for the data protection authorities there, to raise questions or requests about how we process personal data. For support, billing, licensing, or anything else about the Software, use the addresses above, as DataRep cannot help with those.

To contact us through DataRep:

- email [datarequest@datarep.com](mailto:datarequest@datarep.com) with "ctrlyoke" in the subject line;
- use DataRep's web form at [datarep.com/data-request](https://www.datarep.com/data-request); or
- write to DataRep at the address for your country below.

**Address letters to "DataRep", not to ctrlyoke or Fuzzy Nova, or they may not reach DataRep.** Please refer clearly to ctrlyoke in your message. We may ask you for evidence of your identity before acting on your request. DataRep's own handling of your personal data is described in its privacy notice at [datarep.com/privacy-policy](https://www.datarep.com/privacy-policy/).

| Country        | Address                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Austria        | DataRep, City Tower, Brückenkopfgasse 1/6. Stock, Graz, 8020, Austria                                |
| Belgium        | DataRep, Rue des Colonies 11, Brussels, 1000, Belgium                                                |
| Bulgaria       | DataRep, 25 Vitosha blvd. Fl. 2, office 4, 1000, Sofia, Bulgaria                                     |
| Croatia        | DataRep, Ground & 9th Floor, Hoto Tower, Savska cesta 32, Zagreb, 10000, Croatia                     |
| Cyprus         | DataRep, Victory House, 205 Archbishop Makarios Avenue, Limassol, 3030, Cyprus                       |
| Czech Republic | DataRep, Platan Office, 28. Října 205/45, Floor 3&4, Ostrava, 70200, Czech Republic                  |
| Denmark        | DataRep, Lautruphøj 1-3, Ballerup, 2750, Denmark                                                     |
| Estonia        | DataRep, 2nd Floor, Tornimae 5, Tallinn, 10145, Estonia                                              |
| Finland        | DataRep, Luna House, 5.krs, Mannerheimintie 12 B, Helsinki, 00100, Finland                           |
| France         | DataRep, 72 rue de Lessard, Rouen, 76100, France                                                     |
| Germany        | DataRep, 3rd and 4th floor, Altmarkt 10 B/D, Dresden, 01067, Germany                                 |
| Greece         | DataRep, Ippodamias Sq. 8, 4th floor, Piraeus, Attica, Greece                                        |
| Hungary        | DataRep, 1054 Honved street, 8 1/2, Budapest, Hungary                                                |
| Iceland        | DataRep, Laugavegur 13, 101 Reykjavik, Iceland                                                       |
| Ireland        | DataRep, 77 Camden Street Lower, Dublin, D02 XE80, Ireland                                           |
| Italy          | DataRep, Viale Giorgio Ribotta 11, Piano 1, Rome, Lazio, 00144, Italy                                |
| Latvia         | DataRep, 4th & 5th floors, 14 Terbatas Street, Riga, LV-1011, Latvia                                 |
| Liechtenstein  | DataRep, City Tower, Brückenkopfgasse 1/6. Stock, Graz, 8020, Austria                                |
| Lithuania      | DataRep, 44A Gedimino Avenue, 01110 Vilnius, Lithuania                                               |
| Luxembourg     | DataRep, BPM 335368, Banzelt 4 A, 6921, Roodt-sur-Syre, Luxembourg                                   |
| Malta          | DataRep, Tower Business Centre, 2nd floor, Tower Street, Swatar, BKR4013, Malta                      |
| Netherlands    | DataRep, De Nieuwe Erven 3 Unit – 15162, 5431 NV Cuijk, Netherlands                                  |
| Norway         | DataRep, C.J. Hambros Plass 2c, Oslo, 0164, Norway                                                   |
| Poland         | DataRep, Budynek Fronton ul Kamienna 21, Krakow, 31-403, Poland                                      |
| Portugal       | DataRep, Torre de Monsanto, Rua Afonso Praça 30, 7th floor, Algès, Lisbon, 1495-061, Portugal        |
| Romania        | DataRep, 15 Piaţa Charles de Gaulle, nr. 1-T, Bucureşti, Sectorul 1, 011857, Romania                 |
| Slovakia       | DataRep, Apollo Business Centre II, Block E / 9th floor, 4D Prievozska, Bratislava, 821 09, Slovakia |
| Slovenia       | DataRep, Trg. Republike 3, Floor 3, Ljubljana, 1000, Slovenia                                        |
| Spain          | DataRep, Calle de Manzanares 4, Madrid, 28005, Spain                                                 |
| Sweden         | DataRep, S:t Johannesgatan 2, 4th floor, Malmo, SE - 211 46, Sweden                                  |
| Switzerland    | DataRep, Leutschenbachstrasse 95, ZURICH, 8050, Switzerland                                          |
| United Kingdom | DataRep, 107-111 Fleet Street, London, EC4A 2AB, United Kingdom                                      |

---

Copyright © 2026 Fuzzy Nova LLC. All rights reserved.
