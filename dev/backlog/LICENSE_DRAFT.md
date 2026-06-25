# FlightPath Commercial License — DRAFT

> **DRAFT — requires attorney review before use. Not final legal text.**  
> See the questions for counsel at the bottom of this document.  
> Based on requirements in [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md).

**Licensor:** Fuzzy Nova  
**Product:** FlightPath VS Code Extension and companion binaries  
**Draft version:** 0.2 — June 2026

---

## Plain-Language Summary *(not part of the license)*

- You may use FlightPath for free, personally or commercially, as long as your organization is below the revenue and headcount thresholds below.
- Individuals at large organizations (above $10M revenue or 250 employees) must have a Pro license — either purchased personally, or covered by their employer's enterprise license. A personal Pro license is sufficient; you do not need your employer to buy an enterprise license.
- Students in accredited educational programs and academic researchers may use FlightPath free regardless of their institution's size.
- A personal Pro license covers use in the course of employment, freelance work, and client engagements — you are not limited to personal projects.
- You may read and fork the source code for personal evaluation, security review, or contribution — but you may not redistribute FlightPath or use it to build a competing product.
- You may use FlightPath in automated scripts, CI/CD pipelines, and other non-interactive workflows.
- Pro licensees get additional capabilities: remote dashboard access, custom execution hooks, air-gapped activation, and future Pro features.
- This is a **source-available** license, not an open-source license.
- Fuzzy Nova retains all rights not expressly granted.

---

## 1. Definitions

**"Licensor"** means Fuzzy Nova.

**"Software"** means the FlightPath VS Code extension, including the compiled extension binary (VSIX), companion CLI and MCP server binaries, source code made available at the canonical repository, documentation, schemas, templates, and any updates or new versions.

**"Free Tier"** means the capabilities available without a Pro License, as described in current documentation and the VS Code Marketplace listing.

**"Pro License"** means a license key or signed license file issued by Licensor through its authorized licensing system that unlocks Pro Tier capabilities.

**"Pro Tier"** means the capabilities available only to holders of a valid Pro License, including remote dashboard access, custom execution hooks, air-gapped offline activation, and any future capabilities designated Pro by Licensor.

**"You"** (or "Your") means the individual or legal entity exercising rights under this License.

**"Your Organization"** means any legal entity under common control with You, where "control" means ownership of greater than fifty percent (50%) of the outstanding shares or beneficial ownership of such entity.

**"Compete"** means making available to third parties a product or service in which the orchestration of multi-step AI coding-assistant workflows through structured files is a primary or substantial feature, whether offered for free or for a fee.

---

## 2. License Grant

Subject to the terms and conditions of this License, Licensor grants You a limited, non-exclusive, non-transferable, non-sublicensable license to:

(a) **Install and use** the Software for Your internal purposes, including use in the course of personal employment, freelance work, or client engagements;

(b) **Read and fork** the source code for personal evaluation, security review, internal adaptation (not for redistribution), or contribution to the canonical repository; and

(c) **Access Pro Tier capabilities** if and only if You hold a valid, unrevoked Pro License for each machine on which Pro Tier capabilities are activated.

---

## 3. Free Tier Eligibility

The Free Tier rights in Section 2(a)–(b) are granted at no charge, subject to the following:

**(a) Eligible users.** The Free Tier is available to:
- Individual persons acting in their personal capacity; and
- Organizations whose **total annual gross revenue does not exceed ten million US dollars (USD $10,000,000)** AND who employ **fewer than two hundred fifty (250) persons** (counting full-time, part-time, and contract workers).

**(b) Commercial threshold — Pro License required.** If Your Organization's total annual gross revenue meets or exceeds USD $10,000,000, **or** Your Organization employs two hundred fifty (250) or more persons, each individual user of the Software affiliated with Your Organization must hold a valid Pro License for their use of the Software. This requirement is satisfied by either: (i) the individual user purchasing a personal Pro License; or (ii) Your Organization purchasing an enterprise site license that covers that user. Use of the Software under the Free Tier by users at qualifying organizations — without one of these forms of Pro License in place — is not permitted. This threshold is contractual; Licensor relies on Your Organization's honest self-assessment. Automated, scripted, and CI/CD pipeline use is permitted under any valid individual or enterprise Pro License.

**(c) Educational use.** Notwithstanding Section 3(b), students currently enrolled in accredited educational programs and individuals conducting non-commercial academic research may use the Software under the Free Tier regardless of the revenue or headcount of their educational institution. This exemption does not extend to commercial use of the Software by the institution itself.

**(d) Attribution.** You may not remove or alter proprietary notices, copyright statements, or logos that appear in or on the Software.

