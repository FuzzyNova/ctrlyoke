# ctrlyoke Commercial License v2.3 approval memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 21, 2026**
**first pass counsel reviewed and made recommendations on behalf of Fuzzy Nova LLC · November 21, 2026**

[Open the complete v2.3 license draft](LICENSE_2.3_DRAFT.md) ·
[Round 2 recommendations](#round-2-recommendations-for-counsel) ·
[Round 3 proposals](#round-3-risk-allocation-and-global-markets) ·
[Jurisdiction flags](#jurisdiction-flags) ·
[Companion contribution text](#companion-contribution-text-for-approval) ·
[Publication checklist](#publication-checklist) ·
[Product and checkout checks](#product-and-checkout-readiness) ·
[Research and citations](#research-answers-for-counsel)

Reply from counsel: All recommendations and draft is approved.

**Adopted November 21, 2026** as root `LICENSE.md` v2.3, together with the companion Enterprise
Terms §12 and Privacy Policy §8 wording below. The open items in the
[publication checklist](#publication-checklist) are release and operations work, not further
legal review. The exact earlier texts (license 2.1 and 2.2, Enterprise Terms 1.0, Privacy
Policy 1.4–1.6) are archived at permanent URLs such as `ctrlyoke.dev/terms/2.2/`, and the
Enterprise checkout now links the versioned texts it records (`legal/README.md`).

**Requested response.** Confirm R1–R4 below, decide the Round 3 proposals R5–R12, and
approve the v2.3 draft and companion contribution text. If you recommend a change, please identify the clause and give replacement - no change recommended at this time
wording. The publication checklist lists the release work to close after legal review. v2.2
remains the published version until adoption. The [research answers](#research-answers-for-counsel)
address Q1–Q10, including the lettered questions. The collapsed appendix preserves the original
proposals and questions for reference.

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

## Round 2 recommendations for counsel

**Fuzzy Nova chose courts by default.** Fuzzy Nova accepts the class-litigation exposure of
the court-based model in §§16(b) and 16(g). For an AAA-administered consumer arbitration
clause, Rule R-12 provides for clause review, a review fee, and an annual registry fee. That
expense and administration are disproportionate on the stated launch facts of no outside
customers and minimal telemetry. Revisit if the business gains a material number of paying
customers, expands data collection, or receives its first demand letter. Apply any later
revision prospectively under §16(e).
[AAA Consumer Arbitration Rules, R-12](https://www.adr.org/media/yawntdvs/2025_consumer_arbitration_rules.pdf).

### R1. AI tools and automated actions in §12

**Recommendation.** Keep the new paragraph in §12 next to the warranty disclaimer. It
describes the risk of lost work, including files outside version control, and assigns workflow
review, permission configuration, and backup responsibilities to the user. The draft accounts
for defaults and inherited permissions as well as express approvals. ctrlyoke directs the
tools and executes workflow scripts, and third-party AI tools may choose actions automatically.
[Workflow permissions](../../docs/workflows/permissions.md),
[Script steps](../../docs/workflows/script-steps.md).

**Effect of the warning.** Evidence that the user received it can support notice. The actual
permissions, workflow actions, and available backups bear on who caused the deletion and how
much loss followed. For claims subject to Texas Chapter 33, allocation of responsibility
depends on conduct that caused or contributed to the harm. The warning itself sets no
allocation. §13 governs the monetary limits and exceptions.
[Texas Civil Practice & Remedies Code §§33.002–33.003](https://tcss.legis.texas.gov/resources/CP/htm/CP.33.htm).

**For counsel to confirm.** Approve the risk disclosure and its placement in §12.

### R2. Gross negligence and the §13 cap

**Recommendation.** Keep the express gross-negligence exception to both §§12 and 13 in the
standard license. Keep the greater of twelve months' fees or $100. The draft now makes the
damages exclusion and cap expressly applicable to ordinary negligence and claims arising from
use of the Software, subject to the exceptions and mandatory law.

**Texas authority.** In _Zachry_, the Texas Supreme Court refused to enforce a prospective
exclusion of delay damages for deliberate, wrongful interference and cited Texas public policy
against pre-injury waivers of gross negligence. The case involved a provision that eliminated
the relevant damages, and the court did not decide whether a meaningful compensatory cap may
apply to proven gross negligence. The Dallas Court of Appeals upheld a $350 alarm-monitoring
cap against a public-policy challenge that invoked allegations of gross negligence. The
customer had the option to buy greater protection, and the court applied the cap to negligence
and contract claims and preserved certain DTPA claims. _Bombardier_ upheld a negotiated
exemplary-damages waiver for fraud between sophisticated parties that preserved actual damages.
These decisions leave enforceability of this standard software form's cap for proven gross
negligence unresolved. A $100 cap for free or low-fee users could leave very little remedy for
the loss of a project. The express exception reduces the risk of a challenge to the limitation
without conceding that gross negligence occurred.
[_Zachry Construction Corp. v. Port of Houston Authority_, 449 S.W.3d 98, 116–18 (Tex. 2014)](https://dev-search.txcourts.gov/SearchMedia.aspx?DT=OPINION&MediaID=47793855-609b-433a-8073-624295a31f1b&MediaVersionID=f3f9e0a5-d4dd-481b-9991-a759dd2101d6&coa=cossup),
[_Arthur's Garage, Inc. v. Racal-Chubb Security Systems, Inc._, 997 S.W.2d 803, 809–13 (Tex. App.—Dallas 1999)](https://syfert.com/texas/cases/997-s-w-2d-803/arthurs-garage-inc-v-racal-chubb-security-systems-inc),
[_Bombardier Aerospace Corp. v. SPEP Aircraft Holdings, LLC_, 572 S.W.3d 213, 230–34 (Tex. 2019)](https://www.txcourts.gov/media/1443450/170578.pdf).

**Application to deleted files.** Texas's Chapter 41 standard looks for an objectively
extreme risk and actual awareness coupled with conscious indifference. A cap exception can
prompt a gross-negligence allegation. An unexpected deletion within the tool's available
permissions, standing alone, does not establish those elements as to Fuzzy Nova. Evidence
that Fuzzy Nova knew a defect could bypass a sandbox and consciously disregarded the risk
could change the analysis. The warning helps document the disclosed risk and the user's role.
The claim still turns on the facts, including duty and causation. The economic-loss analysis
also depends on whether the alleged duty exists independently of the contract and whether
the harm extends beyond the subject of the contract. Chapter 41 requires clear and convincing
proof of gross negligence to award exemplary damages on that basis.
[Texas Civil Practice & Remedies Code §§41.001(11), 41.003](https://tcss.legis.texas.gov/resources/CP/pdf/CP.41.pdf),
[_Sharyland Water Supply Corp. v. City of Alton_, 354 S.W.3d 407, 415–20 (Tex. 2011)](https://law.justia.com/cases/texas/supreme-court/2011/09-0223-65.html).

**Direct loss and severability.** Texas classifies contract damages based on how the loss
follows from the breach. Reasonable costs of restoring or reconstructing deleted files may
be direct if they are a natural and necessary result of the breach at issue and otherwise
recoverable. Profits lost on a separate downstream project may be consequential. The phrase
“including such damages” ties §13's examples to the listed categories, so the exclusion
does not independently exclude direct loss just because it involves data. Otherwise
recoverable direct loss is capped, subject to §13's exceptions. If one limit fails,
§16(c) supports preserving the other as a distinct provision. Texas severance still depends
on whether the remaining agreement can function and whether the invalid term was essential
to the bargain. Where Article 2 applies, §2.719 separately addresses failure of an exclusive
or limited remedy's essential purpose and unconscionable consequential-damages exclusions.
[_Dallas/Fort Worth International Airport Board v. Vizant Technologies_, 576 S.W.3d 362, 373 (Tex. 2019)](https://www.txcourts.gov/media/1444083/180059.pdf),
[_Signature Industrial Services v. International Paper_, 638 S.W.3d 179, 186–87 (Tex. 2022)](https://www.txcourts.gov/media/1453476/200396.pdf),
[_Venture Cotton Cooperative v. Freeman_, 435 S.W.3d 222, 230–31 (Tex. 2014)](https://dev-search.txcourts.gov/SearchMedia.aspx?DT=OPINION&MediaID=d4a94d95-5448-4bc4-8f14-15625a4a789a&MediaVersionID=cebda089-5041-4736-9726-236a626370e8&coa=cossup),
[Texas Business & Commerce Code §2.719](https://tcss.legis.texas.gov/resources/BC/htm/BC.2.htm#2.719).

**For counsel to confirm.** Approve the express exception and separate limits for the standard
form. A signed Enterprise order that needs a negotiated cap for gross negligence could
expressly override §13's cap exception for compensatory damages only and preserve the other
exceptions. Possible wording is “The aggregate cap for compensatory damages caused by gross
negligence is [negotiated amount], solely to the extent applicable law permits that cap.”

### R3. Venue in §16(b)

**Recommendation.** Use the revised §16(b). It selects Texas as the forum and separately
names the Texas state district courts and county courts at law in Travis County and the U.S.
District Court for the Western District of Texas, Austin Division, for venue. The existing
small-claims, consumer, and mandatory-law exceptions apply. If applicable law prevents
enforcing the choice of venue, ordinary venue rules apply within the Texas forum.
[Travis County civil district courts](https://www.traviscountytx.gov/courts/civil/district),
[28 U.S.C. §124(d)(1)](https://uscode.house.gov/us/usc/119-118/t28/s124/).

**Texas venue and removal.** In _Dr. Mylissa's Medical Boutique_, a Texas appellate court
enforced the Texas forum selection while declining to enforce the Travis County venue term
in a similar clause for a transaction outside §15.020. That statute generally requires a
written transaction with at least $1 million in stated consideration and excludes personal,
family, and household transactions. In _South Shore ER_, the Texas Business Court applied
the county-venue rule and also reasoned that county selection alone would not prevent
Business Court removal. Chapter 25A expressly covers certain disputes relating to software
licensing or performance where the amount in controversy exceeds $5 million, subject to
its calculation rules and exceptions. That route can apply without a separate forum agreement.
Leave Business Court removal to statute in the standard form. An order that expressly changes
the forum or available removal deserves deal-specific review.
[_Dr. Mylissa's Medical Boutique LLC v. Balboa Capital Corp._, No. 02-25-00271-CV, 2025 WL 3119021, at *6 (Tex. App.—Fort Worth Nov. 6, 2025)](https://law.justia.com/cases/texas/second-court-of-appeals/2025/02-25-00271-cv.html),
[_In re Texas Association of School Boards, Inc._, 169 S.W.3d 653, 660 (Tex. 2005)](https://law.justia.com/cases/texas/supreme-court/2005/2000598.html),
[_South Shore ER, LLC v. Bashiri_, 2026 Tex. Bus. 39, ¶¶25–43 (Tex. Bus. Ct. June 11, 2026)](https://www.txcourts.gov/media/1462877/26-bc11a-0039-south-shore-er-v-bashiri-2026-tex-bus-39.pdf),
[Texas Civil Practice & Remedies Code §15.020](https://tcss.legis.texas.gov/resources/CP/htm/CP.15.htm),
[Texas Government Code §§25A.004, 25A.006](https://tcss.legis.texas.gov/resources/GV/htm/GV.25A.htm).

**For counsel to confirm.** Approve the Texas forum and venue language with statutory removal
available where applicable.

### R4. Optional Enterprise jury waiver

**Recommendation.** Leave a jury waiver out of the standard license and standard Enterprise
Terms. If a specific negotiated business order warrants one, put a mutual waiver under a
separate bold heading near the signatures and record both parties' assent. Texas recognizes
knowing and voluntary contractual jury waivers, and a conspicuous clause is prima facie
evidence of knowing and voluntary assent. The Fifth Circuit also considers the circumstances,
including bargaining power, sophistication, an opportunity to negotiate, and placement. A
jury waiver changes who tries the case. Class certification remains a separate question.
[_In re Prudential Insurance Co. of America_, 148 S.W.3d 124, 132–34 (Tex. 2004)](https://law.justia.com/cases/texas/supreme-court/2004/2000462.html),
[_In re Bank of America, N.A._, 278 S.W.3d 342, 344–46 (Tex. 2009)](https://law.justia.com/cases/texas/supreme-court/2009/2001339.html),
[_Pizza Hut, L.L.C. v. Pandya_, 79 F.4th 535, 540–45 (5th Cir. 2023)](https://www.ca5.uscourts.gov/opinions/pub/22/22-40555-CV0.pdf).

**For counsel to confirm.** Fuzzy Nova has no strong preference. Approve the standard terms
with jury procedure governed by court rules. Address any waiver and record of assent in the
specific negotiated order where it would be used.

## Round 3: risk allocation and global markets

**Prepared by Fuzzy Nova for counsel, November 21, 2026. Not yet reviewed by counsel.**
ctrlyoke is distributed wherever the VS Code Marketplace and npm are available, so the
standard form will meet mandatory consumer and liability rules in many countries. These
proposals keep R2's policy (an express gross-negligence exception and the 12-month/$100 cap).
They change how §13 is worded so that it holds up better in those countries and in Texas.
The draft already contains R5–R10a and R12. R11 lists options that are not drafted. Each item
carries a Fuzzy Nova recommendation. The citations
come from Fuzzy Nova's research and need counsel's verification. National
transposition of the 2024 EU directives in particular was not checked.

### R5. Wording of the gross-negligence exception (§13(d))

**What changed.**

- The exception now names **Licensor's** liability. The old text exempted "death or personal
  injury caused by negligence" without saying whose negligence. It could be read to reach
  injuries caused by the user, a third-party AI tool, or a community template.
- It covers conduct "of Licensor and of anyone acting on its behalf". Germany (§309 No. 7(b)
  BGB) and Japan (Consumer Contract Act art. 8) expressly extend the rule to representatives
  and agents, so an exception limited to "Licensor" would be read narrowly against the drafter.
- It adds **fraudulent misrepresentation**, because English law does not allow liability for
  fraud to be excluded and treats misrepresentation as a separate claim. It adds **damage to
  health**, because §309 No. 7(a) covers "life, body or health".
- It adds **non-excludable product liability** as item (iv). See R9 and the EU entry in the
  jurisdiction flags.
- It adds "as finally determined … under the law governing the claim". The cap then applies
  unless gross negligence is proved, not merely pleaded. That improves the settlement and
  insurance position against a pleading that alleges gross negligence only to escape the cap.
  It also stops a dispute over whether Texas's Chapter 41 definition, or a foreign definition,
  controls a claim governed by other law.

**Why keep an express exception, globally.** An express list is more enforceable than relying
on "to the maximum extent permitted by law" alone in the markets most likely to strike the cap:

- **Japan.** Article 8(3) of the Consumer Contract Act, added by the 2022 amendment and in force
  from June 1, 2023, voids a partial exemption in a consumer contract unless it makes clear
  that it does not apply to gross negligence. A clause saved only by "to the extent permitted
  by law" does not do that.
- **Germany.** §309 No. 7 BGB voids limits for gross negligence and for injury to life, body,
  or health in standard terms. Under §306 BGB and the case-law ban on _geltungserhaltende
  Reduktion_, an invalid clause is struck out entirely rather than cut back. §16(c)'s
  "modified to the minimum extent necessary" therefore will not save the cap for German
  consumers.
- **Others.** China (Civil Code art. 506), Korea (Act on the Regulation of Terms and
  Conditions art. 7), France (Code civil arts. 1170 and 1231-3, _faute lourde ou dolosive_),
  and Quebec (Civil Code art. 1474, which also applies between businesses) apply the same
  intentional/gross-fault line.
- **United States.** New York refuses to enforce exculpatory clauses, including limitation
  clauses, for grossly negligent conduct (_Sommer v. Federal Signal Corp._, 79 N.Y.2d 540
  (1992)). California refuses to enforce releases of future gross negligence (_City of Santa
  Barbara v. Superior Court_, 41 Cal. 4th 747 (2007)). Under _DeSantis v. Wackenhut Corp._,
  793 S.W.2d 670 (Tex. 1990), which adopts Restatement (Second) of Conflict of Laws §187(2),
  a court may override the Texas choice of law when another state with a materially greater
  interest has a fundamental contrary policy. The express exception removes the conflict that
  would otherwise invite that override.

**Fair notice.** §13 meets both Texas fair-notice requirements from _Dresser Industries v. Page
Petroleum_, 853 S.W.2d 505, 508–09 (Tex. 1993): it expressly names ordinary negligence and it is
conspicuous. It meets them whether or not a court applies them to limitation clauses rather
than releases. The §12 "AI tools and automated actions" paragraph is not conspicuous. A new
closing sentence says it does not itself limit liability and points to §13. That keeps the
paragraph from being attacked as a hidden exculpatory term, in Texas or under EU/UK
transparency rules. The paragraph's evidentiary value on notice and causation (R1) is
unchanged.

**For counsel to confirm.** Approve §13(d) as redrafted, including "finally determined" and
"under the law governing the claim".

### R6. Cap structure and trigger (§13(a)–(c))

The section now has lettered subsections, so §12, §13(e), and future Enterprise orders can
refer to particular limits. §13(a) adds "warranty" and "strict liability" to the listed
theories, subject to §13(d)(iv). The 12-month look-back now runs from **the event first giving
rise to liability** rather than from "the claim". Under the old wording a claimant could choose
the measurement window by deciding when to make the claim, and a perpetual-license buyer's cap
dropped to $100 a year after purchase whatever the timing of the harm.

**For counsel to confirm.** Approve the restructuring and the new trigger.

### R7. Fallback for consumers where the cap fails (§13(e))

Where a consumer's home law voids the general exclusion and cap (Germany is the clearest case),
the cap would otherwise disappear entirely (R5). §13(e) substitutes the limitation German
courts generally accept for standard terms. Liability for slight negligence applies only to
breach of an essential obligation (_Kardinalpflicht_), which the clause explains in plain
words as transparency requires, and only for damage typical and foreseeable at contracting.
It applies only to Consumers and only where §13(b)–(c) fail, so it does not weaken the cap
anywhere else.

**Recommendation: keep §13(e).** Without it, a German consumer's claim for slight negligence is
unlimited, because the failed cap cannot be cut back (R5). With it, the claim is limited to
breach of essential obligations and to typical, foreseeable damage. Those limits matter most
for the realistic claim, consequential loss from deleted project files. The cost is one
paragraph that does nothing in any market where the cap holds. It also helps in Austria and
other markets that follow the same German standard-terms approach. The clause cannot make
matters worse: if a court rejects it too, the result is the same as deleting it.

**For counsel to confirm.** Approve §13(e) and its plain-language definition of an essential
obligation, which German transparency rules require.

### R8. Protection for Licensor's personnel (§13(f))

Fuzzy Nova is a single-member LLC. Texas law shields members from the company's contractual
obligations (Texas Business Organizations Code §101.114, and §21.223 as applied by §101.002).
It does not shield a person from tort claims based on their own conduct. A user who loses files
could sue the founder personally in negligence and plead around a cap that protects only
"Licensor". §13(f) makes members, managers, officers, employees, and contractors express
beneficiaries of §§12–13, subject to the same exceptions. It applies one combined cap so that
naming more defendants does not multiply it. Texas enforces third-party-beneficiary terms when
the contract clearly expresses that intent.

**For counsel to confirm.** Approve §13(f), and confirm the beneficiary wording is effective
under Texas law.

### R9. Statutory rights, updates, and the Consumer definition (§§1, 9, 12)

- **§1 "Consumer".** A single definition now replaces the two formulations in §16(b). It
  combines the U.S. phrase "personal, family, or household" with the UK/EU phrase "outside …
  trade, business, craft, or profession". It deliberately does **not** adopt every statutory
  definition. The Australian Consumer Law treats a business buying goods under AUD 100,000 as
  a "consumer" (s. 3), and that business should not gain §16(b)'s home-court option. The
  statutory-rights sentence in §12 still protects such buyers.
- **§12 "Statutory rights".** This sentence names the main non-excludable regimes instead of
  relying on §13's closing sentence. An "as is" disclaimer that does not acknowledge consumer
  guarantees can itself be misleading conduct under ACL s. 29(1)(m). The ACCC has pursued
  sellers on that basis. Naming the regimes also meets EU/UK transparency expectations.
- **§9 updates.** The EU Digital Content Directive (art. 8(2), implemented in Germany as §327f
  BGB) requires updates, including security updates, that keep paid digital content in
  conformity. The EU Cyber Resilience Act will add regulatory security-update duties (see the
  flags below). §9's "no obligation to maintain" now gives way to those duties instead of
  contradicting them.

**For counsel to confirm.** Approve all three.

### R10. Governing law, sanctions, and language (§§14, 16(b), 16(i))

- **CISG exclusion.** Choosing Texas law does not by itself exclude the CISG, which is federal
  law and part of Texas law (_BP Oil International v. Empresa Estatal Petroleos de Ecuador_,
  332 F.3d 333, 337 (5th Cir. 2003)). Whether the CISG reaches software licenses is unsettled,
  so the exclusion removes an argument for its conformity and remedy rules. The UCITA
  exclusion is a precaution for Virginia and Maryland.
- **§14 sanctions.** The old text covered export controls and embargoed countries. It now also
  covers OFAC sanctions, persons ordinarily resident in or organized under the laws of
  comprehensively sanctioned countries or regions, and parties owned or controlled by listed
  persons, consistent with OFAC's 50 Percent Rule.
- **§16(i) language.** English controls over translations except where law requires otherwise.
  This does **not** meet Quebec's requirement, described in the flags below.

**For counsel to confirm.** Approve the three additions.

### R10a. Australian Consumer Law remedy limit (§12)

**Recommendation: adopt the drafted §12 paragraph.** For goods not of a kind ordinarily
acquired for personal, domestic, or household use, ACL s. 64A lets a supplier limit its
liability for breach of most consumer guarantees to resupplying the goods or paying the cost
of resupply. "Goods" includes software (ACL s. 2). A tool that orchestrates AI coding
assistants through workflow files is plausibly not of a household kind, even with a free
individual tier. The limit matters because an Australian business buying under AUD 100,000 is
a "consumer" (R9). Without it, that business could claim consequential loss for a guarantee
breach.

The paragraph:

- states the statutory condition rather than asserting that it is met;
- excludes the title and possession guarantees in ss. 51–53, which s. 64A does not let a
  supplier limit;
- applies "to the extent section 64A permits", so s. 64A(3) still lets a consumer show the
  limit is not fair or reasonable.

That wording addresses the ACCC's concern that guarantee terms must not misstate consumers'
rights (s. 29(1)(m)). If the "household kind" condition fails, the paragraph does not apply,
and the §12 statutory-rights sentence governs.

**For counsel to confirm.** Approve the paragraph, and ideally have Australian counsel confirm
the "household kind" characterization before Pro sales to Australia become material.

### R11. Options considered and not drafted

| Option                                                     | Status and reason                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutual cap                                                 | **Not recommended for now.** A one-sided cap counts toward unfairness under EU Directive 93/13 and UK CRA Sch. 2. A mutual cap would limit recovery against a competitor that misuses the code under §4(b). A mutual cap with carve-outs for §4 and IP breaches is the fallback if counsel sees material unfairness risk.                                                        |
| "Essential basis of the bargain" recital                   | **Not recommended.** It supports reasonableness under UK UCTA s. 11. Under Texas severance analysis, which asks whether the invalid term was essential to the bargain, it could argue against severing a failed cap from the rest of the License.                                                                                                                                |
| Shortened limitations period                               | **Not permitted.** Texas Civil Practice & Remedies Code §16.070 voids contractual limitations periods shorter than two years.                                                                                                                                                                                                                                                    |
| Higher evidentiary standard for gross negligence in §13(d) | **Not recommended.** For example, "clear and convincing evidence". It would conflict with foreign consumer law and complicate jury instructions. "Finally determined" achieves most of the benefit.                                                                                                                                                                              |
| Insurance (business, not license text)                     | **Recommended.** §13(d) leaves gross negligence and product liability uncapped. Technology E&O and cyber coverage is the practical backstop for a single-member LLC. Texas does not categorically bar insuring exemplary damages for gross negligence (_Fairfield Insurance Co. v. Stephens Martin Paving_, 246 S.W.3d 653 (Tex. 2008)), but coverage turns on the policy terms. |

### R12. Indemnity from business users (§13(g))

**Recommendation: adopt a narrow, fault-based indemnity from non-Consumer users.** Fuzzy Nova's
most likely third-party exposure comes from what users do with the Software, not from its code:

- a user's client sues Fuzzy Nova after a workflow the user wrote damages the client's systems;
- an AI provider or rights holder names Fuzzy Nova in a claim over content or output a user
  published;
- someone sues over a service a user runs on top of ctrlyoke.

§13 caps what Fuzzy Nova owes the user. It does nothing about claims from people who never
accepted the License. An indemnity is the only term in the License that reaches those claims.
For a single-member LLC, the defense costs of a weak claim are the real risk, so the clause
makes the user defend the claim as well as pay any award.

**How it is limited, and why each limit is there.**

| Limit                                                                                                                                                                 | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business users only                                                                                                                                                   | Indemnities imposed on consumers are a standard example of an unfair term in EU (Directive 93/13), UK (CRA Sch. 2), and Australian law. Free individual users would also be surprised by them.                                                                                                                                                                                                                                                                                                                        |
| Four triggers, each tied to the user's own conduct: Your Content and output, breach of §4, unlawful use or breach of third-party AI terms, services offered to others | This keeps the duty in line with what the user controls. It does **not** cover ordinary use of the Software as provided.                                                                                                                                                                                                                                                                                                                                                                                              |
| Exclusions for IP claims against the Software itself, for Licensor's breach, and for Licensor's own fault                                                             | The user never indemnifies Fuzzy Nova for its own code or conduct. Under Texas's express-negligence and fair-notice rules (_Ethyl Corp. v. Daniel Construction Co._, 725 S.W.2d 705 (Tex. 1987); _Dresser_, 853 S.W.2d at 508–09), an indemnity for the indemnitee's own negligence needs express, conspicuous wording. Excluding it outright, in bold capitals, avoids the question. It also makes the term easier to defend as reasonably necessary to protect a legitimate interest (Australian unfair-terms law). |
| "To the extent" apportionment                                                                                                                                         | When both the user's workflow and some other cause contribute to the harm, the user pays only the share that arises from a listed trigger.                                                                                                                                                                                                                                                                                                                                                                            |
| Ordinary defense procedure: notice, the user's control of the defense, consent for settlements that admit Licensor's fault                                            | This is market-standard. A late notice excuses the user only to the extent of actual prejudice, so a technical delay does not forfeit the indemnity.                                                                                                                                                                                                                                                                                                                                                                  |
| Enterprise Terms or a signed order control                                                                                                                            | Enterprise buyers usually negotiate mutual indemnities. Fuzzy Nova gives no IP indemnity in the standard form. An Enterprise buyer that wants one should get it in its order, priced and capped there.                                                                                                                                                                                                                                                                                                                |

**Not capped.** §13's exclusion and cap limit only Licensor's liability. The indemnity is
uncapped, as is usual, because its triggers are limited to the user's own conduct.

**Residual risks and recommendations.**

- **Fee recovery: added to the draft.** The first draft covered only amounts awarded in the
  third-party case. A user who wrongly refused to defend would have left Fuzzy Nova paying for
  its own defense and for the suit to enforce the indemnity. The new paragraph works as
  follows:
  - If the user does not take over the defense within 30 days of notice, or refuses a defense
    it owes, Fuzzy Nova may defend and settle the claim itself.
  - The user then reimburses Fuzzy Nova's reasonable defense fees and costs, any reasonable
    settlement, and the cost of enforcing §13(g).
  - All of these are limited to the share of the claim the indemnity covers, so
    apportionment cannot be bypassed.
  - The reasonableness standard for the settlement replaces the consent right Fuzzy Nova
    would otherwise need from a user who has walked away.
  - Texas enforces contractual fee clauses as written. In California, Civil Code §1717 makes a
    one-sided contractual fee clause reciprocal in actions on the contract, so a user who
    defeats an enforcement suit there could recover its fees. **Recommendation:** accept
    that, because it rewards only meritless enforcement.
- **Australia's unfair-terms penalties. Recommendation: keep §13(g) unchanged, with no
  Australian carve-out.** The penalty regime covers standard forms with small businesses
  (fewer than 100 employees or turnover under AUD 10 million). One-sided indemnities are a
  known target. However, s. 24(1)(b) asks whether a term is reasonably necessary to protect a
  legitimate interest. A clause limited to the user's own conduct, which excludes Licensor's
  own fault and IP claims and apportions shared causes, is the version most likely to pass
  that test. Carving Australia out would give up the protection where third-party claims are
  as likely as anywhere. Revisit with Australian counsel if Australian revenue becomes
  material.
- **Effect on adoption. Recommendation: keep the indemnity uncapped. Do not add a cap for
  Free Tier businesses.** A cap low enough to reassure a small business would not cover
  defense costs, which are the main risk the clause addresses. The narrow triggers are the
  better answer to a legal team's concern. Organizations that need different terms already
  have the Enterprise path, whose order controls §13(g). Track procurement objections and
  revisit if they recur.
- **Collectability. Recommendation: rely on Fuzzy Nova's own insurance (R11). Do not require
  users to carry insurance.** The indemnity is worth only what the user can pay. An insurance
  requirement cannot be verified for a free download and would add friction without adding
  protection. When placing technology E&O coverage, confirm the policy covers defense of
  claims that arise from a user's workflows.

**For counsel to confirm.** Approve §13(g), including the fee-recovery paragraph, the renamed
§13 heading ("Limitation of Liability; Indemnity"), and its business-user scope.

### Jurisdiction flags

These are markets where mandatory law can override the standard form. The draft's general
savings language covers most of them. **Text** marks items that need a license change, already
drafted unless noted. **Ops** marks items outside the license.

| Market                       | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EU: Product Liability**    | Directive (EU) 2024/2853 must be transposed by **December 9, 2026** and applies to products placed on the market after that date. Software is a "product" (art. 4(1)). The exemption for free and open-source software supplied outside a commercial activity does not fit a freemium commercial product. Recoverable damage includes **destruction or corruption of data not used for professional purposes** (art. 6(1)(c)), which is the hobbyist file-loss scenario. Liability is strict and cannot be limited by contract (art. 15). Where the manufacturer is outside the EU, liability can pass to an importer, authorized representative, or fulfilment provider, and in some cases to an online platform (art. 8). | Text: §13(d)(iv). Ops: confirm with EU counsel whether Marketplace and npm distribution creates an EU economic operator, and review product-liability insurance.                                                                                                                                                                                                                                                                                                                                                         |
| **EU: Cyber Resilience Act** | Regulation (EU) 2024/2847 applies to monetized products with digital elements. Manufacturers' obligations to report actively exploited vulnerabilities and severe incidents apply from **September 11, 2026**. The remaining obligations apply from December 11, 2027, including a declared support period with security updates, normally at least five years.                                                                                                                                                                                                                                                                                                                                                             | Text: §9 carve-out. Ops: a vulnerability-reporting process now, and a support-period and CE-conformity plan before December 2027.                                                                                                                                                                                                                                                                                                                                                                                        |
| **EU consumers generally**   | Rome I art. 6 keeps home-country mandatory law. Brussels I bis art. 18(2) lets Licensor sue an EU consumer only in their home courts. Digital Content Directive conformity and update rights apply to paid supplies and to some supplies paid for with personal data. Withdrawal rights for digital content are lost only with express consent and acknowledgement (Directive 2011/83 art. 16(m)).                                                                                                                                                                                                                                                                                                                          | Text: §§12, 13(e), 16(b). Ops: confirm that Lemon Squeezy, as merchant of record, captures the withdrawal consent. The EU ODR platform has been discontinued, so do not add an ODR link.                                                                                                                                                                                                                                                                                                                                 |
| **Germany**                  | §§305–310 BGB control standard terms for consumers. See R5 and R7. Free supplies may be treated as gifts, with liability limited to intent and gross negligence (§521 BGB). That rule does not displace the Product Liability Directive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Text: §13(d)–(e).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **France**                   | Limits fail for _faute lourde_ or _dol_ (Code civil art. 1231-3). A clause that empties an essential obligation is deemed unwritten (art. 1170). Consumer Code art. R. 212-1 blacklists clauses suppressing the consumer's right to compensation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Covered by §13(d)–(e) and savings language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **United Kingdom**           | UCTA 1977 s. 2(1) and CRA 2015 s. 65 bar excluding negligent death or personal injury. CRA ss. 31 and 47 protect digital-content rights. Under s. 46, a trader may have to repair or compensate when digital content damages a device or other digital content, and this can apply to free content. "Gross negligence" has no settled meaning in English law, so fraud and negligent personal injury are the core carve-outs.                                                                                                                                                                                                                                                                                               | Text: §§12, 13(d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Australia / New Zealand**  | ACL consumer guarantees cannot be excluded (s. 64). "Goods" includes software, and "consumer" includes businesses buying under AUD 100,000. Unfair terms in consumer and small-business standard forms have carried civil penalties since November 9, 2023, so an unfair term creates penalty exposure as well as being unenforceable. New Zealand's CGA allows contracting out only between businesses (s. 43).                                                                                                                                                                                                                                                                                                            | Text: §12, including the s. 64A remedy limit (R10a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Canada: Quebec**           | Civil Code art. 1474 bars excluding liability for intentional or gross fault and for bodily or moral injury, including between businesses. Art. 3149 preserves consumers' home forum. Under the Charter of the French Language s. 55, as amended by Bill 96 and in force from June 1, 2023, a contract of adhesion must first be presented in French. An English-only form presented to a Quebec adherent can be annulled at the adherent's request, and penalties may apply.                                                                                                                                                                                                                                               | **Recommendation: accept the risk for the standard form now, and publish a French version at a set trigger.** The trigger is the first Quebec Enterprise order on the standard form, or Quebec Pro sales becoming material. A negotiated Enterprise order is not a contract of adhesion, so s. 55 does not apply to it. Annulment is at the adherent's option, and Quebec mandatory law already overrides most of §13 for Quebec users, so the incremental exposure before revenue is small. §16(i) does not resolve it. |
| **Japan**                    | See R5. Consumer Contract Act art. 8(3) requires a partial exemption to state that it does not apply to gross negligence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Text: §13(d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Korea / China**            | Exemptions for intentional or gross fault in standard terms are void (Korea Terms Act art. 7; China Civil Code arts. 497 and 506). China also voids exemptions for personal injury.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Text: §13(d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Brazil**                   | Consumer Defense Code art. 51(I) voids clauses that exclude or attenuate supplier liability toward individual consumers. Art. 101(I) gives consumers their home forum. Expect the cap to fail for Brazilian individual consumers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Covered by savings language. Accept the residual risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **India**                    | The Consumer Protection Act 2019 lets consumer commissions declare "unfair contract" terms (s. 2(46)) null.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Covered by savings language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **U.S. states**              | New York and California public policy on gross negligence (R5). Some states bar disclaiming implied warranties in consumer sales of goods (for example, Massachusetts and Maryland). Whether downloaded software is "goods" is unsettled. New Jersey's TCCWNA (N.J.S.A. 56:12-16) targets "void in some jurisdictions" phrasing that does not say whether it applies in New Jersey. Exposure fell after _Spade v. Select Comfort_, 232 N.J. 504 (2018), which requires an aggrieved consumer.                                                                                                                                                                                                                               | **Recommendation: no New Jersey-specific sentence.** The draft never uses "some jurisdictions do not allow" phrasing. Its savings language says what applies ("to the extent applicable law prohibits"), and §13(d) lists the exceptions expressly. A state-by-state list would grow stale and invite the same challenge. Counsel to confirm.                                                                                                                                                                            |
| **Sanctioned markets**       | The Marketplace and npm may be reachable from comprehensively sanctioned regions. Licensing or activating Pro there raises OFAC and EAR questions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Text: §14. Ops: geoblock Pro checkout and activation for comprehensively sanctioned regions. Lemon Squeezy screens payments, but the license server should not rely on that alone.                                                                                                                                                                                                                                                                                                                                       |

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
   summary for a different version. Preserve the exact earlier terms in version history and
   record the change under **Changed** in [CHANGELOG.md](../../CHANGELOG.md). The disclosed
   launch facts call for ordinary publication and distribution. AAA registration, customer
   notification, re-acceptance, and opt-out migration are outside this release.
2. **Align related legal text.** In [Enterprise Terms §12](../../ENTERPRISE_TERMS.md#12-warranties-liability-and-disputes)
   use the companion wording below. Update [Privacy Policy §8](../../PRIVACY.md#8-data-retention)
   using the replacement retention entry below. Publish the updated documents with versioned
   checkout links and confirm the bundle records the applicable EULA and Enterprise Terms
   versions. Add conspicuous EULA notice at the Individual Pro purchase entry point as described
   in [Q10](#q10-adoption-and-earlier-versions). Publish the court-based wording in the
   plain-language summary.
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
   process, and privacy notice against actual behavior. Apply the catalog guidance in
   [Q2](#q2-community-library-coverage-and-installation-exposure) and
   [Q6](#q6-separate-mit-0-contribution-intake-and-removal). Check sales and distribution
   jurisdictions for independently applicable mandatory terms, starting with the
   [jurisdiction flags](#jurisdiction-flags), and close the EU product-liability and Cyber
   Resilience Act items before the next release after December 9, 2026.

### Companion wording for publication

**Enterprise Terms §12, replacement for its final sentence**

> EULA Sections 16(b) (Governing Law and Venue) and 16(g) (Voluntary Dispute Resolution)
> apply to disputes under this Agreement.

**Privacy Policy §8, replacement retention entry**

> **Enterprise terms-acceptance records:** retained for the life of the applicable agreement
> and afterwards as needed for tax, accounting, and evidentiary purposes.

**Website summary, Disputes**

> Texas law governs the license. The ordinary forum is Texas. The license designates
> state district courts and county courts at law in Travis County and the federal district
> court's Austin Division, subject to applicable venue rules. Eligible small claims can be
> brought in a small-claims court with jurisdiction. Consumers keep their mandatory protections
> and forum rights. Consumers who usually live outside the United States can also use the
> courts where they usually live for disputes about personal or household use. After a dispute
> arises, both sides can agree in writing to mediation or arbitration.

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
  or arbitration-specific install or activation step. Individual Pro can continue through
  Lemon Squeezy with the first-party license notice described in [Q10](#q10-adoption-and-earlier-versions).
  Publish the applicable version and ordinary license notice for the
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
and import behavior before representing that templates are safe or reviewed. The plan specifies
unauthenticated requests from the ctrlyoke process to jsDelivr's GitHub mirror for the index and
selected files. jsDelivr says it may collect source IP, requested CDN URLs, and other request
metadata. Those URLs can identify a selected public template. Add this data flow to the privacy
notice before enabling the feature and confirm the actual recipient and metadata after
implementation. Disclose GitHub separately if the implementation contacts GitHub directly.
The repository's public GitHub API endpoint returned 404 during this review, so this analysis
uses the planned design.
[Community templates plan](../backlog/COMMUNITY_TEMPLATES_PLAN.md),
[jsDelivr Privacy Policy, §§2 and 9](https://github.com/jsdelivr/jsdelivr/blob/master/Privacy%20Policy.md).

**Recommendation.** Approve §5(e)'s disclaimer and retain mandatory consumer guarantees. In
the import flow identify the publisher, state where files will be written, require an explicit
import action, and keep execution separate. Describe the checks the product actually performs.
Keep the library outside the release bundle. The EU digital content regime is one reason
mandatory consumer protections belong in the draft.
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

**Repository evidence.** All 12 local release tags reachable from the current branch contain
`src/templates/`, `schemas/`, and `docs/`. The copies at `v0.1.1` and `v0.1.2` carry
license v2.1. The ten tags from `v0.2.0` through `v0.8.0` carry v2.2. A Git history pass over
those paths across the current branch and tags found one author email under two display names.
That is an authorship lead. Final clearance still depends on the origin of copied examples and
any rights held by the individual author that Fuzzy Nova needs authority to license. Confirm
the covered files and distributed tags before posting the notice, including any distributed
v2.1 copies.

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
**Recommendation.** Use GitHub's process for material it hosts and give users a public
reporting contact for the software catalog. The plan calls for a maintainer-reviewed GitHub
repository with a generated index and direct requests from the ctrlyoke process to jsDelivr.
Section 512(d) is the closer statutory fit for the catalog's directory and links. Section
512(c) concerns storage at a user's direction on a system operated or controlled by or for the
provider. Whether either protects Fuzzy Nova depends on its role in curating and delivering the
templates and its compliance with the applicable conditions. Continue planning without an
independent safe harbor. Delist the entry and account for stale index or file caches so the
software can stop offering a reported template promptly. Section 512 addresses copyright
claims. Harm caused by executing a template remains governed by the applicable liability rules.
[Community templates plan](../backlog/COMMUNITY_TEMPLATES_PLAN.md),
[17 U.S.C. §512(c), (d) and (i)](https://www.govinfo.gov/content/pkg/USCODE-2024-title17/html/USCODE-2024-title17-chap5-sec512.htm),
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

**Recommendation.** Adopt the court-based text in §§16(b) and (g). Keep Texas governing law,
the Texas forum, and the venue language in [R3](#r3-venue-in-16b). Preserve eligible small
claims and non-waivable consumer protections, and allow consumers usually resident outside
the U.S. to use their home courts.
Either party may propose informal resolution. The parties can agree in writing to mediation
or arbitration after a dispute arises. The license imposes no waiting period to file suit.
Statutory rules still apply. For example, the Texas DTPA generally requires 60 days' written
notice before filing a damages suit, with exceptions for certain limitations deadlines and
counterclaims. A party may also seek court-ordered mediation under that statute.
[Texas Business & Commerce Code §§17.505–17.5051](https://tcss.legis.texas.gov/resources/BC/htm/BC.17.htm#17.505).

Fuzzy Nova accepts that a claimant can seek class treatment where applicable law permits it.
The court decides certification under the applicable rules. [R4](#r4-optional-enterprise-jury-waiver)
addresses jury waivers for negotiated Enterprise orders. The court-based model gives up the
class-waiver protection that accompanies valid individual arbitration and avoids maintaining a
compulsory arbitration process for claims under v2.3.
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
their respective areas under the existing order of precedence. [R2](#r2-gross-negligence-and-the-13-cap)
explains why the standard form keeps the gross-negligence exception and gives counsel an option
for a negotiated Enterprise order.

**Consumer data loss outside the U.S.** In the EU, national laws implementing Directive
2019/770 can cover paid digital content and some free supplies where consumers provide personal
data. The data exception concerns processing exclusively to supply the product or comply with
legal requirements. Recital 25 also distinguishes collection of metadata alone, with scope
depending on national contract law. Verify the data and national rules before determining Free
Tier coverage. In the UK, Consumer Rights Act §46 can require repair or compensation when the
supplied digital content damages the consumer's device or other digital content and reasonable
care and skill would have avoided that kind of damage. It can apply to free content supplied
under a contract. Section 47(6) points to the §62 fairness test for limits on §46 liability.
Retain the mandatory-law savings language and describe the cap as qualified in consumer-facing
summaries.
[Directive (EU) 2019/770, recital 25 and arts. 3, 14 and 22](https://eur-lex.europa.eu/eli/dir/2019/770/oj),
[UK Consumer Rights Act 2015, §§33, 46, 47 and 62](https://www.legislation.gov.uk/ukpga/2015/15/pdfs/ukpga_20150015_en.pdf?view=extent),
[ctrlyoke Privacy Policy, §3.1](../../PRIVACY.md#31-usage-telemetry).

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

If an outside v2.2 user is later identified, §16(e) keeps v2.2 with the copy they obtained
unless they adopt a later version. Start any existing dispute analysis with that version,
including its §16(g), any opt-out, and enforceability in the applicable jurisdiction. For a
later adoption, clearly identify the new terms and record affirmative acceptance for future
use. Use a separate agreement to resolve any already-arisen dispute. Texas modification law
requires notice and acceptance, and AAA Rule R-12 provides a case-specific expedited review
route for a previously unsubmitted consumer clause if a covered filing actually occurs.
[_Hathaway v. General Mills, Inc._, 711 S.W.2d 227, 228–29 (Tex. 1986)](https://law.justia.com/cases/texas/supreme-court/1986/c-4481-0.html),
[AAA Consumer Arbitration Rules, R-12(f)](https://www.adr.org/media/yawntdvs/2025_consumer_arbitration_rules.pdf).

**Notice and proof of assent under §0.** The Enterprise form presents an affirmative checkbox
and records document versions. Its EULA link currently points to the live terms page. Archive
the exact texts associated with each recorded version. A browser check of the public Individual
Pro purchase path found the EULA link in a separate pricing section. The hosted Lemon Squeezy
payment form displayed the reseller's Buyer Terms and Privacy Policy links. It showed no link to
the ctrlyoke EULA or acceptance of that EULA in the initial form. To rely on purchase-based
assent, put the versioned EULA link and acceptance language at the first-party purchase entry
point. Prefer an affirmative control that records the accepted version before the reseller
handoff. On installation channels, show the terms or give a conspicuous link and acceptance notice
before download or first use. A copy in the package preserves the version received, while proof
of notice before the relevant action remains important for assent based on installation or use.
The signed-in clickwrap decision in _Klebba_ supports affirmative acceptance under Texas law.
[Public pricing page](https://ctrlyoke.dev/pricing/),
[Public Individual Pro checkout](https://ctrlyoke.lemonsqueezy.com/checkout/buy/5216b82f-8571-4ce4-9e8f-37659c88aea1),
[Enterprise checkout](../../landing/src/pages/enterprise/checkout.astro),
[_Klebba v. Netgear, Inc._, No. 1:18-cv-00438-RP, slip op. at 6–9 (W.D. Tex. Feb. 5, 2019)](https://www.govinfo.gov/content/pkg/USCOURTS-txwd-1_18-cv-00438/pdf/USCOURTS-txwd-1_18-cv-00438-0.pdf).

---

<details>
<summary>Superseded proposals and original question wording</summary>

## How to read this

The proposals and questions below are the original brief. The
[research answers](#research-answers-for-counsel) explain which recommendations went forward,
and the [Round 2 recommendations](#round-2-recommendations-for-counsel) give the current approval items.

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
