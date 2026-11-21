# ctrlyoke Commercial License v2.3 approval memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 21, 2026**
**first pass counsel reviewed and made recommendations on behalf of Fuzzy Nova LLC · November 21, 2026**

[Open the complete v2.3 license draft](LICENSE_2.3_DRAFT.md) ·
[Companion contribution text](#companion-contribution-text-for-approval) ·
[Publication checklist](#publication-checklist) ·
[Product and checkout checks](#product-and-checkout-readiness) ·
[Research and citations](#research-answers-for-counsel)

**Requested response.** Approve the v2.3 draft and companion contribution text as written,
or identify the row or clause you would change and give the replacement wording. The
recommendations below resolve the original policy questions. The publication checklist
lists the release work to close after legal review. v2.2 remains the published version until
adoption.

**Fuzzy Nova's launch facts.** ctrlyoke has had no public marketing or sales. Fuzzy Nova
reports that the Marketplace and npm downloads were its own and that there are no known
outside users, customers, or Enterprise orders. On those facts, adopt v2.3 for future
distribution and use with no customer migration. Fuzzy Nova accepts the possibility of
class litigation and has chosen court-based dispute resolution.

## Counsel recommended decisions:

| Topic                                     | Recommended decision                                                                                                                                                                                                                                                                                                                                                                                                                          | Draft and support                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in templates, examples, and schemas | Use MIT-0, with one packaged license and scope notices. Include verified materials in earlier releases in a new, prospective permission independent of v2.3 assent. Add a limited express patent grant for claims Fuzzy Nova can license. Leave past claims to case-by-case handling.                                                                                                                                                         | §§1, 5(e), 11, 15(c), 16(e). [Q1](#q1-mit-0-incorporation-placement-and-patents), [Q2a](#q2a-earlier-copies-and-16e)                                                                               |
| Community library and user content        | Keep the library separately licensed under MIT-0, use the import disclaimer, and preserve mandatory consumer protection. Keep content rights with their existing holders, with narrow handling for voluntarily submitted material and existing privacy and DPA terms.                                                                                                                                                                         | §§5(e), 7(c), 10, 12–13. [Q2](#q2-community-library-coverage-and-installation-exposure), [Q3](#q3-your-content-and-ai-output)                                                                      |
| Competition and assignment                | Permit internal development of competing products and independent implementation. Restrict protectable code reuse and product integration. Keep the competitor restriction on automatic assignment, with written consent available. Reserve immediate termination under §4(b) for knowing, material violations. Allow other material §4(b) breaches the ordinary 30-day cure.                                                                 | §§4(b), 5(b), 15(b), 16(h). [Q4](#q4-nonliteral-copying-and-legitimate-competition)                                                                                                                |
| Contribution intake                       | Require the standalone non-exclusive CLA before merging outside contributions into the main repository. Obtain a limited patent sublicense right for submissions to Open Materials only. For the separate library, use GitHub D.6, an authority confirmation, and a removal process. Plan without relying on a Fuzzy Nova §512 safe harbor.                                                                                                   | §5(c) and [companion text](#companion-contribution-text-for-approval). [Q5](#q5-standalone-contributor-assent-and-license-vs-assignment), [Q6](#q6-separate-mit-0-contribution-intake-and-removal) |
| Remote use and contractor eligibility     | Treat browsers on the same local physical host as local, and browser access from a second device through a relay as remote. Apply both existing commercial thresholds separately to each covered entity. Use client-controlled development or more than six months of substantially full-time work as the workforce tests, including through intermediaries. The draft fixes the counting dates and accepts the residual worker-rotation gap. | §§1, 3, 4(c), 6(d). [Remote access check](#remote-access-implementation-check), [Q7](#q7-contractor-workforce-tests-and-the-intermediary-gap)                                                      |
| Dispute resolution                        | Use courts by default for consumers and businesses. Keep Texas law and Austin venue with the small-claims and consumer protections in the draft. Keep informal resolution optional and permit mediation or arbitration by written agreement after a dispute arises. Accept the possibility of class litigation and leave jury and class procedures to the applicable court rules.                                                             | §§16(b), 16(g). [Q8](#q8-court-proceedings-and-voluntary-resolution), [Q8a](#q8a-provider-and-fee-decision), [Q8b](#q8b-who-decides-threshold-questions)                                           |
| Liability                                 | Keep the greater of 12 months' fees or $100 and count authorized reseller payments. Exempt fraud, willful misconduct, gross negligence, and negligent death or personal injury from the disclaimer and cap. Preserve other non-waivable remedies and fee allocations.                                                                                                                                                                         | §§12–13. [Q9](#q9-liability-cap-and-mandatory-remedies)                                                                                                                                            |
| Adoption and effective date               | Publish the approved v2.3 text and apply it prospectively through the ordinary channels. Keep the v2.2 text in version history. On the confirmed launch facts, there is no outside user or customer migration. Keep the existing versioned Enterprise acceptance for new orders.                                                                                                                                                              | §§0, 16(e). [Q10](#q10-adoption-and-earlier-versions)                                                                                                                                              |

## Companion contribution text for approval

### Main repository contributor license agreement

**ctrlyoke Contributor License Agreement · Version 1.0**

This agreement is between Fuzzy Nova LLC and the individual or entity affirmatively
accepting it. If you accept for an entity, you represent that you are authorized to bind it.

A **Contribution** is material you intentionally submit to the canonical ctrlyoke
repository for inclusion in the project. This agreement covers Contributions you submit
after acceptance and earlier Contributions you expressly identify in a written or
electronic confirmation. You retain ownership of your Contributions.
You grant Fuzzy Nova LLC a perpetual, irrevocable, worldwide, non-exclusive, royalty-free
license to reproduce, modify, create derivative works of, display, perform, distribute,
sublicense, and commercially use your Contributions as part of ctrlyoke or a derivative
or successor product. For a Contribution submitted for inclusion in Open Materials
identified by the project, or later designated as Open Materials with your express
consent, that grant includes distribution and sublicensing under MIT-0.

For a Contribution covered by the preceding Open Materials sentence, you also grant
Fuzzy Nova LLC a perpetual, irrevocable, worldwide, non-exclusive, royalty-free patent
license, with the right to sublicense on the same terms to recipients of those materials.
The grant covers only patent claims you can license that are necessarily infringed by
that Contribution as accepted into Open Materials. It permits making, having made, using,
offering to sell, selling, and importing the Contribution, including in modified form to
the extent the same claim is necessarily infringed by the accepted, unmodified
Contribution. The grant excludes claims infringed only by later modification or by
combination with other materials.

You represent that you have authority to grant these rights and that your Contribution
does not violate any third-party rights. Identify any third-party material included in a
Contribution and disclose the terms that apply before submission. Fuzzy Nova LLC may
decline a Contribution. This agreement governs contribution rights independently of the
commercial license for using ctrlyoke.

**Suggested acceptance control.** “I agree to the ctrlyoke Contributor License Agreement
v1.0 for my contributions.”

### Separate community library PR confirmation

> I have the right to submit this contribution, and I make it available under this
> repository's MIT No Attribution License (MIT-0). I have identified any third-party
> material included in the contribution and its applicable terms.

The community repository should link its root MIT-0 text and identify the reporting
contact in its contribution instructions. Reject submissions with incompatible additional
terms. Use GitHub's repository-license rule for GitHub PRs, and obtain equivalent written
permission for submissions made elsewhere.

## Publication checklist

1. **Adopt and date the license.** Use the calendar date the approved v2.3 text is first
   published as adopted. Update root `LICENSE.md` and the
   [website summary](../../landing/src/legal/license-summary.md) together. The
   [terms page](../../landing/src/pages/terms.astro) imports the root license and rejects a
   summary for a different version. Preserve the exact v2.2 text in version history and
   record the change under **Changed** in [CHANGELOG.md](../../CHANGELOG.md). The disclosed
   launch facts call for ordinary publication and distribution. AAA registration, customer
   notification, re-acceptance, and opt-out migration are outside this release.
2. **Align related legal text.** In [Enterprise Terms §12](../../ENTERPRISE_TERMS.md#12-warranties-liability-and-disputes)
   use the companion wording below. Update [Privacy Policy §8](../../PRIVACY.md#8-data-retention)
   using the replacement retention entry below. Publish the updated documents with versioned
   checkout links and confirm the bundle records the applicable EULA and Enterprise Terms
   versions. Publish the court-based wording in the plain-language summary.
3. **Confirm rights and package MIT-0.** Check historical provenance and publish the dated
   earlier-copy permission for the cleared materials. Publish `LICENSE-MIT-0` with
   `Copyright (c) 2026 Fuzzy Nova LLC` and add scope notices. The
   [npm package build](../../scripts/build-npm-package.mjs) has explicit copy and package
   lists, and the [VSIX allowlist](../../.vscodeignore) names other license filenames.
   Inspect the actual archives. Require the CLA bot check for new outside authors and
   keep acceptance records for contributions the project relies on.
4. **Verify the product matches the terms.** Test local WSL2, container, and VM dashboard
   access and second-device forwarding. Before enabling community import, verify the
   publisher and write-path disclosures, explicit import, separate execution, removal
   process, and privacy notice against actual behavior. Evaluate §512 for Fuzzy Nova's
   role once the catalog architecture is known. Check current sales and distribution
   jurisdictions for independently applicable mandatory terms.

### Companion wording for publication

**Enterprise Terms §12, replacement for its final sentence**

> EULA Sections 16(b) (Governing Law and Venue) and 16(g) (Voluntary Dispute Resolution)
> apply to disputes under this Agreement.

**Privacy Policy §8, replacement retention entry**

> **Enterprise terms-acceptance records:** retained for the life of the applicable agreement
> and afterwards as needed for tax, accounting, and evidentiary purposes.

**Website summary, Disputes**

> Texas law governs the license. The usual venue is state or federal court in Austin,
> Texas. Eligible small claims can be brought in a small-claims court with jurisdiction.
> Consumers keep their mandatory protections and forum rights. Consumers who usually live
> outside the United States can also use the courts where they usually live for disputes
> about personal or household use. After a dispute arises, both sides can agree in writing
> to mediation or arbitration.

## Product and checkout readiness

**First pass, November 21, 2026.** The landing site built with the current v2.2 terms. I
exercised the built Enterprise form with synthetic data and intercepted the handoff locally
before Lemon Squeezy. The unchecked form was blocked. The checked form sent the v2.2
terms bundle version, signer, timestamp, and acceptance method in checkout custom data.
All 123 focused hosted-server and license-service tests passed. A local Windows-to-Ubuntu WSL2 probe using mirrored
networking also confirmed the Linux server sees an IPv4 loopback peer, which ctrlyoke
classifies as local.
[Enterprise form](../../landing/src/pages/enterprise/checkout.astro),
[hosted-server tests](../../src/test/unit/CtrlYokeHostedServer.test.ts),
[bind tests](../../src/test/unit/CtrlYokeHostedServerPortFallback.test.ts),
[license-service tests](../../src/test/unit/LicenseService.test.ts),
[loopback classification](../../src/utils/NetworkUtils.ts)

- **Checkout and distribution.** The existing first-party Enterprise form already links
  the full terms and records the signer's action and document versions. Keep that form for
  future orders. v2.3 requires no separate dispute-resolution choice, arbitration record,
  or arbitration-specific install or activation step. Individual Pro can continue to link
  to Lemon Squeezy. Publish the applicable version and ordinary license notice for the
  Marketplace, npm, CLI, MCP, and source channels. Run one test-mode Enterprise order
  after updating the legal documents and verify the linked text and versions that reach
  the order. The local smoke test verified the handoff up to Lemon Squeezy.
  [Enterprise form](../../landing/src/pages/enterprise/checkout.astro),
  [checkout fields](../../src/license/LemonSqueezyConstants.ts),
  [pricing page](../../landing/src/pages/pricing.astro)
- **Remote access and contractor eligibility.** Current code gates non-loopback binds and
  non-loopback clients using Pro/trial state. The observed WSL2 configuration works with
  the draft's same-host rule. Other WSL2 configurations, containers, VMs, and relays can
  yield a socket peer address that does not describe the physical browser. The tests cover
  the ordinary gate and default fallback. **Recommendation:** retain the physical-location
  contract rule and describe its enforcement as network-address based. Verify a free local
  browser in each supported setup and a direct second-device browser under free, trial and
  Pro before claiming full runtime parity. Leave company revenue, worker counts, and
  commercial eligibility to the contractual self-assessment already specified in §3.
  [Hosted server gate](../../src/server/CtrlYokeHostedServer.ts),
  [license draft](LICENSE_2.3_DRAFT.md#3-free-tier-eligibility)
- **Packaging, community templates, and the contributor agreement.** Both package formats
  ship the commercial license and runtime template/schema content. The VSIX allowlist
  and npm build have no `LICENSE-MIT-0` entry. The landing site imports the live root
  license and checks the summary's version. The local template catalog exists, while
  the dedicated community-library import remains planned. The current PR template has a
  contribution checkbox and no enforced standalone CLA appears in the source tree.
  **Recommendation:** package and inspect the MIT-0 file on adoption, publish the
  revised summary and archived terms, and configure the contributor check separately.
  Verify the community import disclosures when that feature is implemented.
  [VSIX allowlist](../../.vscodeignore),
  [npm build](../../scripts/build-npm-package.mjs),
  [terms page](../../landing/src/pages/terms.astro),
  [community template plan](../backlog/COMMUNITY_TEMPLATES_PLAN.md),
  [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)

## Research answers for counsel

**Scope.** Prepared November 21, 2026. The analysis starts with U.S. federal and Texas law and
addresses material consumer-law exceptions. The recommendations use Fuzzy Nova's confirmed
launch facts and chosen court-based model. The release steps are in the
[publication checklist](#publication-checklist).

### Q1. MIT-0 incorporation, placement, and patents

Use the official MIT-0 text verbatim in one root `LICENSE-MIT-0` and define the covered materials
in §1 and §5(e). The OSI text expressly permits copying, modification, redistribution and
commercial reuse, with no requirement that recipients preserve a copyright or license notice.
There is no need to reproduce the full text per file. Include short scope notices in
`src/templates/` and `schemas/` and a notice for documentation examples, and ship the root
license with the VSIX and npm artifact. Prefer SPDX identifiers or a nearby scope notice for
standalone files where useful and where comments are supported. Copied templates and public
schema endpoints should have an easy-to-find canonical license reference, even though recipients
need not carry it forward. The draft defines the types of covered files, including schema
archives, rather than licensing every future file that happens to appear under those directories.
Flag separately licensed content and avoid marking runtime implementation or borrowed code as
MIT-0. CC0 §4(a) expressly excludes patents, while MIT-0 leaves them unaddressed.
[OSI MIT-0 text](https://opensource.org/license/mit-0),
[SPDX MIT-0 entry](https://spdx.org/licenses/MIT-0.html),
[CC0 §4(a)](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en).

Existing §11 is a poor fit for downstream template use. It covers patents necessarily infringed
by use of the commercial Software, on narrower and non-sublicensable terms. The draft adds a
separate, permissive grant directly to each Open Materials recipient for claims Fuzzy Nova can
license that are necessarily infringed by those materials as distributed. That gives users
express patent permission for ordinary reuse, including the covered part of a modified copy, and
avoids depending on a fact-specific implied license. It makes no promise about other parties'
patents or claims triggered solely by a user's additions. **Recommendation.** Approve the irrevocable grant in §5(e). Require a compatible, limited
patent sublicense right for main-repository contributions destined for Open Materials, using
the CLA below. Keep ordinary commercial-code contributions copyright-only under the standard
CLA. Review separate contributor rights before relicensing older material.
[35 U.S.C. §271](https://uscode.house.gov/us/usc/t35/s271/),
[_TransCore v. Electronic Transaction Consultants_, 563 F.3d 1271, 1278–80 (Fed. Cir. 2009)](https://law.justia.com/cases/federal/appellate-courts/cafc/08-1430/08-1430-2011-03-27.html).

### Q2. Community library coverage and installation exposure

The separate repository and its own MIT-0 license define the inbound and outbound rights in the
library. The draft expressly preserves that boundary when ctrlyoke lists, downloads, or installs
a contribution, and applies §§12–13 to ctrlyoke's own integration. That helps with warranty
expectations. It cannot eliminate claims based on Fuzzy Nova's own conduct, misleading claims
about review or safety, a faulty installer, or non-waivable consumer rights. Keep the product
interface accurate about who supplied a template, what installation writes, and when things
execute. In particular, inspect the planned integration for automatic execution, path writes,
and import behavior before representing that templates are safe or reviewed. Determine whether
fetching directly from GitHub passes user information to GitHub and whether the Privacy Policy
needs updating before launch. The feature and repository are described as proposed in the
[community templates plan](../backlog/COMMUNITY_TEMPLATES_PLAN.md).

**Recommendation.** Approve §5(e)'s disclaimer and retain mandatory consumer guarantees. In
the import flow identify the publisher, state where files will be written, require an explicit
import action, and keep execution separate. Make no safety or review promise beyond what the
product actually verifies. Keep the library outside the release bundle. Where applicable,
update the privacy notice for GitHub requests before enabling import. The EU digital content
regime is one reason mandatory consumer protections belong in the draft.
[Directive (EU) 2019/770, arts. 3, 8, 14 and 22](https://eur-lex.europa.eu/eli/dir/2019/770/oj),
[FTC Avast complaint and order, illustrating exposure from software privacy representations](https://www.ftc.gov/system/files/ftc_gov/pdf/202_3033_-_avast_final_consent_package.pdf).

### Q2a. Earlier copies and §16(e)

Give recipients of earlier releases a new, independent permission. That lets them rely on the
MIT-0 grant while keeping the commercial terms that already govern their copies. The draft
expressly decouples the grant from v2.3 assent, and its scope is limited to rights Licensor
actually holds. Publish the grant in a stable, dated repository or release notice that users of
old tags can find. Identify the materials and releases it covers. Check historical sources
against outside contributions or separate notices before making the offer. A new permission
supports use of older copies from the date of the grant. It does not clearly resolve liability
for pre-grant redistribution. **Recommendation.** Publish a dated, prospective permission
for the verified materials in earlier copies. Do not add a release of past claims. Treat any
specific past-sharing dispute separately and omit any historical material that Fuzzy Nova
lacks authority to relicense.
[17 U.S.C. §§101 and 106](https://copyright.gov/title17/92chap1.html),
[17 U.S.C. §204](https://uscode.house.gov/us/usc/t17/s204/).

### Q3. Your Content and AI output

Use “You retain whatever rights You have” between these two parties. It avoids promising that
the user owns employer or client content, that a shared project grants rights in someone else's
material, or that a purely AI-generated output is protected. The U.S. Copyright Office says
prompts alone ordinarily do not supply the required human authorship under today's systems.
Human-authored material, creative selection or arrangement, and human modifications can still
qualify. Model terms allocate rights between the model vendor and its customer where those
rights exist. A vendor's ownership clause cannot create copyright or guarantee unique or
noninfringing output. OpenAI is one example, and the applicable terms depend on the harness
and account.
[U.S. Copyright Office, AI Copyrightability Report, pp. ii–iii, 17–28](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf),
[17 U.S.C. §§101, 102 and 201](https://copyright.gov/title17/index.html),
[OpenAI Terms of Use, Content](https://openai.com/policies/terms-of-use/).

The draft includes outputs, logs, settings and other project materials. It preserves the
separate permissions for contributions, feedback, voluntarily submitted support content, and
applicable processing under §10 and the DPA. The [Privacy Policy](../../PRIVACY.md) says that
workflow content and prompts are not intentionally collected, and that VS Code extension
telemetry can include redacted errors and pseudonymous identifiers. **Recommendation.** Approve
§7(c) as drafted. Keep support access purpose-limited, retain the DPA where applicable, and
check that the privacy description matches actual handling before publication.

### Q4. Nonliteral copying and legitimate competition

Potentially yes. Nonliteral copying can infringe where a competitor actually copies protected
expression, for example an original selection or arrangement of implementation elements,
and the filtered expression is substantially similar. A court filters ideas, methods of
operation, interfaces or elements dictated by compatibility or efficiency, and public-domain
material. Access and matching features alone do not prove infringement. An independent
implementation of publicly documented behavior or formats ordinarily falls outside copyright
protection for the code. Patents and, for genuinely secret material, trade secrets are distinct.
Use copyright's “protectable expression” standard to limit §4(b)(i), preserve §4(b)(ii)'s
separate bar on incorporating the Software into a competing product, and expressly allow
ordinary internal use to develop that product subject to normal tier eligibility.
[17 U.S.C. §102(b)](https://copyright.gov/title17/92chap1.html#102),
[_Engineering Dynamics v. Structural Software_, 26 F.3d 1335, 1342–47 (5th Cir. 1994)](https://law.justia.com/cases/federal/appellate-courts/F3/26/1335/618781/),
[_Computer Associates v. Altai_, 982 F.2d 693, 706–12 (2d Cir. 1992)](https://law.justia.com/cases/federal/appellate-courts/F2/982/693/137252/),
[_SAS Institute v. World Programming_, 64 F.4th 1319 (Fed. Cir. 2023)](https://www.govinfo.gov/content/pkg/USCOURTS-ca13-21-01542/pdf/USCOURTS-ca13-21-01542-0.pdf),
[Texas Civil Practice & Remedies Code §134A.002](https://tcss.legis.texas.gov/resources/CP/pdf/CP.134A.pdf).

**Recommendation.** Keep §16(h)'s competitor-assignment condition as a limit on automatic
assignment in a business transfer. Written consent remains available. Under §15(b), reserve
immediate termination under §4(b) for knowing, material violations. Apply the existing
30-day notice-and-cure process to other material violations, including inadvertent inclusion.
[Texas Business & Commerce Code §§15.05 and 15.50](https://statutes.capitol.texas.gov/Docs/BC/htm/BC.15.htm).

### Q5. Standalone contributor assent and license vs. assignment

Use a standalone non-exclusive CLA with conspicuous text and an affirmative authenticated
acceptance before merge. It can bind a contributor directly regardless of whether they have
installed ctrlyoke or agreed to the EULA. Keep §5(c) and the PR reminder as complementary
notice. The merge check should cover each contributing author, including co-authors and authors
added on later pushes, with controlled exceptions for company-authored changes and any automated
accounts. Preserve the contributor's stable GitHub ID, signature or recorded action, timestamp,
CLA version and immutable text, and related PR or commits. Check the bot's retention and export
capabilities and require its specific check through a ruleset. A GitHub identity helps prove
assent but does not establish rights in employer-owned or copied work. Ask for authority or
corporate acceptance when the contributor cannot grant those rights personally. Record consent
from existing contributors if their earlier grant is insufficient for a planned use.
[Texas Business & Commerce Code §§322.007 and 322.009](https://statutes.capitol.texas.gov/Docs/BC/htm/BC.322.htm),
[E-SIGN, 15 U.S.C. §7001](https://uscode.house.gov/us/usc/119-124/t15/s7001/),
[_Aerotek v. Boyd_, 624 S.W.3d 199, 204–09 (Tex. 2021)](https://law.justia.com/cases/texas/supreme-court/2021/20-0290.html),
[CLA Assistant](https://github.com/cla-assistant/cla-assistant),
[GitHub required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

A broad non-exclusive license is sufficient for incorporating, modifying, distributing,
sublicensing and commercializing the submitted code, assuming contributors actually own or
control the necessary rights. Include the right to sublicense under MIT-0 for contributions to
Open Materials, and align its patent terms with §5(e). Contributors keep ownership.
Consider an assignment or exclusive arrangement only if Fuzzy Nova needs ownership or standing
to bring its own copyright infringement action over a contribution. Copyright transfers
generally need a signed writing under §204(a), while §101 excludes non-exclusive licenses from
“transfer of copyright ownership.” **Recommendation.** Approve the standalone non-exclusive CLA
below and make its versioned check mandatory for outside contributions. Preserve acceptance
records for as long as Fuzzy Nova distributes or relies on the contribution. §5(c) in the
draft expressly addresses MIT-0 distribution and allows the separate CLA.
[17 U.S.C. §§101, 201, 204 and 501(b)](https://copyright.gov/title17/index.html).

### Q6. Separate MIT-0 contribution intake and removal

GitHub Terms D.6 generally licenses a contribution under the repository's license when the
repository contains notice of that license, subject to any separate agreement. For ordinary
GitHub PRs to a single-license MIT-0 library, use a root MIT-0 license, an express contribution
rule, and a PR confirmation that the submitter has authority and licenses the contribution under
MIT-0. Treat the checkbox as additional evidence. Review provenance and separate-license
dependencies before merging. For submissions that arrive outside GitHub or where ownership is
unclear, obtain an express grant or decline the submission. Fuzzy Nova would need a separate
agreement if it wanted rights beyond MIT-0, including an express contributor patent grant.
[GitHub Terms of Service D.5–D.7](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#d-user-generated-content),
[OSI MIT-0 text](https://opensource.org/license/mit-0).

Publish a reporting and removal contact, with a way to delist a template and stop offering it
through the product independently of GitHub's removal process. Triage copyright, malicious
content, secrets, and other reports, preserve the submission record, and consider warning users
if an installed version presents a credible risk. Removing a template from the catalog does
not remove old copies or itself cancel permission previously granted for legitimate copies.
**Recommendation.** Launch with a public reporting contact and a documented way to delist or
block an imported template. Use GitHub's process for material it hosts. Assume Fuzzy Nova has
no independent §512 safe harbor for planning purposes. Once the catalog architecture is
settled, assess whether §512(c) or (d) applies to Fuzzy Nova and complete the applicable steps
before relying on it, including a designated agent where required, notice and counter-notice,
repeat-infringer procedures, and responding to actual knowledge.
[U.S. Copyright Office, §512 safe harbors](https://www.copyright.gov/512/),
[GitHub DMCA Takedown Policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy).

### Remote access implementation check

The draft treats the browser's actual location as controlling. A browser on the Windows host of
a local WSL2 instance is local use. A laptop browser reaching a cloud-hosted dashboard by port
forwarding is Remote Dashboard Access, even if it uses a `localhost` URL. A VS Code in-editor
panel is outside the Hosted Dashboard definition, including in Codespaces. The current
[hosted server](../../src/server/CtrlYokeHostedServer.ts) treats a connection as local when
the socket peer address is loopback, and otherwise asks the Pro/trial gate. Reading the code
does not establish how Windows-to-WSL, same-host containers or VMs, or a same-host relay present
the peer address under each configuration. Test WSL2 defaults and mirrored networking, local
containers and VMs, and forwarding from a second device before claiming implementation
matches the text. Guest networking may gate intended local use, and loopback-terminating
forwarding from a second device may leave the prohibition to self-assessment.
[Microsoft WSL networking guidance](https://learn.microsoft.com/en-us/windows/wsl/networking),
[VS Code remote port forwarding](https://code.visualstudio.com/docs/remote/ssh#_forwarding-a-port-creating-ssh-tunnel).

### Q7. Contractor workforce tests and the intermediary gap

These can work as contract-specific eligibility tests. They need a clear subject, measurement
period, and exception for ordinary client collaboration. The draft looks through one-person
LLCs and staffing intermediaries, covers a development environment supplied or managed on
behalf of the client, and treats repository or ticket-system access alone as insufficient. It
starts the duration test after more than six consecutive months of work at or close to the
client's normal full-time schedule for comparable work. Routine leave or changing an
intermediary does not reset the clock. Both revenue and headcount apply. A contractor may
trigger Pro through their own firm, the client, or another qualifying entity under the
definition. An applicable Enterprise license satisfies the client requirement only as stated
in §6(d) and the relevant order.

This implements the intended distinctions: a short project on the freelancer's own equipment
generally uses the freelancer's metrics, a client-controlled cloud IDE can trigger the client
test from the start, and a full-time contractor on personal equipment becomes subject to the
client test after six months. A short engagement on personal equipment with ordinary repo access
still falls outside the workforce definition even if a large company procures it through an
LLC. Deliberate rotation of different workers can still avoid the duration test if their
development environments are independent. **Recommendation.** Accept that gap and keep the
two observable tests without a separate anti-avoidance clause. Apply both thresholds to
each covered business entity separately, including the contractor's own business. Use the
last completed fiscal year for revenue, actual revenue to date for a new business, and
headcount as of use, with a reasonable payroll-record proxy. Count employees and direct
contract workers once per entity. Count workers engaged through intermediaries when they
meet a workforce test based on their actual work, even if they do not use ctrlyoke. For
multiple clients, measure each client that meets a workforce test. The tests
establish license eligibility. Employment and tax status depend on separate rules.
[IRS employee and independent contractor factors](https://www.irs.gov/taxtopics/tc762),
[Texas Workforce Commission coverage and worker classification](https://efte.twc.texas.gov/ui_law_coverage_issues.html).

### Q8. Court proceedings and voluntary resolution

**Recommendation.** Adopt the court-based text in §§16(b) and (g). Keep Texas governing law and
Austin as the ordinary venue, preserve eligible small claims and non-waivable consumer
protections, and allow consumers usually resident outside the U.S. to use their home courts.
Either party may propose informal resolution. The parties can agree in writing to mediation
or arbitration after a dispute arises. The license imposes no waiting period to file suit.

Fuzzy Nova accepts that a claimant can seek class treatment where applicable law permits it.
The court decides certification under the applicable rules. The draft has no advance class
or jury waiver. This gives up the class-waiver protection that accompanies valid individual
arbitration and avoids maintaining a compulsory arbitration process for claims under v2.3.
[_AT&T Mobility v. Concepcion_, 563 U.S. 333 (2011)](https://www.govinfo.gov/app/details/USREPORTS-563/USREPORTS-563-333),
[Federal Rules of Civil Procedure, Rule 23](https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure),
[_Atlantic Marine Construction v. U.S. District Court_, 571 U.S. 49 (2013)](https://www.govinfo.gov/app/details/USREPORTS-571/USREPORTS-571-49),
[Rome I, art. 6](https://eur-lex.europa.eu/eli/reg/2008/593/oj),
[Brussels I bis, arts. 17–19](https://eur-lex.europa.eu/legal-content/en/ALL/?uri=CELEX%3A32012R1215).

### Q8a. Provider and fee decision

**Recommendation.** Choose a provider only if both parties agree after a dispute arises.
The standard terms do not name a provider, so v2.3 requires no consumer clause registration
or annual registry fee. Any voluntary mediation or arbitration would have the fees the
parties agree to for that case.
[AAA Consumer Rules R-12](https://www.adr.org/media/yawntdvs/2025_consumer_arbitration_rules.pdf).

### Q8b. Who decides threshold questions

**Recommendation.** Leave threshold and procedural questions to the court hearing the case
under its ordinary rules. The draft contains no delegation, batching, or filing-delay
provision. If the parties later agree to arbitrate a particular dispute, that later
agreement can specify the procedure and decision-maker.

### Q9. Liability cap and mandatory remedies

Keep the higher of twelve months' fees or $100. A lower cap would buy little in individual
claims. Regulatory remedies and non-waivable statutory rights remain subject to applicable
law. The draft expressly counts Software license payments through the authorized reseller
for all customers, consistent with [Enterprise Terms §12](../../ENTERPRISE_TERMS.md#12-warranties-liability-and-disputes).
It also preserves required fee allocations and mandatory remedies. In Texas, a general
consumer form usually cannot waive DTPA rights under §17.42. If Article 2 applies to a
transaction, §2.719 also raises unconscionability and essential-purpose questions. Its
applicability depends on the particular software transaction.
[Texas Business & Commerce Code §17.42](https://statutes.capitol.texas.gov/Docs/BC/htm/BC.17.htm#17.42),
[Texas Business & Commerce Code §2.719](https://statutes.capitol.texas.gov/Docs/BC/htm/BC.2.htm#2.719).

**Recommendation.** Keep the dollar cap and explicitly exempt fraud, willful misconduct,
gross negligence, and death or personal injury caused by negligence from both §§12 and 13.
Preserve other non-waivable remedies. Let the DPA and signed Enterprise Orders control in
their respective areas under the existing order of precedence. These explicit exceptions
are a drafting recommendation for the standard form. In `Bombardier`, the Texas Supreme Court
enforced a specific waiver of exemplary damages for fraud in a negotiated transaction between
sophisticated parties. [_Bombardier Aerospace v. SPEP Aircraft Holdings_, 572 S.W.3d 213, 230–34 (Tex. 2019)](https://www.txcourts.gov/media/1443450/170578.pdf).

The privacy-related question
depends on facts and jurisdiction, including actual data collection, recipients and claims
with private enforcement. Texas's Data Privacy and Security Act delegates enforcement to the
attorney general and creates no private right of action. Other statutes and common-law claims
can differ. Product and telemetry practices determine much of the underlying exposure.
[Texas Business & Commerce Code Chapter 541, §§541.151 and 541.156](https://tcss.legis.texas.gov/resources/BC/htm/BC.541.htm),
[FTC Avast final consent package](https://www.ftc.gov/system/files/ftc_gov/pdf/202_3033_-_avast_final_consent_package.pdf).

### Q10. Adoption and earlier versions

The published v2.2 terms name AAA and §16(e) ties the terms for a copy to the version in
effect when obtained unless a user adopts a later version. Fuzzy Nova confirms that it did
not submit v2.2 to AAA and has no outside users, sales, or Enterprise customers to move.

**Recommendation.** Publish v2.3 prospectively when approved and keep the prior version in
version history. The launch facts call for no v2.2 registry filing, customer notice,
re-acceptance campaign, or opt-out migration. Use normal notice of the new license and the
existing versioned legal bundle at future Enterprise checkouts.
[Published v2.2 license](../../LICENSE.md#e-updates-to-license),
[Enterprise checkout](../../landing/src/pages/enterprise/checkout.astro).
---

<details>
<summary>Superseded proposals and original question wording</summary>

## How to read this

Each change below gives the current text (or "new"), the proposed text, and why it is proposed.
The questions marked **Q** are the ones we most need counsel to answer. Changes 4 (contribution
mechanism) and 7 (dispute resolution) are where we most need precise wording.

Background on the product, because several changes depend on it:

- ctrlyoke is a source-available developer tool (VS Code extension, CLI, MCP server) sold by a
  single-member Texas LLC. The Free Tier covers most use. Pro is a cheap perpetual individual
  license, plus annual Enterprise subscriptions governed by separate Enterprise Subscription Terms
  (`ENTERPRISE_TERMS.md`).
- The source repository is public on GitHub. Outside contributions arrive as pull requests.
- The product ships **templates**: example workflow files, AI-agent definitions, "skills"
  (instruction files for AI assistants), and small example scripts. When a user picks a template,
  the product **copies it into the user's own project or the AI assistant's configuration
  folder**. Users then edit those copies, commit them to their own repositories (often public
  ones), and share them.
- We plan a **community template library**: anyone can submit a template by pull request, and
  the product lets users browse and import them. The library will be a **separate public
  GitHub repository, `FuzzyNova/ctrlyoke-templates`, whose only license is the MIT No
  Attribution License (MIT-0)**. It is not part of the Software's repository, and this License
  does not govern it. Contributions to it are licensed MIT-0 under GitHub's "inbound = outbound"
  rule (GitHub Terms of Service, section D.6) and that repository's own contribution guidelines.

---

## 1. Open Materials carve-out (built-in templates, examples, schemas)

**Problem.** Section 1 defines "Software" to include "schemas, templates", so every **built-in**
template is under the commercial license, including Section 4(a)'s ban on redistribution. Read
literally, a user who commits a workflow created from a built-in template to a public
repository, or posts it in a gist, is redistributing the Software. That is the product's
normal, intended use.

Community templates do **not** need this carve-out: they live in a separate MIT-0 repository and
were never part of the Software. The carve-out is still needed for the built-in templates,
documentation examples and schemas that ship inside the Software and that it copies into users'
projects. Section 5(e) below only needs a short statement that the community library is not
governed by this License.

**Proposed: amend the definition of "Software" in Section 1.**

> **"Software"** means the ctrlyoke VS Code extension, the compiled extension binary (VSIX),
> companion CLI and MCP server binaries, source code made available at the canonical repository,
> documentation, and any updates or new versions released by Licensor, excluding Open Materials.

**Proposed: new definition in Section 1.**

> **"Open Materials"** means the following, wherever they appear, including in copies made by
> the Software into Your projects or into the configuration of a third-party AI tool:
>
> (i) the workflow templates, agent definitions, skills, and example condition scripts that
> Licensor distributes with the Software for use in Your projects (in the canonical repository,
> the contents of `src/templates/`);
>
> (ii) code and configuration examples in the documentation; and
>
> (iii) the JSON Schemas that describe the Software's workflow and settings file formats (the
> contents of `schemas/`).

**Proposed: new Section 5(e).**

> ### (e) Open Materials and community templates
>
> Open Materials are not licensed under Sections 2 through 4 of this License. Licensor licenses
> the Open Materials to You under the MIT No Attribution License (MIT-0), reproduced in full in
> the `LICENSE-MIT-0` file distributed with the Software, in which "the Software" refers to the
> Open Materials. You may use, copy, modify, publish, distribute, sublicense, and sell Open
> Materials for any purpose, including in or with other tools, without attribution. This
> Section 5(e) also applies to Open Materials included in any earlier version of the Software.
>
> The community template library at `github.com/FuzzyNova/ctrlyoke-templates`, and any
> successor library Licensor designates, is not part of the Software and is not governed by this
> License. It is governed by the license stated in that library. Community templates are written
> by third parties, including when You find or install them through the Software. Licensor does
> not author or warrant them, and accepting a template into the library is not an endorsement of
> it. A template can run commands on Your computer and instruct AI tools to change Your files.
> Review any template before You run it.

**Proposed: amend Section 3(d).** Add at the end: "This Section does not apply to Open
Materials."

**Decided by Fuzzy Nova (November 21, 2026):**

- **MIT-0, not CC0 or MIT.** Templates get pasted into gists, chat messages and other people's
  repositories. Plain MIT would require each copy to carry the copyright notice, which nobody
  will do for a 30-line YAML file; MIT-0 drops that requirement. MIT-0 was preferred over CC0
  because templates contain scripts, MIT-0 is written for code and is OSI-approved, and some
  corporate legal policies reject CC0 for code because it expressly withholds patent rights
  (CC0 §4(a)). The same license applies to the separate community library.
- **Schemas are open (item iii).** The file format is already fully documented and its schema is
  publicly served to every user's editor, so keeping it closed protects little. Opening it lets
  the schemas be listed in the SchemaStore catalog (planned, `dev/backlog/SCHEMASTORE_CATALOG_PLAN.md`)
  so other editors validate ctrlyoke files, and lets the community library's CI use them. The
  protection that matters is Section 4(b), which bars reuse of the Software's code.

**Q1.** Is incorporating MIT-0 by reference, with "the Software" in MIT-0 redefined as the Open
Materials, clean enough? Or should Open Materials carry the MIT-0 text in each file or directory
instead? MIT-0 is silent on patents: is that, together with Section 11, enough for users who
copy built-in scripts?

**Q2.** The Software can fetch and install community templates from the separate MIT-0
repository. Is the "not part of the Software" sentence plus the third-party disclaimer enough to
keep that library outside this License, and outside Licensor's warranty and liability exposure,
when the product itself does the installing?

**Q2a.** Is the retroactive sentence ("also applies to Open Materials included in any earlier
version") effective, given Section 16(e) says the version in effect when a user obtained a copy
governs that copy?

---

## 2. Ownership of what users create

**Problem.** The license is silent on who owns workflow files, prompts, settings, run history, and
AI-generated output. Enterprise legal teams ask about this first.

**Proposed: new Section 7(c).**

> ### (c) Your Content
>
> **"Your Content"** means the workflow files, prompts, templates, settings, scripts, and other
> material You create or provide when using the Software, the run history and logs the Software
> stores for You, and any code, text, or other output produced by third-party AI tools or by the
> Software in the course of Your use. As between You and Licensor, You own Your Content, and
> Licensor claims no rights in it. This License does not give Licensor any right to access, use,
> or receive Your Content, except as You choose to send it to Licensor (for example, in a support
> request or Feedback) and as described in the Privacy Policy. Your Content may contain or be
> derived from Open Materials, which remain subject to Section 5(e). Licensor makes no
> representation about the ownership, originality, or accuracy of output produced by third-party
> AI tools; Your rights in that output, and any obligations attached to it, are governed by those
> tools' terms.

Add 7(c) to the survival list in Section 15(c).

**Q3.** Is "as between You and Licensor, You own" the right formulation, given that AI-generated
output may not be copyrightable at all and is governed by the AI vendor's terms?

---

## 3. Narrowing the non-compete

**Problem.** Section 4(b) currently says you may not "use the Software or any material portion of
its source code to Compete". Read literally, an engineer at any company building agent-orchestration
tools cannot use ctrlyoke at all, even to write unrelated code. That was not the intent. The intent
is to stop a competitor from (a) reusing ctrlyoke's code or (b) shipping ctrlyoke inside, or
wrapped by, a competing product.

The definition of "Compete" ("primary or substantial feature") stays as it is.

**Current 4(b):**

> Use the Software or any material portion of its source code to Compete with the Software.

**Proposed 4(b):**

> ### (b) Compete
>
> (i) Copy, adapt, translate, or create derivative works of the Software's source code, or any
> material portion of it, for use in a product or service that Competes; or (ii) incorporate,
> bundle, embed, or wrap the Software, or make it a required component or dependency of, a
> product or service that Competes. For clarity, You may install and use the Software as a
> development tool under Section 2(a) even if You or Your Organization Competes, including to
> write, test, and maintain the code of a product that Competes, so long as that product does not
> contain, depend on, or derive from the Software's source code.

**Conforming changes.**

- Section 5(b): "may not be used to Compete" becomes "may not be used in a manner prohibited by
  Section 4(b)".
- Section 16(h): the condition that an assignee "does not Compete with the Software" is kept, but
  counsel should confirm it is still wanted.
- Section 15(b): breaches of 4(b) stay non-curable. That is more defensible now that 4(b) is
  narrower.

**Q4.** Does "derivative works" plus "material portion" also cover a competitor that reads the
source and reimplements it closely without copying it literally? We are not trying to stop
clean-room reimplementation of the ideas, only reuse of the code.

---

## 4. Contribution license: an enforced mechanism

**What is already in place.** The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) already has a
checkbox: "I have the right to submit this contribution, and I grant the license to it described
in `LICENSE.md` §5(c)". `CONTRIBUTING.md` says that submitting a PR grants that license.

**Remaining gap.** A checkbox in a PR template is not enforced. A contributor can delete the
template text, open a PR from the command line, or leave the box unchecked, and nothing records
their acceptance against their GitHub identity. A contributor who has never installed the Software
has arguably never accepted the License at all.

**Proposed mechanism (engineering, not license text):**

1. A **click-through CLA bot** (for example, CLA Assistant) that blocks merging until each
   contributor's GitHub account has accepted a short Contributor License Agreement once, and keeps
   a record of the acceptance. The CLA text restates Section 5(c) as a standalone agreement, so it
   binds contributors who never accepted the License.
2. The PR checkbox stays as a reminder, and merging also requires the bot's check.

Community templates need no exemption: they are submitted to the separate MIT-0 repository, which
has no CLA. Its PR template asks the contributor to confirm the right to submit and the license
under MIT-0.

**Proposed: amend Section 5(c)** to point to the CLA:

> By submitting a contribution, including a pull request, to the canonical repository, You grant
> Licensor a perpetual, irrevocable, worldwide, non-exclusive, royalty-free license to use,
> reproduce, modify, distribute, sublicense, and otherwise exploit the contribution as part of the
> Software or any derivative or successor product. You represent that You have the right to grant
> this license and that the contribution does not violate any third-party rights. Licensor may
> require You to accept a Contributor License Agreement stating these terms before it accepts a
> contribution.

**Q5.** Is a click-through CLA plus the Section 5(c) language enough to bind a one-time
contributor who has never installed the Software? Should the CLA be a license (as drafted) or an
assignment? We prefer a license.

**Q6.** For the separate MIT-0 templates repository, is GitHub ToS D.6 plus a contribution note
and a PR checkbox in that repository enough without a CLA? Is there anything Fuzzy Nova LLC
should do as that repository's owner (for example, a takedown or removal policy) given that the
product fetches from it?

---

## 5. Remote Session vs. Remote Dashboard Access: concrete examples

**Problem.** The definitions are right in principle. A Remote Session transmits only the Host
Machine's screen or terminal; Remote Dashboard Access serves the Hosted Dashboard's traffic to
another device. But SSH supports both, and the reviewer asked directly whether `ssh -L` port
forwarding counts as a Remote Session or a tunnel. The answer under the current text is a tunnel,
and the license should say so.

There is a second, unintended problem: "Host Machine" means "the single physical or **virtual**
computer" running the Software. A developer who runs ctrlyoke inside WSL2, a dev container, Docker
Desktop, or a local VM, and opens the dashboard in a browser on the same laptop, is technically
using a browser on "another device". That is local use and should be Free.

**Proposed: amend the definition of "Host Machine".**

> **"Host Machine"** means the single physical computer on which a given installation of the
> Software is running. If the Software runs in a virtual machine, container, or subsystem (for
> example, Windows Subsystem for Linux, a dev container, or a local virtual machine), the Host
> Machine is the physical computer hosting it, and a browser running on that same physical
> computer is on the Host Machine. If the Software runs on a cloud virtual machine or a cloud
> development environment, that virtual machine or environment is the Host Machine.

**Proposed: add examples after the definition of "Remote Session".**

> For example:
>
> - **Remote Sessions** (Free Tier): connecting to the Host Machine through Windows Remote
>   Desktop, VNC, macOS Screen Sharing, Chrome Remote Desktop, or similar, and viewing the Hosted
>   Dashboard in a browser that runs on the Host Machine; using an SSH terminal session to run the
>   companion CLI on the Host Machine; and using the dashboard panel inside Visual Studio Code
>   while connected to the Host Machine through VS Code Remote Development (Remote-SSH, WSL, Dev
>   Containers, or Codespaces).
> - **Remote Dashboard Access** (Pro Tier): opening the Hosted Dashboard in a browser on Your
>   laptop or phone through SSH port forwarding (for example, `ssh -L 8080:localhost:8080`);
>   through Tailscale, ZeroTier, WireGuard, or another VPN or mesh network; through ngrok,
>   Cloudflare Tunnel, or another tunneling service; through VS Code's port-forwarding feature; or
>   by binding the Software's server to a network interface other than loopback.

The last sentence of Section 4(c), which bans relaying the dashboard "through a proxy, tunnel,
port forward, or similar mechanism", stays as it is. The examples make it unambiguous.

**Note for Nathan (not for the license).** The product detects remote access from the client's
network address. Traffic forwarded through `ssh -L`, or a tunnel that terminates on the same
machine, arrives on the loopback address and looks local. For those setups the Pro requirement is
honor-system only. That is consistent with the self-assessment approach elsewhere in the license,
but be aware the code will not enforce it. Confirm that a browser on Windows reaching ctrlyoke
inside WSL2 is treated as local in code, so the product matches the new definition.

---

## 6. Freelancers and contractors under the Section 3(b) revenue threshold

**Problem (not raised by the reviewer).** "Your Organization" includes "any legal entity ... for
whose benefit You use the Software". A solo freelancer using ctrlyoke on a contract for a client
with more than $10M in revenue therefore needs a Pro License, even though Section 2(a) expressly
permits use "in the course of ... freelance work, or client engagements", and Section 6(d) treats
an Enterprise customer's contractors as covered by that customer.

**Decided by Fuzzy Nova (November 21, 2026): a middle line.** An independent contractor's own
business size decides eligibility, unless the contractor works as part of the client's
workforce. In that case the client's size decides it, and the client's Enterprise license, if
any, covers the contractor under Section 6(d). A freelancer working on their own equipment is
judged by their own business. A contractor embedded in a large company's team on that company's
equipment is judged by the company. Committing to the client's source repository does **not**
by itself count as working inside the workforce: every freelancer does that.

**Proposed: replace clause (i) of "Your Organization" in Section 1.**

> (i) any legal entity that employs You; (ii) any legal entity that engages You as an independent
> contractor, consultant, or other non-employee worker, but only if You work as part of its
> workforce, meaning that You use the Software on a device, virtual desktop, or development
> environment that the entity provides, manages, or controls, or You perform services for it on
> a full-time or substantially full-time basis for more than six (6) consecutive months; (iii)
> any other legal entity for whose benefit You use the Software, other than a client of Your own
> independent business; and (iv) any legal entity under common control with You or with any
> entity described in clauses (i) through (iii), where **control** means ownership of greater
> than fifty percent (50%) of the outstanding shares or beneficial ownership of such entity.

**Proposed: add to the end of Section 3(b).**

> If You use the Software as an independent contractor or consultant, Your eligibility is
> determined by Your own business, and not by Your client's, except where Your client is Your
> Organization under clause (ii) of that definition. For example, a freelancer who uses the
> Software on their own computer to perform a contract for a large company is eligible for the
> Free Tier if the freelancer's own business is eligible. A contractor placed on a large
> company's team who works on a laptop that company provides is not.

**Q7.** Are the two workforce tests (client-controlled environment; full-time for more than six
consecutive months) clear and enforceable? Does clause (iii), "a client of Your own independent
business", leave a loophole, for example a large company routing a team through a
contractor's own LLC?

---

## 7. Dispute resolution: keep arbitration, with mass-arbitration safeguards

**Decided by Fuzzy Nova (November 21, 2026):** keep individual arbitration and the class-action
waiver, and add safeguards against mass arbitration. The replacement text for Section 16(g) is
below.

**Why.** Under AAA consumer rules the business pays most of the filing and arbitrator fees,
which can be thousands of dollars per claim even when the claim has no merit, and coordinated
mass-arbitration campaigns exploit exactly that. But for a _single_ claim, arbitration is not
clearly more expensive than court: legal fees dominate either way, and court adds discovery,
motion practice and a possible jury. Arbitration's distinctive cost is the _mass_ filing
scenario. Its distinctive benefit is the class-action waiver, which is generally enforceable
inside arbitration and much weaker in court. For this product the most realistic class-action
theory is a privacy claim about telemetry, not a licensing dispute. Dropping arbitration would
swap mass-arbitration fee risk for class-action risk. Keeping it and blunting the mass-filing
risk keeps the benefit and reduces the cost.

**Alternatives considered and not chosen:** keeping Section 16(g) unchanged (full
mass-arbitration fee exposure); courts only in Austin with a jury waiver (gives up most
class-action protection); and arbitration for Enterprise customers only (keeps arbitration where
class actions are least likely and drops it where they are most likely).

**What changes compared with v2.2:**

| Subsection                                   | Status                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| (1) Informal resolution                      | Expanded: personally signed notice, an individual conference, a 60-day window, and tolling of limitation periods |
| (2) Scope and exceptions                     | Unchanged in substance                                                                                           |
| (3) Rules, location, enforcement             | Unchanged in substance                                                                                           |
| (4) Fees                                     | New: states the fee position, plus fee awards for frivolous claims                                               |
| (5) Individual claims; jury and class waiver | Unchanged                                                                                                        |
| (6) Mass filings                             | New                                                                                                              |
| (7) Opt-out                                  | Unchanged                                                                                                        |
| (8) Severance                                | Expanded: a court stay while arbitration proceeds                                                                |
| (9) Future changes                           | New                                                                                                              |

Section 0 (the notice pointing to Section 16(g)), Section 16(b), and `ENTERPRISE_TERMS.md`
Section 12 (which incorporates Sections 16(b) and 16(g)) need no change.

**Proposed: replace Section 16(g) in full.**

> ### (g) Dispute resolution; arbitration
>
> **PLEASE READ THIS SECTION CAREFULLY. EXCEPT FOR THE LIMITED EXCEPTIONS BELOW, IT REQUIRES
> INDIVIDUAL BINDING ARBITRATION AND WAIVES JURY TRIALS AND CLASS PROCEEDINGS. YOU MAY OPT OUT AS
> DESCRIBED IN SECTION 16(g)(7).**
>
> **(1) Informal resolution first.** Before either party starts an arbitration, it must send the
> other a written notice of dispute. A notice from You must include Your name, the email address
> associated with Your license or purchase (if any), a description of the claim and the relief
> requested, and Your personal signature, and, if You are represented, Your counsel's signature as
> well. A notice to Licensor must be sent to the legal-notice address in Section 16(f), with a
> copy to `licensing@ctrlyoke.dev`. A notice from Licensor will be sent to the email address
> associated with Your license or purchase, or another address Licensor has for You.
>
> Within thirty (30) days after a notice is received, either party may request an individual
> informal dispute-resolution conference by telephone or video. If requested, the conference will
> take place at a mutually convenient time within thirty (30) days after the request. You and an
> authorized representative of Licensor must each attend personally; counsel may also attend. A
> separate conference is required for each claimant, unless the parties agree otherwise.
>
> Neither party may start an arbitration until sixty (60) days after the notice is received, or
> until any requested conference has taken place, whichever is later, unless the parties agree
> otherwise. All applicable statutes of limitation and filing-fee deadlines are tolled from
> receipt of a notice that complies with this Section until that period ends. A court of
> competent jurisdiction may enforce this Section 16(g)(1), including by enjoining or staying an
> arbitration filed without complying with it.
>
> **(2) Scope.** Except for (i) an individual claim eligible to be brought in small-claims court,
> which either party may bring there for so long as it remains in that court and is pursued on an
> individual basis, (ii) a dispute relating to a party's actual or threatened misuse of
> intellectual property or breach of confidentiality obligations, and (iii) a claim seeking
> temporary or preliminary injunctive relief, any dispute, claim, or controversy arising out of or
> relating to this License or the Software (a **Dispute**) shall be resolved by individual binding
> arbitration. The arbitrator decides all questions about the interpretation, scope,
> applicability, and enforceability of this Section 16(g), except that a court of competent
> jurisdiction decides any question about Section 16(g)(1), 16(g)(5), or 16(g)(6).
>
> **(3) Rules, location, and enforcement.** The arbitration will be administered by the American
> Arbitration Association (**AAA**) under its Consumer Arbitration Rules if AAA determines that
> those rules apply, and otherwise under its Commercial Arbitration Rules, in each case as
> modified by this Section 16(g). The Federal Arbitration Act governs the interpretation and
> enforcement of this Section. The arbitration will take place in Austin, Texas, except that a
> consumer claimant may participate remotely or from the county of the claimant's residence when
> the applicable AAA rules or law requires it. Unless a party requests an in-person hearing, or
> the arbitrator decides one is necessary, a claim for USD $25,000 or less will be decided on
> written submissions and, where the arbitrator permits, a hearing by telephone or video.
> Judgment on the award may be entered in any court of competent jurisdiction.
>
> **(4) Fees.** Payment of filing, administrative, and arbitrator fees is governed by the
> applicable AAA rules and fee schedule, and Licensor will pay the fees those rules allocate to
> the business. Each party bears its own attorneys' fees and costs, except where applicable law or
> the AAA rules provide otherwise. If the arbitrator finds that a claim, or the relief requested,
> was frivolous or brought for an improper purpose, as measured by the standards of Federal Rule
> of Civil Procedure 11(b), the arbitrator may award the other party its fees and costs to the
> extent applicable law permits.
>
> **(5) Individual claims only; waiver of jury and class proceedings.** **TO THE MAXIMUM EXTENT
> PERMITTED BY LAW, YOU AND LICENSOR WAIVE ANY RIGHT TO A JURY TRIAL AND AGREE THAT EACH MAY BRING
> CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY, NOT AS A PLAINTIFF OR CLASS MEMBER IN
> ANY PURPORTED CLASS, COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE PROCEEDING. THE ARBITRATOR MAY
> AWARD RELIEF ONLY TO THE INDIVIDUAL PARTY SEEKING RELIEF AND ONLY TO THE EXTENT NECESSARY TO
> RESOLVE THAT PARTY'S INDIVIDUAL CLAIM.** Except as provided in Section 16(g)(6), the arbitrator
> may not consolidate more than one person's claims.
>
> **(6) Mass filings.** If twenty-five (25) or more demands for arbitration that raise
> substantially similar claims are filed against Licensor, or by Licensor, by or with the
> assistance of the same or coordinated counsel or entities, within any one-hundred-eighty (180)
> day period (a **Mass Filing**):
>
> - (A) the AAA Mass Arbitration Supplementary Rules, as amended from time to time, apply in
>   addition to the rules in Section 16(g)(3), and each demand must still comply with
>   Section 16(g)(1);
> - (B) counsel for the claimants and counsel for Licensor will meet and confer in good faith
>   about resolving the demands efficiently, which may include mediation, agreed test cases,
>   and an agreed fee arrangement with AAA;
> - (C) unless the parties agree otherwise, AAA will administer the demands in batches of no
>   more than fifty (50) demands each, with one arbitrator appointed for each batch to the
>   extent the AAA rules permit. All batches may proceed at the same time. The demands in a
>   batch are consolidated for administration only: each claimant's claim is decided
>   individually, and each award binds only the parties to the claim it decides;
> - (D) no demand in a Mass Filing is treated as filed, and no filing or administrative fees are
>   due for it, until the meet-and-confer process in paragraph (B) has run for at least sixty
>   (60) days, and all applicable statutes of limitation are tolled for each demand from the
>   time it is first submitted until it is treated as filed; and
> - (E) a court of competent jurisdiction may enforce this Section 16(g)(6). If a court holds
>   any part of it unenforceable as to a Mass Filing, that part is severed, and the Mass Filing
>   proceeds in arbitration under the remaining provisions and the AAA rules.
>
> **(7) Opt-out.** You may opt out of this Section 16(g) by sending written notice to
> `licensing@ctrlyoke.dev` within thirty (30) days after You first accept this License. The notice
> must identify You, state that You opt out of Section 16(g), and provide the email address or
> other information reasonably sufficient to identify Your purchase or license, if any. Opting out
> does not affect the remaining provisions of this License, including Section 16(b), and does not
> affect any other agreement You have with Licensor.
>
> **(8) Severance.** If a final decision, not subject to further appeal, holds that a particular
> limitation in Section 16(g)(5) is unenforceable as to a particular claim or request for relief,
> that claim or request will be severed and may proceed only in a court as provided in
> Section 16(b). It will be stayed until the individual claims and requests for relief that remain
> in arbitration have been decided. The remaining claims will be arbitrated. In no event will a
> Dispute be arbitrated on a class, collective, or representative basis.
>
> **(9) Future changes.** If a future version of this License changes this Section 16(g), the
> change does not apply to a Dispute of which a party gave written notice under
> Section 16(g)(1) before that version took effect for You. You may reject a change to this
> Section 16(g) by writing to `licensing@ctrlyoke.dev` within thirty (30) days after the new
> version takes effect for You, in which case the last version of this Section 16(g) You accepted
> continues to govern Your Disputes.

**Q8.** Are the conference requirement in (1) and the batching in (6) likely to be enforced by
Texas state courts and the Fifth Circuit? The batching was kept deliberately moderate:
batches run in parallel, each claim is decided individually, there are no binding test cases,
and limitation periods are tolled. That is meant to avoid the problems that led the Ninth
Circuit to refuse to enforce one mass-arbitration protocol in _Heckman v. Live Nation_ (2024).
Are the thresholds (25 demands in 180 days; batches of 50; 60 days of meet-and-confer; written
submissions for claims of $25,000 or less) sensible?

**Q8a.** Is AAA the right provider for a business this size? Another provider, for example NAM,
which also has mass-filing rules, may be cheaper.

**Q8b.** Is the delegation split in (2) right? The arbitrator decides arbitrability in general,
but a court decides (1), (5) and (6), so that a mass filing can't use arbitrator-decided fee
disputes to gain leverage.

**Q9.** Does the limitation of liability (Section 13: the greater of 12 months' fees or $100)
need tightening alongside these changes?

**Q10.** Users who accepted v2.2 stay on v2.2 unless they adopt a later version (Section 16(e)).
Does a v2.2 dispute therefore stay under the v2.2 clause, without these safeguards? Is there an
enforceable way to bring existing users onto the new Section 16(g), for example through
acceptance at the next update, given (9)'s rule that changes do not apply to disputes already
noticed?

---

## 8. Housekeeping

- **Version and date:** "Version: 2.3", with a new Effective Date.
- **Survival (15(c)):** add 5(e) and 7(c).
- **Section 4(a):** add "Nothing in this Section restricts Open Materials or Your Content."
- **`LICENSE-MIT-0`:** add the MIT-0 text as a new root file referenced by Section 5(e), with the
  copyright line `Copyright (c) 2026 Fuzzy Nova LLC`. Make sure the VSIX and npm packages include
  it, and add a one-line MIT-0 notice to `src/templates/` and `schemas/` (for example, a short
  README in each) so a copied file's origin and license can be looked up.
- **Changelog:** record the license change under **Changed** in `CHANGELOG.md`, because users
  will notice it.
- **Website:** `ctrlyoke.dev/terms` renders `LICENSE.md` directly, so it updates automatically.

## Deliberately unchanged

These were considered and kept as they are: the honor-system self-assessment with no audit clause;
forking only through the repository host's built-in fork feature; perpetual individual Pro
licenses with paid major upgrades; the student and academic exemption; and Section 5(d), under
which the license never converts to open source.

## Decided: community templates live in a separate MIT-0 repository

Fuzzy Nova decided on November 20, 2026 to host the community library in
`FuzzyNova/ctrlyoke-templates`, whose only license is MIT-0, rather than in a directory of the
Software's repository. As a result:

- the license needs no path-scoped carve-out for community content (Section 1 now covers only
  built-in templates, documentation examples and schemas);
- the contributor agreement needs no exemption for template PRs (Section 4); and
- the License needs no clause on template contributions. Section 5(e) only states that the
  library is outside this License and disclaims its contents.

The engineering plan is in `dev/backlog/COMMUNITY_TEMPLATES_PLAN.md`.

</details>