---

## 4. Restrictions

You may not, and may not permit others to:

**(a) Redistribute.** Distribute, sublicense, sell, transfer, or otherwise make the Software (in source or compiled form) available to any third party, except that contributions may be submitted to the canonical repository as described in Section 5.

**(b) Compete.** Use the Software or any material portion of its source code to Compete with the Software.

**(c) Circumvent licensing.** Circumvent, disable, or defeat the Software's license verification mechanisms, or use Pro Tier capabilities without a valid, unrevoked Pro License.

**(d) Offer as a hosted service.** Offer the Software's workflow orchestration capabilities as a hosted or managed service to third parties. (Using the Software's local and LAN-accessible server features to automate your own development workflows is permitted; providing those capabilities *to others* as a service is not.)

**(e) Misrepresent license status.** Represent that the Software is "open source" or governed by an OSI-approved open-source license. The Software is **source-available** under this commercial license only.

**(f) Third-party AI service terms.** The Software is designed to interface with third-party AI services and tools (including GitHub Copilot, Claude, Codex, Gemini, and others). Your use of those services through the Software remains subject to each service's own terms of use. You are solely responsible for ensuring Your use of the Software complies with the terms and conditions of any third-party AI service You access through it. Licensor is not responsible for changes to third-party service terms that affect Your ability to use the Software with those services.

---

## 5. Source Code and Contributions

**(a) Source availability.** Licensor makes the Software's source code available at its canonical public repository. This availability does not grant rights beyond those stated in this License.

**(b) Forking.** You may fork the repository for personal evaluation, security review, internal non-redistributed adaptation, or contribution preparation. Forks must not be distributed externally or used to Compete.

**(c) Contributions.** By submitting a contribution (e.g., a pull request) to the canonical repository, You grant Licensor a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, distribute, sublicense, and otherwise exploit the contribution as part of the Software. You represent that You have the right to grant this license and that the contribution does not violate any third-party rights.

**(d) No Change Date.** This License does not convert to any other license on any future date. The Software remains under this License (or a successor commercial license issued by Licensor) indefinitely.

---

## 6. Pro License Terms

**(a) Grant.** A Pro License grants the licensee the right to activate Pro Tier capabilities on up to the number of machines stated at purchase (currently ten (10) machines per individual license).

**(b) Activation.** Pro Tier capabilities require activation using a valid license key or signed license file issued by Licensor.

**(c) Individual perpetual license.** Unless otherwise stated at purchase, an individual Pro License is perpetual and does not require subscription renewal. Licensor may require a new license for major version upgrades at its discretion; existing licenses will be honored for the version purchased.

**(d) Enterprise license.** Enterprise site licenses, if offered, cover unlimited authorized users within a single legal entity and are issued as annual subscriptions. Coverage extends to employees, officers, and contractors engaged to perform work for Your Organization, provided their use of the Software is in the course of that work.

**(e) Revocation.** Licensor may revoke a Pro License upon: (i) material breach of this License; (ii) fraudulent purchase or chargeback; or (iii) violation of applicable law including export controls. Revocation terminates the Pro License; Free Tier rights (where applicable) continue.

**(f) Non-transferability.** Pro Licenses are personal to the named licensee and may not be transferred, resold, or sublicensed without Licensor's prior written consent.

---

## 7. Intellectual Property

The Software and all copies are proprietary to Licensor; title remains with Licensor. No intellectual property rights in the Software are transferred to You by this License.

---

## 8. Feedback

If You provide Licensor with feedback, suggestions, or ideas regarding the Software, You grant Licensor a perpetual, irrevocable, worldwide, royalty-free license to use, incorporate, and commercialize that feedback in any product or service.

---

## 9. Disclaimer of Warranties

**THE SOFTWARE IS PROVIDED "AS IS," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL MEET YOUR REQUIREMENTS, OPERATE WITHOUT INTERRUPTION OR ERROR, OR THAT DEFECTS WILL BE CORRECTED.**

---

## 10. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING LOSS OF USE, DATA, OR PROFITS; BUSINESS INTERRUPTION; OR PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES), ARISING OUT OF OR IN CONNECTION WITH THIS LICENSE OR THE USE OF THE SOFTWARE, EVEN IF LICENSOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. LICENSOR'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR IN CONNECTION WITH THIS LICENSE SHALL NOT EXCEED THE AMOUNTS PAID BY YOU TO LICENSOR IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM, OR USD $100 IF NO AMOUNTS HAVE BEEN PAID.**

---

## 11. Export Controls

