# ctrlyoke Commercial License

**Licensor:** Fuzzy Nova LLC
**Product:** ctrlyoke VS Code Extension and companion binaries
**Effective Date:** September 17, 2026
**Version:** 2.1

## 0. Acceptance

Please read this License carefully, including the binding-arbitration and class-action-waiver provisions in Section 16(g).

You accept this License by affirmatively clicking or selecting an acceptance control that links to it, by completing a purchase after receiving conspicuous notice of and a link to it, or by installing, activating, accessing, or using the Software after receiving notice of and a reasonable opportunity to review it. If You do not agree, do not install, activate, access, or use the Software. If You accept this License on behalf of an entity, You represent and warrant that You have authority to bind that entity, and **You** refers to that entity.

## 1. Definitions

**"Licensor"**, **"Fuzzy Nova"**, **"we"**, or **"us"** means Fuzzy Nova LLC, a Texas limited liability company.

**"Software"** means the ctrlyoke VS Code extension, the compiled extension binary (VSIX), companion CLI and MCP server binaries, source code made available at the canonical repository, documentation, schemas, templates, and any updates or new versions released by Licensor.

**"Free Tier"** means the capabilities available without a Pro License, as described in the current documentation and the VS Code Marketplace listing.

**"Pro License"** means a license key or signed license file issued by Licensor through its authorized licensing system that unlocks Pro Tier capabilities.

**"Pro Tier"** means the capabilities available only to holders of a valid Pro License, or available during an Evaluation Trial to the extent stated in Section 2(d). Pro Tier capabilities currently include remote and LAN dashboard access, HTTPS and self-signed certificate generation for remote connections, browser and mobile push notifications, air-gapped activation from a signed license file, and custom icon colors, together with any future capabilities designated as Pro by Licensor. Capabilities not designated as Pro remain available under the Free Tier, including workflow execution, custom execution hooks, the MCP and agent managers, the companion CLI and MCP server binaries, and the local and `localhost` dashboard.

**"You"** or **"Your"** means the individual or legal entity exercising rights under this License.

**"Your Organization"** means (i) any legal entity that employs or engages You, or for whose benefit You use the Software, and (ii) any legal entity under common control with You or with such an entity, where **control** means ownership of greater than fifty percent (50%) of the outstanding shares or beneficial ownership of such entity. If You use the Software for the benefit of more than one entity, each of them is Your Organization for purposes of Section 3.

**"Compete"** means developing, marketing, offering, or providing a product or service in which the orchestration of multi-step AI coding-assistant workflows through structured files is a primary or substantial feature.

## 2. License Grant

Subject to the terms and conditions of this License, Licensor grants You a limited, non-exclusive, non-transferable, non-sublicensable license to:

(a) **Install and use** the Software for Your internal purposes, including use in the course of personal employment, freelance work, or client engagements;

(b) **Read and fork** the source code for personal evaluation, security review, internal non-redistributed adaptation, or contribution to the canonical repository;

(c) **Access Pro Tier capabilities** if and only if You hold a valid, unrevoked Pro License for each authorized user using Pro Tier capabilities, subject to any machine activation limits stated at purchase; and

(d) **Evaluate Pro Tier capabilities during an Evaluation Trial.** Each new installation of the Software includes a one-time, fourteen (14) day evaluation trial of remote dashboard access (an **Evaluation Trial**), beginning when that capability is first used on that installation. No purchase, payment method, or account registration is required. An Evaluation Trial is offered at Licensor's discretion, extends only to the capabilities Licensor designates for trial, is limited to one trial per installation, and may be modified or discontinued for future installations. Use of Pro Tier capabilities during a valid Evaluation Trial is permitted under Sections 2(c) and 4(c). When an Evaluation Trial ends, Free Tier rights continue and any further use of Pro Tier capabilities requires a valid Pro License. **AN EVALUATION TRIAL IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND, AS FURTHER STATED IN SECTION 12.**

## 3. Free Tier Eligibility

The Free Tier rights in Section 2(a)–(b) are granted at no charge, subject to the following:

### (a) Eligible users

The Free Tier is available to:

- individual persons acting in their personal capacity; and
- organizations whose total annual gross revenue is less than ten million US dollars (USD $10,000,000) and who employ fewer than two hundred fifty (250) persons, counting full-time, part-time, and contract workers.

### (b) Commercial threshold — Pro License required

If Your Organization's total annual gross revenue meets or exceeds USD $10,000,000, or Your Organization employs two hundred fifty (250) or more persons, each individual user of the Software affiliated with Your Organization must hold a valid Pro License for their use of the Software. This requirement is satisfied by either:

