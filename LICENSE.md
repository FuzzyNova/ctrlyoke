# ctrlyoke Commercial License

**Licensor:** Fuzzy Nova LLC
**Product:** ctrlyoke VS Code Extension and companion binaries
**Effective Date:** November 22, 2026
**Version:** 2.4

## 0. Acceptance

You accept this License by affirmatively clicking or selecting an acceptance control that links to it, by completing a purchase after receiving conspicuous notice of and a link to it, or by installing, activating, accessing, or using the Software after receiving notice of and a reasonable opportunity to review it. If You do not agree, do not install, activate, access, or use the Software. If You accept this License on behalf of an entity, You represent and warrant that You have authority to bind that entity, and **You** refers to that entity.

## 1. Definitions

**"Licensor"**, **"Fuzzy Nova"**, **"we"**, or **"us"** means Fuzzy Nova LLC, a Texas limited liability company.

**"Software"** means the ctrlyoke VS Code extension, the compiled extension binary (VSIX), companion CLI and MCP server binaries, source code made available at the canonical repository, documentation, and any updates or new versions released by Licensor, excluding Open Materials.

**"Open Materials"** means the following materials to the extent Licensor has the right to license them, wherever they appear, including copies created by the Software in a project or a third-party tool's configuration:

(i) the workflow templates, agent definitions, skills, and example condition scripts Licensor distributes for use in Your projects, corresponding to the template and example files under `src/templates/` in the canonical repository;

(ii) code and configuration examples identified as examples in Licensor's ctrlyoke documentation, including fenced examples and downloadable example files; and

(iii) Licensor's workflow and settings schema files under `schemas/` in the canonical repository, including archived versions of those schemas.

Any material identified as subject to separate third-party terms remains subject to those terms.

**"Free Tier"** means the capabilities available without a Pro License, as described in the current documentation and the VS Code Marketplace listing.

**"Host Machine"** means the physical computer on which a given installation of the Software runs, including when it runs in a local virtual machine, container, or subsystem on that computer. For an installation running in a cloud virtual machine or a cloud development environment, the Host Machine is the cloud instance or environment running that installation. A browser running on the same physical computer as a local virtual machine, container, or subsystem is on the Host Machine for that installation.

**"Hosted Dashboard"** means the browser-based dashboard served by the Software's built-in web server, whether started from the VS Code extension or the companion CLI (for example, through `ctrlyoke server`). It does not include the dashboard panel displayed inside Visual Studio Code itself.

**"Remote Dashboard Access"** means loading or interacting with the Hosted Dashboard from a browser, application, or other client running on any device other than the Host Machine, by any means, including binding the Software's server to a network interface, a virtual private network, port forwarding, a reverse proxy, or a tunnel or other mechanism that relays the Hosted Dashboard's network traffic to another device.

**"Remote Session"** means operating the Host Machine from another device through a remote desktop, screen-sharing, or remote command-line session (for example, Windows Remote Desktop, VNC, macOS Screen Sharing, or SSH), in which the Software, and any browser displaying the Hosted Dashboard, run on the Host Machine, and only that machine's display, input, or terminal output is transmitted to the other device. A Remote Session is not Remote Dashboard Access.

- **Remote Sessions and local dashboard use:** A browser running on the Host Machine remains on it when You view it over Remote Desktop or VNC. Running the CLI over SSH and using the in-editor dashboard panel in VS Code Remote Development (including Remote SSH, WSL, Dev Containers, and Codespaces) do not constitute Remote Dashboard Access. A browser on the same physical computer as a local WSL installation, dev container, or VM may open the Hosted Dashboard as local use.
- **Remote Dashboard Access:** Opening the Hosted Dashboard in a browser on another device through SSH local port forwarding (`ssh -L`), VS Code or Codespaces port forwarding, a VPN or mesh network, a tunnel service, or a network-accessible server address constitutes Remote Dashboard Access. The location of the browser or other client controls even if the URL displayed on that device uses `localhost`.

**"Pro License"** means a license key or signed license file issued by Licensor through its authorized licensing system that unlocks Pro Tier capabilities.