You may not use or export the Software in violation of applicable export laws and regulations, including U.S. Export Administration Regulations. By using the Software, You represent that You are not located in a country subject to a U.S. Government embargo and are not listed on any U.S. Government list of prohibited or restricted parties.

---

## 12. Term and Termination

**(a) Term.** This License is effective from the date You first install, use, or access the Software and continues until terminated.

**(b) Termination for breach.** This License terminates automatically and immediately if You materially breach any of its terms and fail to cure such breach within thirty (30) days of written notice. Upon termination You must cease all use and destroy all copies in Your possession or control.

**(c) Survival.** Sections 4, 7, 8, 9, 10, 12, and 13 survive termination.

---

## 13. General

**(a) Entire agreement.** This License is the entire agreement between the parties regarding the Software and supersedes all prior and contemporaneous understandings.

**(b) Governing law; venue.** This License is governed by the laws of [STATE], USA, without regard to conflict-of-law rules. Any dispute shall be resolved in [COUNTY/CITY], [STATE].

**(c) Severability.** If any provision is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable; remaining provisions continue in full force.

**(d) No waiver.** Failure by Licensor to enforce any provision shall not constitute a waiver of future enforcement.

**(e) Updates to license.** Licensor may update this License for future versions of the Software. The version in effect when You obtained Your copy governs Your use of that copy unless You choose to adopt a later version.

**(f) Contact.** Licensing inquiries: `admin@fuzzno.com`

**(g) Dispute resolution; arbitration.** *[ATTORNEY TO ADVISE — consider whether to include mandatory binding arbitration and a class action waiver. Rationale for inclusion: a class action from a large user base is existential for a solo-operated product in a way a single arbitration is not; mandatory arbitration is standard in many commercial software licenses. Tradeoffs: some users react negatively to arbitration clauses; may not be enforceable in all jurisdictions (notably the EU and Quebec). Attorney should advise on scope (e.g., carve-out for injunctive relief), applicable rules (AAA, JAMS), location, and whether a class action waiver is appropriate here. PLACEHOLDER — do not ship without attorney decision.]*

---

**Copyright © 2026 Fuzzy Nova. All rights reserved.**

---

## Questions for Counsel

The following are the open points that need attorney judgment — the draft above reflects our intent, but these clauses should be reviewed and tightened:

1. **Governing law / venue** — fill in jurisdiction (Nathan's state of residence or state of incorporation).
2. **Revenue threshold clause (§3(b))** — confirm the honor-system threshold is the right enforcement model and the language is clean. Is "total annual gross revenue" the correct measure, or should it be "recurring software revenue" or something else?
3. **"Compete" definition (§1)** — updated from "primary purpose" to "primary or substantial feature." Is this the right line? Confirm it catches a tool where workflow orchestration is a major secondary feature, without being so broad it catches any AI-adjacent developer tool.
4. **Anti-SaaS clause (§4(d))** — confirm the carve-out for personal/LAN use is unambiguous and does not inadvertently capture the legitimate Pro use case (binding to a LAN IP for personal mobile access).
5. **Pro License revocation on chargeback (§6(e))** — review for consumer protection implications in relevant jurisdictions (EU, UK, AU, CA). Is "immediately upon chargeback" the right trigger, or should there be a cure period?
6. **Contribution license grant (§5(c))** — is this sufficient to allow relicensing of contributions under a future commercial license, including CLA-equivalent protections?
7. **"No Change Date" clause (§5(d))** — confirm this is unambiguous and cannot be read to conflict with any open-source obligations in the Software's npm dependencies.
8. **Enterprise annual subscription (§6(d))** — any additional terms needed for B2B subscription contracts (auto-renewal notices, cancellation rights, etc.)?
9. **First-run acceptance** — does installing from the VS Code Marketplace constitute acceptance of this license, or does the extension need an explicit in-app click-through? (Consider GDPR/CCPA consent implications if click-through also covers a privacy policy.)
10. **Patent rights** — should there be an explicit patent license grant or defensive termination clause?
11. **Minimum-age / COPPA** — is a minimum-age clause needed given the product is developer tooling (unlikely to be used by minors, but confirm)?
12. **Arbitration / class action waiver (§13(g))** — advise on whether to include, which rules to use (AAA, JAMS), whether to carve out injunctive relief, and enforceability in key international markets (EU, UK, CA, AU).
13. **Educational carve-out enforcement (§3(c))** — is the "currently enrolled in accredited educational programs" language sufficient, or does it need a verification mechanism or an explicit statement that Licensor may request proof of eligibility?
14. **Privacy policy** — once a privacy policy exists at `flightpath.dev/privacy`, the license should reference it. Add a forward reference now or on next revision.