- the individual user purchasing a personal Pro License; or
- Your Organization purchasing an enterprise license that covers that user.

Use of the Software under the Free Tier by users at qualifying organizations, without one of these forms of Pro License in place, is not permitted. This threshold is contractual and relies on Your Organization's honest self-assessment. It applies to Your use of the Software regardless of which capabilities You use, including use limited to Free Tier capabilities.

For clarity, automated, scripted, and CI/CD pipeline use of the Software is permitted under the Free Tier and under any valid individual or enterprise Pro License, provided the user or organization on whose behalf the Software runs is itself eligible under this Section 3.

### (c) Educational use

Notwithstanding Section 3(b), students currently enrolled in accredited educational programs and individuals conducting non-commercial academic research may use the Software under the Free Tier regardless of the revenue or headcount of their educational institution. This exemption does not extend to commercial use of the Software by the institution itself.

### (d) Attribution

You may not remove or alter proprietary notices, copyright statements, or logos that appear in or on the Software.

## 4. Restrictions

You may not, and may not permit others to:

### (a) Redistribute

Distribute, sublicense, sell, transfer, publish, or otherwise make the Software, in source or compiled form, available to any third party, except that You may (i) create and maintain a publicly visible fork solely through the canonical repository host's built-in forking functionality, subject to Section 5(b), and (ii) submit contributions to the canonical repository as described in Section 5. A permitted public fork does not authorize You to publish releases, packages, binaries, or other standalone distributions from that fork.

### (b) Compete

Use the Software or any material portion of its source code to Compete with the Software.

### (c) Circumvent licensing

Circumvent, disable, or defeat the Software's license verification mechanisms, or use Pro Tier capabilities without either a valid, unrevoked Pro License or an active Evaluation Trial. You may not restart, extend, or obtain more than one Evaluation Trial for the same installation, user, or machine.

### (d) Offer as a hosted service

Offer the Software's workflow orchestration capabilities as a hosted, managed, or multi-tenant service to third parties. For clarity, using the Software locally, or on Your own private devices or private network, to automate Your own development workflows is permitted, including use in LAN-accessible setups for Your own internal access, so long as it is not offered to third parties as a service.

### (e) Misrepresent license status

Represent that the Software is "open source" or governed by an OSI-approved open-source license. The Software is source-available under this commercial license only.

### (f) Third-party AI service terms

The Software is designed to interface with third-party AI coding assistants and the model providers behind them, including GitHub Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI. The Software does not include, and Licensor does not supply, any of those tools, services, models, or the subscriptions or API credits they require; You are responsible for obtaining and maintaining them. Your use of those services through the Software remains subject to each service's own terms of use. You are solely responsible for ensuring Your use of the Software complies with the terms and conditions of any third-party AI service You access through it. Licensor is not responsible for changes to third-party service terms that affect Your ability to use the Software with those services.

## 5. Source Code and Contributions

### (a) Source availability

Licensor makes the Software's source code available at its canonical public repository. This availability does not grant rights beyond those stated in this License.

### (b) Forking

You may fork the repository solely for personal evaluation, security review, internal non-redistributed adaptation, or contribution preparation. A fork created through the canonical repository host's built-in forking functionality may remain publicly visible to the extent the host requires. Any fork remains subject to this License, may not be distributed outside that hosted fork or used to publish releases, packages, or binaries except as part of a permitted contribution to the canonical repository, and may not be used to Compete.

### (c) Contributions

By submitting a contribution, including a pull request, to the canonical repository, You grant Licensor a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, distribute, sublicense, and otherwise exploit the contribution as part of the Software or any derivative or successor product. You represent that You have the right to grant this license and that the contribution does not violate any third-party rights.

### (d) No Change Date

This License does not convert to any other license on any future date. The Software remains under this License, or any successor commercial license issued by Licensor, indefinitely.

## 6. Pro License Terms

### (a) Grant

A Pro License grants the named licensee the right to activate Pro Tier capabilities for the number of authorized users and any machine activation limits stated at purchase.

### (b) Activation

Pro Tier capabilities require activation using a valid license key or signed license file issued by Licensor.

### (c) Individual perpetual license

Unless otherwise stated at purchase, an individual Pro License is perpetual and does not require subscription renewal. Licensor may require a new license for major version upgrades at its discretion; existing licenses will be honored for the version purchased.

### (d) Enterprise license

Enterprise licenses cover authorized users within the single legal entity identified in the applicable order form or invoice and are issued as annual subscriptions unless otherwise stated there. Coverage extends to that entity's employees and officers, and to contractors engaged to perform work for it, provided their use of the Software is in the course of that work.