**"Pro Tier"** means the capabilities available only to holders of a valid Pro License, or available during an Evaluation Trial to the extent stated in Section 2(d). Pro Tier capabilities currently include Remote Dashboard Access, HTTPS and self-signed certificate generation for remote connections, browser and mobile push notifications, air-gapped activation from a signed license file, and custom icon colors, together with any future capabilities designated as Pro by Licensor. Capabilities not designated as Pro remain available under the Free Tier, including workflow execution, custom execution hooks, the MCP and agent managers, the companion CLI and MCP server binaries, and the dashboard and Hosted Dashboard when viewed on the Host Machine, including on the Host Machine during a Remote Session.

**"You"** or **"Your"** means the individual or legal entity exercising rights under this License.

**"Your Organization"** means, for the use at issue:

(i) each legal entity that employs You and for which You use the Software in the course of that employment;

(ii) each client legal entity for which You use the Software while working as part of its workforce, including through Your own entity, a staffing firm, or another intermediary. You work as part of a client's workforce if (A) You use the Software on a device, virtual desktop, or development environment supplied to You, managed, or controlled by the client or by an intermediary on its behalf, or (B) You have performed services for the client at or close to its ordinary full-time schedule for comparable work for more than six (6) consecutive months. Routine leave or a change of intermediary does not restart that period. Access to a source repository, ticket system, or collaboration service by itself does not constitute a client-provided development environment;

(iii) each other legal entity for whose benefit You use the Software, except a client of Your independent business for which You do not meet either workforce test in clause (ii); and

(iv) any legal entity under common control with You or with an entity described in clauses (i) through (iii). **Control** means ownership of more than fifty percent (50%) of the outstanding shares or beneficial ownership of an entity.

If You operate an independent business, including through a sole proprietorship, Your own business is also Your Organization for that use. If You are a legal entity, clause (ii) applies to the work and working environment of each individual who uses the Software on Your behalf for a client. Each applicable organization is assessed under Section 3.

Clause (iii) does not apply to a legal entity merely because You use the Software to prepare contributions to a Public Open-Source Project that the entity owns, sponsors, maintains, or uses, unless that entity, or another person acting on its behalf, pays or engages You for that work. The independent-client exception in clause (iii) and clauses (i), (ii), and (iv) continue to apply. A **Public Open-Source Project** is a project whose source code is publicly available under a license approved by the Open Source Initiative.

**"Compete"** means developing, marketing, offering, or providing a product or service in which the orchestration of multi-step AI coding-assistant workflows through structured files is a primary or substantial feature.

**"Dispute"** means any dispute, claim, or controversy arising out of or relating to this License or the Software.

**"Consumer"** means an individual who acquires or uses the Software wholly or mainly for personal, family, or household purposes, and not for the purposes of their trade, business, craft, or profession.

## 2. License Grant

Subject to the terms and conditions of this License, Licensor grants You a limited, non-exclusive, non-transferable, non-sublicensable license to:

(a) **Install and use** the Software for Your internal purposes, including use in the course of personal employment, freelance work, or client engagements;

(b) **Read and fork** the source code for personal evaluation, security review, internal non-redistributed adaptation, or contribution to the canonical repository;

(c) **Access Pro Tier capabilities** if and only if You hold a valid, unrevoked Pro License for each authorized user using Pro Tier capabilities, subject to any machine activation limits stated at purchase; and

(d) **Evaluate Pro Tier capabilities during an Evaluation Trial.** Each new installation of the Software includes a one-time, fourteen (14) day evaluation trial of Remote Dashboard Access (an **Evaluation Trial**), beginning when that capability is first used on that installation. No purchase, payment method, or account registration is required. An Evaluation Trial is offered at Licensor's discretion, extends only to the capabilities Licensor designates for trial, is limited to one trial per installation, and may be modified or discontinued for future installations. Use of Pro Tier capabilities during a valid Evaluation Trial is permitted under Sections 2(c) and 4(c). When an Evaluation Trial ends, Free Tier rights continue and any further use of Pro Tier capabilities requires a valid Pro License. **AN EVALUATION TRIAL IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF ANY KIND, AS FURTHER STATED IN SECTION 12.**

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

Assess each entity that is Your Organization separately. Measure each entity's annual gross revenue from its most recently completed fiscal year or, if it has not completed its first fiscal year, the actual revenue it has earned since it began operating. Measure headcount as of the date of use. Count each person once per entity. Count the entity's full-time and part-time employees and its directly engaged contract workers. For a worker engaged through an intermediary, apply the workforce tests in Section 1 to the work and working environment of that person, whether or not the person uses the Software. An organization may use its most recent ordinary-course payroll and contractor records if it reasonably believes they reflect its current headcount.

