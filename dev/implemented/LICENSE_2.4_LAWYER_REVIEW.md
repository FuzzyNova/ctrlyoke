# ctrlyoke Commercial License v2.4 approval memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 22, 2026**
**reviewed by outside counsel on behalf of Fuzzy Nova LLC · November 22, 2026**

[Open the complete v2.4 license draft](LICENSE_2.4_DRAFT.md) ·
[Previous memo (v2.3)](../implemented/LICENSE_2.3_LAWYER_REVIEW.md)

Counsel has approved the draft and made recommendations below on 11/22/2026

**Adopted November 22, 2026** as root `LICENSE.md` v2.4, archived at `legal/archive/eula/2.4.md`,
together with the plain-language summary changes below. v2.3 stays at its permanent URL. The
open items in the [adoption checklist](#adoption-checklist-fuzzy-nova) (test-mode checkouts and
the CLA Assistant setup) are release and operations work, not further legal review.

**Facts.** v2.3 was adopted and published on November 21, 2026. Fuzzy Nova reports that
no ctrlyoke release (VSIX or npm) has shipped with v2.3 and that there are no customers or
Enterprise orders. Both changes below narrow the licensee's exposure. [Current terms](https://ctrlyoke.dev/terms/)

**Recommendation on versioning.** Publish the approved changes as v2.4 and retain v2.3 at
its permanent URL. Section 16(e) ties each copy to the version in effect when the user
obtained it and allows the user to adopt a later version. A source user could have obtained
and accepted v2.3 in the interval. Section 0 requires the specified notice and assent, so
publication or reading alone does not establish acceptance. Ship v2.4 in the next VSIX and
npm release. Let any existing v2.3 user elect v2.4 under Section 16(e) and keep a record of
the election when Fuzzy Nova relies on it. [Published v2.3, §§0 and 16(e)](https://ctrlyoke.dev/terms/2.3/)

The Ninth Circuit's decision in _Douglas v. U.S. District Court_ illustrates the notice
and assent problem with relying on website publication alone to modify an existing
agreement. The recommendation here follows Sections 0 and 16(e) and Fuzzy Nova's published
version policy. [_Douglas_, 495 F.3d 1062, 1066–67 (9th Cir. 2007)](https://cdn.ca9.uscourts.gov/datastore/opinions/2007/07/18/0675424.pdf)

## Changes

### C1. Cure for unintentional Section 4(c) breaches under Section 15(b)

**Issue.** In v2.3, any breach of Section 4(c) terminates the License immediately, with no
knowledge requirement. A Free Tier user who opens the Hosted Dashboard on another device
through SSH port forwarding outside an active trial, unaware that it counts as Pro use,
could lose the entire license immediately.

**Change.** Section 4(c) triggers immediate termination only for deliberate circumvention,
known violations of the trial limits, or continued Pro use with actual knowledge that
the required license or trial is absent. Other material Section 4(c) breaches follow the
existing 30-day written-notice and cure process. For the breach identified in the notice,
the cure period remains available when the user learns of the requirement through that notice
and continues the same use during the period.

**v2.3 wording**

> A breach of Section 4(a) or 4(c), or a knowing and material breach of Section 4(b),
> terminates this License immediately without notice.

**Proposed v2.4 wording**

> A breach of Section 4(a), a knowing breach of Section 4(c), or a knowing and material
> breach of Section 4(b) terminates this License immediately without notice. For purposes of
> this Section 15(b), a breach of Section 4(c) is knowing if You (i) deliberately circumvent,
> disable, or defeat the Software's license verification mechanisms, (ii) restart, extend,
> or obtain an additional Evaluation Trial knowing that doing so exceeds the limits in
> Section 4(c), or (iii) continue to use a Pro Tier capability after You actually know that
> the use requires a valid, unrevoked Pro License or an active Evaluation Trial and that You
> have neither. A material breach of Section 4(c) that is not knowing is subject to the thirty
> (30) day cure period above. For purposes of termination, You cure the breach if, by the
> end of that period, You have stopped the affected use or obtained a valid Pro License that
> covers that use. Either option cures the breach without payment for past use. For the breach
> identified in Licensor's written notice, that notice and Your continuation of the same use
> during the cure period, by themselves, are insufficient to establish a knowing breach.

1. **Use actual knowledge.** A constructive-knowledge standard would allow immediate
   termination based on what a user ought to have known, which could sweep in the first-time
   dashboard user this change is meant to protect. The draft also requires knowledge of
   the trial limit before an accidental trial reset can trigger immediate termination.
   _Sulyma_, an ERISA decision, illustrates the difference between disclosure and actual
   awareness. The draft adopts that distinction as a contractual standard.
   [_Intel Corp. Investment Policy Committee v. Sulyma_, 589 U.S. 178, 184–90 (2020)](https://www.supremecourt.gov/opinions/19pdf/18-1116_h3cj.pdf)
2. **Allow cure without back payment.** Stopping the affected use or acquiring a valid
   Pro License covering it by the written-notice deadline should preserve the license
   without a fee for prior use as a condition of cure. This is a proposed business choice.
   A purchase authorizes covered future use. The draft limits the effect of cure to
   termination and leaves any separate remedies for past use to the existing license terms
   and applicable law. Send and retain written notice that identifies the affected use and
   the cure deadline. [_James Construction Group, LLC v. Westlake Chemical Corp._, 650 S.W.3d 392, 403–08 (Tex. 2022), on contractual written notice](https://txcourts.gov/media/1454224/200079.pdf)

### C2. Open-source contributions under the Section 1 definition of Your Organization

**Issue.** Clause (iii) makes any entity "for whose benefit You use the Software" Your
Organization. Someone contributing on weekends to a large company's open-source repository
could arguably be using ctrlyoke for that company's benefit, which would require a Pro
License under Section 3(b). That is not intended.

**Change.** Add this paragraph at the end of the definition.

> Clause (iii) does not apply to a legal entity merely because You use the Software to
> prepare contributions to a Public Open-Source Project that the entity owns, sponsors,
> maintains, or uses, unless that entity, or another person acting on its behalf, pays or
> engages You for that work. The independent-client exception in clause (iii) and clauses
> (i), (ii), and (iv) continue to apply. A **Public Open-Source Project** is a project whose
> source code is publicly available under a license approved by the Open Source Initiative.

The exception applies to a volunteer contributing to a company's public MIT-licensed
project in a personal capacity. Work done in the course of employment or in a client's
managed environment remains subject to the existing tests. If the company or its agent
pays or engages the contributor for that work, apply the ordinary Section 1 tests,
including clause (iii)'s existing exception for independent clients. [OSI listing for the MIT license](https://opensource.org/license/mit)

**Recommendation on the license list.** Use OSI approval alone. OSI publishes a list of
licenses that have gone through its approval process. The Free Software Foundation (FSF)
describes its own license list as non-exhaustive. For example, the FSF recognizes the original
Affero General Public License v1 as free software, while OSI lists the GNU Affero General
Public License v3. Using OSI approval gives contributors one published reference and matches
the terminology in Section 4(e). An FSF-only license falls outside the carve-out, so the
ordinary Section 1 tests apply. [OSI approved licenses](https://opensource.org/licenses) ·
[FSF license list](https://www.gnu.org/licenses/license-list.html#AGPLv1.0)

## CLA acceptance record

**Recommendation.** Keep CLA v1.0 and Section 5(c) as drafted. Section 5(c) permits a
separate CLA, and CLA v1.0 requires affirmative acceptance without specifying a tool. Use
the GitHub-authenticated CLA Assistant signing screen to present the exact approved v1.0 text
and obtain an affirmative signature. Federal E-SIGN recognizes electronic signatures, and
Texas law addresses intent, attribution, and retention. In _Aerotek_, the Texas Supreme
Court relied on evidence about how the system attributed signatures to individuals.
[15 U.S.C. §§7001](https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/USCODE-2024-title15-chap96-subchapI-sec7001.htm)
and [7006(5)](https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/USCODE-2024-title15-chap96-subchapI-sec7006.htm) ·
[Tex. Bus. & Com. Code §§322.002(8), .007, .009 and .012](https://tcss.legis.texas.gov/resources/bc/htm/bc.322.htm) ·
[_Aerotek, Inc. v. Boyd_, 624 S.W.3d 199, 204–08 (Tex. 2021)](https://www.txcourts.gov/media/1452283/200290.pdf)

Use a dedicated GitHub Gist containing the exact archived CLA v1.0 text.
Keep the Gist revision and a copy of the signing screen. Export signature records and verify
that they tie the GitHub account and signing time to the text accepted. Preserve existing
checkbox and email acceptances. Record the entity and the signer's authority where a
contributor signs on behalf of an entity. For any contribution submitted before acceptance
that Fuzzy Nova intends to cover under the CLA, obtain written or electronic confirmation
expressly identifying it, for example by PR URL. [Archived CLA v1.0](https://ctrlyoke.dev/cla/1.0/) ·
[CLA Assistant documentation](https://github.com/cla-assistant/cla-assistant#contributor-license-agreement-cla-assistant)

## Companion changes to the plain-language summary

Add the following at adoption to `landing/src/legal/license-summary.md`, shown above the
license on `/terms/`.

- Under "Who can use ctrlyoke for free", after the paragraph on organizations involved,
  add “You can volunteer for a public project under an OSI-approved license without counting
  the company behind it just because it benefits. The usual organization rules still apply
  if the company or someone acting for it pays or hires you for that work.”
- Under "What you can't do", after the license-check bullet, add “If you accidentally break
  the license-check, Pro use, or trial rules in a way that could end your license, you have
  30 days from our written notice to stop the use or get a Pro license that covers it. You
  can fix the breach without paying for past use.”

## Adoption checklist (Fuzzy Nova)

- Copy the approved text into `LICENSE.md`, set the effective date, remove the draft banner.
- Update the plain-language summary above and set its `licenseVersion` to `2.4`.
- `npm run legal:archive`, `npm run check:legal`, landing build.
- `CHANGELOG.md` **Changed** entry; move this memo and the draft to `dev/implemented/`.
- Confirm test-mode Pro and Enterprise checkouts record `eula@2.4` and link to the versioned
  text.
- Install CLA Assistant with the v1.0 Gist. Test the signing flow on a fork PR, including an
  unsigned contributor and the transition to a passing check after signing. Verify the export
  against the Gist revision, then require the app's `license/cla` check on `main`. Update
  `CONTRIBUTING.md`, the PR template, and `dev/active/RELEASE_CHECKLIST.md` for the new
  acceptance record. [CLA Assistant status implementation](https://github.com/cla-assistant/cla-assistant/blob/main/src/server/src/services/status.js) ·
  [GitHub ruleset documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging)