An Enterprise subscription is additionally governed by the ctrlyoke Enterprise Subscription Terms at [ctrlyoke.dev/enterprise-terms](https://ctrlyoke.dev/enterprise-terms) and, to the extent Licensor processes personal data on the customer's behalf, the ctrlyoke Data Processing Agreement at [ctrlyoke.dev/dpa](https://ctrlyoke.dev/dpa). Both are incorporated by reference for an Enterprise subscription, and the Enterprise Subscription Terms control over this Section 6(d) to the extent they conflict with it.

### (e) Revocation

Licensor may suspend or revoke a Pro License upon:

- material breach of this License;
- fraudulent purchase, unauthorized payment reversal, or chargeback; or
- violation of applicable law, including export controls.

Where commercially reasonable and permitted by law, Licensor will provide notice and an opportunity to cure before permanent revocation, except in cases of fraud, abuse, or legal compliance risk. Revocation terminates the Pro License; Free Tier rights, where applicable, continue.

### (f) Non-transferability

Pro Licenses are personal to the named licensee and may not be transferred, resold, or sublicensed without Licensor's prior written consent.

## 7. Intellectual Property

### (a) Ownership

The Software and all copies are proprietary to Licensor; title remains with Licensor. No intellectual property rights in the Software are transferred to You by this License, except for the limited rights expressly granted here. "ctrlyoke" and "Fuzzy Nova" are marks of Licensor, and this License grants You no right to use them except as reasonably necessary to identify the Software accurately.

### (b) Third-party components

The Software incorporates third-party open-source components licensed to You by their respective licensors under their own terms, not under this License. Those components and their required attributions are identified in the `THIRD_PARTY_NOTICES.md` file distributed with the Software. Where a third-party component's license grants You rights broader than this License with respect to that component, that license controls for that component, and nothing in this License limits any right You have under it.

## 8. Feedback

If You provide Licensor with feedback, suggestions, or ideas regarding the Software, You grant Licensor a perpetual, irrevocable, worldwide, royalty-free license to use, incorporate, modify, and commercialize that feedback in any product or service, without obligation to You.

## 9. Support; Updates; Availability

Licensor may provide support, updates, bug fixes, or future features at its sole discretion. Except as expressly stated in a separate written agreement, Licensor has no obligation to maintain, support, or continue offering any feature, version, or service.

## 10. Privacy and Data Processing

Your use of the Software may involve the collection, transmission, storage, or processing of data, including telemetry, license validation data, configuration data, diagnostics, and usage information, as described in Licensor's Privacy Policy at [ctrlyoke.dev/privacy](https://ctrlyoke.dev/privacy) or any successor URL. The Privacy Policy, as updated from time to time, is incorporated by reference into this License. Notwithstanding Section 16(e), the then-current Privacy Policy governs Licensor's processing of that data, and Licensor will identify material changes to it as described in that policy.

## 11. Patent Rights

To the extent Licensor owns patent rights that are necessarily infringed by use of the Software as permitted under this License, Licensor grants You a limited, non-exclusive, worldwide, non-transferable, non-sublicensable patent license to make, use, and run the Software as permitted under this License.

If You initiate patent litigation alleging that the Software or any portion of it infringes Your patent, any patent license granted to You under this Section terminates as of the date such litigation is filed.

## 12. Disclaimer of Warranties

**THE SOFTWARE IS PROVIDED "AS IS," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS, OPERATE WITHOUT INTERRUPTION OR ERROR, OR THAT DEFECTS WILL BE CORRECTED.**

## 13. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES, INCLUDING LOSS OF USE, DATA, OR PROFITS; BUSINESS INTERRUPTION; OR PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES, ARISING OUT OF OR IN CONNECTION WITH THIS LICENSE OR THE USE OF THE SOFTWARE, EVEN IF LICENSOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. LICENSOR'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR IN CONNECTION WITH THIS LICENSE SHALL NOT EXCEED THE GREATER OF (I) THE AMOUNTS PAID BY YOU TO LICENSOR IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR (II) USD $100. NOTHING IN THIS LICENSE EXCLUDES OR LIMITS LIABILITY TO THE EXTENT IT CANNOT LAWFULLY BE EXCLUDED OR LIMITED.**

## 14. Export Controls

You may not use or export the Software in violation of applicable export laws and regulations, including U.S. Export Administration Regulations. By using the Software, You represent that You are not located in a country subject to a U.S. Government embargo and are not listed on any U.S. Government list of prohibited or restricted parties.

## 15. Term and Termination

### (a) Term

This License is effective from the date You first install, use, or access the Software and continues until terminated.

### (b) Termination for breach

This License terminates if You materially breach any of its terms and fail to cure the breach within thirty (30) days after written notice from Licensor. A breach of Section 4(a), 4(b), or 4(c) is not curable, and this License terminates immediately upon such a breach without notice. Upon termination You must cease all use and destroy all copies in Your possession or control, except to the extent retention is required by law.

### (c) Survival

Sections 4, 5(c), 5(d), 7, 8, 9, 10, 11, 12, 13, 14, 15, and 16 survive termination.

## 16. General

### (a) Entire agreement

This License is the entire agreement between the parties regarding the Software and supersedes all prior and contemporaneous understandings regarding the Software. For an Enterprise subscription, the ctrlyoke Enterprise Subscription Terms replace this Section 16(a) and identify the documents that together form the agreement.

### (b) Governing law; venue

This License is governed by the laws of the State of Texas, USA, without regard to conflict-of-law rules. Subject to the dispute resolution provision below, any permitted court proceeding shall be brought exclusively in the state or federal courts located in Austin, Texas, and the parties consent to personal jurisdiction and venue there. If You are a consumer, this choice of law and venue does not deprive You of any non-waivable protections of the law of Your usual residence or any right to bring a proceeding in another forum that applicable law does not permit You to waive.

### (c) Severability

If any provision is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable; the remaining provisions continue in full force.

### (d) No waiver

Failure by Licensor to enforce any provision shall not constitute a waiver of future enforcement.

### (e) Updates to license

Licensor may update this License for future versions of the Software. The version in effect when You obtained Your copy governs Your use of that copy unless You choose to adopt a later version.

### (f) Contact

Licensing inquiries: `licensing@ctrlyoke.dev`

Legal notices: Fuzzy Nova LLC, 5518 Roosevelt Ave, Austin, TX 78756, USA

### (g) Dispute resolution; arbitration

**PLEASE READ THIS SECTION CAREFULLY. EXCEPT FOR THE LIMITED EXCEPTIONS BELOW, IT REQUIRES INDIVIDUAL BINDING ARBITRATION AND WAIVES JURY TRIALS AND CLASS PROCEEDINGS.**

Before starting arbitration, the claimant must send the other party written notice describing the claim and requested relief and allow thirty (30) days for an informal resolution. Notices to Licensor must be sent to the legal-notice address in Section 16(f), with a copy to `licensing@ctrlyoke.dev`.

Except for (i) an individual claim eligible to be brought in small-claims court, (ii) a dispute relating to a party's actual or threatened misuse of intellectual property or breach of confidentiality obligations, or (iii) a claim seeking temporary or preliminary injunctive relief, any dispute, claim, or controversy arising out of or relating to this License or the Software shall be resolved by individual binding arbitration administered by the American Arbitration Association (**AAA**) under its Commercial Arbitration Rules, or its Consumer Arbitration Rules if AAA determines that those rules apply. The Federal Arbitration Act governs the interpretation and enforcement of this Section. The arbitration will take place in Austin, Texas, except that a consumer claimant may participate remotely or from the county of the claimant's residence when required by the applicable AAA rules or law. Judgment on the award may be entered in any court of competent jurisdiction.

**TO THE MAXIMUM EXTENT PERMITTED BY LAW, YOU AND LICENSOR WAIVE ANY RIGHT TO A JURY TRIAL AND AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY, NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE PROCEEDING. THE ARBITRATOR MAY AWARD RELIEF ONLY TO THE INDIVIDUAL PARTY SEEKING RELIEF AND ONLY TO THE EXTENT NECESSARY TO RESOLVE THAT PARTY'S INDIVIDUAL CLAIM.**

You may opt out of the arbitration requirement and class-action waiver in this Section by sending written notice to `licensing@ctrlyoke.dev` within thirty (30) days after You first accept this License. The notice must identify You, state that You opt out of Section 16(g), and provide the email address or other information reasonably sufficient to identify Your purchase or license, if any. Opting out does not affect the remaining provisions of this License. If a final decision holds a particular limitation in this Section unenforceable as to a particular claim or request for relief, that claim or request will be severed and may proceed in court, while the remaining claims will be arbitrated.

### (h) Assignment

You may not assign or transfer this License or any right under it, by operation of law or otherwise, without Licensor's prior written consent, except that You may assign this License in its entirety to a successor to all or substantially all of Your business or assets, provided that the successor does not Compete with the Software, agrees in writing to be bound by this License, and You notify Licensor within thirty (30) days of the assignment. Licensor may assign this License, in whole or in part, to an affiliate or in connection with a merger, acquisition, reorganization, financing, or sale of all or substantially all of its assets. Any attempted assignment in violation of this Section is void. This License binds and benefits the parties' permitted successors and assigns.

---

Copyright © 2026 Fuzzy Nova LLC. All rights reserved.