For clarity, automated, scripted, and CI/CD pipeline use of the Software is permitted under the Free Tier and under any valid individual or enterprise Pro License, provided the user or organization on whose behalf the Software runs is itself eligible under this Section 3.

For freelance or consulting use, apply both thresholds to Your own business and to any client that qualifies as Your Organization under Section 1. For example, a freelancer using their own computer for a three-month project for a large company may qualify for the Free Tier based on the freelancer's own business. A contractor using a large client's managed laptop or cloud development environment for the work must meet the licensing requirement for that client. Section 6(d) applies if the client has an Enterprise license covering that contractor's use.

### (c) Educational use

Notwithstanding Section 3(b), students currently enrolled in accredited educational programs and individuals conducting non-commercial academic research may use the Software under the Free Tier regardless of the revenue or headcount of their educational institution. This exemption does not extend to commercial use of the Software by the institution itself.

### (d) Attribution

You may not remove or alter proprietary notices, copyright statements, or logos that appear in or on the Software. This Section does not apply to Open Materials.

## 4. Restrictions

You may not, and may not permit others to:

### (a) Redistribute

Distribute, sublicense, sell, transfer, publish, or otherwise make the Software, in source or compiled form, available to any third party, except that You may (i) create and maintain a publicly visible fork solely through the canonical repository host's built-in forking functionality, subject to Section 5(b), and (ii) submit contributions to the canonical repository as described in Section 5. A permitted public fork does not authorize You to publish releases, packages, binaries, or other standalone distributions of the Software from that fork. Nothing in this Section restricts Your rights in Open Materials or Your Content.

### (b) Compete

(i) Copy, adapt, translate, or otherwise reuse any material portion of the Software's protectable source-code expression, whether through literal copying or by creating a derivative work, for a product or service that Competes, or (ii) incorporate, bundle, embed, or wrap the Software in a product or service that Competes, or make the Software a required component or dependency of that product or service.

You may use the Software as an internal development tool under Section 2(a), including to write, test, or maintain a product that Competes, subject to Sections 3 and 6. This Section does not restrict independent implementation of ideas, functionality, methods, or publicly documented formats, subject to applicable intellectual property rights. Your rights in Open Materials are described in Section 5(e).

### (c) Circumvent licensing

Circumvent, disable, or defeat the Software's license verification mechanisms, or use Pro Tier capabilities without either a valid, unrevoked Pro License or an active Evaluation Trial. For clarity, Remote Dashboard Access obtained by relaying the Hosted Dashboard to another device through a proxy, tunnel, port forward, or similar mechanism, rather than through the Software's own settings, is use of a Pro Tier capability. You may not restart, extend, or obtain more than one Evaluation Trial for the same installation, user, or machine.

### (d) Offer as a hosted service

Offer the Software's workflow orchestration capabilities as a hosted, managed, or multi-tenant service to third parties. For clarity, using the Software locally, or on Your own private devices or private network, to automate Your own development workflows is permitted, including Remote Sessions and, subject to Section 2(c) or 2(d), Remote Dashboard Access for Your own internal access, so long as it is not offered to third parties as a service.

### (e) Misrepresent license status

Represent that the Software is "open source" or governed by an OSI-approved open-source license. The Software is source-available under this commercial license only.

### (f) Third-party AI service terms

The Software is designed to interface with third-party AI coding assistants and the model providers behind them, including GitHub Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI. The Software does not include, and Licensor does not supply, any of those tools, services, models, or the subscriptions or API credits they require; You are responsible for obtaining and maintaining them. Your use of those services through the Software remains subject to each service's own terms of use. You are solely responsible for ensuring Your use of the Software complies with the terms and conditions of any third-party AI service You access through it. Licensor is not responsible for changes to third-party service terms that affect Your ability to use the Software with those services.

## 5. Source Code and Contributions

### (a) Source availability

Licensor makes the Software's source code available at its canonical public repository. This availability does not grant rights beyond those stated in this License.

### (b) Forking

You may fork the repository solely for personal evaluation, security review, internal non-redistributed adaptation, or contribution preparation. A fork created through the canonical repository host's built-in forking functionality may remain publicly visible to the extent the host requires. Any fork remains subject to this License, may not be distributed outside that hosted fork or used to publish releases, packages, or binaries except as part of a permitted contribution to the canonical repository, and may not be used in a manner prohibited by Section 4(b).

