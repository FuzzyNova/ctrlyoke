# ctrlyoke Commercial License v2.4 approval memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 22, 2026**

[Open the complete v2.4 license draft](LICENSE_2.4_DRAFT.md) ·
[Previous memo (v2.3)](../implemented/LICENSE_2.3_LAWYER_REVIEW.md)

**Requested response.** Approve the two changes below (C1 and C2) and the v2.4 draft, or give
replacement wording for the clause you would change. Everything else in the draft is v2.3
verbatim.

**Facts.** v2.3 was adopted and published at `ctrlyoke.dev/terms/` on November 21, 2026. No
ctrlyoke release (VSIX or npm) has shipped with v2.3, and there are no customers or
Enterprise orders. Both changes below narrow the licensee's exposure; neither expands any
licensee obligation.

**Why a new version rather than editing v2.3.** Every published version stays online
unchanged at its permanent URL (`ctrlyoke.dev/terms/2.3/`), and Section 16(e) ties each copy
to the version in effect when it was obtained. v2.3 has been public for a day, so anyone who
read or accepted it, for example by installing from source, accepted that exact text.
Issuing v2.4 keeps that record truthful at no cost. v2.3 remains archived and v2.4 becomes the
first version that ships in a release. Please tell us if you see a reason to handle it
differently.

## Changes

### C1. Section 15(b): unintentional Section 4(c) breaches get the cure period

**Issue.** In v2.3, any breach of Section 4(c) terminates the License immediately, with no
knowledge requirement, while Section 4(b) at least requires a knowing breach. A Free Tier
user who once opens the Hosted Dashboard from another device through `ssh -L` without having
read the Section 1 definition of Remote Dashboard Access would technically lose the whole
License with no opportunity to cure. Fuzzy Nova would not enforce it that way, but enterprise
legal reviewers read the worst case.

**Change.** Immediate termination applies only to a knowing breach of Section 4(c).
"Knowing" is defined to cover the deliberate conduct 4(c) targets: circumventing license
verification, restarting or stacking trials, or continuing Pro use after learning it needs a
license. Any other 4(c) breach falls under the existing thirty-day cure period, curable by
stopping the use or buying a Pro License. The last sentence keeps Licensor's own notice from
turning a curable breach into a knowing one during the cure window.

**v2.3:**

> A breach of Section 4(a) or 4(c), or a knowing and material breach of Section 4(b),
> terminates this License immediately without notice.

**v2.4:**

> A breach of Section 4(a), a knowing breach of Section 4(c), or a knowing and material
> breach of Section 4(b) terminates this License immediately without notice. A breach of
> Section 4(c) is knowing if You circumvent, disable, or defeat the Software's license
> verification mechanisms, restart, extend, or obtain more than one Evaluation Trial, or
> continue to use a Pro Tier capability after You know that the use requires a Pro License
> or an active Evaluation Trial. A breach of Section 4(c) that is not knowing, such as
> relaying the Hosted Dashboard to another device without knowing that this is Remote
> Dashboard Access, is subject to the thirty (30) day cure period. You cure it by stopping
> the use, or by obtaining a valid Pro License, within that period. Continuing the use
> during the cure period that follows Licensor's notice does not by itself make the breach
> knowing.

The rest of Section 15(b) is unchanged.

**Questions for counsel.**

1. Is "continue to use … after You know" the right standard, or do you prefer "know or
   reasonably should know"? We chose actual knowledge because the worst-case reader is the
   user who never read Section 1.
2. A cure by buying a Pro License does not require paying for the period of unlicensed use.
   We think that is acceptable for a remote-dashboard feature with a free trial. Please flag
   it if you disagree.

### C2. Section 1 "Your Organization": open-source contributions

**Issue.** Clause (iii) makes any entity "for whose benefit You use the Software" Your
Organization. Someone contributing on weekends to a large company's open-source repository
could arguably be using ctrlyoke for that company's benefit, which would require a Pro
License under Section 3(b). That is not intended.

**Change.** A new paragraph after the existing closing paragraph of the definition:

> Clause (iii) does not apply to a legal entity merely because You use the Software to
> prepare contributions to a Public Open-Source Project that the entity owns, sponsors,
> maintains, or uses, unless that entity, or another person acting on its behalf, pays or
> engages You for that work. Clauses (i), (ii), and (iv) still apply to that use. A
> **Public Open-Source Project** is a project whose source code is publicly available under
> a license approved by the Open Source Initiative.

Notes on the drafting:

- The carve-out removes only clause (iii). An employee contributing as part of their job is
  still covered by clause (i), and a contractor on a client-managed device by clause (ii).
- "Pays or engages You for that work" keeps paid open-source work (a sponsored maintainer,
  a contractor hired to land a feature) inside clause (iii).
- "Approved by the Open Source Initiative" matches the existing reference to OSI-approved
  licenses in Section 4(e).

**Question for counsel.** Should the definition also cover projects under licenses the Free
Software Foundation recognizes but OSI has not approved? We think OSI alone is clear enough.

## Not a license change: CLA acceptance record

The license needs no change for the CLA mechanism. Section 5(c) already lets Licensor
require a separate CLA, and CLA v1.0 binds "the individual or entity affirmatively accepting
it" without naming the method of acceptance. Fuzzy Nova plans to move from the PR-template
checkbox to CLA Assistant, which records acceptance per GitHub account and blocks merging
until the contributor accepts. That is an operational change, so the CLA stays at v1.0.
Please confirm you agree that no CLA version change is needed.

## Companion change: plain-language summary

`landing/src/legal/license-summary.md` (shown above the license on `/terms/`) will gain two
lines at adoption, with no change in meaning from the license:

- Under "Who can use ctrlyoke for free", after the paragraph on organizations involved:
  "Contributing to a public open-source project doesn't make the company behind it one of
  those organizations, unless it pays or hires you for that work."
- Under "What you can't do", after the license-check bullet: "If you use a Pro feature
  without realizing it, for example by forwarding the dashboard to another device, we'll
  give you 30 days' notice to stop or buy a license before your license ends."

## Adoption checklist (Fuzzy Nova)

- Copy the approved text into `LICENSE.md`, set the effective date, remove the draft banner.
- Update the plain-language summary above and set its `licenseVersion` to `2.4`.
- `npm run legal:archive`, `npm run check:legal`, landing build.
- `CHANGELOG.md` **Changed** entry; move this memo and the draft to `dev/implemented/`.
- Confirm the Enterprise checkout records `eula@2.4`.
- CLA Assistant: install the app, point it at `CLA.md` v1.0, and add its status check
  (`license/cla`) to the `main` ruleset's required checks. Update `CONTRIBUTING.md`, the PR
  template and `dev/active/RELEASE_CHECKLIST.md`, which still describe the checkbox as the
  acceptance record.
