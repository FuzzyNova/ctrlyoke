# ctrlyoke Commercial License: proposed v2.3 changes (for counsel review)

**Status:** Draft, not adopted. `LICENSE.md` (v2.2, effective October 13, 2026) is unchanged.
**Prepared for:** outside counsel, on behalf of Fuzzy Nova LLC
**Date:** November 20, 2026

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
mass-arbitration campaigns exploit exactly that. But for a *single* claim, arbitration is not
clearly more expensive than court: legal fees dominate either way, and court adds discovery,
motion practice and a possible jury. Arbitration's distinctive cost is the *mass* filing
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

| Subsection | Status |
|---|---|
| (1) Informal resolution | Expanded: personally signed notice, an individual conference, a 60-day window, and tolling of limitation periods |
| (2) Scope and exceptions | Unchanged in substance |
| (3) Rules, location, enforcement | Unchanged in substance |
| (4) Fees | New: states the fee position, plus fee awards for frivolous claims |
| (5) Individual claims; jury and class waiver | Unchanged |
| (6) Mass filings | New |
| (7) Opt-out | Unchanged |
| (8) Severance | Expanded: a court stay while arbitration proceeds |
| (9) Future changes | New |

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
Circuit to refuse to enforce one mass-arbitration protocol in *Heckman v. Live Nation* (2024).
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