### (c) Contributions

By submitting a contribution, including a pull request, to the canonical repository, You grant Licensor a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, distribute, sublicense, and otherwise exploit the contribution as part of the Software or any derivative or successor product. For a contribution submitted for inclusion in Open Materials, this grant includes the right to distribute the contribution or a modified version of it under MIT-0. Licensor may designate another contribution as Open Materials with the contributor's express consent. You represent that You have the right to grant this license and that the contribution does not violate any third-party rights. Licensor may require You to accept a separate Contributor License Agreement before accepting a contribution.

### (d) No Change Date

This License does not convert to any other license on any future date. The Software remains under this License, or any successor commercial license issued by Licensor, indefinitely.

### (e) Open Materials and community templates

Licensor offers Open Materials under the [MIT No Attribution License (MIT-0)](https://opensource.org/license/mit-0), reproduced in `LICENSE-MIT-0` distributed with the Software. For purposes of MIT-0, its reference to the software means the Open Materials. The grant covers Open Materials in all released versions, including copies obtained under earlier versions of this License, to the extent Licensor has the right to grant it. It is an independent permission from Licensor. It does not require acceptance of this License or change the terms governing the rest of an earlier release under Section 16(e).

In addition to MIT-0, Licensor independently grants recipients of the Open Materials a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license under patent claims Licensor can license that are necessarily infringed by the Open Materials as distributed by Licensor. The patent license permits recipients to make, have made, use, offer to sell, sell, and import the Open Materials and modifications of them to the extent infringement would occur in the absence of the modification. It does not extend to claims infringed only by a modification or by combining the Open Materials with other materials. This grant is distinct from the patent license for the Software in Section 11.

The community template library at `github.com/FuzzyNova/ctrlyoke-templates`, and any successor library Licensor designates, is separate from the Software and is governed by the license stated in that library. Community submissions remain third-party materials when the Software lists, downloads, or installs them. Listing or making a template available does not endorse or certify it. To the maximum extent permitted by applicable law, Licensor makes no warranty about third-party templates, including their safety, suitability, or provenance. Sections 12 and 13 apply to the Software's functions for finding, downloading, and installing them. A template can run commands and instruct AI tools to change files. Review templates before running them.

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

### (c) Your Content

**"Your Content"** means the workflows, prompts, templates, settings, scripts, and other material You create or provide in using the Software, together with run history and logs stored for You and output produced for You by the Software or third-party AI tools. As between You and Licensor, You retain whatever rights You have in Your Content. Licensor does not claim ownership of it. This License does not create intellectual property rights in material that is ineligible for protection or change the rights of third parties.

This License grants Licensor no general right to access, use, or receive Your Content. If You choose to send Your Content to Licensor, Licensor may handle it for the purpose for which You sent it, as described in the Privacy Policy or agreed with You. Sections 5(c), 8, and 10 and any applicable Data Processing Agreement continue to apply. Rights in Open Materials included in Your Content are described in Section 5(e). Output from third-party tools is subject to applicable law, the applicable third-party terms, and any third-party rights. Licensor makes no representation about the ownership, originality, or accuracy of that output.

## 8. Feedback

If You provide Licensor with feedback, suggestions, or ideas regarding the Software, You grant Licensor a perpetual, irrevocable, worldwide, royalty-free license to use, incorporate, modify, and commercialize that feedback in any product or service, without obligation to You.

## 9. Support; Updates; Availability

Licensor may provide support, updates, bug fixes, or future features at its sole discretion. Except as expressly stated in a separate written agreement or required by applicable law (for example, a legal obligation to supply security or conformity updates for digital content You paid for), Licensor has no obligation to maintain, support, or continue offering any feature, version, or service.

## 10. Privacy and Data Processing

Your use of the Software may involve the collection, transmission, storage, or processing of data, including telemetry, license validation data, configuration data, diagnostics, and usage information, as described in Licensor's Privacy Policy at [ctrlyoke.dev/privacy](https://ctrlyoke.dev/privacy) or any successor URL. The Privacy Policy, as updated from time to time, is incorporated by reference into this License. Notwithstanding Section 16(e), the then-current Privacy Policy governs Licensor's processing of that data, and Licensor will identify material changes to it as described in that policy.

## 11. Patent Rights

To the extent Licensor owns patent rights that are necessarily infringed by use of the Software as permitted under this License, Licensor grants You a limited, non-exclusive, worldwide, non-transferable, non-sublicensable patent license to make, use, and run the Software as permitted under this License.

If You initiate patent litigation alleging that the Software or any portion of it infringes Your patent, any patent license granted to You under this Section terminates as of the date such litigation is filed.

## 12. Disclaimer of Warranties

**THE SOFTWARE IS PROVIDED "AS IS," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS, OPERATE WITHOUT INTERRUPTION OR ERROR, OR THAT DEFECTS WILL BE CORRECTED.**

**Statutory rights.** Nothing in this License excludes, restricts, or modifies any guarantee, warranty, right, or remedy that applicable law gives You and does not permit to be excluded, restricted, or modified. Examples include the consumer guarantees under the Australian Consumer Law and the New Zealand Consumer Guarantees Act 1993, the statutory rights under the UK Consumer Rights Act 2015, and the conformity and update rights under national laws implementing Directive (EU) 2019/770. This Section 12 applies only to the extent those laws permit.

**Australian Consumer Law remedy.** If You acquire the Software as a consumer under the Australian Consumer Law and the Software is not of a kind ordinarily acquired for personal, domestic, or household use or consumption, Licensor's liability for failing to comply with a consumer guarantee, other than a guarantee under section 51, 52, or 53 of that law, is limited, to the extent section 64A of that law permits, to supplying the Software again or paying the cost of having it supplied again.

**AI tools and automated actions.** The Software directs third-party AI tools and executes scripts and commands as part of Your workflows. Depending on the permissions available in Your environment, these tools and automated actions can read, create, modify, or delete files, run programs, rewrite source-control history, and access networks and services. Available permissions can come from default or inherited settings or from permissions You expressly grant. You are responsible for reviewing workflows and templates before running them, configuring the permissions available to tools and scripts, reviewing resulting actions and output, and maintaining recoverable backups of important files, including work outside version control. Third-party AI tools determine the content they generate and may select actions automatically. Licensor does not guarantee the safety or accuracy of those actions or that content. This paragraph describes the respective roles of You and Licensor. It does not by itself limit Licensor's liability; Section 13 states those limits and their exceptions.

## 13. Limitation of Liability; Indemnity

### (a) Scope

**SUBJECT TO SECTION 13(d), THE DAMAGES EXCLUSION IN SECTION 13(b) AND THE CAP IN SECTION 13(c) APPLY, TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, TO ALL CLAIMS ARISING OUT OF OR IN CONNECTION WITH THIS LICENSE OR USE OF THE SOFTWARE, WHETHER BASED ON CONTRACT, WARRANTY, TORT (INCLUDING LICENSOR'S ORDINARY NEGLIGENCE), STRICT LIABILITY, OR ANY OTHER LEGAL THEORY.**

### (b) Excluded damages

**LICENSOR SHALL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES, INCLUDING SUCH DAMAGES FROM LOSS OF USE, DATA, OR PROFITS, BUSINESS INTERRUPTION, OR PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES, EVEN IF LICENSOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.**

### (c) Cap

**LICENSOR'S TOTAL CUMULATIVE LIABILITY FOR ALL THOSE CLAIMS SHALL NOT EXCEED THE GREATER OF (I) THE AMOUNTS PAID BY YOU TO LICENSOR IN THE TWELVE (12) MONTHS BEFORE THE EVENT FIRST GIVING RISE TO LIABILITY OR (II) USD $100. FOR THIS CAP, AMOUNTS PAID THROUGH LICENSOR'S AUTHORIZED RESELLER FOR YOUR LICENSE TO THE SOFTWARE COUNT AS AMOUNTS PAID TO LICENSOR.**

### (d) Exceptions

**NOTHING IN SECTION 12 OR THIS SECTION 13 EXCLUDES OR LIMITS LICENSOR'S LIABILITY FOR (I) FRAUD OR FRAUDULENT MISREPRESENTATION; (II) WILLFUL MISCONDUCT OR GROSS NEGLIGENCE; (III) DEATH, PERSONAL INJURY, OR DAMAGE TO HEALTH CAUSED BY NEGLIGENCE; OR (IV) LIABILITY UNDER APPLICABLE PRODUCT-LIABILITY LAW THAT CANNOT BE EXCLUDED OR LIMITED BY CONTRACT. ITEMS (I) THROUGH (III) COVER CONDUCT OF LICENSOR AND OF ANYONE ACTING ON ITS BEHALF, AS FINALLY DETERMINED BY A COURT OR OTHER TRIBUNAL OF COMPETENT JURISDICTION UNDER THE LAW GOVERNING THE CLAIM. NOTHING IN THIS LICENSE EXCLUDES OR LIMITS ANY OTHER LIABILITY, REMEDY, OR FEE ALLOCATION TO THE EXTENT APPLICABLE LAW PROHIBITS THAT EXCLUSION OR LIMITATION.**

### (e) Consumers where these limits are restricted

**If You are a Consumer and the mandatory law of Your usual residence does not permit Section 13(b) or 13(c) to apply to Licensor's ordinary negligence, then, to the extent that law permits, Licensor is liable for ordinary negligence only if it breaches an obligation whose performance is essential to the proper performance of this License and on which You may regularly rely, and only for damage that was typical and reasonably foreseeable when You accepted this License. This Section 13(e) does not limit liability described in Section 13(d).**

### (f) Licensor's personnel

Licensor's members, managers, officers, employees, and contractors may rely on Sections 12 and 13 as if each were Licensor. Those Sections limit their liability to the same extent as Licensor's, subject to the same exceptions, and the cap in Section 13(c) applies to all claims against Licensor and those persons combined.

### (g) Indemnity by business users

This Section 13(g) applies only if You are not a Consumer. You will defend Licensor and the persons described in Section 13(f) against any claim, demand, suit, or proceeding brought by a third party (a **Third-Party Claim**) to the extent it arises from (i) Your Content, including output You direct a third-party AI tool to produce and then use, publish, or distribute; (ii) Your breach of Section 4; (iii) Your violation of applicable law or of the terms of a third-party service You access through the Software; or (iv) a product or service You provide to others using the Software. You will pay the damages, costs, and reasonable attorneys' fees finally awarded against them in that Third-Party Claim, and any settlement of it that You agree to.

You have no obligation under this Section 13(g) to the extent a Third-Party Claim arises from (A) a claim that the Software as Licensor provides it infringes or misappropriates a third party's intellectual property rights; (B) Licensor's breach of this License; or (C) the negligence, gross negligence, willful misconduct, or fraud of Licensor or anyone acting on its behalf. **THIS SECTION 13(g) DOES NOT REQUIRE YOU TO INDEMNIFY ANY PERSON FOR THAT PERSON'S OWN NEGLIGENCE.**

Licensor will notify You in writing promptly after it learns of a Third-Party Claim. A delay relieves You of Your obligations only to the extent it materially prejudices Your defense. You may control the defense and settlement with counsel reasonably acceptable to Licensor, and Licensor will cooperate reasonably at Your expense. Licensor may participate through its own counsel at its own expense. You may not settle a Third-Party Claim in a way that admits fault by, or imposes any obligation other than a payment You make on, Licensor or a person described in Section 13(f) without Licensor's prior written consent, which Licensor will not unreasonably withhold.

If You do not assume the defense of a Third-Party Claim covered by this Section 13(g) within thirty (30) days after Licensor's notice, or You refuse a defense this Section 13(g) requires, Licensor may defend and settle that Third-Party Claim with counsel of its choice. You will then reimburse Licensor for the reasonable attorneys' fees and costs of that defense, for any reasonable settlement Licensor makes, and for the reasonable attorneys' fees and costs Licensor incurs in enforcing this Section 13(g). These amounts are limited to the share of the Third-Party Claim that this Section 13(g) requires You to bear.

Enterprise Subscription Terms or a signed order that addresses indemnity control over this Section 13(g).

## 14. Export Controls

You may not use, export, re-export, or transfer the Software in violation of applicable export control or economic sanctions laws, including the U.S. Export Administration Regulations and sanctions administered by the U.S. Treasury Department's Office of Foreign Assets Control. By using the Software, You represent that You are not located in, ordinarily resident in, or organized under the laws of a country or region subject to comprehensive U.S. sanctions, and that You are not listed on, or owned or controlled by a party listed on, any U.S. Government list of prohibited or restricted parties.

## 15. Term and Termination

### (a) Term

This License is effective from the date You first install, use, or access the Software and continues until terminated.

### (b) Termination for breach

This License terminates if You materially breach any of its terms and fail to cure the breach within thirty (30) days after written notice from Licensor. A breach of Section 4(a), a knowing breach of Section 4(c), or a knowing and material breach of Section 4(b) terminates this License immediately without notice. For purposes of this Section 15(b), a breach of Section 4(c) is knowing if You (i) deliberately circumvent, disable, or defeat the Software's license verification mechanisms, (ii) restart, extend, or obtain an additional Evaluation Trial knowing that doing so exceeds the limits in Section 4(c), or (iii) continue to use a Pro Tier capability after You actually know that the use requires a valid, unrevoked Pro License or an active Evaluation Trial and that You have neither. A material breach of Section 4(c) that is not knowing is subject to the thirty (30) day cure period above. For purposes of termination, You cure the breach if, by the end of that period, You have stopped the affected use or obtained a valid Pro License that covers that use. Either option cures the breach without payment for past use. For the breach identified in Licensor's written notice, that notice and Your continuation of the same use during the cure period, by themselves, are insufficient to establish a knowing breach. Upon termination You must cease using the Software and destroy all copies of it in Your possession or control, except to the extent retention is required by law. Termination does not require You to destroy Open Materials, Your Content, or materials You may keep under separate third-party terms. This exception does not authorize retaining any part of the Software included in those materials unless You have a separate right to do so.

### (c) Survival

Sections 4, 5(c)–(e), 7(a)–(c), and 8 through 16 survive termination.

## 16. General

### (a) Entire agreement

This License is the entire agreement between the parties regarding the Software and supersedes all prior and contemporaneous understandings regarding the Software. For an Enterprise subscription, the ctrlyoke Enterprise Subscription Terms replace this Section 16(a) and identify the documents that together form the agreement.

### (b) Governing law; venue

This License is governed by the laws of the State of Texas, USA, without regard to conflict-of-law rules. The United Nations Convention on Contracts for the International Sale of Goods and any law based on the Uniform Computer Information Transactions Act do not apply to this License. Except as provided in this Section 16(b), and to the extent permitted by applicable law, any court proceeding concerning a Dispute must be brought in a state or federal court of competent jurisdiction in Texas. The parties select a Texas state district court or county court at law in Travis County, Texas, or the United States District Court for the Western District of Texas, Austin Division, as the exclusive venue to the extent the venue selection is enforceable. If the venue selection is unenforceable, applicable law determines venue within the Texas forum. The parties consent to personal jurisdiction in Texas and to venue in the designated courts.

Either party may bring an individual claim in a small-claims court with jurisdiction. If You are a Consumer, this choice of law and venue preserves the non-waivable protections of the law of Your usual residence and any forum rights that applicable law does not permit You to waive. If You are a Consumer whose usual residence was outside the United States when the Dispute arose, either party may bring proceedings in the courts with jurisdiction where You usually reside. You may also use any other forum available to You under mandatory law.

### (c) Severability

If any provision is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable; the remaining provisions continue in full force.

### (d) No waiver

Failure by Licensor to enforce any provision shall not constitute a waiver of future enforcement.

### (e) Updates to license

Licensor may update this License for future versions of the Software. The version in effect when You obtained Your copy governs Your use of that copy unless You choose to adopt a later version. The independent permission for Open Materials in earlier releases is described in Section 5(e).

### (f) Contact

Licensing inquiries: `licensing@ctrlyoke.dev`

Legal notices: Fuzzy Nova LLC, 5518 Roosevelt Ave, Austin, TX 78756, USA

### (g) Voluntary dispute resolution

Either party may invite the other to resolve a Dispute informally. After a Dispute arises, the parties may separately agree in writing to mediation or arbitration. This License does not require an informal process before either party may file in court.

### (h) Assignment

You may not assign or transfer this License or any right under it, by operation of law or otherwise, without Licensor's prior written consent, except that You may assign this License in its entirety to a successor to all or substantially all of Your business or assets, provided that the successor does not Compete with the Software, agrees in writing to be bound by this License, and You notify Licensor within thirty (30) days of the assignment. Licensor may assign this License, in whole or in part, to an affiliate or in connection with a merger, acquisition, reorganization, financing, or sale of all or substantially all of its assets. Any attempted assignment in violation of this Section is void. This License binds and benefits the parties' permitted successors and assigns.

### (i) Language

This License is written in English. Licensor may provide translations for convenience. If a translation conflicts with the English text, the English text controls, except where applicable law requires otherwise.

---

Copyright © 2026 Fuzzy Nova LLC. All rights reserved in the Software, subject to the licenses stated above.
